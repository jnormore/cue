import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronScheduler } from "../../../src/cron/index.js";
import { CronRegistry } from "../../../src/cron/registry.js";
import type { ActionRuntime } from "../../../src/runtime/index.js";
import type { StateAdapter } from "../../../src/state/index.js";
import {
  type ActionRecord,
  pickStore,
  type StoreAdapter,
} from "../../../src/store/index.js";
import { makeTestState } from "../../helpers/state.js";

function makeRuntime(): {
  runtime: ActionRuntime;
  run: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn().mockResolvedValue({
    stdout: "",
    stderr: "",
    exitCode: 0,
    runtimeRunId: "u_MOCK",
  });
  return {
    run,
    runtime: {
      name: "mock",
      async doctor() {
        return { ok: true, details: {} };
      },
      run,
    },
  };
}

function captureScheduler(): {
  scheduler: CronScheduler;
  handlers: Map<string, () => Promise<void>>;
  cancels: Map<string, ReturnType<typeof vi.fn>>;
  scheduleMock: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, () => Promise<void>>();
  const cancels = new Map<string, ReturnType<typeof vi.fn>>();
  const scheduleMock = vi.fn().mockImplementation(async (args) => {
    handlers.set(args.triggerId, args.handler);
    const cancel = vi.fn().mockResolvedValue(undefined);
    cancels.set(args.triggerId, cancel);
    return { cancel };
  });
  return {
    handlers,
    cancels,
    scheduleMock,
    scheduler: {
      name: "capture",
      async doctor() {
        return { ok: true, details: {} };
      },
      schedule: scheduleMock,
      async close() {
        /* no-op */
      },
    },
  };
}

