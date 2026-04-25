import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentTokenStore,
  StoreError,
  parseAgentTokenId,
  pickStore,
  type StoreAdapter,
} from "../../../src/store/index.js";

describe("parseAgentTokenId", () => {
  it("extracts the id from well-formed bearer strings", () => {
    expect(parseAgentTokenId("atk_01ABC.deadbeef")).toBe("atk_01ABC");
  });

  it("returns null for malformed input", () => {
    expect(parseAgentTokenId("nope")).toBeNull();
    expect(parseAgentTokenId("atk_only")).toBeNull();
    expect(parseAgentTokenId("atk_01ABC.")).toBeNull();
    expect(parseAgentTokenId("other_prefix.abc")).toBeNull();
  });
});

describe("sqlite agent-tokens store", () => {
  let home: string;
  let store: StoreAdapter;
  let tokens: AgentTokenStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-atk-"));
    store = pickStore("sqlite", { home });
    tokens = store.agentTokens;
  });

  afterEach(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  describe("mint", () => {
    it("returns {id, token, scope, createdAt}", async () => {
      const r = await tokens.mint({ scope: { namespaces: ["shop"] } });
      expect(r.id).toMatch(/^atk_/);
      expect(r.token).toMatch(/^atk_[0-9A-Z]+\.[0-9a-f]{64}$/);
      expect(r.scope).toEqual({ namespaces: ["shop"] });
    });

    it("stores label when provided; omits it otherwise", async () => {
      const a = await tokens.mint({
        scope: { namespaces: ["shop"] },
        label: "claude-desktop",
      });
      expect(a.label).toBe("claude-desktop");
      const b = await tokens.mint({ scope: { namespaces: ["shop"] } });
      expect(b.label).toBeUndefined();
    });

    it("de-dupes + sorts scope namespaces for stable comparison", async () => {
      const r = await tokens.mint({
        scope: { namespaces: ["weather", "shop", "shop"] },
      });
      expect(r.scope.namespaces).toEqual(["shop", "weather"]);
    });

    it("rejects an empty scope", async () => {
      await expect(
        tokens.mint({ scope: { namespaces: [] } }),
      ).rejects.toBeInstanceOf(StoreError);
    });

    it("rejects invalid namespace names", async () => {
      await expect(
        tokens.mint({ scope: { namespaces: ["Bad Name"] } }),
      ).rejects.toBeInstanceOf(StoreError);
    });
  });

  describe("verify", () => {
    it("returns a summary (no raw token) for valid bearers", async () => {
      const r = await tokens.mint({ scope: { namespaces: ["shop"] } });
      const verified = await tokens.verify(r.token);
      expect(verified).not.toBeNull();
      expect(verified?.id).toBe(r.id);
      expect(verified?.scope).toEqual({ namespaces: ["shop"] });
      expect((verified as unknown as { token?: string }).token).toBeUndefined();
    });

    it("returns null for a token with a forged tail", async () => {
      const r = await tokens.mint({ scope: { namespaces: ["shop"] } });
      const forged = `${r.id}.` + "f".repeat(64);
      expect(await tokens.verify(forged)).toBeNull();
    });

    it("returns null for unknown ids", async () => {
      expect(await tokens.verify("atk_nope.abc")).toBeNull();
    });

    it("returns null for malformed bearers", async () => {
      expect(await tokens.verify("garbage")).toBeNull();
      expect(await tokens.verify("atk_")).toBeNull();
    });
  });

  describe("list / get / delete", () => {
    it("list returns summaries in createdAt order without the raw token", async () => {
      const a = await tokens.mint({
        scope: { namespaces: ["a"] },
        label: "first",
      });
      const b = await tokens.mint({
        scope: { namespaces: ["b"] },
        label: "second",
      });
      const all = await tokens.list();
      expect(all.map((s) => s.id)).toEqual([a.id, b.id]);
      expect((all[0] as unknown as { token?: string }).token).toBeUndefined();
    });

    it("get returns the summary for a known id, null otherwise", async () => {
      const a = await tokens.mint({ scope: { namespaces: ["a"] } });
      expect(await tokens.get(a.id)).toMatchObject({ id: a.id });
      expect(await tokens.get("atk_unknown")).toBeNull();
    });

    it("delete revokes the token", async () => {
      const r = await tokens.mint({ scope: { namespaces: ["a"] } });
      await tokens.delete(r.id);
      expect(await tokens.verify(r.token)).toBeNull();
      expect(await tokens.get(r.id)).toBeNull();
    });

    it("delete on unknown id is a no-op", async () => {
      await expect(tokens.delete("atk_nope")).resolves.toBeUndefined();
    });
  });
});
