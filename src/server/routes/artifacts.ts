import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { type StoreAdapter, StoreError } from "../../store/index.js";
import { extractBearer } from "../auth.js";
import { assertNamespaceActive } from "../namespace-status.js";

export interface ArtifactsRouteOpts {
  store: StoreAdapter;
  /** Master token — also accepted on /u/* for operator preview. */
  token: string;
}

/**
 * Static-asset surface. `GET /u/:namespace/*` returns artifact bytes
 * with the recorded MIME type. Public artifacts (the default) need
 * no auth; non-public artifacts require the per-artifact view token
 * via either the `?t=` query param (URL-bearable so a `<script src>`
 * works) or `Authorization: Bearer …`.
 *
 * Lifecycle:
 *   • paused namespace  → 423 NamespacePaused (matches /w/:id behavior)
 *   • archived namespace → reads still work (read-only freeze, mutations
 *                          are blocked elsewhere)
 *   • missing namespace / artifact → 404
 */
export function artifactsRoutes(
  opts: ArtifactsRouteOpts,
): FastifyPluginAsync {
  return async (app) => {
    app.get<{
      Params: { namespace: string; "*": string };
      Querystring: { t?: string };
    }>("/u/:namespace/*", async (req, reply) => {
      const { namespace } = req.params;
      const path = req.params["*"];
      if (!path) {
        // Trailing-slash / bare-namespace requests have no resolution
        // strategy in v1 (no implicit index.html). Fail explicitly.
        reply.code(404).send({ error: "artifact path is required" });
        return;
      }

      let rec;
      try {
        rec = await opts.store.artifacts.get(namespace, path);
      } catch (err) {
        if (err instanceof StoreError && err.kind === "ValidationError") {
          reply.code(404).send({ error: err.message });
          return;
        }
        throw err;
      }
      if (!rec) {
        reply.code(404).send({ error: `Artifact not found` });
        return;
      }

      // Lifecycle gate. assertNamespaceActive throws StoreError on
      // paused/archived; the global error handler maps both to 423.
      // Reads of archived namespaces are explicitly allowed by the
      // lifecycle contract — only paused returns 423 here.
      try {
        await assertNamespaceActive(opts.store, namespace);
      } catch (err) {
        if (
          err instanceof StoreError &&
          err.kind === "NamespaceArchived"
        ) {
          // archived: reads pass through. Fall through to serve.
        } else {
          throw err;
        }
      }

      if (!rec.public) {
        const provided =
          (typeof req.query.t === "string" ? req.query.t : null) ??
          extractBearer(req);
        if (!provided) {
          reply.code(401).send({ error: "view token required" });
          return;
        }
        if (!constantTimeEq(provided, rec.viewToken, opts.token)) {
          reply.code(401).send({ error: "invalid view token" });
          return;
        }
      }

      const content = await opts.store.artifacts.read(namespace, path);
      if (content === null) {
        // Metadata row exists but blob is missing. Treat as 404 so
        // the caller doesn't get a misleading empty 200.
        reply.code(404).send({ error: "Artifact bytes missing" });
        return;
      }

      reply
        .header("Content-Type", rec.mimeType)
        .header("Content-Length", String(rec.size))
        .header("Cache-Control", "no-cache")
        .send(content);
    });
  };
}

/**
 * True if `provided` matches either the artifact's view token or the
 * master token, in constant time. Bytes-of-different-length always
 * compare false.
 */
function constantTimeEq(
  provided: string,
  viewToken: string,
  masterToken: string,
): boolean {
  return safeEq(provided, viewToken) || safeEq(provided, masterToken);
}

function safeEq(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
