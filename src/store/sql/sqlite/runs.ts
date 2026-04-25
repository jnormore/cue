import type { DatabaseSync } from "node:sqlite";
import type { BlobStore } from "../../../blob/index.js";
import {
  type RunRecord,
  type RunStore,
  type RunSummary,
  StoreError,
  newRunId,
} from "../../index.js";

interface RunRow {
  id: string;
  action_id: string;
  trigger_id: string | null;
  fired_at: string;
  finished_at: string | null;
  exit_code: number | null;
  runtime_run_id: string | null;
  denials: string | null;
}

const blobKey = {
  input: (id: string) => `runs/${id}/input.json`,
  stdout: (id: string) => `runs/${id}/stdout`,
  stderr: (id: string) => `runs/${id}/stderr`,
  output: (id: string) => `runs/${id}/output.json`,
};

function toRecord(r: RunRow): RunRecord {
  const out: RunRecord = {
    id: r.id,
    actionId: r.action_id,
    firedAt: r.fired_at,
  };
  if (r.trigger_id !== null) out.triggerId = r.trigger_id;
  if (r.finished_at !== null) out.finishedAt = r.finished_at;
  if (r.exit_code !== null) out.exitCode = r.exit_code;
  if (r.runtime_run_id !== null) out.runtimeRunId = r.runtime_run_id;
  if (r.denials !== null) out.denials = JSON.parse(r.denials) as string[];
  return out;
}

function toSummary(r: RunRow): RunSummary {
  const out: RunSummary = {
    id: r.id,
    actionId: r.action_id,
    firedAt: r.fired_at,
  };
  if (r.trigger_id !== null) out.triggerId = r.trigger_id;
  if (r.finished_at !== null) out.finishedAt = r.finished_at;
  if (r.exit_code !== null) out.exitCode = r.exit_code;
  return out;
}

export function sqliteRuns(db: DatabaseSync, blob: BlobStore): RunStore {
  return {
    async create(input) {
      const id = newRunId();
      db.prepare(
        `INSERT INTO runs (id, action_id, trigger_id, fired_at)
         VALUES (?, ?, ?, ?)`,
      ).run(id, input.actionId, input.triggerId ?? null, input.firedAt);
      // Persist the input envelope immediately so debugging is possible
      // even if the run fails before completion.
      await blob.put(blobKey.input(id), JSON.stringify(input.input ?? null));
      const record: RunRecord = {
        id,
        actionId: input.actionId,
        firedAt: input.firedAt,
      };
      if (input.triggerId) record.triggerId = input.triggerId;
      return record;
    },

    async finish(id, result) {
      const existing = db
        .prepare("SELECT * FROM runs WHERE id = ?")
        .get(id) as RunRow | undefined;
      if (!existing) {
        throw new StoreError("NotFound", `Run ${id} not found`, { id });
      }
      const denialsJson =
        Array.isArray(result.denials) && result.denials.length > 0
          ? JSON.stringify(result.denials)
          : null;
      db.prepare(
        `UPDATE runs
            SET finished_at = ?, exit_code = ?, runtime_run_id = ?, denials = ?
          WHERE id = ?`,
      ).run(
        result.finishedAt,
        result.exitCode,
        result.runtimeRunId ?? null,
        denialsJson,
        id,
      );
      await Promise.all([
        blob.put(blobKey.stdout(id), result.stdout),
        blob.put(blobKey.stderr(id), result.stderr),
        writeOutputIfJson(blob, blobKey.output(id), result.stdout),
      ]);
      const record: RunRecord = {
        id,
        actionId: existing.action_id,
        firedAt: existing.fired_at,
        finishedAt: result.finishedAt,
        exitCode: result.exitCode,
      };
      if (existing.trigger_id !== null) record.triggerId = existing.trigger_id;
      if (result.runtimeRunId) record.runtimeRunId = result.runtimeRunId;
      if (denialsJson !== null) record.denials = result.denials ?? [];
      return record;
    },

    async get(id) {
      const row = db
        .prepare("SELECT * FROM runs WHERE id = ?")
        .get(id) as RunRow | undefined;
      return row ? toRecord(row) : null;
    },

    async list(filter) {
      const limit = filter?.limit ?? 1000;
      const rows = (
        filter?.actionId
          ? (db
              .prepare(
                "SELECT * FROM runs WHERE action_id = ? ORDER BY fired_at DESC LIMIT ?",
              )
              .all(filter.actionId, limit) as unknown as RunRow[])
          : (db
              .prepare("SELECT * FROM runs ORDER BY fired_at DESC LIMIT ?")
              .all(limit) as unknown as RunRow[])
      );
      return rows.map(toSummary);
    },

    async readStdout(id) {
      return (await blob.get(blobKey.stdout(id))) ?? "";
    },

    async readStderr(id) {
      return (await blob.get(blobKey.stderr(id))) ?? "";
    },

    async readInput(id) {
      const raw = await blob.get(blobKey.input(id));
      if (raw === null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
  };
}

async function writeOutputIfJson(
  blob: BlobStore,
  key: string,
  stdout: string,
): Promise<void> {
  const trimmed = stdout.trim();
  if (!trimmed) return;
  try {
    const parsed = JSON.parse(trimmed);
    await blob.put(key, JSON.stringify(parsed, null, 2));
  } catch {
    // stdout isn't JSON — skip silently
  }
}