describe("CronRegistry", () => {
  let home: string;
  let store: StoreAdapter;
  let state: StateAdapter;
  let action: ActionRecord;
  let runtime: ActionRuntime;
  let runMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "cue-cron-reg-"));
    store = pickStore("sqlite", { home });
    state = makeTestState(home);
    action = await store.actions.create({ name: "a", code: "x" });
    const r = makeRuntime();
    runtime = r.runtime;
    runMock = r.run;
  });

  afterEach(async () => {
    await store.close();
    await state.close();
    rmSync(home, { recursive: true, force: true });
  });

  describe("loadExisting", () => {
    it("schedules each cron trigger, ignores non-cron", async () => {
      const cronTrg = await store.triggers.create({
        type: "cron",
        actionId: action.id,
        namespace: "default",
        config: { schedule: "0 9 * * *", timezone: "UTC" },
      });
      await store.triggers.create({
        type: "webhook",
        actionId: action.id,
        namespace: "default",
        config: {},
      });
      const { scheduler, scheduleMock } = captureScheduler();
      const reg = new CronRegistry(scheduler, { store, runtime, state, port: 0, ceiling: {} });
      const result = await reg.loadExisting();
      expect(result.scheduled).toHaveLength(1);
      expect(result.scheduled[0]?.triggerId).toBe(cronTrg.id);
      expect(result.failed).toEqual([]);
      expect(scheduleMock).toHaveBeenCalledTimes(1);
      expect(reg.size()).toBe(1);
    });

    it("records failures without throwing", async () => {
      await store.triggers.create({
        type: "cron",
        actionId: action.id,
        namespace: "default",
        config: { schedule: "* * * * *" },
      });
      const scheduler: CronScheduler = {
        name: "fail",
        async doctor() {
          return { ok: true, details: {} };
        },
        async schedule() {
          throw new Error("scheduler broken");
        },
        async close() {
          /* no-op */
        },
      };
      const reg = new CronRegistry(scheduler, { store, runtime, state, port: 0, ceiling: {} });
      const result = await reg.loadExisting();
      expect(result.scheduled).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.error).toContain("scheduler broken");
    });
  });

  describe("add / remove", () => {
    it("add runs the handler, remove cancels it", async () => {
      const trg = await store.triggers.create({
        type: "cron",
        actionId: action.id,
        namespace: "default",
        config: { schedule: "* * * * *" },
      });
      const { scheduler, handlers, cancels } = captureScheduler();
      const reg = new CronRegistry(scheduler, { store, runtime, state, port: 0, ceiling: {} });
      await reg.add(trg);
      expect(reg.has(trg.id)).toBe(true);
      await handlers.get(trg.id)?.();
      expect(runMock).toHaveBeenCalledOnce();
      await reg.remove(trg.id);
      expect(reg.has(trg.id)).toBe(false);
      expect(cancels.get(trg.id)).toHaveBeenCalled();
    });

    it("add is a no-op for non-cron triggers", async () => {
      const webhookTrg = await store.triggers.create({
        type: "webhook",
        actionId: action.id,
        namespace: "default",
        config: {},
      });
      const { scheduler, scheduleMock } = captureScheduler();
      const reg = new CronRegistry(scheduler, { store, runtime, state, port: 0, ceiling: {} });
      await reg.add(webhookTrg);
      expect(reg.has(webhookTrg.id)).toBe(false);
      expect(scheduleMock).not.toHaveBeenCalled();
    });

    it("re-adding the same trigger with the same schedule is a no-op", async () => {
      const trg = await store.triggers.create({
        type: "cron",
        actionId: action.id,
        namespace: "default",
        config: { schedule: "* * * * *" },
      });
      const allCancels: ReturnType<typeof vi.fn>[] = [];
      let scheduleCalls = 0;
      const scheduler: CronScheduler = {
        name: "all-cancels",
        async doctor() {
          return { ok: true, details: {} };
        },
        async schedule() {
          scheduleCalls += 1;
          const cancel = vi.fn().mockResolvedValue(undefined);
          allCancels.push(cancel);
          return { cancel };
        },
        async close() {
          /* no-op */
        },
      };
      const reg = new CronRegistry(scheduler, { store, runtime, state, port: 0, ceiling: {} });
      await reg.add(trg);
      await reg.add(trg);
      // Idempotent add: only one schedule call, zero cancels.
      expect(scheduleCalls).toBe(1);
      expect(allCancels).toHaveLength(1);
      expect(allCancels[0]).not.toHaveBeenCalled();
    });

    it("re-adding with a changed schedule replaces the prior handle", async () => {
      const trg = await store.triggers.create({
        type: "cron",
        actionId: action.id,
        namespace: "default",
        config: { schedule: "* * * * *" },
      });
      const changed = { ...trg, config: { ...trg.config, schedule: "0 9 * * *" } };
      const allCancels: ReturnType<typeof vi.fn>[] = [];
      let scheduleCalls = 0;
      const scheduler: CronScheduler = {
        name: "all-cancels",
        async doctor() {
          return { ok: true, details: {} };
        },
        async schedule() {
          scheduleCalls += 1;
          const cancel = vi.fn().mockResolvedValue(undefined);
          allCancels.push(cancel);
          return { cancel };
        },
        async close() {
          /* no-op */
        },
      };
      const reg = new CronRegistry(scheduler, { store, runtime, state, port: 0, ceiling: {} });
      await reg.add(trg);
      await reg.add(changed);
      expect(scheduleCalls).toBe(2);
      expect(allCancels[0]).toHaveBeenCalledTimes(1);
      expect(allCancels[1]).not.toHaveBeenCalled();
    });

    it("remove is a no-op for unknown trigger", async () => {
      const { scheduler } = captureScheduler();
      const reg = new CronRegistry(scheduler, { store, runtime, state, port: 0, ceiling: {} });
      await expect(reg.remove("trg_UNKNOWN")).resolves.not.toThrow();
    });
  });

  describe("handler self-healing", () => {
    it("skips invocation when trigger is deleted between fires", async () => {
      const trg = await store.triggers.create({
        type: "cron",
        actionId: action.id,
        namespace: "default",
        config: { schedule: "* * * * *" },
      });
      const { scheduler, handlers } = captureScheduler();
      const reg = new CronRegistry(scheduler, { store, runtime, state, port: 0, ceiling: {} });
      await reg.add(trg);
      await store.triggers.delete(trg.id);
      await handlers.get(trg.id)?.();
      expect(runMock).not.toHaveBeenCalled();
    });

    it("skips invocation when action is deleted between fires", async () => {
      const trg = await store.triggers.create({
        type: "cron",
        actionId: action.id,
        namespace: "default",
        config: { schedule: "* * * * *" },
      });
      const { scheduler, handlers } = captureScheduler();
      const reg = new CronRegistry(scheduler, { store, runtime, state, port: 0, ceiling: {} });
      await reg.add(trg);
      await store.actions.delete(action.id);
      await handlers.get(trg.id)?.();
      expect(runMock).not.toHaveBeenCalled();
    });
  });

  describe("closeAll", () => {
    it("cancels every handle and empties the registry", async () => {
      const a = await store.triggers.create({
        type: "cron",
        actionId: action.id,
        namespace: "default",
        config: { schedule: "* * * * *" },
      });
      const b = await store.triggers.create({
        type: "cron",
        actionId: action.id,
        namespace: "default",
        config: { schedule: "*/5 * * * *" },
      });
      const { scheduler, cancels } = captureScheduler();
      const reg = new CronRegistry(scheduler, { store, runtime, state, port: 0, ceiling: {} });
      await reg.add(a);
      await reg.add(b);
      await reg.closeAll();
      expect(reg.size()).toBe(0);
      expect(cancels.get(a.id)).toHaveBeenCalled();
      expect(cancels.get(b.id)).toHaveBeenCalled();
    });
  });
});
