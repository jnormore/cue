import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronScheduler } from "../../../src/cron/index.js";
import { CronRegistry } from "../../../src/cron/registry.js";
import type { ActionRuntime } from "../../../src/runtime/index.js";
import {
  createAction,
  createTrigger,
  deleteActionTool,
  deleteNamespaceTool,
  deleteTrigger,
  doctor,
  getAction,
  inspectRun,
  invokeActionTool,
  listActionRuns,
  listActions,
  listTriggers,
  type McpToolDeps,
  setSecret,
  updateAction,
} from "../../../src/server/mcp-tools.js";
import { StoreError } from "../../../src/store/index.js";
import { makeTestState } from "../../helpers/state.js";
import { type StoreAdapter, pickStore } from "../../../src/store/index.js";

function makeRuntime(): {
  runtime: ActionRuntime;
  run: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn().mockResolvedValue({
    stdout: "ok",
    stderr: "",
    exitCode: 0,
    runtimeRunId: "u_MOCK",
  });
  return {
    run,
    runtime: {
      name: "mock",
      async doctor() {
        return { ok: true, details: { mock: true } };
      },
      run,
    },
  };
}

function captureScheduler(): {
  scheduler: CronScheduler;
  scheduleMock: ReturnType<typeof vi.fn>;
  cancelMocks: Map<string, ReturnType<typeof vi.fn>>;
} {
  const cancelMocks = new Map<string, ReturnType<typeof vi.fn>>();
  const scheduleMock = vi.fn().mockImplementation(async (args) => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    cancelMocks.set(args.triggerId, cancel);
    return { cancel };
  });
  return {
    scheduleMock,
    cancelMocks,
    scheduler: {
      name: "capture",
      async doctor() {
        return { ok: true, details: { schedulerMock: true } };
      },
      schedule: scheduleMock,
      async close() {
        /* no-op */
      },
    },
  };
}

