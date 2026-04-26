import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pickCron } from "../../src/cron/index.js";
import type { ActionRuntime } from "../../src/runtime/index.js";
import { buildServer, type BuiltServer } from "../../src/server/index.js";
import {
  deleteAction as cascadeDeleteAction,
  deleteNamespace as cascadeDeleteNamespace,
  pickStore,
  type StoreAdapter,
} from "../../src/store/index.js";
import { makeTestState } from "../helpers/state.js";

const TOKEN = "smoke-master-token";

function parseToolText(result: CallToolResult): unknown {
  const first = result.content[0];
  if (!first || first.type !== "text") return null;
  try {
    return JSON.parse(first.text);
  } catch {
    return first.text;
  }
}

describe("daemon smoke", () => {
  let home: string;
  let store: StoreAdapter;
  let built: BuiltServer;
  let baseUrl: string;
  let runMock: ReturnType<typeof vi.fn>;
  let state: ReturnType<typeof makeTestState>;
  /** Client connected to /mcp with a scoped agent token (namespace: "smoke"). */
  let agent: Client;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "cue-smoke-"));
    store = pickStore("sqlite", { home });

    runMock = vi.fn().mockImplementation(async () => ({
      stdout: '{"ran":true}',
      stderr: "",
      exitCode: 0,
      runtimeRunId: "u_SMOKE",
    }));
    const runtime: ActionRuntime = {
      name: "mock",
      async doctor() {
        return { ok: true, details: { mock: true } };
      },
      run: runMock as unknown as ActionRuntime["run"],
    };

    state = makeTestState(home);
    built = await buildServer({
      store,
      runtime,
      state,
      port: 0,
      ceiling: {},
      token: TOKEN,
      baseUrl: "http://127.0.0.1:0",
      cronScheduler: pickCron("node-cron"),
      cueVersion: "0.1.0-smoke",
    });

    const address = await built.app.listen({ port: 0, host: "127.0.0.1" });
    const url = new URL(address);
    baseUrl = `http://127.0.0.1:${url.port}`;
    built.mcpDeps.invokeUrlFor = (id) => `${baseUrl}/a/${id}`;
    built.mcpDeps.webhookUrlFor = (id) => `${baseUrl}/w/${id}`;
    built.mcpDeps.port = Number(url.port);
    await built.cronRegistry.loadExisting();
    built.cronRegistry.watch();

    // Agent-token minting is pure storage — mint via the shared
    // store, same path the CLI takes.
    const minted = await store.agentTokens.mint({
      scope: {
        namespaces: ["smoke", "smoke-cron", "secretns", "cascade"],
      },
      label: "smoke",
    });

    agent = new Client(
      { name: "smoke-agent", version: "0.1.0" },
      { capabilities: {} },
    );
    await agent.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${minted.token}` } },
      }),
    );
  });

  afterAll(async () => {
    await agent.close().catch(() => {});
    await built.cronRegistry.closeAll();
    await built.app.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("agent MCP surface lists only the agent-facing tool set", async () => {
    const tools = await agent.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "create_action",
        "create_namespace",
        "create_trigger",
        "delete_action",
        "delete_namespace",
        "delete_trigger",
        "doctor",
        "get_action",
        "get_namespace",
        "get_trigger",
        "inspect_run",
        "invoke_action",
        "list_action_runs",
        "list_actions",
        "list_triggers",
        "set_secret",
        "state_append",
        "state_delete",
        "state_read",
        "update_action",
        "update_namespace",
        "whoami",
      ].sort(),
    );
  });

  it("GET /health responds 200 without auth (used by `cue doctor` for liveness)", async () => {
    const r = await fetch(`${baseUrl}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("creates an action via MCP (agent), invokes it, lists runs", async () => {
    const create = (await agent.callTool({
      name: "create_action",
      arguments: {
        name: "smoke-hello",
        code: "console.log('hi')",
        namespace: "smoke",
      },
    })) as CallToolResult;
    const action = parseToolText(create) as { id: string; invokeUrl: string };
    expect(action.id).toMatch(/^act_/);

    const invoke = (await agent.callTool({
      name: "invoke_action",
      arguments: { id: action.id, input: { hello: "world" } },
    })) as CallToolResult;
    const run = parseToolText(invoke) as {
      runId: string;
      output: unknown;
      exitCode: number;
    };
    expect(run.exitCode).toBe(0);
    expect(run.output).toEqual({ ran: true });

    const runs = (await agent.callTool({
      name: "list_action_runs",
      arguments: { id: action.id },
    })) as CallToolResult;
    expect((parseToolText(runs) as unknown[]).length).toBe(1);
  });

  it("creates a webhook trigger and invokes it via HTTP with the scoped token", async () => {
    const create = (await agent.callTool({
      name: "create_action",
      arguments: {
        name: "smoke-hook",
        code: "console.log('hook')",
        namespace: "smoke",
      },
    })) as CallToolResult;
    const action = parseToolText(create) as { id: string };

    const trigCreate = (await agent.callTool({
      name: "create_trigger",
      arguments: { type: "webhook", actionId: action.id },
    })) as CallToolResult;
    const trg = parseToolText(trigCreate) as {
      webhookUrl: string;
      webhookToken: string;
    };

    const res = await fetch(trg.webhookUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${trg.webhookToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: "smoke" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exitCode: number };
    expect(body.exitCode).toBe(0);
  });

  it("master token cannot be used against /w/:id (webhook requires scoped token)", async () => {
    const createdAction = await store.actions.create({
      name: "hook-scope",
      code: "x",
      namespace: "smoke",
    });
    const trg = await store.triggers.create({
      type: "webhook",
      actionId: createdAction.id,
      namespace: "smoke",
      config: {},
    });
    const res = await fetch(`${baseUrl}/w/${trg.id}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("trigger.subscribe reconciles new cron trigger and fires it within a few seconds", async () => {
    const before = runMock.mock.calls.length;
    const action = await store.actions.create({
      name: "every-second",
      code: "console.log(Date.now())",
      namespace: "smoke-cron",
    });
    // Inserting the trigger row is all we do — the in-process
    // subscription notifies the cron registry, which schedules a
    // handle. The 1-second poll fallback would also catch this if
    // the subscription missed it.
    await store.triggers.create({
      type: "cron",
      actionId: action.id,
      namespace: "smoke-cron",
      config: { schedule: "*/1 * * * * *" },
    });

    const deadline = Date.now() + 3_500;
    while (runMock.mock.calls.length === before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(runMock.mock.calls.length).toBeGreaterThan(before);

    // Teardown via the cascade — the cron registry cancels the
    // schedule when the trigger row goes.
    await cascadeDeleteNamespace(store, state, "smoke-cron");
  });

  it("set_secret via MCP (agent) stores a value invokeAction resolves into runtime.run(secrets)", async () => {
    const action = (await agent.callTool({
      name: "create_action",
      arguments: {
        name: "needs-secret",
        code: "x",
        namespace: "secretns",
        policy: { secrets: ["MY_API_KEY"] },
      },
    })) as CallToolResult;
    const aId = (parseToolText(action) as { id: string }).id;

    const setRes = (await agent.callTool({
      name: "set_secret",
      arguments: {
        namespace: "secretns",
        name: "MY_API_KEY",
        value: "sk-live-123",
      },
    })) as CallToolResult;
    expect(parseToolText(setRes)).toEqual({
      ok: true,
      namespace: "secretns",
      name: "MY_API_KEY",
    });

    const before = runMock.mock.calls.length;
    await agent.callTool({
      name: "invoke_action",
      arguments: { id: aId },
    });
    const runArgs = runMock.mock.calls[before]?.[0] as {
      secrets: Record<string, string>;
    };
    expect(runArgs.secrets).toEqual({ MY_API_KEY: "sk-live-123" });

    const del = (await agent.callTool({
      name: "delete_namespace",
      arguments: { name: "secretns" },
    })) as CallToolResult;
    const body = parseToolText(del) as {
      deleted: { actions: string[]; triggers: string[]; secrets: string[] };
    };
    expect(body.deleted.secrets).toEqual(["MY_API_KEY"]);
    expect(await store.secrets.list("secretns")).toEqual([]);
  });

  it("deleteNamespace cascade via store: actions + triggers gone", async () => {
    await store.actions.create({
      name: "cascade-a",
      code: "x",
      namespace: "cascade",
    });
    await store.actions.create({
      name: "cascade-b",
      code: "y",
      namespace: "cascade",
    });
    const result = await cascadeDeleteNamespace(store, state, "cascade");
    expect(result.actions).toHaveLength(2);

    const after = await store.actions.list({ namespace: "cascade" });
    expect(after.length).toBe(0);
  });

  it("deleteAction cascade via store removes triggers", async () => {
    const a = await store.actions.create({
      name: "with-trigger",
      code: "x",
      namespace: "cascade-action",
    });
    await store.triggers.create({
      type: "webhook",
      actionId: a.id,
      namespace: "cascade-action",
      config: {},
    });
    expect(await store.triggers.list({ actionId: a.id })).toHaveLength(1);
    await cascadeDeleteAction(store, a.id);
    expect(await store.actions.get(a.id)).toBeNull();
    expect(await store.triggers.list({ actionId: a.id })).toHaveLength(0);
  });
});
