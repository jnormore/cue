import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  intersectPolicy,
  loadProjectConfig,
  walkUpForConfig,
} from "../../src/policy.js";

describe("walkUpForConfig", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cue-walk-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds .cue.toml in the start dir", () => {
    writeFileSync(join(root, ".cue.toml"), "");
    expect(walkUpForConfig(root)).toBe(join(root, ".cue.toml"));
  });

  it("finds .cue.toml in an ancestor dir", () => {
    writeFileSync(join(root, ".cue.toml"), "");
    const child = join(root, "a", "b", "c");
    mkdirSync(child, { recursive: true });
    expect(walkUpForConfig(child)).toBe(join(root, ".cue.toml"));
  });

  it("returns null when no .cue.toml exists up to root", () => {
    const child = join(root, "nested");
    mkdirSync(child);
    expect(walkUpForConfig(child)).toBeNull();
  });

  it("returns the nearest match when multiple exist", () => {
    writeFileSync(join(root, ".cue.toml"), "");
    const child = join(root, "a");
    mkdirSync(child);
    writeFileSync(join(child, ".cue.toml"), "");
    expect(walkUpForConfig(child)).toBe(join(child, ".cue.toml"));
  });
});

describe("loadProjectConfig", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cue-proj-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null when no .cue.toml exists", () => {
    expect(loadProjectConfig(root)).toBeNull();
  });

  it("parses runtime, store, cron, cors, and ceiling fields", () => {
    writeFileSync(
      join(root, ".cue.toml"),
      `runtime        = "unitask"
store          = "fs"
cron           = "node-cron"
cors           = ["https://claude.ai", "https://*.anthropic.com"]
memoryMb       = 512
timeoutSeconds = 60
allowNet       = ["api.github.com", "api.openai.com"]
secrets        = ["GITHUB_TOKEN"]
files          = ["/Users/me/work/config.yml"]
dirs           = ["/Users/me/work"]
`,
    );
    const p = loadProjectConfig(root);
    expect(p).not.toBeNull();
    expect(p?.path).toBe(join(root, ".cue.toml"));
    expect(p?.runtime).toBe("unitask");
    expect(p?.store).toBe("fs");
    expect(p?.cron).toBe("node-cron");
    expect(p?.cors).toEqual([
      "https://claude.ai",
      "https://*.anthropic.com",
    ]);
    expect(p?.ceiling).toEqual({
      memoryMb: 512,
      timeoutSeconds: 60,
      allowNet: ["api.github.com", "api.openai.com"],
      secrets: ["GITHUB_TOKEN"],
      files: ["/Users/me/work/config.yml"],
      dirs: ["/Users/me/work"],
    });
  });

  it("accepts a single-string cors as [cors]", () => {
    writeFileSync(join(root, ".cue.toml"), `cors = "*"\n`);
    const p = loadProjectConfig(root);
    expect(p?.cors).toEqual(["*"]);
  });

  it("filters non-string entries in cors array", () => {
    writeFileSync(
      join(root, ".cue.toml"),
      `cors = ["https://a.com", 1, true]\n`,
    );
    const p = loadProjectConfig(root);
    expect(p?.cors).toEqual(["https://a.com"]);
  });

  it("tolerates missing fields", () => {
    writeFileSync(join(root, ".cue.toml"), "");
    const p = loadProjectConfig(root);
    expect(p).not.toBeNull();
    expect(p?.runtime).toBeUndefined();
    expect(p?.store).toBeUndefined();
    expect(p?.ceiling).toEqual({});
  });

  it("ignores unknown fields and wrong types", () => {
    writeFileSync(
      join(root, ".cue.toml"),
      `foo       = "bar"
memoryMb  = "not-a-number"
allowNet  = [1, 2, "ok"]
`,
    );
    const p = loadProjectConfig(root);
    expect(p?.ceiling.memoryMb).toBeUndefined();
    expect(p?.ceiling.allowNet).toEqual(["ok"]);
  });

  it("throws on malformed TOML", () => {
    writeFileSync(join(root, ".cue.toml"), "this is !!! not toml ===");
    expect(() => loadProjectConfig(root)).toThrow(/Failed to parse/);
  });
});

