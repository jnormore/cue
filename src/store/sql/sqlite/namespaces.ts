import type { DatabaseSync } from "node:sqlite";
import {
  type NamespaceRecord,
  type NamespaceStatus,
  type NamespaceStore,
  StoreError,
  validateNamespace,
} from "../../index.js";

interface NamespaceRow {
  name: string;
  display_name: string | null;
  description: string | null;
  status: NamespaceStatus;
  created_at: string;
  updated_at: string;
}

function toRecord(r: NamespaceRow): NamespaceRecord {
  const out: NamespaceRecord = {
    name: r.name,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.display_name !== null) out.displayName = r.display_name;
  if (r.description !== null) out.description = r.description;
  return out;
}

export function sqliteNamespaces(db: DatabaseSync): NamespaceStore {
  return {
    async get(name) {
      const row = db
        .prepare("SELECT * FROM namespaces WHERE name = ?")
        .get(name) as NamespaceRow | undefined;
      return row ? toRecord(row) : null;
    },

    async list() {
      const rows = db
        .prepare("SELECT * FROM namespaces ORDER BY name")
        .all() as unknown as NamespaceRow[];
      return rows.map(toRecord);
    },

    async upsert(record) {
      validateNamespace(record.name);
      db.prepare(
        `INSERT INTO namespaces (name, display_name, description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET
           display_name = excluded.display_name,
           description  = excluded.description,
           status       = excluded.status,
           updated_at   = excluded.updated_at`,
      ).run(
        record.name,
        record.displayName ?? null,
        record.description ?? null,
        record.status,
        record.createdAt,
        record.updatedAt,
      );
      return record;
    },

    async update(name, patch) {
      validateNamespace(name);
      const existing = db
        .prepare("SELECT * FROM namespaces WHERE name = ?")
        .get(name) as NamespaceRow | undefined;
      if (!existing) {
        throw new StoreError("NotFound", `Namespace "${name}" not found`, {
          name,
        });
      }
      const next: NamespaceRow = {
        name: existing.name,
        display_name:
          patch.displayName === undefined
            ? existing.display_name
            : patch.displayName,
        description:
          patch.description === undefined
            ? existing.description
            : patch.description,
        status: patch.status ?? existing.status,
        created_at: existing.created_at,
        updated_at: new Date().toISOString(),
      };
      db.prepare(
        `UPDATE namespaces
            SET display_name = ?, description = ?, status = ?, updated_at = ?
          WHERE name = ?`,
      ).run(
        next.display_name,
        next.description,
        next.status,
        next.updated_at,
        next.name,
      );
      return toRecord(next);
    },

    async delete(name) {
      validateNamespace(name);
      db.prepare("DELETE FROM namespaces WHERE name = ?").run(name);
    },
  };
}
