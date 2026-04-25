import type { FastifyPluginAsync } from "fastify";
import {
  type ActionPatch,
  deleteAction as cascadeDeleteAction,
  deleteNamespace as cascadeDeleteNamespace,
  type Policy,
  type StoreAdapter,
  type TriggerCreateInput,
  type TriggerRecord,
} from "../../store/index.js";
import type { StateAdapter } from "../../state/index.js";
import { masterAuth } from "../auth.js";

export interface AdminRoutesOpts {
  store: StoreAdapter;
  state: StateAdapter;
  token: string;
  /** Build absolute invoke URLs for action create/get responses. */
  invokeUrlFor(id: string): string;
  /** Build absolute webhook URLs for trigger create/get responses. */
  webhookUrlFor(id: string): string;
}

/**
 * Operator-only HTTP API. Every route is gated by the master token —
 * agent tokens are rejected. The CLI is the primary client; nothing
 * here is exposed via MCP (MCP has its own surface in src/server/mcp.ts).
 *
 * Conventions:
 *   - Resource paths are plural: /admin/actions, /admin/triggers, etc.
 *   - Standard verbs: POST=create, GET=read, PATCH=update, DELETE=remove.
 *   - Cascade-delete responses include the dependent resources removed,
 *     so CLI tooling can show a meaningful summary.
 *   - Errors come back as { error, kind?, details? }; HTTP status codes
 *     are translated by the global error handler in src/server/index.ts.
 */
export function adminRoutes(opts: AdminRoutesOpts): FastifyPluginAsync {
  return async (app) => {
    app.addHook("preHandler", masterAuth(opts.token));

    registerActionRoutes(app, opts);
    registerTriggerRoutes(app, opts);
    registerSecretRoutes(app, opts);
    registerAgentTokenRoutes(app, opts);
    registerNamespaceRoutes(app, opts);
  };
}

// ---------- actions ----------

function registerActionRoutes(
  app: Parameters<FastifyPluginAsync>[0],
  opts: AdminRoutesOpts,
): void {
  app.post<{
    Body: { name: string; code: string; namespace?: string; policy?: Policy };
  }>("/admin/actions", async (req) => {
    const created = await opts.store.actions.create({
      name: req.body.name,
      code: req.body.code,
      ...(req.body.namespace ? { namespace: req.body.namespace } : {}),
      ...(req.body.policy ? { policy: req.body.policy } : {}),
    });
    return { ...created, invokeUrl: opts.invokeUrlFor(created.id) };
  });

  app.get<{ Querystring: { namespace?: string } }>(
    "/admin/actions",
    async (req) => {
      return opts.store.actions.list(
        req.query.namespace ? { namespace: req.query.namespace } : undefined,
      );
    },
  );

  app.get<{ Params: { id: string } }>("/admin/actions/:id", async (req, reply) => {
    const rec = await opts.store.actions.get(req.params.id);
    if (!rec) {
      reply.code(404).send({ error: `Action ${req.params.id} not found`, kind: "NotFound" });
      return;
    }
    return rec;
  });

  app.patch<{ Params: { id: string }; Body: ActionPatch }>(
    "/admin/actions/:id",
    async (req) => {
      return opts.store.actions.update(req.params.id, req.body);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/actions/:id",
    async (req) => {
      const result = await cascadeDeleteAction(opts.store, req.params.id);
      return {
        deleted: result.action,
        alsoDeleted: result.triggers,
      };
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string };
  }>("/admin/actions/:id/runs", async (req) => {
    const limit =
      req.query.limit !== undefined
        ? Number.parseInt(req.query.limit, 10)
        : undefined;
    return opts.store.runs.list({
      actionId: req.params.id,
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
    });
  });
}

// ---------- triggers ----------

function registerTriggerRoutes(
  app: Parameters<FastifyPluginAsync>[0],
  opts: AdminRoutesOpts,
): void {
  app.post<{ Body: TriggerCreateInput }>("/admin/triggers", async (req) => {
    const created = await opts.store.triggers.create(req.body);
    return decorateTrigger(created, opts);
  });

  app.get<{ Querystring: { namespace?: string; actionId?: string } }>(
    "/admin/triggers",
    async (req) => {
      const filter: { namespace?: string; actionId?: string } = {};
      if (req.query.namespace) filter.namespace = req.query.namespace;
      if (req.query.actionId) filter.actionId = req.query.actionId;
      const list = await opts.store.triggers.list(filter);
      return list.map((t) => decorateTrigger(t, opts));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/triggers/:id",
    async (req, reply) => {
      const rec = await opts.store.triggers.get(req.params.id);
      if (!rec) {
        reply.code(404).send({
          error: `Trigger ${req.params.id} not found`,
          kind: "NotFound",
        });
        return;
      }
      return decorateTrigger(rec, opts);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/triggers/:id",
    async (req) => {
      await opts.store.triggers.delete(req.params.id);
      return { deleted: req.params.id };
    },
  );
}

function decorateTrigger(
  t: TriggerRecord,
  opts: AdminRoutesOpts,
): TriggerRecord & { webhookUrl?: string } {
  if (t.type === "webhook" && t.config.type === "webhook") {
    return { ...t, webhookUrl: opts.webhookUrlFor(t.id) };
  }
  return t;
}

// ---------- secrets ----------

function registerSecretRoutes(
  app: Parameters<FastifyPluginAsync>[0],
  opts: AdminRoutesOpts,
): void {
  app.put<{
    Params: { namespace: string; name: string };
    Body: { value: string };
  }>("/admin/secrets/:namespace/:name", async (req) => {
    await opts.store.secrets.set(
      req.params.namespace,
      req.params.name,
      req.body.value,
    );
    return { namespace: req.params.namespace, name: req.params.name };
  });

  app.get<{ Params: { namespace: string } }>(
    "/admin/secrets/:namespace",
    async (req) => {
      const names = await opts.store.secrets.list(req.params.namespace);
      return { namespace: req.params.namespace, names };
    },
  );

  app.delete<{ Params: { namespace: string; name: string } }>(
    "/admin/secrets/:namespace/:name",
    async (req) => {
      await opts.store.secrets.delete(req.params.namespace, req.params.name);
      return { deleted: req.params.name, namespace: req.params.namespace };
    },
  );
}

// ---------- agent tokens ----------

function registerAgentTokenRoutes(
  app: Parameters<FastifyPluginAsync>[0],
  opts: AdminRoutesOpts,
): void {
  app.post<{
    Body: { scope: { namespaces: string[] }; label?: string };
  }>("/admin/agent-tokens", async (req) => {
    return opts.store.agentTokens.mint({
      scope: req.body.scope,
      ...(req.body.label !== undefined ? { label: req.body.label } : {}),
    });
  });

  app.get("/admin/agent-tokens", async () => {
    return opts.store.agentTokens.list();
  });

  app.delete<{ Params: { id: string } }>(
    "/admin/agent-tokens/:id",
    async (req) => {
      await opts.store.agentTokens.delete(req.params.id);
      return { deleted: req.params.id };
    },
  );
}

// ---------- namespaces ----------

function registerNamespaceRoutes(
  app: Parameters<FastifyPluginAsync>[0],
  opts: AdminRoutesOpts,
): void {
  app.delete<{ Params: { name: string } }>(
    "/admin/namespaces/:name",
    async (req) => {
      const result = await cascadeDeleteNamespace(
        opts.store,
        opts.state,
        req.params.name,
      );
      return {
        deleted: {
          actions: result.actions,
          triggers: result.triggers,
          secrets: result.secrets,
          stateKeys: result.stateKeys,
        },
      };
    },
  );
}
