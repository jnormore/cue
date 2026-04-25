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
