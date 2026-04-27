import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BlobStore } from "../../../blob/index.js";
import { detectMimeType } from "../../../util/mime.js";
import {
  ARTIFACT_MAX_BYTES,
  type ArtifactRecord,
  type ArtifactStore,
  type ArtifactSummary,
  StoreError,
  validateArtifactPath,
  validateNamespace,
} from "../../index.js";

interface ArtifactRow {
  namespace: string;
  path: string;
  mime_type: string;
  size: number;
  public: number; // 0/1
  view_token: string;
  created_at: string;
  updated_at: string;
}

const blobKey = (namespace: string, path: string) =>
  `artifacts/${namespace}/${path}`;

function newViewToken(): string {
  return `art_${randomBytes(24).toString("hex")}`;
}

function toRecord(r: ArtifactRow): ArtifactRecord {
  return {
    namespace: r.namespace,
    path: r.path,
    mimeType: r.mime_type,
    size: r.size,
    public: r.public !== 0,
    viewToken: r.view_token,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toSummary(r: ArtifactRow): ArtifactSummary {
  return {
    namespace: r.namespace,
    path: r.path,
    mimeType: r.mime_type,
    size: r.size,
    public: r.public !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function bufFor(content: string | Buffer): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
}

function assertSize(size: number): void {
  if (size > ARTIFACT_MAX_BYTES) {
    throw new StoreError(
      "ValidationError",
      `Artifact is ${size} bytes, exceeds ${ARTIFACT_MAX_BYTES} byte cap`,
      { size, maxBytes: ARTIFACT_MAX_BYTES },
    );
  }
}

export function sqliteArtifacts(
  db: DatabaseSync,
  blob: BlobStore,
): ArtifactStore {
  return {
    async get(namespace, path) {
      validateNamespace(namespace);
      validateArtifactPath(path);
      const row = db
        .prepare(
          "SELECT * FROM artifacts WHERE namespace = ? AND path = ?",
        )
        .get(namespace, path) as ArtifactRow | undefined;
      return row ? toRecord(row) : null;
    },

    async list(namespace) {
      validateNamespace(namespace);
      const rows = db
        .prepare(
          "SELECT * FROM artifacts WHERE namespace = ? ORDER BY path",
        )
        .all(namespace) as unknown as ArtifactRow[];
      return rows.map(toSummary);
    },

    async create(input) {
      validateNamespace(input.namespace);
      validateArtifactPath(input.path);
      const buf = bufFor(input.content);
      assertSize(buf.length);
      const collision = db
        .prepare(
          "SELECT path FROM artifacts WHERE namespace = ? AND path = ?",
        )
        .get(input.namespace, input.path) as { path: string } | undefined;
      if (collision) {
        throw new StoreError(
          "NameCollision",
          `Artifact "${input.path}" already exists in namespace "${input.namespace}"`,
          { namespace: input.namespace, path: input.path },
        );
      }
      const mimeType = input.mimeType ?? detectMimeType(input.path);
      const isPublic = input.public ?? true;
      const viewToken = isPublic ? "" : newViewToken();
      const now = new Date().toISOString();
      // Write blob first so a metadata row never references missing
      // bytes. If the row insert below fails, the blob is orphaned but
      // a retry succeeds.
      await blob.put(blobKey(input.namespace, input.path), buf);
      db.prepare(
        `INSERT INTO artifacts
           (namespace, path, mime_type, size, public, view_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.namespace,
        input.path,
        mimeType,
        buf.length,
        isPublic ? 1 : 0,
        viewToken,
        now,
        now,
      );
      return {
        namespace: input.namespace,
        path: input.path,
        mimeType,
        size: buf.length,
        public: isPublic,
        viewToken,
        createdAt: now,
        updatedAt: now,
      };
    },

    async update(namespace, path, patch) {
      validateNamespace(namespace);
      validateArtifactPath(path);
      const existing = db
        .prepare(
          "SELECT * FROM artifacts WHERE namespace = ? AND path = ?",
        )
        .get(namespace, path) as ArtifactRow | undefined;
      if (!existing) {
        throw new StoreError(
          "NotFound",
          `Artifact "${path}" not found in namespace "${namespace}"`,
          { namespace, path },
        );
      }
      let nextSize = existing.size;
      let nextMime = existing.mime_type;
      if (patch.content !== undefined) {
        const buf = bufFor(patch.content);
        assertSize(buf.length);
        await blob.put(blobKey(namespace, path), buf);
        nextSize = buf.length;
        // re-detect MIME if the agent didn't override it AND content
        // changed — in case the path implies a different type now
        if (patch.mimeType === undefined) nextMime = detectMimeType(path);
      }
      if (patch.mimeType !== undefined) nextMime = patch.mimeType;
      // Token rotates on every public ↔ non-public transition. Toggling
      // back to public clears the token; toggling to non-public mints
      // a fresh one. Updates that don't change `public` keep the
      // existing token.
      let nextPublic = existing.public !== 0;
      let nextToken = existing.view_token;
      if (patch.public !== undefined && patch.public !== nextPublic) {
        nextPublic = patch.public;
        nextToken = nextPublic ? "" : newViewToken();
      }
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE artifacts
            SET mime_type = ?, size = ?, public = ?, view_token = ?, updated_at = ?
          WHERE namespace = ? AND path = ?`,
      ).run(
        nextMime,
        nextSize,
        nextPublic ? 1 : 0,
        nextToken,
        now,
        namespace,
        path,
      );
      return {
        namespace,
        path,
        mimeType: nextMime,
        size: nextSize,
        public: nextPublic,
        viewToken: nextToken,
        createdAt: existing.created_at,
        updatedAt: now,
      };
    },

    async delete(namespace, path) {
      validateNamespace(namespace);
      validateArtifactPath(path);
      const result = db
        .prepare("DELETE FROM artifacts WHERE namespace = ? AND path = ?")
        .run(namespace, path);
      if (result.changes === 0) {
        throw new StoreError(
          "NotFound",
          `Artifact "${path}" not found in namespace "${namespace}"`,
          { namespace, path },
        );
      }
      await blob.delete(blobKey(namespace, path));
    },

    async deleteNamespace(namespace) {
      validateNamespace(namespace);
      const rows = db
        .prepare("SELECT path FROM artifacts WHERE namespace = ?")
        .all(namespace) as unknown as { path: string }[];
      const paths = rows.map((r) => r.path);
      db.prepare("DELETE FROM artifacts WHERE namespace = ?").run(namespace);
      // One blob-prefix delete covers every artifact path.
      await blob.deleteByPrefix(`artifacts/${namespace}/`);
      return paths;
    },

    async read(namespace, path) {
      validateNamespace(namespace);
      validateArtifactPath(path);
      return blob.get(blobKey(namespace, path));
    },

    async findByViewToken(namespace, token) {
      validateNamespace(namespace);
      // Empty input never matches: public artifacts store an empty token,
      // and we don't want `findByViewToken(ns, "")` to silently return one.
      if (!token) return null;
      const rows = db
        .prepare(
          "SELECT * FROM artifacts WHERE namespace = ? AND public = 0",
        )
        .all(namespace) as unknown as ArtifactRow[];
      // Walk every row and compare in constant time. We don't `WHERE
      // view_token = ?` because that's a non-constant-time string compare
      // inside SQLite — at the cost of an irrelevant timing leak for what
      // is already a short list (the agent ships ~1-5 artifacts per app).
      const candidate = Buffer.from(token);
      let match: ArtifactRow | null = null;
      for (const r of rows) {
        const stored = Buffer.from(r.view_token);
        if (stored.length !== candidate.length) continue;
        if (timingSafeEqual(stored, candidate)) match = r;
      }
      return match ? toRecord(match) : null;
    },
  };
}
