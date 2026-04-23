import type { FastifyReply, FastifyRequest } from "fastify";
import type { AgentScope, StoreAdapter } from "../store/index.js";

const BEARER_PREFIX = "Bearer ";

export function extractBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith(BEARER_PREFIX)) return null;
  return header.slice(BEARER_PREFIX.length).trim();
}

/**
 * Who is making a request. Master is the single admin principal
 * (holder of `~/.cue/token`); agent is a scoped-token principal with a
 * namespace allowlist. Webhook tokens are resolved at the /w/:id route
 * and never appear here.
 */
export type Principal =
  | { type: "master" }
  | { type: "agent"; id: string; scope: AgentScope };

export interface AuthenticateOpts {
  masterToken: string;
  store: StoreAdapter;
}

/**
 * Resolve the bearer on a request to a Principal, or null if missing
 * or invalid. Does not write a response — callers decide whether a
 * null is 401 or something else.
 */
export async function authenticate(
  request: FastifyRequest,
  opts: AuthenticateOpts,
): Promise<Principal | null> {
  const bearer = extractBearer(request);
  if (bearer === null) return null;
  if (bearer === opts.masterToken) return { type: "master" };
  const agent = await opts.store.agentTokens.verify(bearer);
  if (agent) return { type: "agent", id: agent.id, scope: agent.scope };
  return null;
}

/**
 * Fastify preHandler that requires either master or agent auth and
 * attaches the principal to `request.principal`. Routes that need to
 * restrict to master only should call `requireMaster(principal)`
 * after this runs.
 */
export function requireAnyPrincipal(opts: AuthenticateOpts) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const bearer = extractBearer(request);
    if (bearer === null) {
      reply.code(401).send({ error: "Missing bearer token" });
      return;
    }
    const principal = await authenticate(request, opts);
    if (!principal) {
      reply.code(401).send({ error: "Invalid bearer token" });
      return;
    }
    (request as FastifyRequest & { principal?: Principal }).principal =
      principal;
  };
}

/**
 * Fastify preHandler for `/mcp`: accepts **agent** tokens only. The
 * master token is explicitly rejected here — the operator uses local
 * filesystem access (via the `cue` CLI) and `/a/:id` for invocation,
 * never `/mcp`. This makes it impossible for an agent client to
 * accidentally authenticate with master credentials, regardless of
 * how its config was generated.
 */
export function requireAgentPrincipal(opts: AuthenticateOpts) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const bearer = extractBearer(request);
    if (bearer === null) {
      reply.code(401).send({ error: "Missing bearer token" });
      return;
    }
    if (bearer === opts.masterToken) {
      reply.code(401).send({
        error:
          "The master token is not accepted on /mcp. Wire the client with `cue mcp config <client>` (auto-mints a sandbox token) or `cue token create --namespace <ns>` for an explicit namespace.",
      });
      return;
    }
    const agent = await opts.store.agentTokens.verify(bearer);
    if (!agent) {
      reply.code(401).send({ error: "Invalid bearer token" });
      return;
    }
    (request as FastifyRequest & { principal?: Principal }).principal = {
      type: "agent",
      id: agent.id,
      scope: agent.scope,
    };
  };
}

/**
 * Backwards-compatible master-only guard. Use on routes that must
 * reject agent tokens outright.
 */
export function masterAuth(token: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const provided = extractBearer(request);
    if (provided === null) {
      reply.code(401).send({ error: "Missing bearer token" });
      return;
    }
    if (provided !== token) {
      reply.code(401).send({ error: "Invalid bearer token" });
      return;
    }
  };
}

export function principalFromRequest(request: FastifyRequest): Principal {
  const p = (request as FastifyRequest & { principal?: Principal }).principal;
  if (!p) throw new Error("principal not attached — missing auth preHandler");
  return p;
}

export function isMaster(principal: Principal): boolean {
  return principal.type === "master";
}

/**
 * Returns true if `principal` is allowed to touch `namespace`. Master
 * is always allowed; agent tokens must have the namespace in their
 * allowlist.
 */
export function namespaceAllowed(
  principal: Principal,
  namespace: string,
): boolean {
  if (principal.type === "master") return true;
  return principal.scope.namespaces.includes(namespace);
}

/**
 * Error thrown when a scoped caller attempts to touch a namespace
 * outside its allowlist. MCP/tool callers catch and translate; HTTP
 * routes translate to a 403 body.
 */
export class ScopeError extends Error {
  readonly namespace: string;
  constructor(namespace: string, op?: string) {
    super(
      op
        ? `Token is not allowed to ${op} namespace "${namespace}"`
        : `Token is not allowed to access namespace "${namespace}"`,
    );
    this.name = "ScopeError";
    this.namespace = namespace;
  }
}

/**
 * Throwing form of {@link namespaceAllowed}. Use inside MCP handlers
 * and helpers where a thrown ScopeError gets translated into a tool
 * error by `wrap()` in the MCP server.
 */
export function requireNamespace(
  principal: Principal,
  namespace: string,
  op?: string,
): void {
  if (!namespaceAllowed(principal, namespace)) {
    throw new ScopeError(namespace, op);
  }
}
