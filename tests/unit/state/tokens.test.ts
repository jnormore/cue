import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type NamespaceTokenStore,
  parseTokenNamespace,
  pickState,
  type StateAdapter,
} from "../../../src/state/index.js";
import { pickStore } from "../../../src/store/index.js";

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

describe("sqlite namespace tokens store", () => {
  let home: string;
  let state: StateAdapter;
  let tokens: NamespaceTokenStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-toks-"));
    pickStore("sqlite", { home }).close();
    state = pickState("sqlite", { home });
    tokens = state.tokens;
  });

  afterEach(async () => {
    await state.close();
    rmSync(home, { recursive: true, force: true });
  });

  describe("resolveOrCreate", () => {
    it("mints a stk_<namespace>.<hex> token on first call", async () => {
      const token = await tokens.resolveOrCreate("shop");
      expect(token).toMatch(/^stk_shop\.[0-9a-f]{64}$/);
    });

    it("returns the same token on subsequent calls", async () => {
      const a = await tokens.resolveOrCreate("shop");
      const b = await tokens.resolveOrCreate("shop");
      expect(a).toBe(b);
    });

    it("survives reopens", async () => {
      const a = await tokens.resolveOrCreate("shop");
      await state.close();
      state = pickState("sqlite", { home });
      tokens = state.tokens;
      const b = await tokens.resolveOrCreate("shop");
      expect(a).toBe(b);
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

    it("returns null when the namespace has no token", async () => {
      const fake = "stk_unknown." + "ab".repeat(32);
      expect(await tokens.verify(fake)).toBeNull();
    });
  });

  describe("deleteNamespace", () => {
    it("removes the namespace's token", async () => {
      const token = await tokens.resolveOrCreate("shop");
      await tokens.deleteNamespace("shop");
      expect(await tokens.verify(token)).toBeNull();
    });

    it("is a no-op when the namespace had no token", async () => {
      await expect(tokens.deleteNamespace("never")).resolves.toBeUndefined();
    });

    it("does not touch other namespaces", async () => {
      await tokens.resolveOrCreate("shop");
      const weatherToken = await tokens.resolveOrCreate("weather");
      await tokens.deleteNamespace("shop");
      expect(await tokens.verify(weatherToken)).toBe("weather");
    });
  });
});
