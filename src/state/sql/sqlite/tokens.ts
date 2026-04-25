import { timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { validateNamespace } from "../../../store/index.js";
import {
  mintToken,
  type NamespaceTokenStore,
  parseTokenNamespace,
} from "../../index.js";

interface TokenRow {
  namespace: string;
  token: string;
}

export function sqliteNamespaceTokens(db: DatabaseSync): NamespaceTokenStore {
  return {
    async resolveOrCreate(namespace: string): Promise<string> {
      validateNamespace(namespace);
      const existing = db
        .prepare("SELECT token FROM state_tokens WHERE namespace = ?")
        .get(namespace) as { token: string } | undefined;
      if (existing) return existing.token;
      const token = mintToken(namespace);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO state_tokens (namespace, token, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT (namespace) DO NOTHING`,
      ).run(namespace, token, now);
      // Re-read to handle the rare conflict case (another caller raced
      // us). In that case our INSERT was a no-op; we should return the
      // token that won.
      const winner = db
        .prepare("SELECT token FROM state_tokens WHERE namespace = ?")
        .get(namespace) as { token: string } | undefined;
      return winner?.token ?? token;
    },

    async verify(token: string): Promise<string | null> {
      const ns = parseTokenNamespace(token);
      if (!ns) return null;
      const row = db
        .prepare("SELECT * FROM state_tokens WHERE namespace = ?")
        .get(ns) as TokenRow | undefined;
      if (!row) return null;
      const a = Buffer.from(token);
      const b = Buffer.from(row.token);
      if (a.length !== b.length) return null;
      return timingSafeEqual(a, b) ? ns : null;
    },

    async deleteNamespace(namespace: string): Promise<void> {
      validateNamespace(namespace);
      db.prepare("DELETE FROM state_tokens WHERE namespace = ?").run(namespace);
    },
  };
}
