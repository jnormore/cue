import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type BlobStore, pickBlob } from "../../../blob/index.js";
import type { StoreAdapter } from "../../index.js";
import { runMigrations } from "../runner.js";
import { sqliteActions } from "./actions.js";
import { sqliteAgentTokens } from "./agent-tokens.js";
import { sqliteArtifacts } from "./artifacts.js";
import { sqliteConfigs } from "./configs.js";
import { sqliteNamespaces } from "./namespaces.js";
import { sqliteRuns } from "./runs.js";
import { sqliteSecrets } from "./secrets.js";
import { sqliteTriggers } from "./triggers.js";

// Vite (used by vitest) doesn't recognize `node:sqlite` in its static
// analysis. Going through createRequire keeps the import at runtime
// where Node's resolver handles it correctly.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

interface SqliteStoreState {
  db: DatabaseSync;
  blob: BlobStore;
  inTransaction: boolean;
}

function buildAdapter(state: SqliteStoreState): StoreAdapter {
  const adapter: StoreAdapter = {
    name: "sqlite",
    namespaces: sqliteNamespaces(state.db),
    actions: sqliteActions(state.db),
    triggers: sqliteTriggers(state.db),
    runs: sqliteRuns(state.db, state.blob),
    secrets: sqliteSecrets(state.db),
    configs: sqliteConfigs(state.db),
    artifacts: sqliteArtifacts(state.db, state.blob),
    agentTokens: sqliteAgentTokens(state.db),

    async doctor() {
      try {
        state.db.prepare("SELECT 1").get();
        const blobDr = await state.blob.doctor();
        return {
          ok: blobDr.ok,
          details: { db: "ok", blob: blobDr.details },
        };
      } catch (err) {
        return {
          ok: false,
          details: { error: String(err) },
        };
      }
    },

    async transaction(fn) {
      if (state.inTransaction) {
        throw new Error("Nested transactions are not supported");
      }
      state.db.exec("BEGIN IMMEDIATE");
      const txState: SqliteStoreState = { ...state, inTransaction: true };
      const txAdapter = buildAdapter(txState);
      try {
        const result = await fn(txAdapter);
        state.db.exec("COMMIT");
        return result;
      } catch (err) {
        state.db.exec("ROLLBACK");
        throw err;
      }
    },

    async close() {
      // Only the outer adapter owns the resources.
      if (!state.inTransaction) {
        state.db.close();
        await state.blob.close();
      }
    },
  };
  return adapter;
}

/**
 * Open the SQLite store at `<home>/cue.db`, run migrations, and wire
 * up the blob store at `<home>/blobs/`. The blob store is opened with
 * the same `home` so the two share a directory tree.
 *
 * Closing the adapter closes both the database and the blob store.
 */
export function sqliteStore(home: string): StoreAdapter {
  const dbPath = join(home, "cue.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db: DatabaseSync = new DatabaseSyncCtor(dbPath);
  // WAL gives crash safety and concurrent readers. busy_timeout
  // stalls writers up to 5s if another writer holds the lock — fine
  // for a single-process daemon. Foreign keys are off (we don't use
  // FK constraints; cascades are application-level).
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  runMigrations(db);
  const blob = pickBlob("fs", { home });
  const state: SqliteStoreState = { db, blob, inTransaction: false };
  return buildAdapter(state);
}
