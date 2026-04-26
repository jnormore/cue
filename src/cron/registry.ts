import { type InvokeDeps, invokeAction } from "../invoke.js";
import { assertNamespaceActive } from "../server/namespace-status.js";
import {
  StoreError,
  type TriggerRecord,
  type TriggerSubscription,
} from "../store/index.js";
import type { CronHandle, CronScheduler } from "./index.js";

export interface ScheduledCron {
  triggerId: string;
  expression: string;
}

export interface FailedCron {
  triggerId: string;
  error: string;
}

export interface LoadCronResult {
  scheduled: ScheduledCron[];
  failed: FailedCron[];
}

const WATCH_DEBOUNCE_MS = 150;
const POLL_INTERVAL_MS = 1000;

export class CronRegistry {
  /** In-memory map of triggerId → CronHandle. Per-trigger schedule state. */
  private readonly handles = new Map<string, CronHandle>();
  /** Schedule expression each current handle was started with, so we only replace when it actually changed. */
  private readonly expressions = new Map<string, string>();
  private readonly scheduler: CronScheduler;
  private readonly deps: InvokeDeps;
  /** Subscription to store.triggers change notifications; null until `watch()` starts. */
  private subscription: TriggerSubscription | null = null;
  /** Debounce handle for coalescing burst events into a single reconcile. */
  private pendingReconcile: NodeJS.Timeout | null = null;
  /** Periodic poll handle — backs up the in-process subscribe path so out-of-process writes get picked up. */
  private pollTimer: NodeJS.Timeout | null = null;
  /** Serializes reconciles so overlapping events never race. */
  private inflight: Promise<void> = Promise.resolve();

  constructor(scheduler: CronScheduler, deps: InvokeDeps) {
    this.scheduler = scheduler;
    this.deps = deps;
  }

  async loadExisting(): Promise<LoadCronResult> {
    const triggers = await this.deps.store.triggers.list();
    const scheduled: ScheduledCron[] = [];
    const failed: FailedCron[] = [];
    for (const t of triggers) {
      if (t.type !== "cron" || t.config.type !== "cron") continue;
      try {
        await this.add(t);
        scheduled.push({ triggerId: t.id, expression: t.config.schedule });
      } catch (err) {
        failed.push({
          triggerId: t.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { scheduled, failed };
  }

  async add(trigger: TriggerRecord): Promise<void> {
    if (trigger.type !== "cron" || trigger.config.type !== "cron") return;
    const existing = this.expressions.get(trigger.id);
    if (existing === trigger.config.schedule) return; // no-op
    if (this.handles.has(trigger.id)) {
      await this.remove(trigger.id);
    }
    const handle = await this.scheduler.schedule({
      triggerId: trigger.id,
      expression: trigger.config.schedule,
      ...(trigger.config.timezone ? { timezone: trigger.config.timezone } : {}),
      handler: () => this.fire(trigger.id),
    });
    this.handles.set(trigger.id, handle);
    this.expressions.set(trigger.id, trigger.config.schedule);
  }

  async remove(triggerId: string): Promise<void> {
    const h = this.handles.get(triggerId);
    if (!h) return;
    await h.cancel();
    this.handles.delete(triggerId);
    this.expressions.delete(triggerId);
  }

  has(triggerId: string): boolean {
    return this.handles.has(triggerId);
  }

  size(): number {
    return this.handles.size;
  }

  /**
   * Bring the in-memory schedule map in sync with whatever cron
   * triggers currently exist on disk: cancel schedules whose trigger
   * disappeared, add/reschedule any new or modified ones. Idempotent
   * — safe to call repeatedly, which is what `watch()` does.
   */
  async reconcile(): Promise<void> {
    const triggers = await this.deps.store.triggers.list();
    const diskIds = new Set<string>();
    for (const t of triggers) {
      if (t.type === "cron" && t.config.type === "cron") {
        diskIds.add(t.id);
        try {
          await this.add(t);
        } catch {
          /* A single bad schedule shouldn't block others. */
        }
      }
    }
    for (const id of Array.from(this.handles.keys())) {
      if (!diskIds.has(id)) await this.remove(id);
    }
  }

  /**
   * Start watching the trigger store for changes. Two channels run in
   * parallel: the in-process `subscribe()` callback fires synchronously
   * for writes inside this daemon (debounced reconcile), and a periodic
   * poll catches writes from elsewhere (CLI tools, future fleet peers)
   * the in-process channel can't see. Calling `watch()` twice replaces
   * any existing subscription.
   */
  watch(): void {
    if (this.subscription) this.subscription.close();
    this.subscription = this.deps.store.triggers.subscribe(() => {
      this.scheduleReconcile();
    });
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      this.scheduleReconcile();
    }, POLL_INTERVAL_MS);
    // Don't keep the event loop alive just for the poll.
    this.pollTimer.unref();
  }

  private scheduleReconcile(): void {
    if (this.pendingReconcile) clearTimeout(this.pendingReconcile);
    this.pendingReconcile = setTimeout(() => {
      this.pendingReconcile = null;
      // Chain onto the inflight promise so reconciles never overlap.
      this.inflight = this.inflight
        .then(() => this.reconcile())
        .catch(() => {
          /* swallow — next event will trigger another reconcile */
        });
    }, WATCH_DEBOUNCE_MS);
  }

  async closeAll(): Promise<void> {
    if (this.pendingReconcile) {
      clearTimeout(this.pendingReconcile);
      this.pendingReconcile = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.subscription) {
      this.subscription.close();
      this.subscription = null;
    }
    // Wait for any in-flight reconcile before tearing down handles.
    await this.inflight.catch(() => undefined);
    const ids = Array.from(this.handles.keys());
    for (const id of ids) await this.remove(id);
  }

  private async fire(triggerId: string): Promise<void> {
    const t = await this.deps.store.triggers.get(triggerId);
    if (!t) return;
    const a = await this.deps.store.actions.get(t.actionId);
    if (!a) return;
    // Cron silently no-ops on paused/archived namespaces. The next
    // scheduled tick will check again, so resuming the namespace
    // restarts firing without an explicit reload.
    try {
      await assertNamespaceActive(this.deps.store, a.namespace);
    } catch (err) {
      if (
        err instanceof StoreError &&
        (err.kind === "NamespacePaused" || err.kind === "NamespaceArchived")
      ) {
        return;
      }
      throw err;
    }
    await invokeAction(this.deps, a, {
      trigger: {
        type: "cron",
        triggerId,
        firedAt: new Date().toISOString(),
      },
      input: null,
    });
  }
}
