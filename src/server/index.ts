import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import fastify, { type FastifyInstance } from "fastify";
import type { CronScheduler } from "../cron/index.js";
import { CronRegistry } from "../cron/registry.js";
import type { InvokeDeps } from "../invoke.js";
import type { McpToolDeps } from "./mcp-tools.js";
import { bootstrapNamespaces } from "./bootstrap.js";
import { actionsRoutes } from "./routes/actions.js";
import { adminRoutes } from "./routes/admin.js";
import { artifactsRoutes } from "./routes/artifacts.js";
import { healthRoutes } from "./routes/health.js";
import { mcpRoutes } from "./routes/mcp.js";
import { stateRoutes } from "./routes/state.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { StoreError } from "../store/index.js";
import { ScopeError } from "./auth.js";

export interface BuildServerOpts extends InvokeDeps {
  token: string;
  baseUrl: string;
  cronScheduler: CronScheduler;
  cronRegistry?: CronRegistry;
  cueVersion?: string;
  logger?: boolean;
  /** Allowed CORS origins. [] disables CORS. ["*"] allows any. */
  cors?: string[];
}

export interface BuiltServer {
  app: FastifyInstance;
  cronRegistry: CronRegistry;
  /**
   * MCP dep fields that are stable across requests (everything except
   * the authenticated principal, which is resolved per-request in
   * `mcpRoutes`). Exposed so tests and callers can patch URL helpers
   * after the server has bound to a real port.
   */
  mcpDeps: Omit<McpToolDeps, "principal">;
}

export async function buildServer(opts: BuildServerOpts): Promise<BuiltServer> {
  // Synthesize namespace metadata rows for any namespace referenced by
  // an existing action or trigger but missing its `namespaces` record.
  // Idempotent; safe to run on every boot.
  await bootstrapNamespaces(opts.store);

  const app = fastify({
    logger: opts.logger ?? false,
    forceCloseConnections: true,
  });

  const corsOrigins = opts.cors ?? [];
  if (corsOrigins.length > 0) {
    const origin: string | string[] | boolean = corsOrigins.includes("*")
      ? true
      : corsOrigins;
    await app.register(cors, {
      origin,
      credentials: false,
      allowedHeaders: ["Authorization", "Content-Type"],
      methods: ["GET", "POST", "OPTIONS", "DELETE"],
    });
  }

  const cronRegistry =
    opts.cronRegistry ?? new CronRegistry(opts.cronScheduler, opts);

  // `mcpDeps` is built fresh per /mcp request with the authenticated
  // principal attached (see mcpRoutes). The shape returned here is the
  // set of fields that don't depend on request identity.
  const mcpDepsBase: Omit<McpToolDeps, "principal"> = {
    store: opts.store,
    runtime: opts.runtime,
    state: opts.state,
    ceiling: opts.ceiling,
    port: opts.port,
    cronScheduler: opts.cronScheduler,
    cronRegistry,
    invokeUrlFor: (id) => `${opts.baseUrl}/a/${id}`,
    webhookUrlFor: (id) => `${opts.baseUrl}/w/${id}`,
    artifactUrlFor: (ns, path) =>
      `${opts.baseUrl}/u/${encodeURIComponent(ns)}/${path
        .split("/")
        .map((s) => encodeURIComponent(s))
        .join("/")}`,
    cueVersion: opts.cueVersion ?? "0.1.0",
  };

  // Translate cue-specific thrown errors into HTTP status codes. The
  // agent-facing routes (/mcp, /a/:id, /state/*) dispatch into tool
  // handlers that throw StoreError / ScopeError; without this they'd
  // land as 500s.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ScopeError) {
      reply.code(403).send({
        error: err.message,
        namespace: err.namespace,
      });
      return;
    }
    if (err instanceof StoreError) {
      const status =
        err.kind === "NotFound"
          ? 404
          : err.kind === "NameCollision"
            ? 409
            : err.kind === "NamespacePaused" ||
                err.kind === "NamespaceArchived"
              ? 423
              : 400;
      reply.code(status).send({
        error: err.message,
        kind: err.kind,
        ...(err.details ? { details: err.details } : {}),
      });
      return;
    }
    reply.send(err);
  });

  await app.register(sensible);
  await app.register(healthRoutes);
  await app.register(actionsRoutes(opts));
  await app.register(webhookRoutes(opts));
  await app.register(
    artifactsRoutes({ store: opts.store, token: opts.token }),
  );
  await app.register(
    stateRoutes({ state: opts.state, store: opts.store, token: opts.token }),
  );
  await app.register(
    adminRoutes({
      store: opts.store,
      state: opts.state,
      token: opts.token,
      invokeUrlFor: mcpDepsBase.invokeUrlFor,
      webhookUrlFor: mcpDepsBase.webhookUrlFor,
      artifactUrlFor: mcpDepsBase.artifactUrlFor,
    }),
  );
  await app.register(mcpRoutes({ deps: mcpDepsBase, token: opts.token }));
  return { app, cronRegistry, mcpDeps: mcpDepsBase };
}
