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
import { pickStore, type StoreAdapter } from "../../src/store/index.js";
import { makeTestState } from "../helpers/state.js";

const MASTER = "smoke-master-token";

function parseToolText(result: CallToolResult): unknown {
  const first = result.content[0];
  if (!first || first.type !== "text") return null;
  try {
    return JSON.parse(first.text);
  } catch {
    return first.text;
  }
}

async function connectAgent(baseUrl: string, token: string): Promise<Client> {
  const client = new Client(
    { name: "scope-smoke", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

describe("agent-token scope enforcement", () => {
  let home: string;
  let store: StoreAdapter;
  let built: BuiltServer;
  let baseUrl: string;

  let shopActionId: string;
  let weatherActionId: string;
  let shopToken: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "cue-scope-smoke-"));
    store = pickStore("fs", { home });

    const runtime: ActionRuntime = {
      name: "mock",
      async doctor() {
        return { ok: true, details: {} };
      },
      run: vi.fn().mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
        runtimeRunId: "u_SMOKE",
      }) as unknown as ActionRuntime["run"],
    };

    built = await buildServer({
      store,
      runtime,
      state: makeTestState(home),
      port: 0,
      ceiling: {},
      token: MASTER,
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

    // Actions + agent tokens are pure storage → seed via the store
    // adapter directly (same path as the CLI).
    const shop = await store.actions.create({
      name: "shop-tick",
      code: "console.log('shop')",
      namespace: "shop",
    });
    shopActionId = shop.id;

    const weather = await store.actions.create({
      name: "weather-tick",
      code: "console.log('w')",
      namespace: "weather",
    });
    weatherActionId = weather.id;

    const minted = await store.agentTokens.mint({
      scope: { namespaces: ["shop"] },
      label: "scope-test",
    });
    shopToken = minted.token;
  });

  afterAll(async () => {
    await built.cronRegistry.closeAll();
    await built.app.close();
    rmSync(home, { recursive: true, force: true });
  });

  describe("/mcp never accepts the master token", () => {
    it("master presented at /mcp → 401 with guidance", async () => {
      const r = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${MASTER}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(r.status).toBe(401);
      const body = (await r.json()) as { error: string };
      expect(body.error).toMatch(/master token is not accepted on \/mcp/i);
    });
  });

  describe("no /admin surface exists", () => {
    it("every /admin/* path 404s (routes were removed)", async () => {
      for (const path of [
        "/admin/doctor",
        "/admin/agent-tokens",
        "/admin/actions",
        "/admin/triggers",
        "/admin/namespaces/shop",
      ]) {
        const r = await fetch(`${baseUrl}${path}`, {
          headers: { authorization: `Bearer ${MASTER}` },
        });
        expect(r.status).toBe(404);
      }
    });
  });

  describe("MCP surface — agent with scope:[shop]", () => {
    let agent: Client;

    beforeAll(async () => {
      agent = await connectAgent(baseUrl, shopToken);
    });

    afterAll(async () => {
      await agent.close().catch(() => {});
    });

    it("agent cannot call create_agent_token — tool not exposed on /mcp", async () => {
      const tools = await agent.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).not.toContain("create_agent_token");
      expect(names).not.toContain("list_agent_tokens");
      expect(names).not.toContain("delete_agent_token");
    });

    it("list_actions returns only in-scope actions when unfiltered", async () => {
      const r = (await agent.callTool({
        name: "list_actions",
        arguments: {},
      })) as CallToolResult;
      const items = parseToolText(r) as Array<{ namespace: string }>;
      expect(items.every((a) => a.namespace === "shop")).toBe(true);
      expect(items.length).toBeGreaterThan(0);
    });

    it("list_actions({namespace: 'weather'}) returns [] (silent filter)", async () => {
      const r = (await agent.callTool({
        name: "list_actions",
        arguments: { namespace: "weather" },
      })) as CallToolResult;
      expect(parseToolText(r)).toEqual([]);
    });

    it("get_action on an out-of-scope action returns NotFound", async () => {
      const r = (await agent.callTool({
        name: "get_action",
        arguments: { id: weatherActionId },
      })) as CallToolResult;
      expect(r.isError).toBe(true);
      const body = parseToolText(r) as { kind: string };
      expect(body.kind).toBe("NotFound");
    });

    it("invoke on an out-of-scope action returns NotFound (hides existence)", async () => {
      const r = (await agent.callTool({
        name: "invoke_action",
        arguments: { id: weatherActionId },
      })) as CallToolResult;
      expect(r.isError).toBe(true);
      const body = parseToolText(r) as { kind: string };
      expect(body.kind).toBe("NotFound");
    });

    it("get_action on an in-scope action succeeds", async () => {
      const r = (await agent.callTool({
        name: "get_action",
        arguments: { id: shopActionId },
      })) as CallToolResult;
      expect(r.isError).toBeFalsy();
      const body = parseToolText(r) as { namespace: string };
      expect(body.namespace).toBe("shop");
    });

    it("create_action in an out-of-scope namespace returns Forbidden", async () => {
      const r = (await agent.callTool({
        name: "create_action",
        arguments: { name: "sneaky", code: "x", namespace: "weather" },
      })) as CallToolResult;
      expect(r.isError).toBe(true);
      const body = parseToolText(r) as { kind: string };
      expect(body.kind).toBe("Forbidden");
    });

    it("set_secret out of scope → Forbidden", async () => {
      const r = (await agent.callTool({
        name: "set_secret",
        arguments: { namespace: "weather", name: "X", value: "y" },
      })) as CallToolResult;
      expect(r.isError).toBe(true);
      const body = parseToolText(r) as { kind: string };
      expect(body.kind).toBe("Forbidden");
    });

    it("state_append in scope works", async () => {
      const r = (await agent.callTool({
        name: "state_append",
        arguments: { namespace: "shop", key: "events", entry: { v: 1 } },
      })) as CallToolResult;
      expect(r.isError).toBeFalsy();
      const body = parseToolText(r) as { seq: number };
      expect(body.seq).toBeGreaterThan(0);
    });

    it("state_read out of scope → Forbidden", async () => {
      const r = (await agent.callTool({
        name: "state_read",
        arguments: { namespace: "weather", key: "events" },
      })) as CallToolResult;
      expect(r.isError).toBe(true);
      const body = parseToolText(r) as { kind: string };
      expect(body.kind).toBe("Forbidden");
    });

    it("delete_namespace out of scope → Forbidden", async () => {
      const r = (await agent.callTool({
        name: "delete_namespace",
        arguments: { name: "weather" },
      })) as CallToolResult;
      expect(r.isError).toBe(true);
      const body = parseToolText(r) as { kind: string };
      expect(body.kind).toBe("Forbidden");
    });
  });

  describe("HTTP /a/:id surface", () => {
    it("agent token can invoke in-scope action", async () => {
      const r = await fetch(`${baseUrl}/a/${shopActionId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${shopToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(r.status).toBe(200);
    });

    it("agent token hitting out-of-scope action gets 404 (hides existence)", async () => {
      const r = await fetch(`${baseUrl}/a/${weatherActionId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${shopToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(r.status).toBe(404);
    });
  });

  describe("HTTP /state/:ns/:key surface", () => {
    it("agent token can read/write in-scope state", async () => {
      const appendR = await fetch(`${baseUrl}/state/shop/api-log/append`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${shopToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ entry: { v: 1 } }),
      });
      expect(appendR.status).toBe(200);
    });

    it("agent token hitting out-of-scope state gets 403", async () => {
      const r = await fetch(`${baseUrl}/state/weather/x/append`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${shopToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ entry: 1 }),
      });
      expect(r.status).toBe(403);
    });
  });

  describe("revocation", () => {
    it("deleting an agent token via the store invalidates it immediately", async () => {
      const minted = await store.agentTokens.mint({
        scope: { namespaces: ["shop"] },
      });

      const before = await fetch(`${baseUrl}/a/${shopActionId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${minted.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(before.status).toBe(200);

      await store.agentTokens.delete(minted.id);

      const after = await fetch(`${baseUrl}/a/${shopActionId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${minted.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(after.status).toBe(401);
    });
  });
});
