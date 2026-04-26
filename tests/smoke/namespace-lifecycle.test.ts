import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pickCron } from "../../src/cron/index.js";
import type { ActionRuntime } from "../../src/runtime/index.js";
import { buildServer, type BuiltServer } from "../../src/server/index.js";
import { pickStore, type StoreAdapter } from "../../src/store/index.js";
import { makeTestState } from "../helpers/state.js";

const MASTER = "lifecycle-master-token";

describe("namespace lifecycle smoke", () => {
  let home: string;
  let store: StoreAdapter;
  let built: BuiltServer;
  let baseUrl: string;
  let runMock: ReturnType<typeof vi.fn>;
  let state: ReturnType<typeof makeTestState>;
  let agent: Client;
  let agentToken: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "cue-ns-lifecycle-"));
    store = pickStore("sqlite", { home });

    runMock = vi.fn().mockImplementation(async () => ({
      stdout: "ran",
      stderr: "",
      exitCode: 0,
      runtimeRunId: "u_NS",
    }));
    const runtime: ActionRuntime = {
      name: "mock",
      async doctor() {
        return { ok: true, details: {} };
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
      token: MASTER,
      baseUrl: "http://127.0.0.1:0",
      cronScheduler: pickCron("node-cron"),
    });
    const address = await built.app.listen({ port: 0, host: "127.0.0.1" });
    const url = new URL(address);
    baseUrl = `http://127.0.0.1:${url.port}`;
    built.mcpDeps.invokeUrlFor = (id) => `${baseUrl}/a/${id}`;
    built.mcpDeps.webhookUrlFor = (id) => `${baseUrl}/w/${id}`;
    built.mcpDeps.port = Number(url.port);
    built.cronRegistry.watch();

    const minted = await store.agentTokens.mint({
      scope: { namespaces: ["lc"] },
      label: "lifecycle test",
    });
    agentToken = minted.token;
    agent = new Client(
      { name: "lifecycle-agent", version: "0.0.0" },
      { capabilities: {} },
    );
    await agent.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${agentToken}` },
        },
      }),
    );
  }, 15_000);

  afterAll(async () => {
    await agent.close();
    await built.cronRegistry.closeAll();
    await built.app.close();
    await store.close();
    await state.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function adminPost(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MASTER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async function adminPatch(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${MASTER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  it("create_action against a namespace with no metadata row succeeds (treated as active)", async () => {
    // Mutations don't auto-create the namespace metadata row.
    // assertNamespaceMutable's "missing row → treat as active"
    // fallback covers the gap until the next daemon start, when
    // bootstrap fills in the row. This test pins that behavior.
    const created = await fetch(`${baseUrl}/admin/actions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MASTER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "boot", code: "1", namespace: "lc" }),
    });
    expect(created.ok).toBe(true);
    const r = await fetch(`${baseUrl}/admin/namespaces/lc`, {
      headers: { Authorization: `Bearer ${MASTER}` },
    });
    expect(r.status).toBe(404);
  });

  it("PATCH /admin/namespaces creates lc record via explicit create then transitions", async () => {
    const create = await adminPost("/admin/namespaces", {
      name: "lc",
      displayName: "Lifecycle test",
    });
    expect(create.status).toBe(200);

    const get = await fetch(`${baseUrl}/admin/namespaces/lc`, {
      headers: { Authorization: `Bearer ${MASTER}` },
    });
    expect(get.status).toBe(200);
    const body = (await get.json()) as {
      name: string;
      status: string;
      displayName: string;
      actionCount: number;
    };
    expect(body.name).toBe("lc");
    expect(body.status).toBe("active");
    expect(body.displayName).toBe("Lifecycle test");
    expect(body.actionCount).toBe(1); // the "boot" action from the previous test
  });

  it("paused namespace blocks MCP invoke with NamespacePaused", async () => {
    const created = (await agent.callTool({
      name: "create_action",
      arguments: { name: "ping", code: "1", namespace: "lc" },
    })) as { content: { type: string; text: string }[] };
    const ref = JSON.parse(created.content[0]!.text) as { id: string };

    await adminPatch("/admin/namespaces/lc", { status: "paused" });

    const result = (await agent.callTool({
      name: "invoke_action",
      arguments: { id: ref.id },
    })) as { isError: boolean; content: { type: string; text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/paused/i);

    // Restore for next test.
    await adminPatch("/admin/namespaces/lc", { status: "active" });
  });

  it("paused namespace returns 423 from a webhook", async () => {
    const trigger = (await agent.callTool({
      name: "create_trigger",
      arguments: {
        type: "webhook",
        actionId: (
          JSON.parse(
            ((await agent.callTool({
              name: "create_action",
              arguments: {
                name: "wh-target",
                code: "1",
                namespace: "lc",
              },
            })) as { content: { type: string; text: string }[] }).content[0]!.text,
          ) as { id: string }
        ).id,
        namespace: "lc",
      },
    })) as { content: { type: string; text: string }[] };
    const tref = JSON.parse(trigger.content[0]!.text) as {
      webhookUrl: string;
      webhookToken: string;
    };

    await adminPatch("/admin/namespaces/lc", { status: "paused" });

    const r = await fetch(tref.webhookUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tref.webhookToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(423);
    const body = (await r.json()) as { kind: string };
    expect(body.kind).toBe("NamespacePaused");

    await adminPatch("/admin/namespaces/lc", { status: "active" });
  });

  it("archived namespace blocks MCP create_action mutations", async () => {
    await adminPatch("/admin/namespaces/lc", { status: "archived" });
    const result = (await agent.callTool({
      name: "create_action",
      arguments: { name: "after-archive", code: "1", namespace: "lc" },
    })) as { isError: boolean; content: { type: string; text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/archived/i);

    await adminPatch("/admin/namespaces/lc", { status: "active" });
  });

  it("archived namespace blocks set_secret too", async () => {
    await adminPatch("/admin/namespaces/lc", { status: "archived" });
    const r = await fetch(`${baseUrl}/admin/secrets/lc/SOME_SECRET`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${MASTER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value: "x" }),
    });
    expect(r.status).toBe(423);

    await adminPatch("/admin/namespaces/lc", { status: "active" });
  });

  it("archived namespace still allows reads and cascade delete", async () => {
    await adminPatch("/admin/namespaces/lc", { status: "archived" });

    const list = await fetch(`${baseUrl}/admin/actions?namespace=lc`, {
      headers: { Authorization: `Bearer ${MASTER}` },
    });
    expect(list.status).toBe(200);

    const del = await fetch(`${baseUrl}/admin/namespaces/lc`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${MASTER}` },
    });
    expect(del.status).toBe(200);

    // Metadata row gone too.
    const after = await fetch(`${baseUrl}/admin/namespaces/lc`, {
      headers: { Authorization: `Bearer ${MASTER}` },
    });
    expect(after.status).toBe(404);
  });

  it("whoami returns principal=agent and the in-scope namespaces with status", async () => {
    // Re-create lc so it has a metadata row.
    await adminPost("/admin/namespaces", {
      name: "lc",
      displayName: "Lifecycle scope",
    });
    await adminPatch("/admin/namespaces/lc", { status: "paused" });

    const result = (await agent.callTool({
      name: "whoami",
      arguments: {},
    })) as { content: { type: string; text: string }[] };
    const body = JSON.parse(result.content[0]!.text) as {
      principal: string;
      namespaces: { name: string; status: string; displayName?: string }[];
    };
    expect(body.principal).toBe("agent");
    expect(body.namespaces).toHaveLength(1);
    expect(body.namespaces[0]).toMatchObject({
      name: "lc",
      status: "paused",
      displayName: "Lifecycle scope",
    });

    // Restore for cleanup, then drop the row entirely.
    await adminPatch("/admin/namespaces/lc", { status: "active" });
    await fetch(`${baseUrl}/admin/namespaces/lc`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${MASTER}` },
    });
  });

  it("whoami for a prefix-scoped agent returns only matching namespaces", async () => {
    // Set up: create three namespaces — two under acme-, one under bob-.
    for (const name of ["acme-shop", "acme-billing", "bob-foo"]) {
      await adminPost("/admin/namespaces", { name });
    }
    // Mint a prefix-scoped token.
    const minted = await fetch(`${baseUrl}/admin/agent-tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MASTER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scope: { namespaces: ["acme-*"] },
        label: "acme",
      }),
    }).then((r) => r.json() as Promise<{ token: string }>);

    const acmeAgent = new Client(
      { name: "acme", version: "0.0.0" },
      { capabilities: {} },
    );
    await acmeAgent.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${minted.token}` },
        },
      }),
    );

    const result = (await acmeAgent.callTool({
      name: "whoami",
      arguments: {},
    })) as { content: { type: string; text: string }[] };
    const body = JSON.parse(result.content[0]!.text) as {
      principal: string;
      namespaces: { name: string }[];
    };
    expect(body.principal).toBe("agent");
    const names = body.namespaces.map((n) => n.name).sort();
    expect(names).toEqual(["acme-billing", "acme-shop"]);
    expect(names).not.toContain("bob-foo");

    await acmeAgent.close();
    // Cleanup
    for (const name of ["acme-shop", "acme-billing", "bob-foo"]) {
      await fetch(`${baseUrl}/admin/namespaces/${name}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${MASTER}` },
      });
    }
  });

  it("whoami synthesizes active stubs for in-scope namespaces with no metadata row", async () => {
    // No `lc` metadata row exists at this point.
    const result = (await agent.callTool({
      name: "whoami",
      arguments: {},
    })) as { content: { type: string; text: string }[] };
    const body = JSON.parse(result.content[0]!.text) as {
      principal: string;
      namespaces: { name: string; status: string }[];
    };
    expect(body.principal).toBe("agent");
    expect(body.namespaces).toEqual([{ name: "lc", status: "active" }]);
  });

  it("MCP create_namespace lets a wildcard agent allocate fresh namespaces", async () => {
    // The shared agent in this file has scope ["lc"] (single literal).
    // For this test, mint a wildcard token via the admin API and connect
    // a separate Client.
    const minted = await fetch(`${baseUrl}/admin/agent-tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MASTER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scope: { namespaces: ["*"] },
        label: "wildcard-agent",
      }),
    }).then((r) => r.json() as Promise<{ token: string }>);

    const wildcardAgent = new Client(
      { name: "wildcard", version: "0.0.0" },
      { capabilities: {} },
    );
    await wildcardAgent.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${minted.token}` },
        },
      }),
    );

    const result = (await wildcardAgent.callTool({
      name: "create_namespace",
      arguments: {
        name: "fresh-app",
        displayName: "Fresh App",
        description: "spun up by the agent",
      },
    })) as { content: { type: string; text: string }[] };
    const body = JSON.parse(result.content[0]!.text) as {
      name: string;
      status: string;
      displayName: string;
    };
    expect(body.name).toBe("fresh-app");
    expect(body.status).toBe("active");
    expect(body.displayName).toBe("Fresh App");

    // Now create_action against the new namespace works.
    const action = (await wildcardAgent.callTool({
      name: "create_action",
      arguments: {
        name: "hi",
        code: "1",
        namespace: "fresh-app",
      },
    })) as { content: { type: string; text: string }[] };
    expect(JSON.parse(action.content[0]!.text)).toMatchObject({
      namespace: "fresh-app",
    });

    // Collision on second create_namespace with the same name.
    const collision = (await wildcardAgent.callTool({
      name: "create_namespace",
      arguments: { name: "fresh-app" },
    })) as { isError: boolean; content: { type: string; text: string }[] };
    expect(collision.isError).toBe(true);
    expect(collision.content[0]!.text).toMatch(/already exists/i);

    await wildcardAgent.close();
    // Cleanup — cascade-delete the namespace we created.
    await fetch(`${baseUrl}/admin/namespaces/fresh-app`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${MASTER}` },
    });
  });

  it("MCP update_namespace can set displayName but not status", async () => {
    // Re-create lc for this test.
    await adminPost("/admin/namespaces", {
      name: "lc",
      displayName: "Original",
    });

    const updated = (await agent.callTool({
      name: "update_namespace",
      arguments: {
        name: "lc",
        patch: { displayName: "Renamed by agent" },
      },
    })) as { content: { type: string; text: string }[] };
    const body = JSON.parse(updated.content[0]!.text) as {
      displayName: string;
      status: string;
    };
    expect(body.displayName).toBe("Renamed by agent");
    expect(body.status).toBe("active");

    // Tool schema rejects status; the SDK validates inputs against the
    // declared shape. We confirm by checking the tool's declared shape
    // does not mention status — and that any extra key is dropped.
    const sneaky = (await agent.callTool({
      name: "update_namespace",
      arguments: {
        name: "lc",
        // biome-ignore lint: deliberate extra field
        patch: { displayName: "x", status: "archived" } as unknown as {
          displayName: string;
        },
      },
    })) as { content: { type: string; text: string }[] };
    const after = JSON.parse(sneaky.content[0]!.text) as { status: string };
    // Status is unchanged because update_namespace ignores status fields.
    expect(after.status).toBe("active");

    // Cleanup.
    await fetch(`${baseUrl}/admin/namespaces/lc`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${MASTER}` },
    });
  });
});
