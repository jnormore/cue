import type { DatabaseSync } from "node:sqlite";
import {
  type ActionRecord,
  type ActionStore,
  type ActionSummary,
  DEFAULT_NAMESPACE,
  type Policy,
  StoreError,
  newActionId,
  validateName,
  validateNamespace,
} from "../../index.js";

interface ActionRow {
  id: string;
  name: string;
  namespace: string;
  code: string;
  policy: string;
  created_at: string;
  updated_at: string;
}

function toRecord(r: ActionRow): ActionRecord {
  return {
    id: r.id,
    name: r.name,
    namespace: r.namespace,
    code: r.code,
    policy: JSON.parse(r.policy) as Policy,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toSummary(r: ActionRow): ActionSummary {
  return {
    id: r.id,
    name: r.name,
    namespace: r.namespace,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function sqliteActions(db: DatabaseSync): ActionStore {
  return {
    async create(input) {
      validateName(input.name);
      const namespace = input.namespace ?? DEFAULT_NAMESPACE;
      validateNamespace(namespace);
      const collision = db
        .prepare("SELECT id FROM actions WHERE namespace = ? AND name = ?")
        .get(namespace, input.name) as { id: string } | undefined;
      if (collision) {
        throw new StoreError(
          "NameCollision",
          `Action "${input.name}" already exists in namespace "${namespace}"`,
          { existingId: collision.id },
        );
      }
      const now = new Date().toISOString();
      const id = newActionId();
      const policy = input.policy ?? {};
      db.prepare(
        `INSERT INTO actions (id, name, namespace, code, policy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.name, namespace, input.code, JSON.stringify(policy), now, now);
      return {
        id,
        name: input.name,
        namespace,
        code: input.code,
        policy,
        createdAt: now,
        updatedAt: now,
      };
    },

    async get(id) {
      const row = db
        .prepare("SELECT * FROM actions WHERE id = ?")
        .get(id) as ActionRow | undefined;
      return row ? toRecord(row) : null;
    },

    async list(filter) {
      const rows = (
        filter?.namespace
          ? (db
              .prepare(
                "SELECT * FROM actions WHERE namespace = ? ORDER BY created_at",
              )
              .all(filter.namespace) as unknown as ActionRow[])
          : (db
              .prepare("SELECT * FROM actions ORDER BY created_at")
              .all() as unknown as ActionRow[])
      );
      return rows.map(toSummary);
    },

    async update(id, patch) {
      const existing = db
        .prepare("SELECT * FROM actions WHERE id = ?")
        .get(id) as ActionRow | undefined;
      if (!existing) {
        throw new StoreError("NotFound", `Action ${id} not found`, { id });
      }
      const newName = patch.name ?? existing.name;
      if (patch.name !== undefined) validateName(patch.name);
      if (patch.name !== undefined && patch.name !== existing.name) {
        const collision = db
          .prepare(
            "SELECT id FROM actions WHERE namespace = ? AND name = ? AND id != ?",
          )
          .get(existing.namespace, patch.name, id) as
          | { id: string }
          | undefined;
        if (collision) {
          throw new StoreError(
            "NameCollision",
            `Action "${patch.name}" already exists in namespace "${existing.namespace}"`,
            { existingId: collision.id },
          );
        }
      }
      const newCode = patch.code ?? existing.code;
      const newPolicy = patch.policy ?? (JSON.parse(existing.policy) as Policy);
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE actions
            SET name = ?, code = ?, policy = ?, updated_at = ?
          WHERE id = ?`,
      ).run(newName, newCode, JSON.stringify(newPolicy), now, id);
      return {
        id,
        name: newName,
        namespace: existing.namespace,
        code: newCode,
        policy: newPolicy,
        createdAt: existing.created_at,
        updatedAt: now,
      };
    },

    async delete(id) {
      const result = db.prepare("DELETE FROM actions WHERE id = ?").run(id);
      if (result.changes === 0) {
        throw new StoreError("NotFound", `Action ${id} not found`, { id });
      }
    },
  };
}
