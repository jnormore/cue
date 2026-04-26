/**
 * Artifacts: agent-hosted static assets per namespace.
 *
 * Bytes live in the blob store at `artifacts/<namespace>/<path>`;
 * this row tracks the metadata + per-artifact view token (empty
 * string for public artifacts).
 */
export const sql = `
CREATE TABLE IF NOT EXISTS artifacts (
  namespace   TEXT NOT NULL,
  path        TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size        INTEGER NOT NULL,
  public      INTEGER NOT NULL DEFAULT 1,    -- 0 or 1; SQLite has no bool
  view_token  TEXT NOT NULL DEFAULT '',      -- empty when public
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (namespace, path)
);

CREATE INDEX IF NOT EXISTS artifacts_by_namespace ON artifacts (namespace);
`;
