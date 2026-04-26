import type { FastifyPluginAsync } from "fastify";
import { type InvokeDeps, type InvokeEnvelope, invokeAction } from "../../invoke.js";
import { extractBearer } from "../auth.js";
import { assertNamespaceActive } from "../namespace-status.js";

/**
 * Webhook handler. Accepts GET and POST on /w/:id with the same auth.
 *
 * - POST: typical "fire with a JSON body" use. Body lands at env.input.
 * - GET:  body-less invocation. env.input is null; query params are
 *         in env.request.query for actions that want REST-shaped reads.
 *
 * Allowing GET removes a real foot-gun: `fetch(url)` without options
 * defaults to GET, browser clicks are GET, `curl <url>` is GET. The
 * token is the gate, not the verb — the security story is identical
 * for both methods. Actions that need to differentiate read
 * env.request.method.
 */
export function webhookRoutes(deps: InvokeDeps): FastifyPluginAsync {
  return async (app) => {
    const handler = async (
      req: Parameters<Parameters<typeof app.route>[0]["handler"]>[0],
      reply: Parameters<Parameters<typeof app.route>[0]["handler"]>[1],
    ) => {
      const params = req.params as { id: string };
      const trigger = await deps.store.triggers.get(params.id);
      if (!trigger || trigger.type !== "webhook") {
        reply.code(404).send({ error: `Webhook trigger ${params.id} not found` });
        return;
      }
      if (trigger.config.type !== "webhook") {
        reply.code(404).send({ error: "Trigger config is not a webhook" });
        return;
      }
      // Accept the token via Authorization header OR `?t=<token>` query
      // param. Header is the standard for programmatic calls; `?t=` is
      // there so a browser GET (anchor click, fetch without explicit
      // headers, curl with no auth flag) can carry the token without
      // setting a header. Same security story — the token is the gate,
      // not the channel. Matches the artifact route's `?t=` semantics.
      const queryToken =
        typeof (req.query as { t?: unknown } | undefined)?.t === "string"
          ? ((req.query as { t: string }).t)
          : null;
      const provided = queryToken ?? extractBearer(req);
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
      // Throws StoreError(NamespacePaused | NamespaceArchived); the
      // global error handler maps both to 423.
      await assertNamespaceActive(deps.store, action.namespace);
      // Body only meaningful on POST — GET requests have no body.
      // env.input mirrors env.request.body so action code can read
      // its payload from one canonical place regardless of how it was
      // fired (invoke_action, cron, webhook POST, webhook GET).
      const body = req.method === "POST" ? (req.body ?? null) : null;
      const envelope: InvokeEnvelope = {
        trigger: {
          type: "webhook",
          triggerId: trigger.id,
          firedAt: new Date().toISOString(),
        },
        input: body,
        request: {
          method: req.method,
          path: req.url,
          query: (req.query ?? {}) as Record<string, unknown>,
          headers: req.headers,
          body,
        },
      };
      return invokeAction(deps, action, envelope);
    };

    app.route({ method: ["GET", "POST"], url: "/w/:id", handler });
  };
}
