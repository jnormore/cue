import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type LogAppendResult,
  type LogEntry,
  type LogReadOpts,
  type LogReadResult,
  type LogStore,
  validateKey,
} from "../index.js";
import { validateNamespace } from "../../store/index.js";
import { isENOENT } from "../../store/fs/util.js";

const DEFAULT_READ_LIMIT = 1000;
const FILE_SUFFIX = ".ndjson";

interface MutexSlot {
  /** Chain: each new append awaits the previous one. */
  tail: Promise<unknown>;
  /** Highest seq already persisted on disk. */
  nextSeq: number;
  /** True once we've scanned the file to seed nextSeq. */
  seeded: boolean;
}

export function fsLog(home: string): LogStore {
  const root = join(home, "state", "logs");
  const nsDir = (namespace: string) => join(root, namespace);
  const keyFile = (namespace: string, key: string) =>
    join(nsDir(namespace), `${key}${FILE_SUFFIX}`);

  // Per-(ns, key) in-process mutex so concurrent appends serialize.
  // The daemon is the only writer, so this is sufficient.
  const slots = new Map<string, MutexSlot>();
  const slotFor = (namespace: string, key: string): MutexSlot => {
    const id = `${namespace}/${key}`;
    let s = slots.get(id);
    if (!s) {
      s = { tail: Promise.resolve(), nextSeq: 1, seeded: false };
      slots.set(id, s);
    }
    return s;
  };

  async function seedSlot(
    slot: MutexSlot,
    namespace: string,
    key: string,
  ): Promise<void> {
    if (slot.seeded) return;
    try {
      const raw = await readFile(keyFile(namespace, key), "utf8");
      let maxSeq = 0;
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
          const p = JSON.parse(line) as { seq?: number };
          if (typeof p.seq === "number" && p.seq > maxSeq) maxSeq = p.seq;
        } catch {
          // Skip corrupt lines; they should not exist but tolerating
          // them keeps the log usable after an unclean edit.
        }
      }
      slot.nextSeq = maxSeq + 1;
    } catch (err) {
      if (!isENOENT(err)) throw err;
      slot.nextSeq = 1;
    }
    slot.seeded = true;
  }

  return {
    async append(namespace, key, entry): Promise<LogAppendResult> {
      validateNamespace(namespace);
      validateKey(key);
      const slot = slotFor(namespace, key);
      const run = async () => {
        await seedSlot(slot, namespace, key);
        const seq = slot.nextSeq++;
        const at = new Date().toISOString();
        const line = `${JSON.stringify({ seq, at, entry })}\n`;
        await mkdir(nsDir(namespace), { recursive: true });
        await appendFile(keyFile(namespace, key), line);
        return { seq, at };
      };
      const prior = slot.tail;
      const next = prior.then(run, run);
      // Swallow rejections on the chain so a failing append doesn't
      // poison subsequent ones. The caller still sees the error.
      slot.tail = next.catch(() => undefined);
      return next;
    },

    async read(namespace, key, opts: LogReadOpts = {}): Promise<LogReadResult> {
      validateNamespace(namespace);
      validateKey(key);
      const since = opts.since ?? 0;
      const limit = opts.limit ?? DEFAULT_READ_LIMIT;
      let raw: string;
      try {
        raw = await readFile(keyFile(namespace, key), "utf8");
      } catch (err) {
        if (isENOENT(err)) return { entries: [], lastSeq: 0 };
        throw err;
      }
      const entries: LogEntry[] = [];
      let lastSeq = 0;
      for (const line of raw.split("\n")) {
        if (!line) continue;
        let p: LogEntry;
        try {
          p = JSON.parse(line) as LogEntry;
        } catch {
          continue;
        }
        if (typeof p.seq !== "number") continue;
        if (p.seq > lastSeq) lastSeq = p.seq;
        if (p.seq > since) entries.push(p);
      }
      // Entries are append-order, which is also seq-order.
      if (entries.length > limit) entries.length = limit;
      return { entries, lastSeq };
    },

    async list(namespace): Promise<string[]> {
      validateNamespace(namespace);
      try {
        const entries = await readdir(nsDir(namespace));
        return entries
          .filter((e) => e.endsWith(FILE_SUFFIX))
          .map((e) => e.slice(0, -FILE_SUFFIX.length))
          .sort();
      } catch (err) {
        if (isENOENT(err)) return [];
        throw err;
      }
    },

    async delete(namespace, key): Promise<void> {
      validateNamespace(namespace);
      validateKey(key);
      slots.delete(`${namespace}/${key}`);
      try {
        await rm(keyFile(namespace, key));
      } catch (err) {
        if (isENOENT(err)) return;
        throw err;
      }
    },

    async deleteNamespace(namespace): Promise<void> {
      validateNamespace(namespace);
      for (const id of Array.from(slots.keys())) {
        if (id.startsWith(`${namespace}/`)) slots.delete(id);
      }
      await rm(nsDir(namespace), { recursive: true, force: true });
    },
  };
}
