import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ActionStore,
  StoreError,
} from "../../../src/store/index.js";
import { fsActions } from "../../../src/store/fs/actions.js";

describe("fsActions", () => {
  let home: string;
  let actions: ActionStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-actions-"));
    actions = fsActions(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates an action with default namespace and empty policy", async () => {
      const rec = await actions.create({ name: "hello", code: "console.log(1)" });
      expect(rec.id).toMatch(/^act_[0-9A-Z]{26}$/);
      expect(rec.name).toBe("hello");
      expect(rec.namespace).toBe("default");
      expect(rec.code).toBe("console.log(1)");
      expect(rec.policy).toEqual({});
      expect(rec.createdAt).toBe(rec.updatedAt);
    });

    it("persists code.js, policy.toml, meta.json on disk", async () => {
      const rec = await actions.create({
        name: "hello",
        code: "console.log(1)",
        policy: { timeoutSeconds: 10, allowNet: ["api.github.com"] },
      });
      const dir = join(home, "actions", rec.id);
      expect(readFileSync(join(dir, "code.js"), "utf8")).toBe("console.log(1)");
      const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
      expect(meta.name).toBe("hello");
      const toml = readFileSync(join(dir, "policy.toml"), "utf8");
      expect(toml).toContain("timeoutSeconds = 10");
      expect(toml).toContain("api.github.com");
    });

    it("accepts explicit namespace", async () => {
      const rec = await actions.create({
        name: "hello",
        code: "x",
        namespace: "weather",
      });
      expect(rec.namespace).toBe("weather");
    });

    it("rejects invalid name", async () => {
      await expect(
        actions.create({ name: "Bad Name", code: "x" }),
      ).rejects.toBeInstanceOf(StoreError);
      await expect(
        actions.create({ name: "", code: "x" }),
      ).rejects.toBeInstanceOf(StoreError);
    });

    it("rejects invalid namespace", async () => {
      await expect(
        actions.create({ name: "ok", code: "x", namespace: "Bad NS" }),
      ).rejects.toBeInstanceOf(StoreError);
    });

    it("rejects duplicate name within the same namespace", async () => {
      await actions.create({ name: "hello", code: "x" });
      await expect(
        actions.create({ name: "hello", code: "y" }),
      ).rejects.toMatchObject({ kind: "NameCollision" });
    });

    it("allows same name in different namespaces", async () => {
      await actions.create({ name: "hello", code: "x", namespace: "a" });
      await actions.create({ name: "hello", code: "y", namespace: "b" });
      const list = await actions.list();
      expect(list).toHaveLength(2);
    });
  });

  describe("get", () => {
    it("returns the full record", async () => {
      const created = await actions.create({
        name: "hello",
        code: "x",
        policy: { memoryMb: 128 },
      });
      const fetched = await actions.get(created.id);
      expect(fetched).toEqual(created);
    });

    it("returns null for unknown id", async () => {
      expect(await actions.get("act_ZZZ")).toBeNull();
    });
  });

  describe("list", () => {
    it("returns empty when no actions", async () => {
      expect(await actions.list()).toEqual([]);
    });

    it("returns summaries sorted by createdAt", async () => {
      const a = await actions.create({ name: "first", code: "x" });
      await new Promise((r) => setTimeout(r, 5));
      const b = await actions.create({ name: "second", code: "y" });
      const list = await actions.list();
      expect(list.map((s) => s.id)).toEqual([a.id, b.id]);
      expect(list[0]).not.toHaveProperty("code");
    });

    it("filters by namespace", async () => {
      await actions.create({ name: "a", code: "x", namespace: "one" });
      await actions.create({ name: "b", code: "y", namespace: "two" });
      const only = await actions.list({ namespace: "one" });
      expect(only).toHaveLength(1);
      expect(only[0]?.name).toBe("a");
    });
  });

  describe("update", () => {
    it("patches name, code, and policy; bumps updatedAt", async () => {
      const orig = await actions.create({ name: "hello", code: "x" });
      await new Promise((r) => setTimeout(r, 5));
      const updated = await actions.update(orig.id, {
        name: "renamed",
        code: "y",
        policy: { memoryMb: 256 },
      });
      expect(updated.name).toBe("renamed");
      expect(updated.code).toBe("y");
      expect(updated.policy).toEqual({ memoryMb: 256 });
      expect(updated.createdAt).toBe(orig.createdAt);
      expect(updated.updatedAt).not.toBe(orig.updatedAt);
    });

    it("rejects unknown id", async () => {
      await expect(
        actions.update("act_ZZZ", { name: "new" }),
      ).rejects.toMatchObject({ kind: "NotFound" });
    });

    it("rejects name collision within namespace", async () => {
      await actions.create({ name: "a", code: "x" });
      const b = await actions.create({ name: "b", code: "y" });
      await expect(
        actions.update(b.id, { name: "a" }),
      ).rejects.toMatchObject({ kind: "NameCollision" });
    });

    it("does not rewrite code/policy when omitted from patch", async () => {
      const orig = await actions.create({
        name: "hello",
        code: "original",
        policy: { memoryMb: 128 },
      });
      const updated = await actions.update(orig.id, { name: "renamed" });
      expect(updated.code).toBe("original");
      expect(updated.policy).toEqual({ memoryMb: 128 });
    });
  });

  describe("delete", () => {
    it("removes the action dir", async () => {
      const rec = await actions.create({ name: "hello", code: "x" });
      await actions.delete(rec.id);
      expect(existsSync(join(home, "actions", rec.id))).toBe(false);
      expect(await actions.get(rec.id)).toBeNull();
    });

    it("rejects unknown id", async () => {
      await expect(actions.delete("act_ZZZ")).rejects.toMatchObject({
        kind: "NotFound",
      });
    });
  });
});