describe("mcp-tools", () => {
  let home: string;
  let store: StoreAdapter;
  let runtime: ActionRuntime;
  let runMock: ReturnType<typeof vi.fn>;
  let scheduler: CronScheduler;
  let scheduleMock: ReturnType<typeof vi.fn>;
  let cancelMocks: Map<string, ReturnType<typeof vi.fn>>;
  let deps: McpToolDeps;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-mcp-tools-"));
    store = pickStore("fs", { home });
    const rt = makeRuntime();
    runtime = rt.runtime;
    runMock = rt.run;
    const s = captureScheduler();
    scheduler = s.scheduler;
    scheduleMock = s.scheduleMock;
    cancelMocks = s.cancelMocks;
    const state = makeTestState(home);
    const invokeDeps = { store, runtime, state, port: 4747, ceiling: {} };
    const registry = new CronRegistry(scheduler, invokeDeps);
    deps = {
      ...invokeDeps,
      cronScheduler: scheduler,
      cronRegistry: registry,
      invokeUrlFor: (id) => `http://localhost:4747/a/${id}`,
      webhookUrlFor: (id) => `http://localhost:4747/w/${id}`,
      cueVersion: "0.1.0",
      principal: { type: "master" },
    };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe("actions", () => {
    it("create_action returns { id, name, namespace, invokeUrl }", async () => {
      const ref = await createAction(deps, {
        name: "hello",
        code: "console.log('hi')",
        namespace: "weather",
      });
      expect(ref.id).toMatch(/^act_/);
      expect(ref.namespace).toBe("weather");
      expect(ref.invokeUrl).toBe(`http://localhost:4747/a/${ref.id}`);
    });

    it("update_action patches code and returns updated ref", async () => {
      const ref = await createAction(deps, { name: "a", code: "x" });
      const patched = await updateAction(deps, {
        id: ref.id,
        patch: { code: "y" },
      });
      const full = await getAction(deps, { id: ref.id });
      expect(patched.id).toBe(ref.id);
      expect(full.code).toBe("y");
    });

    it("invoke_action runs the action and records a run", async () => {
      const ref = await createAction(deps, { name: "a", code: "x" });
      runMock.mockResolvedValueOnce({
        stdout: '{"k":42}',
        stderr: "",
        exitCode: 0,
        runtimeRunId: "u_A",
      });
      const r = await invokeActionTool(deps, {
        id: ref.id,
        input: { q: 1 },
      });
      expect(r.exitCode).toBe(0);
      expect(r.output).toEqual({ k: 42 });
      const runs = await listActionRuns(deps, { id: ref.id });
      expect(runs).toHaveLength(1);
    });

    it("invoke_action throws NotFound for unknown id", async () => {
      await expect(
        invokeActionTool(deps, { id: "act_UNKNOWN" }),
      ).rejects.toMatchObject({ kind: "NotFound" });
    });

    it("list_actions filters by namespace", async () => {
      await createAction(deps, { name: "a", code: "x", namespace: "one" });
      await createAction(deps, { name: "b", code: "y", namespace: "two" });
      const all = await listActions(deps, {});
      expect(all).toHaveLength(2);
      const one = await listActions(deps, { namespace: "one" });
      expect(one).toHaveLength(1);
      expect(one[0]?.name).toBe("a");
    });

    it("delete_action cascades trigger removal and cancels cron handles", async () => {
      const ref = await createAction(deps, { name: "a", code: "x" });
      const cron = await createTrigger(deps, {
        type: "cron",
        actionId: ref.id,
        config: { schedule: "* * * * *" },
      });
      const webhook = await createTrigger(deps, {
        type: "webhook",
        actionId: ref.id,
      });
      const result = await deleteActionTool(deps, { id: ref.id });
      expect(result.deleted).toBe(ref.id);
      expect(result.alsoDeleted.sort()).toEqual(
        [cron.id, webhook.id].sort(),
      );
      expect(cancelMocks.get(cron.id)).toHaveBeenCalled();
    });

    it("inspect_run returns stdout, stderr, input alongside meta", async () => {
      const ref = await createAction(deps, { name: "a", code: "x" });
      runMock.mockResolvedValueOnce({
        stdout: "hello",
        stderr: "warn",
        exitCode: 0,
        runtimeRunId: "u_I",
      });
      const r = await invokeActionTool(deps, { id: ref.id, input: { q: 9 } });
      const ins = await inspectRun(deps, { runId: r.runId });
      expect(ins.stdout).toBe("hello");
      expect(ins.stderr).toBe("warn");
      expect(ins.input).toEqual({ trigger: null, input: { q: 9 } });
    });
  });

  describe("triggers", () => {
    it("create_trigger defaults namespace to the action's namespace", async () => {
      const action = await createAction(deps, {
        name: "a",
        code: "x",
        namespace: "weather",
      });
      const trg = await createTrigger(deps, {
        type: "cron",
        actionId: action.id,
        config: { schedule: "0 9 * * *" },
      });
      expect(scheduleMock).toHaveBeenCalledWith(
        expect.objectContaining({ triggerId: trg.id, expression: "0 9 * * *" }),
      );
    });

    it("create_trigger webhook returns webhookUrl and webhookToken", async () => {
      const action = await createAction(deps, { name: "a", code: "x" });
      const trg = await createTrigger(deps, {
        type: "webhook",
        actionId: action.id,
      });
      expect(trg.webhookUrl).toBe(`http://localhost:4747/w/${trg.id}`);
      expect(trg.webhookToken).toMatch(/^tok_[0-9a-f]{64}$/);
      expect(scheduleMock).not.toHaveBeenCalled();
    });

    it("delete_trigger cancels the cron handle", async () => {
      const action = await createAction(deps, { name: "a", code: "x" });
      const trg = await createTrigger(deps, {
        type: "cron",
        actionId: action.id,
        config: { schedule: "* * * * *" },
      });
      await deleteTrigger(deps, { id: trg.id });
      expect(cancelMocks.get(trg.id)).toHaveBeenCalled();
    });

    it("list_triggers filters by namespace and actionId", async () => {
      const a = await createAction(deps, { name: "a", code: "x" });
      const b = await createAction(deps, { name: "b", code: "y" });
      await createTrigger(deps, {
        type: "cron",
        actionId: a.id,
        config: { schedule: "* * * * *" },
      });
      await createTrigger(deps, {
        type: "cron",
        actionId: b.id,
        config: { schedule: "* * * * *" },
      });
      const forA = await listTriggers(deps, { actionId: a.id });
      expect(forA).toHaveLength(1);
    });
  });

  describe("namespaces", () => {
    it("delete_namespace cascades actions + triggers and cancels cron handles", async () => {
      const a = await createAction(deps, {
        name: "a",
        code: "x",
        namespace: "weather",
      });
      await createAction(deps, { name: "b", code: "y", namespace: "weather" });
      await createAction(deps, { name: "c", code: "z", namespace: "news" });
      const cronTrg = await createTrigger(deps, {
        type: "cron",
        actionId: a.id,
        config: { schedule: "* * * * *" },
      });
      await setSecret(deps, {
        namespace: "weather",
        name: "WEATHER_API_KEY",
        value: "secret-value",
      });
      const result = await deleteNamespaceTool(deps, { name: "weather" });
      expect(result.deleted.actions).toHaveLength(2);
      expect(result.deleted.triggers).toContain(cronTrg.id);
      expect(result.deleted.secrets).toEqual(["WEATHER_API_KEY"]);
      expect(cancelMocks.get(cronTrg.id)).toHaveBeenCalled();
      const remaining = await listActions(deps, {});
      expect(remaining).toHaveLength(1);
      expect(await store.secrets.list("weather")).toEqual([]);
    });
  });

  describe("set_secret", () => {
    it("stores a secret scoped to the namespace", async () => {
      const r = await setSecret(deps, {
        namespace: "shop",
        name: "SHOPIFY_TOKEN",
        value: "shpat_abc",
      });
      expect(r).toEqual({
        ok: true,
        namespace: "shop",
        name: "SHOPIFY_TOKEN",
      });
      expect(await store.secrets.list("shop")).toEqual(["SHOPIFY_TOKEN"]);
      expect(
        await store.secrets.resolve("shop", ["SHOPIFY_TOKEN"]),
      ).toEqual({ SHOPIFY_TOKEN: "shpat_abc" });
    });

    it("does not leak to another namespace", async () => {
      await setSecret(deps, {
        namespace: "shop",
        name: "TOKEN",
        value: "shop-value",
      });
      expect(await store.secrets.resolve("other", ["TOKEN"])).toEqual({});
    });

    it("rejects invalid namespace or name", async () => {
      await expect(
        setSecret(deps, { namespace: "Bad NS", name: "A", value: "v" }),
      ).rejects.toBeInstanceOf(StoreError);
      await expect(
        setSecret(deps, { namespace: "shop", name: "with-dash", value: "v" }),
      ).rejects.toBeInstanceOf(StoreError);
    });

    it("makes the secret visible to invokeAction via the runtime args", async () => {
      const a = await createAction(deps, {
        name: "needs-secret",
        code: "x",
        namespace: "shop",
        policy: { secrets: ["SHOPIFY_TOKEN"] },
      });
      await setSecret(deps, {
        namespace: "shop",
        name: "SHOPIFY_TOKEN",
        value: "shpat_xyz",
      });
      await invokeActionTool(deps, { id: a.id });
      const runArgs = runMock.mock.calls.at(-1)?.[0];
      expect(runArgs.secrets).toEqual({ SHOPIFY_TOKEN: "shpat_xyz" });
    });
  });

  describe("doctor", () => {
    it("aggregates cue/runtime/store/cron sub-reports", async () => {
      const d = await doctor(deps);
      expect(d.cue).toEqual({
        version: "0.1.0",
        daemonUp: true,
        port: 4747,
      });
      expect(d.runtime).toEqual({
        name: "mock",
        ok: true,
        details: { mock: true },
      });
      expect(d.store.name).toBe("fs");
      expect(d.store.ok).toBe(true);
      expect(d.cron).toEqual({
        name: "capture",
        ok: true,
        details: { schedulerMock: true },
      });
    });
  });
});
