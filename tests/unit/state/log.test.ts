import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type LogStore,
  pickState,
  type StateAdapter,
} from "../../../src/state/index.js";
import { pickStore, StoreError } from "../../../src/store/index.js";

describe("sqlite log store", () => {
  let home: string;
  let state: StateAdapter;
  let log: LogStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-log-"));
    // Open the store first so migrations run; close it immediately.
    pickStore("sqlite", { home }).close();
    state = pickState("sqlite", { home });
    log = state.log;
  });

  afterEach(async () => {
    await state.close();
    rmSync(home, { recursive: true, force: true });
  });

  describe("append", () => {
    it("starts seq at 1 and increments per (ns, key)", async () => {
      const r1 = await log.append("shop", "orders", { id: 1 });
      const r2 = await log.append("shop", "orders", { id: 2 });
      const r3 = await log.append("shop", "orders", { id: 3 });
      expect(r1.seq).toBe(1);
      expect(r2.seq).toBe(2);
      expect(r3.seq).toBe(3);
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

    it("rejects entries larger than 64KB", async () => {
      // 100KB string easily exceeds the 64KB cap once JSON-serialized.
      const big = { blob: "x".repeat(100 * 1024) };
      await expect(log.append("shop", "orders", big)).rejects.toMatchObject({
        kind: "ValidationError",
      });
    });

    it("accepts entries just under the 64KB cap", async () => {
      // 60KB of payload + JSON overhead stays under 64KB.
      const small = { blob: "x".repeat(60 * 1024) };
      await expect(
        log.append("shop", "orders", small),
      ).resolves.toMatchObject({ seq: 1 });
    });

    it("serializes concurrent appends to the same key (no dup seq)", async () => {
      const N = 20;
      const promises = Array.from({ length: N }, (_, i) =>
        log.append("shop", "orders", { i }),
      );
      const results = await Promise.all(promises);
      const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    });

    it("resumes numbering across reopens", async () => {
      await log.append("shop", "orders", { id: 1 });
      await log.append("shop", "orders", { id: 2 });
      await state.close();
      // Reopen against the same home.
      state = pickState("sqlite", { home });
      log = state.log;
      const r3 = await log.append("shop", "orders", { id: 3 });
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
    it("removes a single key", async () => {
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
    });

    it("does not touch other namespaces", async () => {
      await log.append("shop", "orders", {});
      await log.append("weather", "orders", {});
      await log.deleteNamespace("shop");
      expect(await log.list("weather")).toEqual(["orders"]);
    });
  });
});
