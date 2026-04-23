import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fsLog } from "../../../src/state/fs/log.js";
import { type LogStore } from "../../../src/state/index.js";
import { StoreError } from "../../../src/store/index.js";

describe("fsLog", () => {
  let home: string;
  let log: LogStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-log-"));
    log = fsLog(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe("append", () => {
    it("writes to state/logs/<namespace>/<key>.ndjson with seq 1, 2, 3…", async () => {
      const r1 = await log.append("shop", "orders", { id: 1 });
      const r2 = await log.append("shop", "orders", { id: 2 });
      const r3 = await log.append("shop", "orders", { id: 3 });
      expect(r1.seq).toBe(1);
      expect(r2.seq).toBe(2);
      expect(r3.seq).toBe(3);

      const raw = readFileSync(
        join(home, "state", "logs", "shop", "orders.ndjson"),
        "utf8",
      );
      const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatchObject({ seq: 1, entry: { id: 1 } });
      expect(lines[2]).toMatchObject({ seq: 3, entry: { id: 3 } });
    });

    it("creates namespace directory on first append", async () => {
      expect(existsSync(join(home, "state", "logs", "shop"))).toBe(false);
      await log.append("shop", "orders", { id: 1 });
      expect(existsSync(join(home, "state", "logs", "shop"))).toBe(true);
    });

    it("rejects invalid namespace/key", async () => {
      await expect(log.append("Bad NS", "orders", {})).rejects.toBeInstanceOf(
        StoreError,
      );
      await expect(log.append("shop", "BadKey", {})).rejects.toBeInstanceOf(
        StoreError,
      );
      await expect(log.append("shop", "", {})).rejects.toBeInstanceOf(
        StoreError,
      );
    });

    it("serializes concurrent appends to the same key (no torn lines, no dup seq)", async () => {
      const N = 20;
      const promises = Array.from({ length: N }, (_, i) =>
        log.append("shop", "orders", { i }),
      );
      const results = await Promise.all(promises);
      const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
      const raw = readFileSync(
        join(home, "state", "logs", "shop", "orders.ndjson"),
        "utf8",
      );
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(N);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it("resumes numbering after daemon restart (re-reads highest seq)", async () => {
      await log.append("shop", "orders", { id: 1 });
      await log.append("shop", "orders", { id: 2 });
      // Fresh adapter over the same home.
      const fresh = fsLog(home);
      const r3 = await fresh.append("shop", "orders", { id: 3 });
      expect(r3.seq).toBe(3);
    });
  });

  describe("read", () => {
    it("returns [] + lastSeq 0 for a missing key", async () => {
      const r = await log.read("shop", "never", {});
      expect(r.entries).toEqual([]);
      expect(r.lastSeq).toBe(0);
    });

    it("returns all entries when since is 0 (default)", async () => {
      await log.append("shop", "orders", { id: 1 });
      await log.append("shop", "orders", { id: 2 });
      const r = await log.read("shop", "orders");
      expect(r.entries).toHaveLength(2);
      expect(r.entries[0]?.entry).toEqual({ id: 1 });
      expect(r.lastSeq).toBe(2);
    });

    it("filters by since exclusively", async () => {
      await log.append("shop", "orders", { id: 1 });
      await log.append("shop", "orders", { id: 2 });
      await log.append("shop", "orders", { id: 3 });
      const r = await log.read("shop", "orders", { since: 1 });
      expect(r.entries.map((e) => e.seq)).toEqual([2, 3]);
      expect(r.lastSeq).toBe(3);
    });

    it("respects limit", async () => {
      for (let i = 0; i < 5; i++) await log.append("shop", "orders", { i });
      const r = await log.read("shop", "orders", { limit: 2 });
      expect(r.entries).toHaveLength(2);
      expect(r.lastSeq).toBe(5);
    });
  });

  describe("namespace isolation", () => {
    it("does not leak entries across namespaces", async () => {
      await log.append("shop", "orders", { from: "shop" });
      await log.append("weather", "orders", { from: "weather" });
      const s = await log.read("shop", "orders");
      const w = await log.read("weather", "orders");
      expect(s.entries).toHaveLength(1);
      expect(w.entries).toHaveLength(1);
      expect(s.entries[0]?.entry).toEqual({ from: "shop" });
      expect(w.entries[0]?.entry).toEqual({ from: "weather" });
    });
  });

  describe("list", () => {
    it("returns [] for an unknown namespace", async () => {
      expect(await log.list("never")).toEqual([]);
    });

    it("lists keys sorted, namespace-scoped", async () => {
      await log.append("shop", "orders", {});
      await log.append("shop", "refunds", {});
      await log.append("weather", "orders", {});
      expect(await log.list("shop")).toEqual(["orders", "refunds"]);
      expect(await log.list("weather")).toEqual(["orders"]);
    });
  });

  describe("delete", () => {
    it("removes a single key's file", async () => {
      await log.append("shop", "orders", {});
      await log.delete("shop", "orders");
      expect(await log.list("shop")).toEqual([]);
    });

    it("resets seq when deleted and re-appended", async () => {
      await log.append("shop", "orders", {});
      await log.append("shop", "orders", {});
      await log.delete("shop", "orders");
      const r = await log.append("shop", "orders", {});
      expect(r.seq).toBe(1);
    });

    it("is a no-op for an unknown key", async () => {
      await expect(log.delete("shop", "never")).resolves.toBeUndefined();
    });
  });

  describe("deleteNamespace", () => {
    it("removes every key in the namespace", async () => {
      await log.append("shop", "orders", {});
      await log.append("shop", "refunds", {});
      await log.deleteNamespace("shop");
      expect(await log.list("shop")).toEqual([]);
      expect(existsSync(join(home, "state", "logs", "shop"))).toBe(false);
    });

    it("does not touch other namespaces", async () => {
      await log.append("shop", "orders", {});
      await log.append("weather", "orders", {});
      await log.deleteNamespace("shop");
      expect(await log.list("weather")).toEqual(["orders"]);
    });
  });
});
