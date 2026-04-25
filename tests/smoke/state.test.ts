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
import { deleteNamespace as cascadeDeleteNamespace } from "../../src/store/index.js";
import { makeTestState } from "../helpers/state.js";

const TOKEN = "smoke-state-master";

function parseToolText(result: CallToolResult): unknown {
  const first = result.content[0];
  if (!first || first.type !== "text") return null;
  try {
    return JSON.parse(first.text);
  } catch {
    return first.text;
  }
}

describe("state smoke", () => {
  let home: string;
  let store: StoreAdapter;
  let built: BuiltServer;
  let baseUrl: string;
  let agent: Client;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "cue-state-smoke-"));
    store = pickStore("sqlite", { home });

    const runtime: ActionRuntime = {
      name: "mock",
      async doctor() {
        return { ok: true, details: { mock: true } };
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

    const minted = await store.agentTokens.mint({
      scope: { namespaces: ["shop", "mcp-ns", "only-self", "gone"] },
      label: "state-smoke",
    });
    agent = new Client(
      { name: "state-smoke", version: "0.1.0" },
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

  describe("HTTP routes with master token", () => {
    it("append → read roundtrip", async () => {
      const appendRes = await fetch(`${baseUrl}/state/shop/orders/append`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ entry: { total: 99 } }),
      });
      expect(appendRes.status).toBe(200);
      const appendBody = (await appendRes.json()) as {
        seq: number;
        at: string;
      };
      expect(appendBody.seq).toBe(1);

      const readRes = await fetch(`${baseUrl}/state/shop/orders`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(readRes.status).toBe(200);
      const readBody = (await readRes.json()) as {
        entries: Array<{ seq: number; entry: unknown }>;
        lastSeq: number;
      };
      expect(readBody.entries).toHaveLength(1);
      expect(readBody.entries[0]?.entry).toEqual({ total: 99 });
      expect(readBody.lastSeq).toBe(1);
    });

    it("since cursor filters entries", async () => {
      await fetch(`${baseUrl}/state/shop/since-key/append`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ entry: "a" }),
      });
      await fetch(`${baseUrl}/state/shop/since-key/append`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ entry: "b" }),
      });
      const r = await fetch(
        `${baseUrl}/state/shop/since-key?since=1`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      const body = (await r.json()) as {
        entries: Array<{ seq: number }>;
        lastSeq: number;
      };
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]?.seq).toBe(2);
      expect(body.lastSeq).toBe(2);
    });

    it("rejects missing bearer", async () => {
      const r = await fetch(`${baseUrl}/state/shop/orders`, {});
      expect(r.status).toBe(401);
    });

    it("rejects wrong bearer", async () => {
      const r = await fetch(`${baseUrl}/state/shop/orders`, {
        headers: { authorization: "Bearer wrong" },
      });
      expect(r.status).toBe(401);
    });
  });

  describe("scoped state tokens", () => {
    it("grant access only to their own namespace", async () => {
      const selfToken = await built.mcpDeps.state.tokens.resolveOrCreate(
        "only-self",
      );
      const ok = await fetch(`${baseUrl}/state/only-self/k/append`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${selfToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ entry: "hi" }),
      });
      expect(ok.status).toBe(200);

      const bad = await fetch(`${baseUrl}/state/shop/k/append`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${selfToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ entry: "hi" }),
      });
      expect(bad.status).toBe(403);
    });
  });

  describe("MCP tools (agent)", () => {
    it("state_append / state_read / state_delete work end-to-end", async () => {
      const append = (await agent.callTool({
        name: "state_append",
        arguments: {
          namespace: "mcp-ns",
          key: "events",
          entry: { v: 1 },
        },
      })) as CallToolResult;
      const a = parseToolText(append) as { seq: number };
      expect(a.seq).toBe(1);

      const read = (await agent.callTool({
        name: "state_read",
        arguments: { namespace: "mcp-ns", key: "events" },
      })) as CallToolResult;
      const r = parseToolText(read) as {
        entries: Array<{ entry: unknown }>;
      };
      expect(r.entries).toHaveLength(1);
      expect(r.entries[0]?.entry).toEqual({ v: 1 });

      const del = (await agent.callTool({
        name: "state_delete",
        arguments: { namespace: "mcp-ns", key: "events" },
      })) as CallToolResult;
      expect(parseToolText(del)).toEqual({
        ok: true,
        namespace: "mcp-ns",
        key: "events",
      });
    });
  });

  describe("namespace teardown via store cascade", () => {
    it("cascadeDeleteNamespace wipes log keys + state tokens", async () => {
      await fetch(`${baseUrl}/state/gone/x/append`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ entry: 1 }),
      });
      const stateTok = await built.mcpDeps.state.tokens.resolveOrCreate("gone");
      expect(await built.mcpDeps.state.tokens.verify(stateTok)).toBe("gone");

      const result = await cascadeDeleteNamespace(
        store,
        built.mcpDeps.state,
        "gone",
      );
      expect(result.stateKeys).toEqual(["x"]);
      expect(await built.mcpDeps.state.tokens.verify(stateTok)).toBeNull();
      expect(await built.mcpDeps.state.log.list("gone")).toEqual([]);
    });
  });
});
