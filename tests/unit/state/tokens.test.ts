import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fsNamespaceTokens } from "../../../src/state/fs/tokens.js";
import {
  type NamespaceTokenStore,
  parseTokenNamespace,
} from "../../../src/state/index.js";

describe("parseTokenNamespace", () => {
  it("extracts the namespace from a well-formed token", () => {
    expect(parseTokenNamespace("stk_shop.abcdef")).toBe("shop");
    expect(parseTokenNamespace("stk_foo-bar.0123")).toBe("foo-bar");
  });

  it("returns null for malformed tokens", () => {
    expect(parseTokenNamespace("nope")).toBeNull();
    expect(parseTokenNamespace("stk_only")).toBeNull();
    expect(parseTokenNamespace("stk_.abc")).toBeNull();
    expect(parseTokenNamespace("stk_ns.")).toBeNull();
    expect(parseTokenNamespace("stk_BadUpper.abc")).toBeNull();
  });
});

describe("fsNamespaceTokens", () => {
  let home: string;
  let tokens: NamespaceTokenStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-toks-"));
    tokens = fsNamespaceTokens(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe("resolveOrCreate", () => {
    it("mints a stk_<namespace>.<hex> token on first call, persists it", async () => {
      const token = await tokens.resolveOrCreate("shop");
      expect(token).toMatch(/^stk_shop\.[0-9a-f]{64}$/);
      const path = join(home, "state", "tokens", "shop");
      expect(readFileSync(path, "utf8")).toBe(token);
    });

    it("returns the same token on subsequent calls", async () => {
      const a = await tokens.resolveOrCreate("shop");
      const b = await tokens.resolveOrCreate("shop");
      expect(a).toBe(b);
    });

    it("stores with mode 0600", async () => {
      await tokens.resolveOrCreate("shop");
      const st = statSync(join(home, "state", "tokens", "shop"));
      expect(st.mode & 0o777).toBe(0o600);
    });
  });

  describe("verify", () => {
    it("returns the namespace for a valid token", async () => {
      const token = await tokens.resolveOrCreate("shop");
      expect(await tokens.verify(token)).toBe("shop");
    });

    it("returns null for a wrong token with a valid namespace prefix", async () => {
      await tokens.resolveOrCreate("shop");
      const spoof = "stk_shop." + "00".repeat(32);
      expect(await tokens.verify(spoof)).toBeNull();
    });

    it("returns null for a malformed token", async () => {
      expect(await tokens.verify("nope")).toBeNull();
      expect(await tokens.verify("stk_only")).toBeNull();
    });

    it("returns null when the namespace has no token file", async () => {
      const fake = "stk_unknown." + "ab".repeat(32);
      expect(await tokens.verify(fake)).toBeNull();
    });
  });

  describe("deleteNamespace", () => {
    it("removes the namespace's token", async () => {
      await tokens.resolveOrCreate("shop");
      await tokens.deleteNamespace("shop");
      expect(existsSync(join(home, "state", "tokens", "shop"))).toBe(false);
    });

    it("is a no-op when the namespace had no token", async () => {
      await expect(tokens.deleteNamespace("never")).resolves.toBeUndefined();
    });

    it("does not touch other namespaces", async () => {
      await tokens.resolveOrCreate("shop");
      await tokens.resolveOrCreate("weather");
      await tokens.deleteNamespace("shop");
      expect(existsSync(join(home, "state", "tokens", "weather"))).toBe(true);
    });
  });
});
