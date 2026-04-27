import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ConfigStore,
  StoreError,
  pickStore,
  type StoreAdapter,
} from "../../../src/store/index.js";

describe("sqlite configs store", () => {
  let home: string;
  let store: StoreAdapter;
  let configs: ConfigStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-configs-"));
    store = pickStore("sqlite", { home });
    configs = store.configs;
  });

  afterEach(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  describe("set + get", () => {
    it("stores a value readable via get()", async () => {
      await configs.set("shop", "MONITOR_URL", "https://example.com");
      expect(await configs.get("shop", "MONITOR_URL")).toBe(
        "https://example.com",
      );
    });

    it("get returns null when unset (the secret-store equivalent doesn't exist)", async () => {
      expect(await configs.get("shop", "MISSING")).toBeNull();
    });

    it("overwrites an existing value", async () => {
      await configs.set("shop", "A", "first");
      await configs.set("shop", "A", "second");
      expect(await configs.get("shop", "A")).toBe("second");
    });

    it("rejects an invalid namespace", async () => {
      await expect(configs.set("Bad NS", "A", "v")).rejects.toBeInstanceOf(
        StoreError,
      );
    });

    it("rejects an invalid config name (same env-var rules as secrets)", async () => {
      await expect(configs.set("shop", "1bad", "v")).rejects.toBeInstanceOf(
        StoreError,
      );
      await expect(configs.set("shop", "with-dash", "v")).rejects.toBeInstanceOf(
        StoreError,
      );
      await expect(configs.set("shop", "", "v")).rejects.toBeInstanceOf(
        StoreError,
      );
    });

    it("preserves exact bytes (configs aren't trimmed)", async () => {
      const raw = "https://example.com/path/  ";
      await configs.set("shop", "URL", raw);
      expect(await configs.get("shop", "URL")).toBe(raw);
    });
  });

  describe("list", () => {
    it("returns [] for a namespace with no configs", async () => {
      expect(await configs.list("shop")).toEqual([]);
    });

    it("returns full entries with values, sorted by name", async () => {
      await configs.set("shop", "B", "two");
      await configs.set("shop", "A", "one");
      const entries = await configs.list("shop");
      expect(entries.map((e) => e.name)).toEqual(["A", "B"]);
      expect(entries.map((e) => e.value)).toEqual(["one", "two"]);
      // Timestamps populate; their exact values aren't checked here.
      for (const e of entries) {
        expect(typeof e.createdAt).toBe("string");
        expect(typeof e.updatedAt).toBe("string");
      }
    });

    it("is scoped per-namespace", async () => {
      await configs.set("shop", "SHARED", "shop-value");
      await configs.set("weather", "SHARED", "weather-value");
      expect((await configs.list("shop")).map((e) => e.value)).toEqual([
        "shop-value",
      ]);
      expect((await configs.list("weather")).map((e) => e.value)).toEqual([
        "weather-value",
      ]);
    });
  });

  describe("resolve", () => {
    it("returns only the requested names, only if present", async () => {
      await configs.set("shop", "A", "1");
      await configs.set("shop", "B", "2");
      const resolved = await configs.resolve("shop", ["A", "MISSING", "B"]);
      expect(resolved).toEqual({ A: "1", B: "2" });
    });

    it("returns {} when the namespace has no entries yet", async () => {
      expect(await configs.resolve("brand-new", ["X"])).toEqual({});
    });

    it("returns {} when names list is empty", async () => {
      await configs.set("shop", "A", "1");
      expect(await configs.resolve("shop", [])).toEqual({});
    });

    it("does not leak across namespaces", async () => {
      await configs.set("shop", "URL", "https://shop");
      await configs.set("weather", "URL", "https://weather");
      expect(await configs.resolve("shop", ["URL"])).toEqual({
        URL: "https://shop",
      });
      expect(await configs.resolve("weather", ["URL"])).toEqual({
        URL: "https://weather",
      });
    });
  });

  describe("delete", () => {
    it("removes a single config", async () => {
      await configs.set("shop", "A", "1");
      await configs.delete("shop", "A");
      expect(await configs.list("shop")).toEqual([]);
      expect(await configs.get("shop", "A")).toBeNull();
    });

    it("is a no-op when the config does not exist", async () => {
      await expect(configs.delete("shop", "NEVER")).resolves.toBeUndefined();
    });

    it("leaves other configs in the namespace", async () => {
      await configs.set("shop", "A", "1");
      await configs.set("shop", "B", "2");
      await configs.delete("shop", "A");
      expect((await configs.list("shop")).map((e) => e.name)).toEqual(["B"]);
    });
  });

  describe("deleteNamespace", () => {
    it("removes every config in the namespace", async () => {
      await configs.set("shop", "A", "1");
      await configs.set("shop", "B", "2");
      await configs.deleteNamespace("shop");
      expect(await configs.list("shop")).toEqual([]);
    });

    it("is a no-op when the namespace has no configs", async () => {
      await expect(configs.deleteNamespace("never")).resolves.toBeUndefined();
    });

    it("does not touch other namespaces", async () => {
      await configs.set("shop", "A", "1");
      await configs.set("weather", "A", "2");
      await configs.deleteNamespace("shop");
      expect((await configs.list("weather")).map((e) => e.name)).toEqual(["A"]);
    });
  });
});
