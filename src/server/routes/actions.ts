import type { FastifyPluginAsync } from "fastify";
import { type InvokeDeps, type InvokeEnvelope, invokeAction } from "../../invoke.js";
import {
  authenticate,
  extractBearer,
  namespaceAllowed,
} from "../auth.js";

export interface ActionsRouteOpts extends InvokeDeps {
  token: string;
}

export function actionsRoutes(opts: ActionsRouteOpts): FastifyPluginAsync {
  return async (app) => {
    app.post<{ Params: { id: string }; Body: unknown }>(
      "/a/:id",
      async (req, reply) => {
        const bearer = extractBearer(req);
        if (bearer === null) {
          reply.code(401).send({ error: "Missing bearer token" });
          return;
        }
        const principal = await authenticate(req, {
          masterToken: opts.token,
          store: opts.store,
        });
        if (!principal) {
          reply.code(401).send({ error: "Invalid bearer token" });
          return;
        }
        const action = await opts.store.actions.get(req.params.id);
        // Hide out-of-scope existence behind 404 — same shape as if the
        // action had never been created.
        if (!action || !namespaceAllowed(principal, action.namespace)) {
          reply.code(404).send({ error: `Action ${req.params.id} not found` });
          return;
        }
        const envelope: InvokeEnvelope = {
          trigger: null,
          input: req.body ?? null,
        };
        return invokeAction(opts, action, envelope);
      },
    );
  };
}
