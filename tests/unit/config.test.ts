import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CRON,
  DEFAULT_PORT,
  DEFAULT_RUNTIME,
  DEFAULT_STORE,
  cuePaths,
  resolveConfig,
  tokenMode,
  writePort,
} from "../../src/config.js";
import type { ProjectConfig } from "../../src/policy.js";

describe("cuePaths", () => {
  it("returns paths under the given home", () => {
    const p = cuePaths("/a/b");
    expect(p).toEqual({
      home: "/a/b",
      token: "/a/b/token",
      port: "/a/b/port",
      actions: "/a/b/actions",
      triggers: "/a/b/triggers",
      runs: "/a/b/runs",
    });
  });
});

describe("resolveConfig", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("creates the home directory tree", () => {
    const cfg = resolveConfig({ home, env: {} });
    expect(existsSync(cfg.paths.home)).toBe(true);
    expect(existsSync(cfg.paths.actions)).toBe(true);
    expect(existsSync(cfg.paths.triggers)).toBe(true);
    expect(existsSync(cfg.paths.runs)).toBe(true);
  });

  it("generates a 64-char hex token on first resolve, chmod 600", () => {
    const cfg = resolveConfig({ home, env: {} });
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(cfg.paths.token)).toBe(true);
    if (process.platform !== "win32") {
      expect(tokenMode(cfg.paths)).toBe(0o600);
    }
  });

  it("reuses an existing token across resolves", () => {
    const first = resolveConfig({ home, env: {} });
    const second = resolveConfig({ home, env: {} });
    expect(second.token).toBe(first.token);
  });

  it("defaults port to 4747 when no sources present", () => {
    const cfg = resolveConfig({ home, env: {} });
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(4747);
  });

  it("prefers portFlag > env > file > default", () => {
    writePort(home, 9000);
    expect(resolveConfig({ home, env: {} }).port).toBe(9000);
    expect(resolveConfig({ home, env: { CUE_PORT: "8080" } }).port).toBe(8080);
    expect(
      resolveConfig({ home, env: { CUE_PORT: "8080" }, portFlag: 7000 }).port,
    ).toBe(7000);
  });

  it("allows portFlag=0 for random-bind semantics", () => {
    expect(resolveConfig({ home, env: {}, portFlag: 0 }).port).toBe(0);
  });

  it("throws on invalid CUE_PORT", () => {
    expect(() => resolveConfig({ home, env: { CUE_PORT: "nope" } })).toThrow(
      /CUE_PORT/,
    );
    expect(() => resolveConfig({ home, env: { CUE_PORT: "99999" } })).toThrow(
      /CUE_PORT/,
    );
  });

  it("defaults runtime to unitask", () => {
    const cfg = resolveConfig({ home, env: {} });
    expect(cfg.runtime).toBe(DEFAULT_RUNTIME);
    expect(DEFAULT_RUNTIME).toBe("unitask");
  });

  it("prefers runtimeFlag > env > default", () => {
    expect(
      resolveConfig({ home, env: { CUE_RUNTIME: "firecracker" } }).runtime,
    ).toBe("firecracker");
    expect(
      resolveConfig({
        home,
        env: { CUE_RUNTIME: "firecracker" },
        runtimeFlag: "docker",
      }).runtime,
    ).toBe("docker");
  });

  it("does not validate unknown runtime names (step-5 adapter will)", () => {
    const cfg = resolveConfig({ home, env: {}, runtimeFlag: "not-a-real-one" });
    expect(cfg.runtime).toBe("not-a-real-one");
  });

  it("defaults store to fs", () => {
    const cfg = resolveConfig({ home, env: {} });
    expect(cfg.store).toBe(DEFAULT_STORE);
    expect(DEFAULT_STORE).toBe("fs");
  });

  it("prefers storeFlag > env > default", () => {
    expect(resolveConfig({ home, env: { CUE_STORE: "sqlite" } }).store).toBe(
      "sqlite",
    );
    expect(
      resolveConfig({
        home,
        env: { CUE_STORE: "sqlite" },
        storeFlag: "postgres",
      }).store,
    ).toBe("postgres");
  });

  it("does not validate unknown store names (step-3 adapter will)", () => {
    const cfg = resolveConfig({ home, env: {}, storeFlag: "not-a-real-one" });
    expect(cfg.store).toBe("not-a-real-one");
  });

  it("defaults cron to node-cron", () => {
    const cfg = resolveConfig({ home, env: {} });
    expect(cfg.cron).toBe(DEFAULT_CRON);
    expect(DEFAULT_CRON).toBe("node-cron");
  });

  it("prefers cronFlag > env > default", () => {
    expect(resolveConfig({ home, env: { CUE_CRON: "bullmq" } }).cron).toBe(
      "bullmq",
    );
    expect(
      resolveConfig({
        home,
        env: { CUE_CRON: "bullmq" },
        cronFlag: "pg-cron",
      }).cron,
    ).toBe("pg-cron");
  });

  it("does not validate unknown cron names (step-7 adapter will)", () => {
    const cfg = resolveConfig({ home, env: {}, cronFlag: "not-a-real-one" });
    expect(cfg.cron).toBe("not-a-real-one");
  });

  it("uses project.runtime between env and default", () => {
    const project = {
      path: "/fake/.cue.toml",
      runtime: "from-project",
      ceiling: {},
    };
    expect(resolveConfig({ home, env: {}, project }).runtime).toBe(
      "from-project",
    );
    expect(
      resolveConfig({ home, env: { CUE_RUNTIME: "from-env" }, project })
        .runtime,
    ).toBe("from-env");
    expect(
      resolveConfig({
        home,
        env: { CUE_RUNTIME: "from-env" },
        runtimeFlag: "from-flag",
        project,
      }).runtime,
    ).toBe("from-flag");
  });

  it("uses project.store between env and default", () => {
    const project = {
      path: "/fake/.cue.toml",
      store: "from-project",
      ceiling: {},
    };
    expect(resolveConfig({ home, env: {}, project }).store).toBe(
      "from-project",
    );
    expect(
      resolveConfig({ home, env: { CUE_STORE: "from-env" }, project }).store,
    ).toBe("from-env");
  });

  it("uses project.cron between env and default", () => {
    const project = {
      path: "/fake/.cue.toml",
      cron: "from-project",
      ceiling: {},
    };
    expect(resolveConfig({ home, env: {}, project }).cron).toBe(
      "from-project",
    );
    expect(
      resolveConfig({ home, env: { CUE_CRON: "from-env" }, project }).cron,
    ).toBe("from-env");
  });

  it("defaults cors to [] (same-origin only)", () => {
    const cfg = resolveConfig({ home, env: {} });
    expect(cfg.cors).toEqual([]);
  });

  it("parses --cors CSV into cors[]", () => {
    expect(
      resolveConfig({ home, env: {}, corsFlag: "https://a.com,https://b.com" })
        .cors,
    ).toEqual(["https://a.com", "https://b.com"]);
  });

  it("--cors '*' becomes ['*']", () => {
    expect(resolveConfig({ home, env: {}, corsFlag: "*" }).cors).toEqual(["*"]);
  });

  it("CUE_CORS env is parsed the same way", () => {
    expect(
      resolveConfig({ home, env: { CUE_CORS: "https://claude.ai" } }).cors,
    ).toEqual(["https://claude.ai"]);
  });

  it("prefers corsFlag > env > .cue.toml > default", () => {
    const project: ProjectConfig = {
      path: "/fake/.cue.toml",
      ceiling: {},
      cors: ["https://from-project"],
    };
    expect(resolveConfig({ home, env: {}, project }).cors).toEqual([
      "https://from-project",
    ]);
    expect(
      resolveConfig({
        home,
        env: { CUE_CORS: "https://from-env" },
        project,
      }).cors,
    ).toEqual(["https://from-env"]);
    expect(
      resolveConfig({
        home,
        env: { CUE_CORS: "https://from-env" },
        corsFlag: "https://from-flag",
        project,
      }).cors,
    ).toEqual(["https://from-flag"]);
  });

  it("--cors '' (empty string) disables CORS", () => {
    expect(resolveConfig({ home, env: {}, corsFlag: "" }).cors).toEqual([]);
  });

  it("honors CUE_HOME when opts.home is absent", () => {
    const cfg = resolveConfig({ env: { CUE_HOME: home } });
    expect(cfg.home).toBe(home);
    expect(existsSync(cfg.paths.token)).toBe(true);
  });
});

describe("writePort", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-test-"));
    resolveConfig({ home, env: {} });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("writes the port to ~/.cue/port", () => {
    writePort(home, 9999);
    expect(readFileSync(join(home, "port"), "utf8").trim()).toBe("9999");
  });

  it("rejects invalid ports", () => {
    expect(() => writePort(home, 0)).toThrow(/invalid port/);
    expect(() => writePort(home, -1)).toThrow(/invalid port/);
    expect(() => writePort(home, 70_000)).toThrow(/invalid port/);
    expect(() => writePort(home, Number.NaN)).toThrow(/invalid port/);
  });

  it("roundtrips via resolveConfig", () => {
    writePort(home, 3333);
    expect(resolveConfig({ home, env: {} }).port).toBe(3333);
  });
});
