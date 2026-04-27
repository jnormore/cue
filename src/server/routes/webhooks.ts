import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { type InvokeDeps, type InvokeEnvelope, invokeAction } from "../../invoke.js";
import type { WebhookAuthMode } from "../../store/index.js";
import { extractBearer } from "../auth.js";
import { assertNamespaceActive } from "../namespace-status.js";

/**
 * Webhook handler. Accepts GET and POST on /w/:id.
 *
 * - POST: typical "fire with a JSON body" use. Body lands at env.input.
 * - GET:  body-less invocation. env.input is null; query params are
 *         in env.request.query for actions that want REST-shaped reads.
 *
 * Allowing GET removes a real foot-gun: `fetch(url)` without options
 * defaults to GET, browser clicks are GET, `curl <url>` is GET. The
 * security story is: the trigger's `authMode` decides what gates the
 * URL — verb is always orthogonal. Actions that need to differentiate
 * read env.request.method.
 *
 * Auth modes (see WebhookAuthMode in store/index.ts for full rationale):
 *   • "bearer" — Authorization header or ?t=<token> must equal the
 *     trigger's webhookToken. The default; what server-to-server callers
 *     and the v1 daemon used universally.
 *   • "public" — no token check. Action MUST authenticate the caller
 *     itself (e.g. Stripe-Signature HMAC). For inbound third-party hooks.
 *   • "artifact-session" — ?t=<token> must equal the viewToken of any
 *     non-public artifact in the trigger's namespace. Lets a private
 *     dashboard at /u/<ns>/x.html?t=<viewToken> call read-only triggers
 *     using the same token that gates the page.
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
      const authMode: WebhookAuthMode = trigger.config.authMode;
      const authResult = await checkAuth(deps, req, trigger.namespace, {
        authMode,
        triggerToken: trigger.config.token,
      });
      if (!authResult.ok) {
        reply.code(authResult.code).send({ error: authResult.error });
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
          auth: authMode,
        },
      };
      const result = await invokeAction(deps, action, envelope);

      // The webhook URL is a public HTTP endpoint — what comes back over
      // the wire should be the action's response, not the runtime's
      // InvokeResult envelope (which is just platform-side metadata: run
      // id, exit code, stdout/stderr, etc.). Two well-known shapes for
      // an action's stdout:
      //
      //   1. Lambda/Express style: { status|statusCode, headers?, body }
      //      → emit `body` with that status + headers.
      //   2. Plain JSON: anything else (`{ok:true, ...}`, `[1,2,3]`, etc.)
      //      → emit it as 200 application/json.
      //
      // Both let an agent-built dashboard call /w/<trigger> with no
      // JSON-in-JSON parsing and no special daemon knowledge. The
      // InvokeResult envelope is only returned when the action printed
      // nothing parseable — useful as a debug fallback so callers see
      // *something* explanatory.
      if (result.exitCode !== 0) {
        reply.code(500);
        return {
          error: "Action failed",
          exitCode: result.exitCode,
          // stderr can carry the worker's error trace; cap to avoid
          // dumping megabytes onto unsuspecting callers.
          stderr: result.stderr.slice(0, 8 * 1024),
          runId: result.runId,
        };
      }
      const httpish = detectHttpResponse(result.output);
      if (httpish) {
        reply.code(httpish.status);
        if (httpish.headers) {
          for (const [k, v] of Object.entries(httpish.headers)) {
            reply.header(k, v);
          }
        }
        return reply.send(httpish.body);
      }
      if (result.output !== null && result.output !== undefined) {
        return reply.code(200).send(result.output);
      }
      // Action exited 0 but didn't print parseable JSON. Surface the
      // InvokeResult so an operator can see what happened — caller will
      // get a structured error rather than a confusing empty 200.
      reply.code(502);
      return {
        error: "Action did not return JSON",
        runId: result.runId,
        stdout: result.stdout.slice(0, 4 * 1024),
        stderr: result.stderr.slice(0, 4 * 1024),
      };
    };

    app.route({ method: ["GET", "POST"], url: "/w/:id", handler });
  };
}

type AuthCheckResult =
  | { ok: true }
  | { ok: false; code: 401; error: string };

interface AuthCheckCtx {
  authMode: WebhookAuthMode;
  triggerToken: string;
}

async function checkAuth(
  deps: InvokeDeps,
  req: FastifyRequest,
  namespace: string,
  ctx: AuthCheckCtx,
): Promise<AuthCheckResult> {
  if (ctx.authMode === "public") {
    // Wire-level auth disabled; the action handles authentication itself.
    return { ok: true };
  }

  // Both remaining modes accept the token via Authorization header or
  // ?t=<token> query param. Header is the standard for programmatic
  // calls; ?t= is there so a browser GET (anchor click, fetch without
  // explicit headers, curl with no auth flag) can carry the token.
  // Same security story — the channel doesn't matter, only the token.
  const queryToken =
    typeof (req.query as { t?: unknown } | undefined)?.t === "string"
      ? (req.query as { t: string }).t
      : null;
  const provided = queryToken ?? extractBearer(req);
  if (!provided) {
    return { ok: false, code: 401, error: "Missing bearer token" };
  }

  if (ctx.authMode === "bearer") {
    if (!safeEq(provided, ctx.triggerToken)) {
      return { ok: false, code: 401, error: "Invalid webhook token" };
    }
    return { ok: true };
  }

  // artifact-session: token must equal the viewToken of a non-public
  // artifact in the trigger's namespace. We don't accept the trigger's
  // own bearer token here — the whole point of this mode is that no
  // long-lived secret is in the page; the viewToken is the only proof
  // of authorization. Falling back to bearer would defeat the design.
  const match = await deps.store.artifacts.findByViewToken(
    namespace,
    provided,
  );
  if (!match) {
    return { ok: false, code: 401, error: "Invalid artifact session token" };
  }
  return { ok: true };
}

function safeEq(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

interface HttpishResponse {
  status: number;
  headers?: Record<string, string | number | boolean>;
  body: unknown;
}

/**
 * Recognize an action's stdout JSON as an HTTP response. The shape:
 *
 *   { status: number, body: unknown, headers?: object }
 *
 * `statusCode` is also accepted as an alias for `status` (matches the
 * Lambda gateway convention many agents have seen in training). Headers
 * must be a plain object if present. The `body` key must be present
 * (`null` is fine — distinguishes "I'm declaring an HTTP response, body
 * is null" from "I'm not declaring an HTTP response").
 *
 * Conservative on purpose: we only treat output as HTTP-shaped when ALL
 * three constraints hold (numeric status in [100, 599], `body` key
 * present, headers either absent or a plain object). Anything else
 * falls through to the legacy InvokeResult-JSON behavior.
 */
export function detectHttpResponse(output: unknown): HttpishResponse | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return null;
  }
  const o = output as Record<string, unknown>;
  const statusRaw = typeof o.status === "number" ? o.status : o.statusCode;
  if (typeof statusRaw !== "number" || !Number.isInteger(statusRaw)) {
    return null;
  }
  if (statusRaw < 100 || statusRaw > 599) return null;
  if (!("body" in o)) return null;

  let headers: HttpishResponse["headers"];
  if (o.headers !== undefined) {
    if (
      typeof o.headers !== "object" ||
      o.headers === null ||
      Array.isArray(o.headers)
    ) {
      // Malformed headers — refuse to treat the whole thing as HTTP-ish
      // rather than silently dropping them.
      return null;
    }
    const safe: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        safe[k] = v;
      }
    }
    headers = safe;
  }

  return { status: statusRaw, body: o.body, headers };
}
