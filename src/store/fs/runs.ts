import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type RunRecord,
  type RunStore,
  type RunSummary,
  StoreError,
  newRunId,
} from "../index.js";
import { isENOENT, writeFileAtomic, writeJsonAtomic } from "./util.js";

export function fsRuns(home: string): RunStore {
  const runsDir = join(home, "runs");

  const dirFor = (id: string) => join(runsDir, id);
  const metaFor = (id: string) => join(dirFor(id), "meta.json");
  const inputFor = (id: string) => join(dirFor(id), "input.json");
  const stdoutFor = (id: string) => join(dirFor(id), "stdout");
  const stderrFor = (id: string) => join(dirFor(id), "stderr");
  const outputFor = (id: string) => join(dirFor(id), "output.json");

  async function readMeta(id: string): Promise<RunRecord | null> {
    try {
      const raw = await readFile(metaFor(id), "utf8");
      return JSON.parse(raw) as RunRecord;
    } catch (err) {
      if (isENOENT(err)) return null;
      throw err;
    }
  }

  return {
    async create(input) {
      const id = newRunId();
      const record: RunRecord = {
        id,
        actionId: input.actionId,
        ...(input.triggerId ? { triggerId: input.triggerId } : {}),
        firedAt: input.firedAt,
      };
      await mkdir(dirFor(id), { recursive: true });
      await Promise.all([
        writeJsonAtomic(metaFor(id), record),
        writeJsonAtomic(inputFor(id), input.input ?? null),
      ]);
      return record;
    },

    async finish(id, result) {
      const existing = await readMeta(id);
      if (!existing) {
        throw new StoreError("NotFound", `Run ${id} not found`, { id });
      }
      const hasDenials =
        Array.isArray(result.denials) && result.denials.length > 0;
      const updated: RunRecord = {
        ...existing,
        exitCode: result.exitCode,
        finishedAt: result.finishedAt,
        runtimeRunId: result.runtimeRunId,
        ...(hasDenials ? { denials: result.denials } : {}),
      };
      await Promise.all([
        writeJsonAtomic(metaFor(id), updated),
        writeFileAtomic(stdoutFor(id), result.stdout),
        writeFileAtomic(stderrFor(id), result.stderr),
        writeOutputIfJson(outputFor(id), result.stdout),
      ]);
      return updated;
    },

    async get(id) {
      return readMeta(id);
    },

    async list(filter) {
      let entries: string[];
      try {
        entries = await readdir(runsDir);
      } catch (err) {
        if (isENOENT(err)) return [];
        throw err;
      }
      const metas: RunRecord[] = [];
      for (const entry of entries) {
        if (!entry.startsWith("run_")) continue;
        const meta = await readMeta(entry);
        if (!meta) continue;
        if (filter?.actionId && meta.actionId !== filter.actionId) continue;
        metas.push(meta);
      }
      metas.sort((a, b) => b.firedAt.localeCompare(a.firedAt));
      const summaries: RunSummary[] = metas.map((m) => {
        const s: RunSummary = {
          id: m.id,
          actionId: m.actionId,
          firedAt: m.firedAt,
        };
        if (m.triggerId) s.triggerId = m.triggerId;
        if (m.finishedAt) s.finishedAt = m.finishedAt;
        if (m.exitCode !== undefined) s.exitCode = m.exitCode;
        return s;
      });
      return filter?.limit ? summaries.slice(0, filter.limit) : summaries;
    },

    async readStdout(id) {
      try {
        return await readFile(stdoutFor(id), "utf8");
      } catch (err) {
        if (isENOENT(err)) return "";
        throw err;
      }
    },

    async readStderr(id) {
      try {
        return await readFile(stderrFor(id), "utf8");
      } catch (err) {
        if (isENOENT(err)) return "";
        throw err;
      }
    },

    async readInput(id) {
      try {
        const raw = await readFile(inputFor(id), "utf8");
        return JSON.parse(raw);
      } catch (err) {
        if (isENOENT(err)) return null;
        throw err;
      }
    },
  };
}

async function writeOutputIfJson(
  path: string,
  stdout: string,
): Promise<void> {
  const trimmed = stdout.trim();
  if (!trimmed) return;
  try {
    const parsed = JSON.parse(trimmed);
    await writeFileAtomic(path, JSON.stringify(parsed, null, 2));
  } catch {
    // stdout isn't JSON — skip silently
  }
}
