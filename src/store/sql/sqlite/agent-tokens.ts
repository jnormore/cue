import { timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type AgentScope,
  type AgentTokenCreateInput,
  type AgentTokenId,
  type AgentTokenRecord,
  type AgentTokenStore,
  type AgentTokenSummary,
  StoreError,
  mintAgentTokenBearer,
  newAgentTokenId,
  parseAgentTokenId,
  validateNamespace,
} from "../../index.js";

interface AgentTokenRow {
  id: string;
  token: string;
  scope: string;
  label: string | null;
  created_at: string;
}

function assertScope(scope: AgentScope): void {
  if (!Array.isArray(scope.namespaces)) {
    throw new StoreError(
      "ValidationError",
      "scope.namespaces must be an array",
    );
  }
  if (scope.namespaces.length === 0) {
    throw new StoreError(
      "ValidationError",
      "scope.namespaces must contain at least one namespace",
    );
  }
  for (const ns of scope.namespaces) validateNamespace(ns);
}

function toSummary(r: AgentTokenRow): AgentTokenSummary {
  const out: AgentTokenSummary = {
    id: r.id,
    scope: JSON.parse(r.scope) as AgentScope,
    createdAt: r.created_at,
  };
  if (r.label !== null) out.label = r.label;
  return out;
}

export function sqliteAgentTokens(db: DatabaseSync): AgentTokenStore {
  return {
    async mint(input: AgentTokenCreateInput): Promise<AgentTokenRecord> {
      assertScope(input.scope);
      const id = newAgentTokenId();
      const token = mintAgentTokenBearer(id);
      const scope: AgentScope = {
        namespaces: [...new Set(input.scope.namespaces)].sort(),
      };
      const createdAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO agent_tokens (id, token, scope, label, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        id,
        token,
        JSON.stringify(scope),
        input.label ?? null,
        createdAt,
      );
      const record: AgentTokenRecord = {
        id,
        token,
        scope,
        createdAt,
      };
      if (input.label !== undefined) record.label = input.label;
      return record;
    },

    async list(): Promise<AgentTokenSummary[]> {
      const rows = db
        .prepare("SELECT * FROM agent_tokens ORDER BY created_at")
        .all() as unknown as AgentTokenRow[];
      return rows.map(toSummary);
    },

    async get(id: AgentTokenId): Promise<AgentTokenSummary | null> {
      const row = db
        .prepare("SELECT * FROM agent_tokens WHERE id = ?")
        .get(id) as AgentTokenRow | undefined;
      return row ? toSummary(row) : null;
    },

    async verify(token: string): Promise<AgentTokenSummary | null> {
      const id = parseAgentTokenId(token);
      if (!id) return null;
      const row = db
        .prepare("SELECT * FROM agent_tokens WHERE id = ?")
        .get(id) as AgentTokenRow | undefined;
      if (!row) return null;
      const a = Buffer.from(token);
      const b = Buffer.from(row.token);
      if (a.length !== b.length) return null;
      return timingSafeEqual(a, b) ? toSummary(row) : null;
    },

    async delete(id: AgentTokenId): Promise<void> {
      db.prepare("DELETE FROM agent_tokens WHERE id = ?").run(id);
    },
  };
}
