import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteAction,
  deleteNamespace,
  pickStore,
  type StoreAdapter,
} from "../../../src/store/index.js";
import { makeTestState } from "../../helpers/state.js";

describe("pickStore", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-picker-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns the sqlite adapter for 'sqlite'", async () => {
    const adapter = pickStore("sqlite", { home });
    expect(adapter.name).toBe("sqlite");
    expect(adapter.actions).toBeDefined();
    expect(adapter.triggers).toBeDefined();
    expect(adapter.runs).toBeDefined();
    expect(adapter.namespaces).toBeDefined();
    await adapter.close();
  });

  it("throws on unknown adapter name", () => {
    expect(() => pickStore("nope", { home })).toThrow(/Unknown store/);
  });
});

describe("sqlite adapter doctor", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-doctor-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns ok:true when home is writable", async () => {
    const adapter = pickStore("sqlite", { home });
    const result = await adapter.doctor();
    expect(result.ok).toBe(true);
    await adapter.close();
  });
});

describe("cascade helpers", () => {
  let home: string;
  let adapter: StoreAdapter;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-cascade-"));
    adapter = pickStore("sqlite", { home });
  });

  afterEach(async () => {
    await adapter.close();
    rmSync(home, { recursive: true, force: true });
  });

  describe("deleteAction", () => {
    it("deletes the action and all of its triggers, preserves runs", async () => {
      const action = await adapter.actions.create({
        name: "hello",
        code: "x",
      });
      const t1 = await adapter.triggers.create({
        type: "cron",
        actionId: action.id,
        namespace: "default",
        config: { schedule: "* * * * *" },
      });
      const t2 = await adapter.triggers.create({
        type: "webhook",
        actionId: action.id,
        namespace: "default",
        config: {},
      });
      const run = await adapter.runs.create({
        actionId: action.id,
        firedAt: new Date().toISOString(),
        input: null,
      });

      const result = await deleteAction(adapter, action.id);
      expect(result.action).toBe(action.id);
      expect(result.triggers.sort()).toEqual([t1.id, t2.id].sort());

      expect(await adapter.actions.get(action.id)).toBeNull();
      expect(await adapter.triggers.get(t1.id)).toBeNull();
      expect(await adapter.triggers.get(t2.id)).toBeNull();
      // Run record is preserved per D12.
      expect(await adapter.runs.get(run.id)).not.toBeNull();
    });

    it("does not touch triggers of unrelated actions", async () => {
      const a = await adapter.actions.create({ name: "a", code: "x" });
      const b = await adapter.actions.create({ name: "b", code: "y" });
      await adapter.triggers.create({
        type: "cron",
        actionId: a.id,
        namespace: "default",
        config: { schedule: "* * * * *" },
      });
      const bTrigger = await adapter.triggers.create({
        type: "cron",
        actionId: b.id,
        namespace: "default",
        config: { schedule: "* * * * *" },
      });
      await deleteAction(adapter, a.id);
      expect(await adapter.triggers.get(bTrigger.id)).not.toBeNull();
    });
  });

  describe("deleteNamespace", () => {
    it("removes all actions and triggers tagged with the namespace", async () => {
      const a = await adapter.actions.create({
        name: "a",
        code: "x",
        namespace: "weather",
      });
      const b = await adapter.actions.create({
        name: "b",
        code: "y",
        namespace: "weather",
      });
      const other = await adapter.actions.create({
        name: "c",
        code: "z",
        namespace: "news",
      });
      const tA = await adapter.triggers.create({
        type: "cron",
        actionId: a.id,
        namespace: "weather",
        config: { schedule: "* * * * *" },
      });
      const tOther = await adapter.triggers.create({
        type: "cron",
        actionId: other.id,
        namespace: "news",
        config: { schedule: "* * * * *" },
      });

      const result = await deleteNamespace(adapter, makeTestState(home), "weather");
      expect(result.actions.sort()).toEqual([a.id, b.id].sort());
      expect(result.triggers).toEqual([tA.id]);

      expect(await adapter.actions.get(a.id)).toBeNull();
      expect(await adapter.actions.get(b.id)).toBeNull();
      expect(await adapter.actions.get(other.id)).not.toBeNull();
      expect(await adapter.triggers.get(tA.id)).toBeNull();
      expect(await adapter.triggers.get(tOther.id)).not.toBeNull();
    });

    it("also deletes triggers whose action is in the namespace, even if trigger has a different namespace", async () => {
      const action = await adapter.actions.create({
        name: "a",
        code: "x",
        namespace: "weather",
      });
      const stray = await adapter.triggers.create({
        type: "webhook",
        actionId: action.id,
        namespace: "other-ns",
        config: {},
      });
      const result = await deleteNamespace(adapter, makeTestState(home), "weather");
      expect(result.triggers).toContain(stray.id);
      expect(await adapter.triggers.get(stray.id)).toBeNull();
    });
  });
});
