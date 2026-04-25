/**
 * Initial cue schema.
 *
 * Designed to work in both SQLite (single-node default) and Postgres
 * (fleet, future). Avoids dialect-specific types: TEXT for everything
 * string-shaped (ids, timestamps, JSON-as-text), INTEGER for ints.
 * Large content (run stdout/stderr/input/output) lives in the
 * BlobStore, not here.
 */
export const sql = `
CREATE TABLE IF NOT EXISTS namespaces (
  name         TEXT NOT NULL PRIMARY KEY,
  display_name TEXT,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  CHECK (status IN ('active', 'paused', 'archived'))
);

CREATE TABLE IF NOT EXISTS actions (
  id         TEXT NOT NULL PRIMARY KEY,
  name       TEXT NOT NULL,
  namespace  TEXT NOT NULL,
  code       TEXT NOT NULL,
  policy     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (namespace, name)
);

CREATE INDEX IF NOT EXISTS actions_by_namespace ON actions (namespace);

CREATE TABLE IF NOT EXISTS triggers (
  id            TEXT NOT NULL PRIMARY KEY,
  type          TEXT NOT NULL,
  action_id     TEXT NOT NULL,
  namespace     TEXT NOT NULL,
  config        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  firing_until  TEXT,
  CHECK (type IN ('cron', 'webhook'))
);

CREATE INDEX IF NOT EXISTS triggers_by_namespace ON triggers (namespace);
CREATE INDEX IF NOT EXISTS triggers_by_action ON triggers (action_id);

CREATE TABLE IF NOT EXISTS runs (
  id              TEXT NOT NULL PRIMARY KEY,
  action_id       TEXT NOT NULL,
  trigger_id      TEXT,
  fired_at        TEXT NOT NULL,
  finished_at     TEXT,
  exit_code       INTEGER,
  runtime_run_id  TEXT,
  denials         TEXT
);

CREATE INDEX IF NOT EXISTS runs_by_action ON runs (action_id, fired_at DESC);

CREATE TABLE IF NOT EXISTS secrets (
  namespace  TEXT NOT NULL,
  name       TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (namespace, name)
);

CREATE TABLE IF NOT EXISTS agent_tokens (
  id          TEXT NOT NULL PRIMARY KEY,
  token       TEXT NOT NULL,
  scope       TEXT NOT NULL,
  label       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS state_log (
  namespace  TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  at         TEXT    NOT NULL,
  entry      TEXT    NOT NULL,
  PRIMARY KEY (namespace, key, seq)
);

CREATE TABLE IF NOT EXISTS state_tokens (
  namespace  TEXT NOT NULL PRIMARY KEY,
  token      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;
