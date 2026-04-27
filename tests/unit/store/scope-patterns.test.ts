import { describe, expect, it } from "vitest";
import {
  scopePatternMatches,
  StoreError,
  validateScopePattern,
} from "../../../src/store/index.js";

describe("scopePatternMatches", () => {
  it("'*' matches any namespace", () => {
    expect(scopePatternMatches("*", "anything")).toBe(true);
    expect(scopePatternMatches("*", "shop")).toBe(true);
    expect(scopePatternMatches("*", "")).toBe(true);
  });

  it("'prefix-*' matches anything with that prefix", () => {
    expect(scopePatternMatches("acme-*", "acme-shop")).toBe(true);
    expect(scopePatternMatches("acme-*", "acme-")).toBe(true);
    expect(scopePatternMatches("acme-*", "acme")).toBe(false); // no trailing dash
    expect(scopePatternMatches("acme-*", "bob-foo")).toBe(false);
  });

  it("'workspace/*' matches any namespace inside that workspace", () => {
    // Cloud-allocated namespaces have shape "<workspace>/<slug>-<id>";
    // an agent token scoped to "<workspace>/*" should reach all of them.
    expect(scopePatternMatches("jason/*", "jason/uptime-monitor-abc")).toBe(true);
    expect(scopePatternMatches("jason/*", "jason/")).toBe(true);
    expect(scopePatternMatches("jason/*", "jason")).toBe(false); // no trailing slash
    expect(scopePatternMatches("jason/*", "alice/uptime-monitor-abc")).toBe(false);
    // A dash-only legacy namespace shouldn't match a slash wildcard.
    expect(scopePatternMatches("jason/*", "jason-mnqr84bv")).toBe(false);
  });

  it("literal patterns require exact equality", () => {
    expect(scopePatternMatches("shop", "shop")).toBe(true);
    expect(scopePatternMatches("shop", "shop-2")).toBe(false);
    expect(scopePatternMatches("shop", "")).toBe(false);
  });

  it("middle-of-string globs are not supported (treated as literals)", () => {
    expect(scopePatternMatches("a*b", "a-shop-b")).toBe(false);
    expect(scopePatternMatches("a*b", "a*b")).toBe(true);
  });
});

describe("validateScopePattern", () => {
  it("accepts the wildcard '*'", () => {
    expect(() => validateScopePattern("*")).not.toThrow();
  });

  it("accepts prefix patterns with valid prefixes", () => {
    expect(() => validateScopePattern("acme-*")).not.toThrow();
    expect(() => validateScopePattern("a-*")).not.toThrow();
    expect(() => validateScopePattern("123-*")).not.toThrow();
  });

  it("accepts workspace/* wildcards", () => {
    expect(() => validateScopePattern("jason/*")).not.toThrow();
    expect(() => validateScopePattern("acme/*")).not.toThrow();
  });

  it("accepts literal namespace names (legacy and slash forms)", () => {
    expect(() => validateScopePattern("shop")).not.toThrow();
    expect(() => validateScopePattern("foo-bar")).not.toThrow();
    expect(() => validateScopePattern("jason/uptime-monitor-abc")).not.toThrow();
  });

  it("rejects empty prefix '*' alone is fine but '-*' is rejected", () => {
    // '*' alone is the wildcard — accepted.
    expect(() => validateScopePattern("*")).not.toThrow();
    // Bare prefix without anything before '*' would be empty — that's
    // the same as wildcard but reaches via a different code path.
    expect(() => validateScopePattern("Bad NS-*")).toThrow(StoreError);
  });

  it("rejects invalid characters in prefix", () => {
    expect(() => validateScopePattern("Bad-*")).toThrow(StoreError);
    expect(() => validateScopePattern("under_score-*")).toThrow(StoreError);
  });

  it("rejects invalid literal namespace names", () => {
    expect(() => validateScopePattern("Bad NS")).toThrow(StoreError);
    expect(() => validateScopePattern("")).toThrow(StoreError);
  });
});
