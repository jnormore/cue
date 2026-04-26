import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pickCron } from "../../src/cron/index.js";
import type { ActionRuntime } from "../../src/runtime/index.js";
import { buildServer, type BuiltServer } from "../../src/server/index.js";
import { pickStore, type StoreAdapter } from "../../src/store/index.js";
import { makeTestState } from "../helpers/state.js";

const MASTER = "art-smoke-master";

describe("artifacts smoke", () => {
  let home: string;
  let store: StoreAdapter;
  let built: BuiltServer;
  let baseUrl: string;
  let state: ReturnType<typeof makeTestState>;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "cue-art-smoke-"));
    store = pickStore("sqlite", { home });
    const runtime: ActionRuntime = {
      name: "mock",
      async doctor() {
        return { ok: true, details: {} };
      },
      run: vi.fn() as unknown as ActionRuntime["run"],
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

    // The /admin routes need a namespace metadata row before mutations
    // pass the lifecycle gate — bootstrap on cold start handles
    // existing namespaces, but for a fresh test home we create one.
    await fetch(`${baseUrl}/admin/namespaces`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MASTER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "demo" }),
    });
  }, 15_000);

  afterAll(async () => {
    await built.cronRegistry.closeAll();
    await built.app.close();
    await store.close();
    await state.close();
    rmSync(home, { recursive: true, force: true });
  });

  // helpers
  const adminPost = (body: unknown) =>
    fetch(`${baseUrl}/admin/namespaces/demo`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${MASTER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  it("create_artifact via store + GET /u/demo/index.html serves the bytes", async () => {
    await store.artifacts.create({
      namespace: "demo",
      path: "index.html",
      content: "<h1>hi</h1>",
    });
    const r = await fetch(`${baseUrl}/u/demo/index.html`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await r.text()).toBe("<h1>hi</h1>");
  });

  it("nested path resolves through /u/:ns/* ", async () => {
    await store.artifacts.create({
      namespace: "demo",
      path: "js/app.js",
      content: "console.log('ok')",
    });
    const r = await fetch(`${baseUrl}/u/demo/js/app.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/javascript");
    expect(await r.text()).toBe("console.log('ok')");
  });

  it("non-public artifact requires ?t=<viewToken>", async () => {
    const rec = await store.artifacts.create({
      namespace: "demo",
      path: "secret.html",
      content: "<h1>private</h1>",
      public: false,
    });
    expect(rec.viewToken).toMatch(/^art_/);

    const noAuth = await fetch(`${baseUrl}/u/demo/secret.html`);
    expect(noAuth.status).toBe(401);

    const wrongToken = await fetch(`${baseUrl}/u/demo/secret.html?t=art_wrong`);
    expect(wrongToken.status).toBe(401);

    const ok = await fetch(`${baseUrl}/u/demo/secret.html?t=${rec.viewToken}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("<h1>private</h1>");
  });

  it("master token works on non-public artifacts (operator preview)", async () => {
    const r = await fetch(`${baseUrl}/u/demo/secret.html`, {
      headers: { Authorization: `Bearer ${MASTER}` },
    });
    expect(r.status).toBe(200);
  });

  it("missing artifact returns 404", async () => {
    const r = await fetch(`${baseUrl}/u/demo/nope.html`);
    expect(r.status).toBe(404);
  });

  it("traversal attempts get 404 (path validation)", async () => {
    const r = await fetch(`${baseUrl}/u/demo/../etc/passwd`);
    // node fetch normalizes ".." in URLs, so this becomes
    // /u/etc/passwd → namespace=etc, path=passwd → also 404
    expect([404, 400]).toContain(r.status);
  });

  it("paused namespace blocks reads with 423", async () => {
    expect((await adminPost({ status: "paused" })).status).toBe(200);
    const r = await fetch(`${baseUrl}/u/demo/index.html`);
    expect(r.status).toBe(423);
    const body = (await r.json()) as { kind?: string };
    expect(body.kind).toBe("NamespacePaused");
    await adminPost({ status: "active" });
  });

  it("archived namespace still serves reads (read-only freeze)", async () => {
    expect((await adminPost({ status: "archived" })).status).toBe(200);
    const r = await fetch(`${baseUrl}/u/demo/index.html`);
    expect(r.status).toBe(200);
    await adminPost({ status: "active" });
  });

  describe("admin routes", () => {
    const adminGet = (path: string, headers: Record<string, string> = {}) =>
      fetch(`${baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${MASTER}`, ...headers },
      });
    const adminDelete = (path: string) =>
      fetch(`${baseUrl}${path}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${MASTER}` },
      });

    it("GET /admin/artifacts/:namespace lists summaries with absolute URLs", async () => {
      const r = await adminGet("/admin/artifacts/demo");
      expect(r.status).toBe(200);
      const list = (await r.json()) as Array<{
        namespace: string;
        path: string;
        mimeType: string;
        size: number;
        public: boolean;
        url: string;
      }>;
      const paths = list.map((a) => a.path).sort();
      expect(paths).toEqual(["index.html", "js/app.js", "secret.html"]);
      const indexHtml = list.find((a) => a.path === "index.html")!;
      expect(indexHtml.namespace).toBe("demo");
      expect(indexHtml.mimeType).toBe("text/html; charset=utf-8");
      // baseUrl on buildServer is "http://127.0.0.1:0" (port placeholder) and
      // is what the URL helper interpolates — not the actual listen port.
      expect(indexHtml.url).toBe("http://127.0.0.1:0/u/demo/index.html");
      // Summary, not record — viewToken should not leak in the list.
      expect((indexHtml as unknown as { viewToken?: string }).viewToken).toBeUndefined();
    });

    it("GET /admin/artifacts/:namespace/* returns full record (incl. viewToken for private)", async () => {
      const r = await adminGet("/admin/artifacts/demo/secret.html");
      expect(r.status).toBe(200);
      const rec = (await r.json()) as {
        namespace: string;
        path: string;
        public: boolean;
        viewToken: string;
        url: string;
      };
      expect(rec.namespace).toBe("demo");
      expect(rec.path).toBe("secret.html");
      expect(rec.public).toBe(false);
      expect(rec.viewToken).toMatch(/^art_/);
      expect(rec.url).toBe("http://127.0.0.1:0/u/demo/secret.html");
    });

    it("GET /admin/artifacts/:namespace/* resolves nested paths", async () => {
      const r = await adminGet("/admin/artifacts/demo/js/app.js");
      expect(r.status).toBe(200);
      const rec = (await r.json()) as { path: string; mimeType: string };
      expect(rec.path).toBe("js/app.js");
      expect(rec.mimeType).toBe("application/javascript");
    });

    it("GET /admin/artifacts/:namespace/missing → 404 NotFound", async () => {
      const r = await adminGet("/admin/artifacts/demo/nope.html");
      expect(r.status).toBe(404);
      const body = (await r.json()) as { kind?: string };
      expect(body.kind).toBe("NotFound");
    });

    it("GET /admin/artifacts/:invalid → 400 ValidationError", async () => {
      const r = await adminGet("/admin/artifacts/Bad%20Name");
      expect(r.status).toBe(400);
      const body = (await r.json()) as { kind?: string };
      expect(body.kind).toBe("ValidationError");
    });

    it("DELETE /admin/artifacts/:namespace/* removes the artifact", async () => {
      // Create a throwaway artifact to remove.
      await store.artifacts.create({
        namespace: "demo",
        path: "removeme.txt",
        content: "bye",
      });
      const before = await store.artifacts.get("demo", "removeme.txt");
      expect(before).not.toBeNull();

      const del = await adminDelete("/admin/artifacts/demo/removeme.txt");
      expect(del.status).toBe(200);
      const body = (await del.json()) as {
        deleted: { namespace: string; path: string };
      };
      expect(body.deleted).toEqual({ namespace: "demo", path: "removeme.txt" });

      const after = await store.artifacts.get("demo", "removeme.txt");
      expect(after).toBeNull();
    });

    it("agent token gets rejected on /admin/artifacts/* (master-only)", async () => {
      const tk = await store.agentTokens.mint({
        scope: { namespaces: ["demo"] },
      });
      const r = await fetch(`${baseUrl}/admin/artifacts/demo`, {
        headers: { Authorization: `Bearer ${tk.token}` },
      });
      expect(r.status).toBe(401);
    });

    it("no auth → 401 (preHandler enforces)", async () => {
      const r = await fetch(`${baseUrl}/admin/artifacts/demo`);
      expect(r.status).toBe(401);
    });
  });

  it("delete_namespace cascade wipes artifacts (rows + bytes)", async () => {
    expect((await store.artifacts.list("demo")).length).toBeGreaterThan(0);
    const del = await fetch(`${baseUrl}/admin/namespaces/demo`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${MASTER}` },
    });
    expect(del.status).toBe(200);
    const body = (await del.json()) as {
      deleted: { artifacts: string[] };
    };
    // Three artifacts created earlier: index.html, js/app.js, secret.html
    expect(body.deleted.artifacts.sort()).toEqual(
      ["index.html", "js/app.js", "secret.html"].sort(),
    );
    // Subsequent fetches 404 — namespace gone
    const r = await fetch(`${baseUrl}/u/demo/index.html`);
    expect(r.status).toBe(404);
  });
});
