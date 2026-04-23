import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
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
} from "../index.js";
import { isENOENT, writeFileAtomic, writeJsonAtomic } from "./util.js";

interface ActionMetaOnDisk {
  id: string;
  name: string;
  namespace: string;
  createdAt: string;
  updatedAt: string;
}

export function fsActions(home: string): ActionStore {
  const actionsDir = join(home, "actions");

  const dirFor = (id: string) => join(actionsDir, id);
  const metaFor = (id: string) => join(dirFor(id), "meta.json");
  const codeFor = (id: string) => join(dirFor(id), "code.js");
  const policyFor = (id: string) => join(dirFor(id), "policy.toml");

  async function readMeta(id: string): Promise<ActionMetaOnDisk | null> {
    try {
      const raw = await readFile(metaFor(id), "utf8");
      return JSON.parse(raw) as ActionMetaOnDisk;
    } catch (err) {
      if (isENOENT(err)) return null;
      throw err;
    }
  }

  async function readPolicy(id: string): Promise<Policy> {
    try {
      const raw = await readFile(policyFor(id), "utf8");
      if (raw.trim() === "") return {};
      return parseToml(raw) as Policy;
    } catch (err) {
      if (isENOENT(err)) return {};
      throw err;
    }
  }

  async function loadRecord(id: string): Promise<ActionRecord | null> {
    const meta = await readMeta(id);
    if (!meta) return null;
    const [code, policy] = await Promise.all([
      readFile(codeFor(id), "utf8"),
      readPolicy(id),
    ]);
    return { ...meta, code, policy };
  }

  async function listSummaries(): Promise<ActionSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(actionsDir);
    } catch (err) {
      if (isENOENT(err)) return [];
      throw err;
    }
    const results: ActionSummary[] = [];
    for (const entry of entries) {
      if (!entry.startsWith("act_")) continue;
      const meta = await readMeta(entry);
      if (meta) results.push(meta);
    }
    return results;
  }

  return {
    async create(input) {
      validateName(input.name);
      const namespace = input.namespace ?? DEFAULT_NAMESPACE;
      validateNamespace(namespace);
      const summaries = await listSummaries();
      const collision = summaries.find(
        (s) => s.namespace === namespace && s.name === input.name,
      );
      if (collision) {
        throw new StoreError(
          "NameCollision",
          `Action "${input.name}" already exists in namespace "${namespace}"`,
          { existingId: collision.id },
        );
      }
      const now = new Date().toISOString();
      const id = newActionId();
      const meta: ActionMetaOnDisk = {
        id,
        name: input.name,
        namespace,
        createdAt: now,
        updatedAt: now,
      };
      const policy = input.policy ?? {};
      await mkdir(dirFor(id), { recursive: true });
      await Promise.all([
        writeJsonAtomic(metaFor(id), meta),
        writeFileAtomic(codeFor(id), input.code),
        writeFileAtomic(policyFor(id), stringifyToml(policy)),
      ]);
      return { ...meta, code: input.code, policy };
    },

    async get(id) {
      return loadRecord(id);
    },

    async list(filter) {
      const summaries = await listSummaries();
      return summaries
        .filter((s) => !filter?.namespace || s.namespace === filter.namespace)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async update(id, patch) {
      const existing = await loadRecord(id);
      if (!existing) {
        throw new StoreError("NotFound", `Action ${id} not found`, { id });
      }
      if (patch.name !== undefined) validateName(patch.name);
      if (patch.name !== undefined && patch.name !== existing.name) {
        const summaries = await listSummaries();
        const collision = summaries.find(
          (s) =>
            s.id !== id &&
            s.namespace === existing.namespace &&
            s.name === patch.name,
        );
        if (collision) {
          throw new StoreError(
            "NameCollision",
            `Action "${patch.name}" already exists in namespace "${existing.namespace}"`,
            { existingId: collision.id },
          );
        }
      }
      const now = new Date().toISOString();
      const meta: ActionMetaOnDisk = {
        id,
        name: patch.name ?? existing.name,
        namespace: existing.namespace,
        createdAt: existing.createdAt,
        updatedAt: now,
      };
      const code = patch.code ?? existing.code;
      const policy = patch.policy ?? existing.policy;
      const writes: Promise<void>[] = [writeJsonAtomic(metaFor(id), meta)];
      if (patch.code !== undefined) {
        writes.push(writeFileAtomic(codeFor(id), code));
      }
      if (patch.policy !== undefined) {
        writes.push(writeFileAtomic(policyFor(id), stringifyToml(policy)));
      }
      await Promise.all(writes);
      return { ...meta, code, policy };
    },

    async delete(id) {
      try {
        await rm(dirFor(id), { recursive: true, force: false });
      } catch (err) {
        if (isENOENT(err)) {
          throw new StoreError("NotFound", `Action ${id} not found`, { id });
        }
        throw err;
      }
    },
  };
}