describe("intersectPolicy", () => {
  it("returns empty effective and no denials when both are empty", () => {
    expect(intersectPolicy({}, {})).toEqual({ effective: {}, denials: [] });
  });

  describe("numeric caps (memoryMb, timeoutSeconds)", () => {
    it("passes requested through when no ceiling", () => {
      expect(intersectPolicy({ memoryMb: 256 }, {}).effective).toEqual({
        memoryMb: 256,
      });
    });

    it("applies the ceiling as a cap when requested exceeds it", () => {
      const r = intersectPolicy({ memoryMb: 1024 }, { memoryMb: 256 });
      expect(r.effective.memoryMb).toBe(256);
      expect(r.denials).toContain("memoryMb:1024>256");
    });

    it("passes requested through when under ceiling, no denial", () => {
      const r = intersectPolicy(
        { timeoutSeconds: 20 },
        { timeoutSeconds: 60 },
      );
      expect(r.effective.timeoutSeconds).toBe(20);
      expect(r.denials).toEqual([]);
    });

    it("applies ceiling even when no request is made", () => {
      const r = intersectPolicy({}, { memoryMb: 256 });
      expect(r.effective.memoryMb).toBe(256);
      expect(r.denials).toEqual([]);
    });
  });

  describe("array allow-lists", () => {
    it("passes requested through when no ceiling", () => {
      const r = intersectPolicy({ allowNet: ["a", "b"] }, {});
      expect(r.effective.allowNet).toEqual(["a", "b"]);
      expect(r.denials).toEqual([]);
    });

    it("intersects requested against ceiling", () => {
      const r = intersectPolicy(
        { allowNet: ["a", "b", "c"] },
        { allowNet: ["a", "c", "d"] },
      );
      expect(r.effective.allowNet).toEqual(["a", "c"]);
      expect(r.denials).toEqual(["allowNet:b"]);
    });

    it("does NOT fill in ceiling when no request is made (deny-by-default)", () => {
      const r = intersectPolicy({}, { allowNet: ["a"] });
      expect(r.effective.allowNet).toBeUndefined();
      expect(r.denials).toEqual([]);
    });

    it("empty requested array yields empty effective, no denials", () => {
      const r = intersectPolicy({ allowNet: [] }, { allowNet: ["a"] });
      expect(r.effective.allowNet).toEqual([]);
      expect(r.denials).toEqual([]);
    });

    it("denies every entry when ceiling is empty for that field", () => {
      const r = intersectPolicy(
        { secrets: ["GITHUB_TOKEN", "OPENAI_API_KEY"] },
        { secrets: [] },
      );
      expect(r.effective.secrets).toEqual([]);
      expect(r.denials).toEqual([
        "secrets:GITHUB_TOKEN",
        "secrets:OPENAI_API_KEY",
      ]);
    });
  });

  it("handles a full policy intersect with mixed allow/deny", () => {
    const { effective, denials } = intersectPolicy(
      {
        memoryMb: 1024,
        timeoutSeconds: 30,
        allowNet: ["api.github.com", "evil.com"],
        secrets: ["GITHUB_TOKEN"],
      },
      {
        memoryMb: 256,
        allowNet: ["api.github.com", "api.openai.com"],
        secrets: ["GITHUB_TOKEN"],
      },
    );
    expect(effective).toEqual({
      memoryMb: 256,
      timeoutSeconds: 30,
      allowNet: ["api.github.com"],
      secrets: ["GITHUB_TOKEN"],
    });
    expect(denials).toEqual(["memoryMb:1024>256", "allowNet:evil.com"]);
  });
});
