import type { FastifyPluginAsync } from "fastify";
import {
  type ActionPatch,
  type AgentTokenPatch,
  deleteAction as cascadeDeleteAction,
  deleteNamespace as cascadeDeleteNamespace,
  DEFAULT_NAMESPACE,
  type NamespacePatch,
  type NamespaceRecord,
  type Policy,
  StoreError,
  type StoreAdapter,
  type TriggerCreateInput,
  type TriggerRecord,
  validateNamespace,
} from "../../store/index.js";
import type { StateAdapter } from "../../state/index.js";
import { masterAuth } from "../auth.js";
import { assertNamespaceMutable } from "../namespace-status.js";

export interface AdminRoutesOpts {
  store: StoreAdapter;
  state: StateAdapter;
  token: string;
  /** Build absolute invoke URLs for action create/get responses. */
  invokeUrlFor(id: string): string;
  /** Build absolute webhook URLs for trigger create/get responses. */
  webhookUrlFor(id: string): string;
  /** Build absolute artifact URLs for artifact list/get responses. */
  artifactUrlFor(namespace: string, path: string): string;
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
    registerConfigRoutes(app, opts);
    registerAgentTokenRoutes(app, opts);
    registerArtifactRoutes(app, opts);
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
    const namespace = req.body.namespace ?? DEFAULT_NAMESPACE;
    await assertNamespaceMutable(opts.store, namespace);
    const created = await opts.store.actions.create({
      name: req.body.name,
      code: req.body.code,
      namespace,
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
    async (req, reply) => {
      const existing = await opts.store.actions.get(req.params.id);
      if (!existing) {
        reply.code(404).send({
          error: `Action ${req.params.id} not found`,
          kind: "NotFound",
        });
        return;
      }
      await assertNamespaceMutable(opts.store, existing.namespace);
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
    await assertNamespaceMutable(opts.store, req.body.namespace);
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
    await assertNamespaceMutable(opts.store, req.params.namespace);
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

// ---------- configs ----------

function registerConfigRoutes(
  app: Parameters<FastifyPluginAsync>[0],
  opts: AdminRoutesOpts,
): void {
  app.put<{
    Params: { namespace: string; name: string };
    Body: { value: string };
  }>("/admin/configs/:namespace/:name", async (req) => {
    await assertNamespaceMutable(opts.store, req.params.namespace);
    await opts.store.configs.set(
      req.params.namespace,
      req.params.name,
      req.body.value,
    );
    return { namespace: req.params.namespace, name: req.params.name };
  });

  // Configs differ from secrets here: list returns full entries (name +
  // value + timestamps), and there's a per-key GET that returns the
  // value. Secrets deliberately don't have either of those.
  app.get<{ Params: { namespace: string } }>(
    "/admin/configs/:namespace",
    async (req) => {
      const entries = await opts.store.configs.list(req.params.namespace);
      return { namespace: req.params.namespace, entries };
    },
  );

  app.get<{ Params: { namespace: string; name: string } }>(
    "/admin/configs/:namespace/:name",
    async (req, reply) => {
      const value = await opts.store.configs.get(
        req.params.namespace,
        req.params.name,
      );
      if (value === null) {
        reply.code(404).send({
          error: `Config "${req.params.name}" not set in namespace "${req.params.namespace}"`,
        });
        return;
      }
      return {
        namespace: req.params.namespace,
        name: req.params.name,
        value,
      };
    },
  );

  app.delete<{ Params: { namespace: string; name: string } }>(
    "/admin/configs/:namespace/:name",
    async (req) => {
      await opts.store.configs.delete(req.params.namespace, req.params.name);
      return { deleted: req.params.name, namespace: req.params.namespace };
    },
  );
}

// ---------- artifacts ----------

function registerArtifactRoutes(
  app: Parameters<FastifyPluginAsync>[0],
  opts: AdminRoutesOpts,
): void {
  // List all artifacts in a namespace. Decorate with the public URL
  // so operator UIs can render links without reconstructing them.
  // Bytes are intentionally omitted — use GET /u/:namespace/* for those.
  app.get<{ Params: { namespace: string } }>(
    "/admin/artifacts/:namespace",
    async (req) => {
      validateNamespace(req.params.namespace);
      const list = await opts.store.artifacts.list(req.params.namespace);
      return list.map((a) => ({
        ...a,
        url: opts.artifactUrlFor(a.namespace, a.path),
      }));
    },
  );

  // Fetch a single artifact's metadata. Returns the full record (including
  // the per-artifact viewToken for non-public artifacts), so an operator
  // can construct a private-share URL. Bytes still come from /u/:ns/*.
  app.get<{ Params: { namespace: string; "*": string } }>(
    "/admin/artifacts/:namespace/*",
    async (req, reply) => {
      validateNamespace(req.params.namespace);
      const path = req.params["*"];
      const rec = await opts.store.artifacts.get(req.params.namespace, path);
      if (!rec) {
        reply.code(404).send({
          error: `Artifact "${path}" not found in namespace "${req.params.namespace}"`,
          kind: "NotFound",
        });
        return;
      }
      return { ...rec, url: opts.artifactUrlFor(rec.namespace, rec.path) };
    },
  );

  // Operator-side delete. Useful when an agent token is revoked or the
  // operator needs to remove an artifact without going through MCP.
  app.delete<{ Params: { namespace: string; "*": string } }>(
    "/admin/artifacts/:namespace/*",
    async (req) => {
      validateNamespace(req.params.namespace);
      const path = req.params["*"];
      await opts.store.artifacts.delete(req.params.namespace, path);
      return { deleted: { namespace: req.params.namespace, path } };
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

  app.patch<{
    Params: { id: string };
    Body: { scope?: { namespaces: string[] }; label?: string | null };
  }>("/admin/agent-tokens/:id", async (req) => {
    const patch: AgentTokenPatch = {};
    if (req.body.scope !== undefined) patch.scope = req.body.scope;
    if (req.body.label !== undefined) patch.label = req.body.label;
    return opts.store.agentTokens.update(req.params.id, patch);
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
  app.post<{
    Body: { name: string; displayName?: string; description?: string };
  }>("/admin/namespaces", async (req) => {
    validateNamespace(req.body.name);
    const existing = await opts.store.namespaces.get(req.body.name);
    if (existing) {
      throw new StoreError(
        "NameCollision",
        `Namespace "${req.body.name}" already exists`,
        { existing: existing.name },
      );
    }
    const now = new Date().toISOString();
    const record: NamespaceRecord = {
      name: req.body.name,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    if (req.body.displayName !== undefined)
      record.displayName = req.body.displayName;
    if (req.body.description !== undefined)
      record.description = req.body.description;
    return opts.store.namespaces.upsert(record);
  });

  app.get("/admin/namespaces", async () => {
    const list = await opts.store.namespaces.list();
    // Decorate with rough resource counts so `cue ns list` can show
    // them without a follow-up query per row.
    const [actions, triggers] = await Promise.all([
      opts.store.actions.list(),
      opts.store.triggers.list(),
    ]);
    return list.map((ns) => ({
      ...ns,
      actionCount: actions.filter((a) => a.namespace === ns.name).length,
      triggerCount: triggers.filter((t) => t.namespace === ns.name).length,
    }));
  });

  app.get<{ Params: { name: string } }>(
    "/admin/namespaces/:name",
    async (req, reply) => {
      const ns = await opts.store.namespaces.get(req.params.name);
      if (!ns) {
        reply.code(404).send({
          error: `Namespace "${req.params.name}" not found`,
          kind: "NotFound",
        });
        return;
      }
      const [actions, triggers, secretNames, configEntries, stateKeys] =
        await Promise.all([
          opts.store.actions.list({ namespace: req.params.name }),
          opts.store.triggers.list({ namespace: req.params.name }),
          opts.store.secrets.list(req.params.name),
          opts.store.configs.list(req.params.name),
          opts.state.log.list(req.params.name),
        ]);
      return {
        ...ns,
        actionCount: actions.length,
        triggerCount: triggers.length,
        secretCount: secretNames.length,
        configCount: configEntries.length,
        stateKeyCount: stateKeys.length,
      };
    },
  );

  app.patch<{ Params: { name: string }; Body: NamespacePatch }>(
    "/admin/namespaces/:name",
    async (req) => {
      return opts.store.namespaces.update(req.params.name, req.body);
    },
  );

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
          configs: result.configs,
          stateKeys: result.stateKeys,
          artifacts: result.artifacts,
        },
      };
    },
  );
}
