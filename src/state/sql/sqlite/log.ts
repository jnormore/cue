import type { DatabaseSync } from "node:sqlite";
import { validateNamespace } from "../../../store/index.js";
import {
  type LogAppendResult,
  type LogEntry,
  type LogReadOpts,
  type LogReadResult,
  type LogStore,
  validateEntrySize,
  validateKey,
} from "../../index.js";

interface LogRow {
  seq: number;
  at: string;
  entry: string;
}

const DEFAULT_READ_LIMIT = 1000;

/**
 * Append-only log keyed by (namespace, key) backed by a single SQL
 * table. Sequence numbers are atomic per (namespace, key) pair: an
 * append computes `MAX(seq) + 1 OR 1` inside the same transaction
 * that inserts the row. Single-process SQLite serializes via the
 * write lock; Postgres will need an advisory lock or `INSERT ... ON
 * CONFLICT` retry to get the same guarantee.
 */
export function sqliteLog(db: DatabaseSync): LogStore {
  return {
    async append(namespace, key, entry): Promise<LogAppendResult> {
      validateNamespace(namespace);
      validateKey(key);
      // Serialize and size-check up front so we don't open a write
      // transaction we'd just have to abort on oversized input.
      const serialized = validateEntrySize(entry);
      // Wrap the read+insert in a transaction so concurrent appends
      // against the same key produce monotonic, unique seq values.
      // SQLite's write lock makes this safe even without an advisory
      // lock; the BEGIN IMMEDIATE acquires the writer slot up front.
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare(
            "SELECT MAX(seq) AS m FROM state_log WHERE namespace = ? AND key = ?",
          )
          .get(namespace, key) as { m: number | null } | undefined;
        const seq = (row?.m ?? 0) + 1;
        const at = new Date().toISOString();
        db.prepare(
          `INSERT INTO state_log (namespace, key, seq, at, entry)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(namespace, key, seq, at, serialized);
        db.exec("COMMIT");
        return { seq, at };
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    async read(namespace, key, opts: LogReadOpts = {}): Promise<LogReadResult> {
      validateNamespace(namespace);
      validateKey(key);
      const since = opts.since ?? 0;
      const limit = opts.limit ?? DEFAULT_READ_LIMIT;
      const lastSeqRow = db
        .prepare(
          "SELECT MAX(seq) AS m FROM state_log WHERE namespace = ? AND key = ?",
        )
        .get(namespace, key) as { m: number | null } | undefined;
      const lastSeq = lastSeqRow?.m ?? 0;
      const rows = db
        .prepare(
          `SELECT seq, at, entry FROM state_log
            WHERE namespace = ? AND key = ? AND seq > ?
            ORDER BY seq ASC
            LIMIT ?`,
        )
        .all(namespace, key, since, limit) as unknown as LogRow[];
      const entries: LogEntry[] = rows.map((r) => ({
        seq: r.seq,
        at: r.at,
        entry: JSON.parse(r.entry),
      }));
      return { entries, lastSeq };
    },

    async list(namespace): Promise<string[]> {
      validateNamespace(namespace);
      const rows = db
        .prepare(
          "SELECT DISTINCT key FROM state_log WHERE namespace = ? ORDER BY key",
        )
        .all(namespace) as unknown as { key: string }[];
      return rows.map((r) => r.key);
    },

    async delete(namespace, key): Promise<void> {
      validateNamespace(namespace);
      validateKey(key);
      db.prepare(
        "DELETE FROM state_log WHERE namespace = ? AND key = ?",
      ).run(namespace, key);
    },

    async deleteNamespace(namespace): Promise<void> {
      validateNamespace(namespace);
      db.prepare("DELETE FROM state_log WHERE namespace = ?").run(namespace);
    },
  };
}
