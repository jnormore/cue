import type { DatabaseSync } from "node:sqlite";
import {
  type ConfigEntry,
  type ConfigStore,
  validateConfigName,
  validateNamespace,
} from "../../index.js";

interface ConfigRow {
  namespace: string;
  name: string;
  value: string;
  created_at: string;
  updated_at: string;
}

export function sqliteConfigs(db: DatabaseSync): ConfigStore {
  return {
    async set(namespace, name, value) {
      validateNamespace(namespace);
      validateConfigName(name);
      const now = new Date().toISOString();
      // Preserve created_at on update so the dashboard can show "added 3
      // days ago" accurately. Conflict updates value + updated_at only.
      db.prepare(
        `INSERT INTO configs (namespace, name, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (namespace, name) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      ).run(namespace, name, value, now, now);
    },

    async get(namespace, name) {
      validateNamespace(namespace);
      validateConfigName(name);
      const row = db
        .prepare(
          "SELECT value FROM configs WHERE namespace = ? AND name = ?",
        )
        .get(namespace, name) as { value: string } | undefined;
      return row ? row.value : null;
    },

    async list(namespace) {
      validateNamespace(namespace);
      const rows = db
        .prepare(
          "SELECT name, value, created_at, updated_at FROM configs WHERE namespace = ? ORDER BY name",
        )
        .all(namespace) as unknown as ConfigRow[];
      return rows.map(
        (r): ConfigEntry => ({
          name: r.name,
          value: r.value,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        }),
      );
    },

    async resolve(namespace, names) {
      validateNamespace(namespace);
      if (names.length === 0) return {};
      const placeholders = names.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT name, value FROM configs
            WHERE namespace = ? AND name IN (${placeholders})`,
        )
        .all(namespace, ...(names as string[])) as unknown as {
        name: string;
        value: string;
      }[];
      const out: Record<string, string> = {};
      for (const r of rows) out[r.name] = r.value;
      return out;
    },

    async delete(namespace, name) {
      validateNamespace(namespace);
      validateConfigName(name);
      db.prepare("DELETE FROM configs WHERE namespace = ? AND name = ?").run(
        namespace,
        name,
      );
    },

    async deleteNamespace(namespace) {
      validateNamespace(namespace);
      db.prepare("DELETE FROM configs WHERE namespace = ?").run(namespace);
    },
  };
}
