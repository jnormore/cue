import type { FastifyPluginAsync } from "fastify";
import { type InvokeDeps, type InvokeEnvelope, invokeAction } from "../../invoke.js";
import { extractBearer } from "../auth.js";
import { assertNamespaceActive } from "../namespace-status.js";

export function webhookRoutes(deps: InvokeDeps): FastifyPluginAsync {
  return async (app) => {
    app.post<{ Params: { id: string }; Body: unknown }>(
      "/w/:id",
      async (req, reply) => {
        const trigger = await deps.store.triggers.get(req.params.id);
        if (!trigger || trigger.type !== "webhook") {
          reply.code(404).send({ error: `Webhook trigger ${req.params.id} not found` });
          return;
        }
        if (trigger.config.type !== "webhook") {
          reply.code(404).send({ error: "Trigger config is not a webhook" });
          return;
        }
        const provided = extractBearer(req);
        if (provided === null) {
          reply.code(401).send({ error: "Missing bearer token" });
          return;
        }
        if (provided !== trigger.config.token) {
          reply.code(401).send({ error: "Invalid webhook token" });
          return;
        }
        const action = await deps.store.actions.get(trigger.actionId);
        if (!action) {
          reply.code(404).send({ error: `Action ${trigger.actionId} not found` });
          return;
        }
        // Throws StoreError(NamespacePaused | NamespaceArchived);
        // Fastify's setErrorHandler maps both to 423.
        await assertNamespaceActive(deps.store, action.namespace);
        const envelope: InvokeEnvelope = {
          trigger: {
            type: "webhook",
            triggerId: trigger.id,
            firedAt: new Date().toISOString(),
          },
          request: {
            method: req.method,
            path: req.url,
            query: (req.query ?? {}) as Record<string, unknown>,
            headers: req.headers,
            body: req.body ?? null,
          },
        };
        return invokeAction(deps, action, envelope);
      },
    );
  };
}
