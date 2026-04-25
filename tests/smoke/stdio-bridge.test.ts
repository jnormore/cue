import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pickCron } from "../../src/cron/index.js";
import type { ActionRuntime } from "../../src/runtime/index.js";
import { buildServer, type BuiltServer } from "../../src/server/index.js";
import { pickStore, type StoreAdapter } from "../../src/store/index.js";
import { makeTestState } from "../helpers/state.js";

const TOKEN = "stdio-smoke-token";
const CUE_BIN = resolve(__dirname, "../../dist/index.js");

describe("stdio↔HTTP MCP bridge smoke", () => {
  let home: string;
  let built: BuiltServer;
  let store: StoreAdapter;
  let port: number;
  let client: Client;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "cue-stdio-smoke-"));
    store = pickStore("sqlite", { home });
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
      token: TOKEN,
      baseUrl: "http://127.0.0.1:0",
      cronScheduler: pickCron("node-cron"),
      cueVersion: "0.1.0-smoke",
    });

    const address = await built.app.listen({ port: 0, host: "127.0.0.1" });
    const url = new URL(address);
    port = Number(url.port);
    built.mcpDeps.port = port;

    // Write token + port in the format cue mcp bridge expects.
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "token"), TOKEN, { mode: 0o600 });
    chmodSync(join(home, "token"), 0o600);
    writeFileSync(join(home, "port"), `${port}\n`);

    // Mint a scoped agent token via the shared store (same path the
    // CLI takes) and pass it to the stdio bridge via --token. /mcp
    // doesn't accept master, so the bridge must carry an agent token.
    const minted = await store.agentTokens.mint({
      scope: { namespaces: ["bridge"] },
      label: "stdio-smoke",
    });

    client = new Client(
      { name: "stdio-smoke", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CUE_BIN, "mcp", "--token", minted.token],
        env: { ...process.env, CUE_HOME: home },
      }),
    );
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await built.cronRegistry.closeAll();
    await built.app.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("forwards tools/list through the stdio bridge", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("doctor");
    expect(names).toContain("create_action");
    expect(names).toContain("invoke_action");
  });

  it("forwards tools/call through the stdio bridge", async () => {
    const result = (await client.callTool({
      name: "create_action",
      arguments: {
        name: "bridged",
        code: "console.log('x')",
        namespace: "bridge",
      },
    })) as CallToolResult;
    const first = result.content[0];
    expect(first?.type).toBe("text");
    const parsed = JSON.parse(
      first && first.type === "text" ? first.text : "{}",
    );
    expect(parsed.id).toMatch(/^act_/);
    expect(parsed.namespace).toBe("bridge");
  });
});
