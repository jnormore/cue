import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SecretStore, StoreError } from "../../../src/store/index.js";
import { fsSecrets } from "../../../src/store/fs/secrets.js";

describe("fsSecrets", () => {
  let home: string;
  let secrets: SecretStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-secrets-"));
    secrets = fsSecrets(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe("set", () => {
    it("writes the secret under home/secrets/<namespace>/<name>", async () => {
      await secrets.set("shop", "SHOPIFY_TOKEN", "shpat_abc");
      const path = join(home, "secrets", "shop", "SHOPIFY_TOKEN");
      expect(readFileSync(path, "utf8")).toBe("shpat_abc");
    });

    it("creates the namespace directory on first write", async () => {
      expect(existsSync(join(home, "secrets", "shop"))).toBe(false);
      await secrets.set("shop", "A", "1");
      expect(existsSync(join(home, "secrets", "shop"))).toBe(true);
    });

    it("writes with mode 0600", async () => {
      await secrets.set("shop", "A", "value");
      const st = statSync(join(home, "secrets", "shop", "A"));
      // Low 9 bits are permission; 0o600 = owner rw.
      expect(st.mode & 0o777).toBe(0o600);
    });

    it("overwrites an existing value atomically", async () => {
      await secrets.set("shop", "A", "first");
      await secrets.set("shop", "A", "second");
      expect(readFileSync(join(home, "secrets", "shop", "A"), "utf8")).toBe(
        "second",
      );
      // No stale .tmp file
      expect(existsSync(join(home, "secrets", "shop", "A.tmp"))).toBe(false);
    });

    it("rejects an invalid namespace", async () => {
      await expect(secrets.set("Bad NS", "A", "v")).rejects.toBeInstanceOf(
        StoreError,
      );
    });

    it("rejects an invalid secret name", async () => {
      await expect(secrets.set("shop", "1bad", "v")).rejects.toBeInstanceOf(
        StoreError,
      );
      await expect(secrets.set("shop", "with-dash", "v")).rejects.toBeInstanceOf(
        StoreError,
      );
      await expect(secrets.set("shop", "", "v")).rejects.toBeInstanceOf(
        StoreError,
      );
    });

    it("preserves exact bytes including trailing whitespace", async () => {
      const raw = "shpat_abc\n  ";
      await secrets.set("shop", "A", raw);
      const resolved = await secrets.resolve("shop", ["A"]);
      expect(resolved.A).toBe(raw);
    });
  });

  describe("list", () => {
    it("returns [] for a namespace with no secrets", async () => {
      expect(await secrets.list("shop")).toEqual([]);
    });

    it("returns names sorted, excluding .tmp files", async () => {
      await secrets.set("shop", "B", "2");
      await secrets.set("shop", "A", "1");
      expect(await secrets.list("shop")).toEqual(["A", "B"]);
    });

    it("is scoped per-namespace", async () => {
      await secrets.set("shop", "SHARED", "shop-value");
      await secrets.set("weather", "SHARED", "weather-value");
      expect(await secrets.list("shop")).toEqual(["SHARED"]);
      expect(await secrets.list("weather")).toEqual(["SHARED"]);
    });
  });

  describe("resolve", () => {
    it("returns only the requested names, only if present", async () => {
      await secrets.set("shop", "A", "1");
      await secrets.set("shop", "B", "2");
      const resolved = await secrets.resolve("shop", ["A", "MISSING", "B"]);
      expect(resolved).toEqual({ A: "1", B: "2" });
    });

    it("returns {} when the namespace has no directory yet", async () => {
      expect(await secrets.resolve("brand-new", ["X"])).toEqual({});
    });

    it("does not leak secrets across namespaces", async () => {
      await secrets.set("shop", "TOKEN", "shop-token");
      await secrets.set("weather", "TOKEN", "weather-token");
      expect(await secrets.resolve("shop", ["TOKEN"])).toEqual({
        TOKEN: "shop-token",
      });
      expect(await secrets.resolve("weather", ["TOKEN"])).toEqual({
        TOKEN: "weather-token",
      });
    });
  });

  describe("delete", () => {
    it("removes a single secret", async () => {
      await secrets.set("shop", "A", "1");
      await secrets.delete("shop", "A");
      expect(await secrets.list("shop")).toEqual([]);
      expect(await secrets.resolve("shop", ["A"])).toEqual({});
    });

    it("is a no-op when the secret does not exist", async () => {
      await expect(secrets.delete("shop", "NEVER")).resolves.toBeUndefined();
    });

    it("leaves other secrets in the namespace", async () => {
      await secrets.set("shop", "A", "1");
      await secrets.set("shop", "B", "2");
      await secrets.delete("shop", "A");
      expect(await secrets.list("shop")).toEqual(["B"]);
    });
  });

  describe("deleteNamespace", () => {
    it("removes every secret in the namespace", async () => {
      await secrets.set("shop", "A", "1");
      await secrets.set("shop", "B", "2");
      await secrets.deleteNamespace("shop");
      expect(await secrets.list("shop")).toEqual([]);
      expect(existsSync(join(home, "secrets", "shop"))).toBe(false);
    });

    it("is a no-op when the namespace has no secrets", async () => {
      await expect(secrets.deleteNamespace("never")).resolves.toBeUndefined();
    });

    it("does not touch other namespaces", async () => {
      await secrets.set("shop", "A", "1");
      await secrets.set("weather", "A", "2");
      await secrets.deleteNamespace("shop");
      expect(await secrets.list("weather")).toEqual(["A"]);
    });
  });
});
