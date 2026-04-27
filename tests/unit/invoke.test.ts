import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type InvokeEnvelope, invokeAction } from "../../src/invoke.js";
import type { ActionRuntime } from "../../src/runtime/index.js";
import type { StateAdapter } from "../../src/state/index.js";
import {
  type ActionRecord,
  type StoreAdapter,
  pickStore,
} from "../../src/store/index.js";
import { makeTestState } from "../helpers/state.js";

function makeRuntime(
  override: Partial<{
    stdout: string;
    stderr: string;
    exitCode: number;
    runtimeRunId: string;
  }> = {},
): { runtime: ActionRuntime; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn().mockResolvedValue({
    stdout: override.stdout ?? "",
    stderr: override.stderr ?? "",
    exitCode: override.exitCode ?? 0,
    runtimeRunId: override.runtimeRunId ?? "u_MOCK",
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

describe("invokeAction", () => {
  let home: string;
  let store: StoreAdapter;
  let state: StateAdapter;
  let action: ActionRecord;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "cue-invoke-"));
    store = pickStore("sqlite", { home });
    state = makeTestState(home);
    action = await store.actions.create({
      name: "hello",
      code: "console.log('hi')",
      policy: { memoryMb: 256, allowNet: ["api.github.com"] },
    });
  });

  afterEach(async () => {
    await store.close();
    await state.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("creates a run, calls runtime, finishes the run, returns the result", async () => {
    const { runtime, run } = makeRuntime({
      stdout: "hello world",
      stderr: "",
      exitCode: 0,
      runtimeRunId: "u_ABC",
    });
    const envelope: InvokeEnvelope = { trigger: null, input: { q: 1 } };
    const result = await invokeAction(
      { store, runtime, state, port: 0, ceiling: {} },
      action,
      envelope,
    );

    expect(result.runId).toMatch(/^run_/);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world");
    expect(result.runtimeRunId).toBe("u_ABC");
    expect(result.denials).toEqual([]);

    expect(run).toHaveBeenCalledOnce();
    const runArgs = run.mock.calls[0]?.[0];
    expect(runArgs.code).toBe(action.code);
    expect(runArgs.policy).toEqual({
      memoryMb: 256,
      allowNet: ["api.github.com"],
    });
    expect(JSON.parse(runArgs.stdin)).toEqual(envelope);
    expect(runArgs.timeoutMs).toBeGreaterThan(0);

    const stored = await store.runs.get(result.runId);
    expect(stored).not.toBeNull();
    expect(stored?.actionId).toBe(action.id);
    expect(stored?.exitCode).toBe(0);
    expect(stored?.runtimeRunId).toBe("u_ABC");
  });

  it("parses stdout as JSON when valid; returns null otherwise", async () => {
    const { runtime: r1 } = makeRuntime({ stdout: '{"ok":true}' });
    const a = await invokeAction(
      { store, runtime: r1, state, port: 0, ceiling: {} },
      action,
      { trigger: null, input: null },
    );
    expect(a.output).toEqual({ ok: true });

    const { runtime: r2 } = makeRuntime({ stdout: "plain text" });
    const b = await invokeAction(
      { store, runtime: r2, state, port: 0, ceiling: {} },
      action,
      { trigger: null, input: null },
    );
    expect(b.output).toBeNull();
  });

  it("records policy denials on the run and intersects effective policy", async () => {
    const overCeilingAction = await store.actions.create({
      name: "too-much",
      code: "x",
      policy: {
        memoryMb: 2048,
        allowNet: ["api.github.com", "evil.com"],
      },
    });
    const { runtime, run } = makeRuntime();
    const result = await invokeAction(
      {
        store,
        runtime,
        state,
        port: 0,
        ceiling: { memoryMb: 512, allowNet: ["api.github.com"] },
      },
      overCeilingAction,
      { trigger: null, input: null },
    );
    expect(result.denials.sort()).toEqual(
      ["allowNet:evil.com", "memoryMb:2048>512"].sort(),
    );
    const passedPolicy = run.mock.calls[0]?.[0].policy;
    expect(passedPolicy.memoryMb).toBe(512);
    expect(passedPolicy.allowNet).toEqual(["api.github.com"]);

    const stored = await store.runs.get(result.runId);
    expect(stored?.denials?.sort()).toEqual(
      ["allowNet:evil.com", "memoryMb:2048>512"].sort(),
    );
  });

  it("stores triggerId on the run when envelope has a trigger", async () => {
    const { runtime } = makeRuntime();
    const envelope: InvokeEnvelope = {
      trigger: {
        type: "cron",
        triggerId: "trg_ABC",
        firedAt: "2026-04-23T00:00:00.000Z",
      },
      input: null,
    };
    const result = await invokeAction(
      { store, runtime, state, port: 0, ceiling: {} },
      action,
      envelope,
    );
    const stored = await store.runs.get(result.runId);
    expect(stored?.triggerId).toBe("trg_ABC");
    expect(stored?.firedAt).toBe("2026-04-23T00:00:00.000Z");
  });

  it("finalizes the run with an error record when the runtime throws (no orphans)", async () => {
    const runtime: ActionRuntime = {
      name: "explode",
      async doctor() {
        return { ok: true, details: {} };
      },
      async run() {
        throw new Error("runtime exploded");
      },
    };
    await expect(
      invokeAction(
        { store, runtime, state, port: 0, ceiling: {} },
        action,
        { trigger: null, input: null },
      ),
    ).rejects.toThrow("runtime exploded");

    const runs = await store.runs.list({ actionId: action.id });
    expect(runs).toHaveLength(1);
    const summary = runs[0];
    expect(summary?.exitCode).toBe(-1);
    expect(summary?.finishedAt).toBeDefined();
    const full = await store.runs.get(summary?.id ?? "");
    expect(full?.runtimeRunId).toBeUndefined();
    expect(await store.runs.readStderr(summary?.id ?? "")).toContain(
      "runtime adapter error: runtime exploded",
    );
  });

  it("persists the envelope as input.json", async () => {
    const { runtime } = makeRuntime();
    const envelope: InvokeEnvelope = {
      trigger: null,
      input: { payload: 42 },
    };
    const result = await invokeAction(
      { store, runtime, state, port: 0, ceiling: {} },
      action,
      envelope,
    );
    const savedInput = await store.runs.readInput(result.runId);
    expect(savedInput).toEqual(envelope);
  });

  it("resolves declared secrets from the action's namespace and passes them to the runtime", async () => {
    const secretful = await store.actions.create({
      name: "secretful",
      code: "x",
      namespace: "shop",
      policy: { secrets: ["SHOPIFY_TOKEN", "MISSING_ONE"] },
    });
    await store.secrets.set("shop", "SHOPIFY_TOKEN", "shpat_abc");
    await store.secrets.set("other", "SHOPIFY_TOKEN", "other-ns-value");
    const { runtime, run } = makeRuntime();
    await invokeAction(
      { store, runtime, state, port: 0, ceiling: {} },
      secretful,
      { trigger: null, input: null },
    );
    const runArgs = run.mock.calls[0]?.[0];
    expect(runArgs.secrets).toEqual({ SHOPIFY_TOKEN: "shpat_abc" });
    // Absent secrets are simply omitted — the action handles missing on its own.
    expect(runArgs.secrets.MISSING_ONE).toBeUndefined();
    // No cross-namespace leakage.
    expect(runArgs.secrets.SHOPIFY_TOKEN).not.toBe("other-ns-value");
  });

  it("passes {} secrets when the action declares none", async () => {
    const { runtime, run } = makeRuntime();
    await invokeAction(
      { store, runtime, state, port: 0, ceiling: {} },
      action,
      { trigger: null, input: null },
    );
    expect(run.mock.calls[0]?.[0].secrets).toEqual({});
  });

  it("resolves declared configs and merges them into the env alongside secrets", async () => {
    const cfg = await store.actions.create({
      name: "cfgful",
      code: "x",
      namespace: "shop",
      policy: {
        secrets: ["STRIPE_KEY"],
        configs: ["MONITOR_URL", "THRESHOLD_CENTS"],
      },
    });
    await store.secrets.set("shop", "STRIPE_KEY", "sk_live_xxx");
    await store.configs.set("shop", "MONITOR_URL", "https://example.com");
    await store.configs.set("shop", "THRESHOLD_CENTS", "50000");
    // Cross-namespace decoy that must not leak.
    await store.configs.set("other", "MONITOR_URL", "https://wrong");
    const { runtime, run } = makeRuntime();
    await invokeAction(
      { store, runtime, state, port: 0, ceiling: {} },
      cfg,
      { trigger: null, input: null },
    );
    const runArgs = run.mock.calls[0]?.[0];
    // Configs and secrets share the env channel at the runtime layer.
    expect(runArgs.secrets).toEqual({
      MONITOR_URL: "https://example.com",
      THRESHOLD_CENTS: "50000",
      STRIPE_KEY: "sk_live_xxx",
    });
    // Both sets of names are passed through policy so unitask propagates them.
    expect(runArgs.policy.configs).toEqual([
      "MONITOR_URL",
      "THRESHOLD_CENTS",
    ]);
    expect(runArgs.policy.secrets).toEqual(["STRIPE_KEY"]);
  });

  it("expands $NAME refs in allowNet against the resolved env at invoke time", async () => {
    const a = await store.actions.create({
      name: "dyn",
      code: "x",
      namespace: "shop",
      policy: {
        configs: ["MONITOR_URL", "STATIC_HOST"],
        allowNet: ["api.stripe.com", "$MONITOR_URL", "$STATIC_HOST"],
      },
    });
    await store.configs.set(
      "shop",
      "MONITOR_URL",
      "https://example.com/path?x=1",
    );
    await store.configs.set("shop", "STATIC_HOST", "bare.dev");
    const { runtime, run } = makeRuntime();
    await invokeAction(
      { store, runtime, state, port: 0, ceiling: {} },
      a,
      { trigger: null, input: null },
    );
    const runArgs = run.mock.calls[0]?.[0];
    // Literal hostnames pass through; URL-shaped configs become hostnames;
    // bare hostnames become themselves.
    expect(runArgs.policy.allowNet).toEqual([
      "api.stripe.com",
      "example.com",
      "bare.dev",
    ]);
  });

  it("drops $NAME refs in allowNet when the value is unset or unparseable", async () => {
    const a = await store.actions.create({
      name: "dyn-empty",
      code: "x",
      namespace: "shop",
      policy: {
        configs: ["MONITOR_URL"],
        allowNet: ["slack.com", "$MONITOR_URL", "$NEVER_DEFINED"],
      },
    });
    // MONITOR_URL declared but never set → resolve returns nothing for it.
    const { runtime, run } = makeRuntime();
    await invokeAction(
      { store, runtime, state, port: 0, ceiling: {} },
      a,
      { trigger: null, input: null },
    );
    const runArgs = run.mock.calls[0]?.[0];
    // The literal stays; the unresolved $-refs are dropped silently. The
    // action's fetch will be denied by the proxy — that's the right
    // failure mode (clear error in the action's stderr).
    expect(runArgs.policy.allowNet).toEqual(["slack.com"]);
  });

  it("expands $NAME refs in allowTcp host:port targets", async () => {
    const a = await store.actions.create({
      name: "dyn-tcp",
      code: "x",
      namespace: "shop",
      policy: {
        configs: ["DB_HOST"],
        allowTcp: ["$DB_HOST:5432", "127.0.0.1:6379"],
      },
    });
    await store.configs.set("shop", "DB_HOST", "db.internal");
    const { runtime, run } = makeRuntime();
    await invokeAction(
      { store, runtime, state, port: 0, ceiling: {} },
      a,
      { trigger: null, input: null },
    );
    expect(run.mock.calls[0]?.[0].policy.allowTcp).toEqual([
      "db.internal:5432",
      "127.0.0.1:6379",
    ]);
  });

  it("secrets win over configs of the same name (last-write semantics)", async () => {
    const dup = await store.actions.create({
      name: "dup",
      code: "x",
      namespace: "shop",
      policy: { secrets: ["DUP"], configs: ["DUP"] },
    });
    await store.secrets.set("shop", "DUP", "from-secret");
    await store.configs.set("shop", "DUP", "from-config");
    const { runtime, run } = makeRuntime();
    await invokeAction(
      { store, runtime, state, port: 0, ceiling: {} },
      dup,
      { trigger: null, input: null },
    );
    expect(run.mock.calls[0]?.[0].secrets).toEqual({ DUP: "from-secret" });
  });
});
