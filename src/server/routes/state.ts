import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { StateAdapter } from "../../state/index.js";
import type { StoreAdapter } from "../../store/index.js";
import { authenticate, extractBearer } from "../auth.js";

export interface StateRouteOpts {
  state: StateAdapter;
  store: StoreAdapter;
  /** Daemon master token. Valid on all /state routes, all namespaces. */
  token: string;
}

const DEFAULT_READ_LIMIT = 1000;

/**
 * Three acceptable auth modes for a /state request:
 *   1. master token  → any namespace
 *   2. scoped state token (stk_<ns>.<hex>) → must match the URL's ns
 *   3. agent token (atk_<id>.<hex>) → URL's ns must be in scope
 * Returns true iff the caller is authorized for `namespace`.
 */
async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: StateRouteOpts,
  namespace: string,
): Promise<boolean> {
  const provided = extractBearer(req);
  if (provided === null) {
    reply.code(401).send({ error: "Missing bearer token" });
    return false;
  }
  // 1. Master + 3. Agent are both handled by authenticate().
  const principal = await authenticate(req, {
    masterToken: opts.token,
    store: opts.store,
  });
  if (principal) {
    if (principal.type === "master") return true;
    if (principal.scope.namespaces.includes(namespace)) return true;
    reply.code(403).send({
      error: `Token is not allowed to access namespace "${namespace}"`,
    });
    return false;
  }
  // 2. Per-namespace state token.
  const tokenNs = await opts.state.tokens.verify(provided);
  if (tokenNs === null) {
    reply.code(401).send({ error: "Invalid bearer token" });
    return false;
  }
  if (tokenNs !== namespace) {
    reply.code(403).send({
      error: `Token is bound to namespace "${tokenNs}", cannot access "${namespace}"`,
    });
    return false;
  }
  return true;
}

export function stateRoutes(opts: StateRouteOpts): FastifyPluginAsync {
  return async (app) => {
    app.post<{
      Params: { namespace: string; key: string };
      Body: { entry?: unknown } | unknown;
    }>("/state/:namespace/:key/append", async (req, reply) => {
      const { namespace, key } = req.params;
      if (!(await requireAuth(req, reply, opts, namespace))) return;
      const body = (req.body ?? {}) as { entry?: unknown };
      const entry = "entry" in body ? body.entry : null;
      try {
        return await opts.state.log.append(namespace, key, entry ?? null);
      } catch (err) {
        reply.code(400).send({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    app.get<{
      Params: { namespace: string; key: string };
      Querystring: { since?: string; limit?: string };
    }>("/state/:namespace/:key", async (req, reply) => {
      const { namespace, key } = req.params;
      if (!(await requireAuth(req, reply, opts, namespace))) return;
      const sinceRaw = req.query.since;
      const limitRaw = req.query.limit;
      const since =
        sinceRaw !== undefined ? Number.parseInt(sinceRaw, 10) : undefined;
      const limit =
        limitRaw !== undefined
          ? Number.parseInt(limitRaw, 10)
          : DEFAULT_READ_LIMIT;
      if (sinceRaw !== undefined && !Number.isFinite(since)) {
        reply.code(400).send({ error: `Invalid since: ${sinceRaw}` });
        return;
      }
      if (!Number.isFinite(limit) || (limit as number) < 0) {
        reply.code(400).send({ error: `Invalid limit: ${limitRaw}` });
        return;
      }
      try {
        return await opts.state.log.read(namespace, key, {
          ...(since !== undefined ? { since: since as number } : {}),
          limit: limit as number,
        });
      } catch (err) {
        reply.code(400).send({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    app.delete<{
      Params: { namespace: string; key: string };
    }>("/state/:namespace/:key", async (req, reply) => {
      const { namespace, key } = req.params;
      if (!(await requireAuth(req, reply, opts, namespace))) return;
      try {
        await opts.state.log.delete(namespace, key);
        return { ok: true };
      } catch (err) {
        reply.code(400).send({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  };
}
