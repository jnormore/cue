import type { DatabaseSync } from "node:sqlite";
import { migrations } from "./migrations/index.js";

/**
 * Apply any migration with version > current schema_version, in order.
 * Each migration runs inside its own transaction; a failure aborts the
 * migration and propagates. The schema_version table is created on
 * first run if missing.
 */
export function runMigrations(db: DatabaseSync): void {
  ensureSchemaVersionTable(db);
  const current = readCurrentVersion(db);
  const pending = migrations.filter((m) => m.version > current);
  for (const m of pending) {
    applyMigration(db, m);
  }
}

function ensureSchemaVersionTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER NOT NULL PRIMARY KEY,
      applied_at TEXT    NOT NULL
    );
  `);
}

function readCurrentVersion(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT MAX(version) AS v FROM schema_version")
    .get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

function applyMigration(
  db: DatabaseSync,
  m: { version: number; name: string; sql: string },
): void {
  db.exec("BEGIN");
  try {
    db.exec(m.sql);
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
      m.version,
      new Date().toISOString(),
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw new Error(
      `Migration ${m.version}-${m.name} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
