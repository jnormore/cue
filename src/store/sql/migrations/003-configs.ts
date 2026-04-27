/**
 * Configs: per-namespace named values for non-sensitive runtime
 * configuration (URLs, thresholds, channel names, recipient addresses,
 * etc.). Same row shape as secrets — same NULL behavior, same primary
 * key — but the API layer treats them differently:
 *
 *   • Values are READABLE (admin GET returns the value, not just the
 *     name). Secrets are write-only at the boundary; configs are not.
 *   • Logging/audit is fine to record the value alongside the name.
 *   • UI renders configs as plain text inputs, not masked.
 *
 * The runtime injection channel is identical to secrets — both
 * materialize into the action's env at invoke time. Splitting at the
 * storage layer keeps the API and UI contracts crisp; merging them
 * (e.g. `secrets` with a `sensitive` flag) would force every read path
 * to reason about that flag.
 */
export const sql = `
CREATE TABLE IF NOT EXISTS configs (
  namespace  TEXT NOT NULL,
  name       TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, name)
);

CREATE INDEX IF NOT EXISTS configs_by_namespace ON configs (namespace);
`;
