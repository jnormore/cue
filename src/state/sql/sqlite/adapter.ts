import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { StateAdapter } from "../../index.js";
import { sqliteLog } from "./log.js";
import { sqliteNamespaceTokens } from "./tokens.js";

// See src/store/sql/sqlite/adapter.ts for why this goes through
// createRequire instead of a direct import.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

/**
 * Open the SQLite-backed state adapter at `<home>/cue.db`. Schema
 * migrations are owned by the store adapter; this adapter assumes the
 * tables already exist (the daemon's startup order opens the store
 * first, which runs migrations).
 *
 * State and store run on **separate connections** to the same DB
 * file. SQLite WAL mode supports concurrent readers and one writer,
 * with `busy_timeout` covering the contention window — this is more
 * robust than sharing a single connection across two adapters.
 */
export function sqliteStateAdapter(home: string): StateAdapter {
  const dbPath = join(home, "cue.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db: DatabaseSync = new DatabaseSyncCtor(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");

  return {
    name: "sqlite",
    log: sqliteLog(db),
    tokens: sqliteNamespaceTokens(db),

    async doctor() {
      try {
        db.prepare("SELECT 1").get();
        return { ok: true, details: { path: dbPath } };
      } catch (err) {
        return { ok: false, details: { path: dbPath, error: String(err) } };
      }
    },

    async close() {
      db.close();
    },
  };
}
