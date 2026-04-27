import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronScheduler } from "../../../src/cron/index.js";
import type { ActionRuntime } from "../../../src/runtime/index.js";
import { buildServer } from "../../../src/server/index.js";
import {
  type ActionRecord,
  pickStore,
  type StoreAdapter,
  type TriggerRecord,
} from "../../../src/store/index.js";
import { makeTestState } from "../../helpers/state.js";

function noopScheduler(): CronScheduler {
  return {
    name: "noop",
    async doctor() {
      return { ok: true, details: {} };
    },
    async schedule() {
      return {
        async cancel() {
          /* no-op */
        },
      };
    },
    async close() {
      /* no-op */
    },
  };
}

const TOKEN = "test-master-token";

function makeRuntime(
  override: Partial<{
    stdout: string;
    stderr: string;
    exitCode: number;
    runtimeRunId: string;
  }> = {},
): { runtime: ActionRuntime; run: ReturnType<typeof vi.fn> } {
  // Default to parseable JSON stdout so auth/route tests that don't care
  // about the body still get a 200 — empty stdout under the new webhook
  // contract triggers the 502 "did not return JSON" debug fallback,
  // which is the right behavior in production but not what these tests
  // are checking.
  const run = vi.fn().mockResolvedValue({
    stdout: override.stdout ?? "{}",
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

describe("server", () => {
  let home: string;
  let store: StoreAdapter;
  let app: FastifyInstance;
  let runtime: ActionRuntime;
  let runMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "cue-server-"));
    store = pickStore("sqlite", { home });
    const rt = makeRuntime();
    runtime = rt.runtime;
    runMock = rt.run;
    const built = await buildServer({
      store,
      runtime,
      state: makeTestState(home),
      port: 0,
      ceiling: {},
      token: TOKEN,
      baseUrl: "http://localhost:4747",
      cronScheduler: noopScheduler(),
    });
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  describe("GET /health", () => {
    it("returns 200 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });
  });

  describe("POST /a/:id", () => {
    let action: ActionRecord;

    beforeEach(async () => {
      action = await store.actions.create({
        name: "hello",
        code: "console.log('hi')",
      });
    });

    it("401 without Authorization header", async () => {
      const res = await app.inject({ method: "POST", url: `/a/${action.id}` });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toMatch(/Missing bearer/);
    });

    it("401 with wrong token", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/a/${action.id}`,
        headers: { authorization: "Bearer wrong" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("404 for unknown action id", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/a/act_UNKNOWN",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it("200 invokes the action and returns the result", async () => {
      runMock.mockResolvedValueOnce({
        stdout: '{"answer":42}',
        stderr: "",
        exitCode: 0,
        runtimeRunId: "u_X",
      });
      const res = await app.inject({
        method: "POST",
        url: `/a/${action.id}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { question: 1 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.exitCode).toBe(0);
      expect(body.stdout).toBe('{"answer":42}');
      expect(body.output).toEqual({ answer: 42 });
      expect(body.runtimeRunId).toBe("u_X");

      const envelope = JSON.parse(runMock.mock.calls[0]?.[0].stdin);
      expect(envelope.trigger).toBeNull();
      expect(envelope.input).toEqual({ question: 1 });
    });
  });

  describe("POST /w/:id", () => {
    let action: ActionRecord;
    let trigger: TriggerRecord;
    let scopedToken: string;

    beforeEach(async () => {
      action = await store.actions.create({ name: "hook", code: "x" });
      trigger = await store.triggers.create({
        type: "webhook",
        actionId: action.id,
        namespace: "default",
        config: {},
      });
      if (trigger.config.type !== "webhook") {
        throw new Error("expected webhook trigger config");
      }
      scopedToken = trigger.config.token;
    });

    it("404 for unknown trigger", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/w/trg_UNKNOWN",
        headers: { authorization: `Bearer ${scopedToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it("404 when the trigger is a cron, not a webhook", async () => {
      const cron = await store.triggers.create({
        type: "cron",
        actionId: action.id,
        namespace: "default",
        config: { schedule: "* * * * *" },
      });
      const res = await app.inject({
        method: "POST",
        url: `/w/${cron.id}`,
        headers: { authorization: `Bearer ${scopedToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it("401 without auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/w/${trigger.id}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("401 with the master token (webhooks require the scoped token)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/w/${trigger.id}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it("200 with the scoped token — envelope carries request context", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/w/${trigger.id}?ref=abc`,
        headers: {
          authorization: `Bearer ${scopedToken}`,
          "x-custom": "yes",
        },
        payload: { message: "hello" },
      });
      expect(res.statusCode).toBe(200);
      const envelope = JSON.parse(runMock.mock.calls[0]?.[0].stdin);
      expect(envelope.trigger.type).toBe("webhook");
      expect(envelope.trigger.triggerId).toBe(trigger.id);
      expect(envelope.request.method).toBe("POST");
      expect(envelope.request.query).toEqual({ ref: "abc" });
      expect(envelope.request.body).toEqual({ message: "hello" });
      expect(envelope.request.headers["x-custom"]).toBe("yes");
      // Default trigger uses bearer auth, surfaced in the envelope so the
      // action can make trust decisions without re-deriving from headers.
      expect(envelope.request.auth).toBe("bearer");
    });

    it("returns HTTP-shaped output as an actual HTTP response (status + body unwrapped)", async () => {
      runMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          status: 200,
          headers: { "content-type": "application/json", "x-trace-id": "abc" },
          body: { ok: true, monitorUrl: "https://example.com", checks: 21 },
        }),
        stderr: "",
        exitCode: 0,
        runtimeRunId: "u_HTTP",
      });
      const res = await app.inject({
        method: "GET",
        url: `/w/${trigger.id}`,
        headers: { authorization: `Bearer ${scopedToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-trace-id"]).toBe("abc");
      // Body is the action's `body`, NOT an InvokeResult wrapper. The
      // dashboard's `payload.monitorUrl` lookup now sees the real value
      // instead of digging through `payload.stdout` JSON-in-JSON.
      const body = res.json();
      expect(body).toEqual({
        ok: true,
        monitorUrl: "https://example.com",
        checks: 21,
      });
      expect(body).not.toHaveProperty("stdout");
      expect(body).not.toHaveProperty("runId");
    });

    it("propagates the action's chosen status code (e.g. 4xx)", async () => {
      runMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          status: 400,
          body: { ok: false, error: "Stripe-Signature missing" },
        }),
        stderr: "",
        exitCode: 0,
        runtimeRunId: "u_400",
      });
      const res = await app.inject({
        method: "POST",
        url: `/w/${trigger.id}`,
        headers: { authorization: `Bearer ${scopedToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        ok: false,
        error: "Stripe-Signature missing",
      });
    });

    it("returns plain JSON output as the response body (no Lambda-style wrapper required)", async () => {
      // Many agent-built actions just `console.log(JSON.stringify({ok:true,...}))`
      // without wrapping in {status, headers, body}. Caller should see
      // the action's JSON directly — not an InvokeResult envelope.
      runMock.mockResolvedValueOnce({
        stdout: JSON.stringify({ ok: true, checks: [], monitorUrl: "https://x" }),
        stderr: "",
        exitCode: 0,
        runtimeRunId: "u_PLAIN",
      });
      const res = await app.inject({
        method: "GET",
        url: `/w/${trigger.id}`,
        headers: { authorization: `Bearer ${scopedToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({ ok: true, checks: [], monitorUrl: "https://x" });
      expect(body).not.toHaveProperty("runId");
      expect(body).not.toHaveProperty("stdout");
    });

    it("502s with debug envelope when the action prints nothing parseable", async () => {
      runMock.mockResolvedValueOnce({
        stdout: "not json at all",
        stderr: "",
        exitCode: 0,
        runtimeRunId: "u_NOJSON",
      });
      const res = await app.inject({
        method: "POST",
        url: `/w/${trigger.id}`,
        headers: { authorization: `Bearer ${scopedToken}` },
        payload: { x: 1 },
      });
      expect(res.statusCode).toBe(502);
      const body = res.json();
      expect(body).toHaveProperty("error", "Action did not return JSON");
      expect(body).toHaveProperty("runId");
    });

    it("500s when the action exits non-zero", async () => {
      runMock.mockResolvedValueOnce({
        stdout: "",
        stderr: "ReferenceError: foo is not defined",
        exitCode: 1,
        runtimeRunId: "u_FAIL",
      });
      const res = await app.inject({
        method: "POST",
        url: `/w/${trigger.id}`,
        headers: { authorization: `Bearer ${scopedToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.error).toBe("Action failed");
      expect(body.exitCode).toBe(1);
      expect(body.stderr).toContain("ReferenceError");
    });

    it("statusCode (Lambda alias) works as well as status", async () => {
      runMock.mockResolvedValueOnce({
        stdout: JSON.stringify({ statusCode: 201, body: { id: "x" } }),
        stderr: "",
        exitCode: 0,
        runtimeRunId: "u_201",
      });
      const res = await app.inject({
        method: "POST",
        url: `/w/${trigger.id}`,
        headers: { authorization: `Bearer ${scopedToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ id: "x" });
    });
  });

  // The remaining auth modes are non-default — pick during create_trigger.
  describe("POST /w/:id (auth modes)", () => {
    let action: ActionRecord;

    beforeEach(async () => {
      action = await store.actions.create({ name: "hook-modes", code: "x" });
    });

    describe("auth: 'public'", () => {
      it("invokes the action without any token", async () => {
        const trigger = await store.triggers.create({
          type: "webhook",
          actionId: action.id,
          namespace: "default",
          config: { authMode: "public" },
        });
        const res = await app.inject({
          method: "POST",
          url: `/w/${trigger.id}`,
          payload: { stripe: "event" },
        });
        expect(res.statusCode).toBe(200);
        const envelope = JSON.parse(runMock.mock.calls[0]?.[0].stdin);
        expect(envelope.request.auth).toBe("public");
        expect(envelope.request.body).toEqual({ stripe: "event" });
      });

      it("ignores any token the caller happens to send", async () => {
        const trigger = await store.triggers.create({
          type: "webhook",
          actionId: action.id,
          namespace: "default",
          config: { authMode: "public" },
        });
        const res = await app.inject({
          method: "POST",
          url: `/w/${trigger.id}`,
          headers: { authorization: "Bearer obviously-not-the-token" },
        });
        expect(res.statusCode).toBe(200);
      });
    });

    describe("auth: 'artifact-session'", () => {
      let trigger: TriggerRecord;
      let artifactToken: string;

      beforeEach(async () => {
        trigger = await store.triggers.create({
          type: "webhook",
          actionId: action.id,
          namespace: "default",
          config: { authMode: "artifact-session" },
        });
        const art = await store.artifacts.create({
          namespace: "default",
          path: "dash.html",
          content: "<html/>",
          public: false,
        });
        artifactToken = art.viewToken;
      });

      it("401 without a token", async () => {
        const res = await app.inject({
          method: "GET",
          url: `/w/${trigger.id}`,
        });
        expect(res.statusCode).toBe(401);
      });

      it("401 when the trigger's bearer token is presented (must be a viewToken)", async () => {
        if (trigger.config.type !== "webhook") throw new Error("bad config");
        const res = await app.inject({
          method: "GET",
          url: `/w/${trigger.id}?t=${trigger.config.token}`,
        });
        expect(res.statusCode).toBe(401);
      });

      it("401 when the viewToken belongs to an artifact in another namespace", async () => {
        const otherArt = await store.artifacts.create({
          namespace: "different",
          path: "other.html",
          content: "<html/>",
          public: false,
        });
        const res = await app.inject({
          method: "GET",
          url: `/w/${trigger.id}?t=${otherArt.viewToken}`,
        });
        expect(res.statusCode).toBe(401);
      });

      it("200 with a matching viewToken — envelope marks auth=artifact-session", async () => {
        const res = await app.inject({
          method: "GET",
          url: `/w/${trigger.id}?t=${artifactToken}&limit=5`,
        });
        expect(res.statusCode).toBe(200);
        const envelope = JSON.parse(runMock.mock.calls[0]?.[0].stdin);
        expect(envelope.request.auth).toBe("artifact-session");
        expect(envelope.request.method).toBe("GET");
        expect(envelope.request.query).toEqual({
          t: artifactToken,
          limit: "5",
        });
      });
    });
  });

  describe("POST /mcp", () => {
    it("401 without auth", async () => {
      const res = await app.inject({ method: "POST", url: "/mcp" });
      expect(res.statusCode).toBe(401);
    });
  });
});

describe("server CORS", () => {
  let home: string;
  let store: StoreAdapter;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-cors-"));
    store = pickStore("sqlite", { home });
  });

  afterEach(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("no CORS headers when cors is [] (default)", async () => {
    const { runtime } = makeRuntime();
    const built = await buildServer({
      store,
      runtime,
      state: makeTestState(home),
      port: 0,
      ceiling: {},
      token: TOKEN,
      baseUrl: "http://localhost:4747",
      cronScheduler: noopScheduler(),
      cors: [],
    });
    const res = await built.app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await built.app.close();
  });

  it("emits access-control-allow-origin when origin is allow-listed", async () => {
    const { runtime } = makeRuntime();
    const built = await buildServer({
      store,
      runtime,
      state: makeTestState(home),
      port: 0,
      ceiling: {},
      token: TOKEN,
      baseUrl: "http://localhost:4747",
      cronScheduler: noopScheduler(),
      cors: ["https://claude.ai"],
    });
    const res = await built.app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://claude.ai" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://claude.ai",
    );
    await built.app.close();
  });

  it("'*' allows any origin", async () => {
    const { runtime } = makeRuntime();
    const built = await buildServer({
      store,
      runtime,
      state: makeTestState(home),
      port: 0,
      ceiling: {},
      token: TOKEN,
      baseUrl: "http://localhost:4747",
      cronScheduler: noopScheduler(),
      cors: ["*"],
    });
    const res = await built.app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://example.com" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://example.com",
    );
    await built.app.close();
  });
});
