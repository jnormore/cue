import type { DatabaseSync } from "node:sqlite";
import {
  type SecretStore,
  validateNamespace,
  validateSecretName,
} from "../../index.js";

interface SecretRow {
  namespace: string;
  name: string;
  value: string;
}

export function sqliteSecrets(db: DatabaseSync): SecretStore {
  return {
    async set(namespace, name, value) {
      validateNamespace(namespace);
      validateSecretName(name);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO secrets (namespace, name, value, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (namespace, name) DO UPDATE SET value = excluded.value`,
      ).run(namespace, name, value, now);
    },

    async list(namespace) {
      validateNamespace(namespace);
      const rows = db
        .prepare(
          "SELECT name FROM secrets WHERE namespace = ? ORDER BY name",
        )
        .all(namespace) as unknown as { name: string }[];
      return rows.map((r) => r.name);
    },

    async resolve(namespace, names) {
      validateNamespace(namespace);
      if (names.length === 0) return {};
      const placeholders = names.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT name, value FROM secrets
            WHERE namespace = ? AND name IN (${placeholders})`,
        )
        .all(namespace, ...(names as string[])) as unknown as SecretRow[];
      const out: Record<string, string> = {};
      for (const r of rows) out[r.name] = r.value;
      return out;
    },

    async delete(namespace, name) {
      validateNamespace(namespace);
      validateSecretName(name);
      db.prepare("DELETE FROM secrets WHERE namespace = ? AND name = ?").run(
        namespace,
        name,
      );
    },

    async deleteNamespace(namespace) {
      validateNamespace(namespace);
      db.prepare("DELETE FROM secrets WHERE namespace = ?").run(namespace);
    },
  };
}
