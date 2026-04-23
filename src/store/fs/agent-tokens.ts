import { timingSafeEqual } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
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
} from "../index.js";
import { isENOENT } from "./util.js";

const TOKEN_FILE_MODE = 0o600;

interface OnDiskRecord extends AgentTokenRecord {}

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

function toSummary(r: OnDiskRecord): AgentTokenSummary {
  const s: AgentTokenSummary = {
    id: r.id,
    scope: r.scope,
    createdAt: r.createdAt,
  };
  if (r.label !== undefined) s.label = r.label;
  return s;
}

export function fsAgentTokens(home: string): AgentTokenStore {
  const root = join(home, "agent-tokens");
  const fileFor = (id: AgentTokenId) => join(root, `${id}.json`);

  async function readRecord(id: AgentTokenId): Promise<OnDiskRecord | null> {
    try {
      const raw = await readFile(fileFor(id), "utf8");
      return JSON.parse(raw) as OnDiskRecord;
    } catch (err) {
      if (isENOENT(err)) return null;
      throw err;
    }
  }

  async function writeAtomic0600(path: string, data: string): Promise<void> {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, data, { mode: TOKEN_FILE_MODE });
    await chmod(tmp, TOKEN_FILE_MODE);
    await rename(tmp, path);
  }

  return {
    async mint(input: AgentTokenCreateInput): Promise<AgentTokenRecord> {
      assertScope(input.scope);
      const id = newAgentTokenId();
      const token = mintAgentTokenBearer(id);
      const record: OnDiskRecord = {
        id,
        token,
        scope: {
          namespaces: [...new Set(input.scope.namespaces)].sort(),
        },
        createdAt: new Date().toISOString(),
      };
      if (input.label !== undefined) record.label = input.label;
      await mkdir(root, { recursive: true });
      await writeAtomic0600(fileFor(id), JSON.stringify(record, null, 2));
      return record;
    },

    async list(): Promise<AgentTokenSummary[]> {
      let names: string[];
      try {
        names = await readdir(root);
      } catch (err) {
        if (isENOENT(err)) return [];
        throw err;
      }
      const out: AgentTokenSummary[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -".json".length);
        const r = await readRecord(id);
        if (r) out.push(toSummary(r));
      }
      out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return out;
    },

    async get(id: AgentTokenId): Promise<AgentTokenSummary | null> {
      const r = await readRecord(id);
      return r ? toSummary(r) : null;
    },

    async verify(token: string): Promise<AgentTokenSummary | null> {
      const id = parseAgentTokenId(token);
      if (!id) return null;
      const r = await readRecord(id);
      if (!r) return null;
      const a = Buffer.from(token);
      const b = Buffer.from(r.token);
      if (a.length !== b.length) return null;
      return timingSafeEqual(a, b) ? toSummary(r) : null;
    },

    async delete(id: AgentTokenId): Promise<void> {
      try {
        await rm(fileFor(id));
      } catch (err) {
        if (isENOENT(err)) return;
        throw err;
      }
    },
  };
}
