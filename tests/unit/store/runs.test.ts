import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type RunStore,
  StoreError,
  pickStore,
  type StoreAdapter,
} from "../../../src/store/index.js";

describe("sqlite runs store", () => {
  let home: string;
  let store: StoreAdapter;
  let runs: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-runs-"));
    store = pickStore("sqlite", { home });
    runs = store.runs;
  });

  afterEach(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  const firedAt = () => new Date().toISOString();

  describe("create", () => {
    it("persists actionId and input", async () => {
      const rec = await runs.create({
        actionId: "act_A",
        firedAt: firedAt(),
        input: { hello: "world" },
      });
      expect(rec.id).toMatch(/^run_[0-9A-Z]{26}$/);
      expect(rec.actionId).toBe("act_A");
      expect(await runs.readInput(rec.id)).toEqual({ hello: "world" });
    });

    it("stores triggerId when provided", async () => {
      const rec = await runs.create({
        actionId: "act_A",
        triggerId: "trg_X",
        firedAt: firedAt(),
        input: null,
      });
      expect(rec.triggerId).toBe("trg_X");
    });
  });

  describe("finish", () => {
    it("writes stdout/stderr, updates record, writes output blob for JSON stdout", async () => {
      const rec = await runs.create({
        actionId: "act_A",
        firedAt: firedAt(),
        input: null,
      });
      const updated = await runs.finish(rec.id, {
        exitCode: 0,
        stdout: '{"result":42}',
        stderr: "warn",
        runtimeRunId: "u_123",
        finishedAt: firedAt(),
      });
      expect(updated.exitCode).toBe(0);
      expect(updated.runtimeRunId).toBe("u_123");
      expect(await runs.readStdout(rec.id)).toBe('{"result":42}');
      expect(await runs.readStderr(rec.id)).toBe("warn");
    });

    it("rejects unknown id", async () => {
      await expect(
        runs.finish("run_ZZZ", {
          exitCode: 0,
          stdout: "",
          stderr: "",
          runtimeRunId: "u",
          finishedAt: firedAt(),
        }),
      ).rejects.toBeInstanceOf(StoreError);
    });

    it("records denials array only when non-empty", async () => {
      const rec = await runs.create({
        actionId: "act_A",
        firedAt: firedAt(),
        input: null,
      });
      const a = await runs.finish(rec.id, {
        exitCode: 0,
        stdout: "",
        stderr: "",
        runtimeRunId: "u",
        finishedAt: firedAt(),
        denials: [],
      });
      expect(a.denials).toBeUndefined();

      const rec2 = await runs.create({
        actionId: "act_A",
        firedAt: firedAt(),
        input: null,
      });
      const b = await runs.finish(rec2.id, {
        exitCode: 0,
        stdout: "",
        stderr: "",
        runtimeRunId: "u",
        finishedAt: firedAt(),
        denials: ["allowNet:evil.com"],
      });
      expect(b.denials).toEqual(["allowNet:evil.com"]);
    });
  });

  describe("list", () => {
    it("sorts by firedAt descending and honors limit", async () => {
      const t0 = new Date(Date.now() - 3000).toISOString();
      const t1 = new Date(Date.now() - 2000).toISOString();
      const t2 = new Date(Date.now() - 1000).toISOString();
      const r0 = await runs.create({
        actionId: "act_A",
        firedAt: t0,
        input: null,
      });
      const r1 = await runs.create({
        actionId: "act_A",
        firedAt: t1,
        input: null,
      });
      const r2 = await runs.create({
        actionId: "act_B",
        firedAt: t2,
        input: null,
      });
      const list = await runs.list();
      expect(list.map((s) => s.id)).toEqual([r2.id, r1.id, r0.id]);
      const limited = await runs.list({ limit: 2 });
      expect(limited.map((s) => s.id)).toEqual([r2.id, r1.id]);
      const byAction = await runs.list({ actionId: "act_A" });
      expect(byAction.map((s) => s.id)).toEqual([r1.id, r0.id]);
    });
  });

  describe("reads default to empty/null when missing", () => {
    it("readStdout/Err return empty string, readInput returns null", async () => {
      expect(await runs.readStdout("run_ZZZ")).toBe("");
      expect(await runs.readStderr("run_ZZZ")).toBe("");
      expect(await runs.readInput("run_ZZZ")).toBeNull();
    });
  });
});
