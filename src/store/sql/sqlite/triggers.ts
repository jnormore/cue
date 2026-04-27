import type { DatabaseSync } from "node:sqlite";
import {
  type CronConfig,
  StoreError,
  type TriggerConfigData,
  type TriggerCreateInput,
  type TriggerRecord,
  type TriggerStore,
  type TriggerSubscription,
  type WebhookAuthMode,
  type WebhookTriggerCreateConfig,
  newTriggerId,
  newWebhookToken,
  validateNamespace,
} from "../../index.js";

const VALID_AUTH_MODES: ReadonlySet<WebhookAuthMode> = new Set([
  "bearer",
  "public",
  "artifact-session",
]);

interface TriggerRow {
  id: string;
  type: "cron" | "webhook";
  action_id: string;
  namespace: string;
  config: string;
  created_at: string;
  firing_until: string | null;
}

function toRecord(r: TriggerRow): TriggerRecord {
  const parsed = JSON.parse(r.config) as TriggerConfigData;
  // Legacy rows (pre-authMode) lack the field; normalize on read so
  // downstream code can treat config.authMode as required.
  if (parsed.type === "webhook" && !parsed.authMode) {
    parsed.authMode = "bearer";
  }
  return {
    id: r.id,
    type: r.type,
    actionId: r.action_id,
    namespace: r.namespace,
    createdAt: r.created_at,
    config: parsed,
  };
}

function buildConfig(input: TriggerCreateInput): TriggerConfigData {
  if (input.type === "cron") {
    const c = input.config as CronConfig;
    if (!c || !c.schedule) {
      throw new StoreError(
        "ValidationError",
        "cron trigger requires schedule",
      );
    }
    return {
      type: "cron",
      schedule: c.schedule,
      ...(c.timezone ? { timezone: c.timezone } : {}),
    };
  }
  if (input.type === "webhook") {
    const c = (input.config ?? {}) as WebhookTriggerCreateConfig;
    const authMode: WebhookAuthMode = c.authMode ?? "bearer";
    if (!VALID_AUTH_MODES.has(authMode)) {
      throw new StoreError(
        "ValidationError",
        `Unknown webhook authMode "${authMode}"`,
        { authMode },
      );
    }
    return { type: "webhook", token: newWebhookToken(), authMode };
  }
  throw new StoreError(
    "ValidationError",
    `Unknown trigger type "${input.type}"`,
    { type: input.type },
  );
}

/**
 * Subscribers for trigger-set changes. Since the daemon is the only
 * writer to the local SQLite DB (CLI talks to it over HTTP), in-process
 * notification is sufficient — we just call subscribers after each
 * create/delete. The Postgres adapter will replace this with
 * LISTEN/NOTIFY for cross-daemon awareness.
 */
class Subscribers {
  private listeners = new Set<() => void>();
  add(fn: () => void): TriggerSubscription {
    this.listeners.add(fn);
    return {
      close: () => {
        this.listeners.delete(fn);
      },
    };
  }
  notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* swallow — a callback throwing must not affect other subscribers */
      }
    }
  }
}

export function sqliteTriggers(db: DatabaseSync): TriggerStore {
  const subs = new Subscribers();

  return {
    async create(input) {
      validateNamespace(input.namespace);
      const config = buildConfig(input);
      const id = newTriggerId();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO triggers (id, type, action_id, namespace, config, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, input.type, input.actionId, input.namespace, JSON.stringify(config), now);
      const record: TriggerRecord = {
        id,
        type: input.type,
        actionId: input.actionId,
        namespace: input.namespace,
        createdAt: now,
        config,
      };
      subs.notify();
      return record;
    },

    async get(id) {
      const row = db
        .prepare("SELECT * FROM triggers WHERE id = ?")
        .get(id) as TriggerRow | undefined;
      return row ? toRecord(row) : null;
    },

    async list(filter) {
      let sql = "SELECT * FROM triggers";
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter?.namespace) {
        where.push("namespace = ?");
        params.push(filter.namespace);
      }
      if (filter?.actionId) {
        where.push("action_id = ?");
        params.push(filter.actionId);
      }
      if (where.length > 0) sql += " WHERE " + where.join(" AND ");
      sql += " ORDER BY created_at";
      const rows = db.prepare(sql).all(...(params as never[])) as unknown as TriggerRow[];
      return rows.map(toRecord);
    },

    async delete(id) {
      const result = db.prepare("DELETE FROM triggers WHERE id = ?").run(id);
      if (result.changes === 0) {
        throw new StoreError("NotFound", `Trigger ${id} not found`, { id });
      }
      subs.notify();
    },

    subscribe(onChange) {
      return subs.add(onChange);
    },

    async claimFire(triggerId, leaseMs) {
      // Single-node SQLite: the daemon is the only one running, so the
      // claim always succeeds. We still record the lease so traces /
      // ops tooling can see it. Postgres will reuse this column with a
      // proper UPDATE...WHERE firing_until < now() race.
      const until = new Date(Date.now() + leaseMs).toISOString();
      const result = db
        .prepare("UPDATE triggers SET firing_until = ? WHERE id = ?")
        .run(until, triggerId);
      return result.changes > 0;
    },
  };
}
