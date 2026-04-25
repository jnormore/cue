import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CUE_BIN = resolve(__dirname, "../../dist/index.js");

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CUE_BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("cue CLI (offline — no daemon required)", () => {
  it("cue --version prints the version", () => {
    const r = run(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("0.1.0");
  });

  it("cue --help lists every top-level subcommand", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    for (const cmd of [
      "serve",
      "mcp",
      "action",
      "trigger",
      "ns",
      "doctor",
    ]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  describe("cue mcp config — surface checks that don't need the daemon", () => {
    it("exits 1 on unknown client", () => {
      const r = run(["mcp", "config", "not-a-client"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("unknown client");
    });
  });

  describe("graceful failures without a running daemon", () => {
    let home: string;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "cue-cli-nodaemon-"));
    });
    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
    });

    it("cue doctor with no daemon still succeeds (adapter probes are local, reports daemonUp: false)", () => {
      // doctor probes each adapter in-process and only pings /health for
      // daemon liveness. No daemon → that ping fails, but the command
      // itself completes normally.
      const r = run(["doctor"], { CUE_HOME: home });
      expect(r.status).toBe(0);
      const body = JSON.parse(r.stdout) as {
        cue: { daemonUp: boolean };
        store: { ok: boolean };
        state: { ok: boolean };
      };
      expect(body.cue.daemonUp).toBe(false);
      expect(body.store.ok).toBe(true);
      expect(body.state.ok).toBe(true);
    });

    it("cue action invoke with no daemon fails fast with a clear message", () => {
      const r = run(
        ["action", "invoke", "act_does_not_exist"],
        { CUE_HOME: home },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/daemon|reach|token/i);
    });

    it("cue action list with no daemon fails fast with a clear message", () => {
      // Storage commands now go through the daemon's HTTP admin API.
      // Without a daemon, the CLI surfaces the missing token / unreachable
      // daemon error rather than silently succeeding against a stale view.
      const r = run(["action", "list"], { CUE_HOME: home });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/daemon|reach|token/i);
    });

    it("cue token list with no daemon fails fast with a clear message", () => {
      const r = run(["token", "list"], { CUE_HOME: home });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/daemon|reach|token/i);
    });
  });

  describe("arg validation", () => {
    it("cue action create without --name exits non-zero", () => {
      const r = run(["action", "create", "--code", "x"]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/name|required/i);
    });

    it("cue trigger create with bogus --type exits non-zero", () => {
      const r = run(["trigger", "create", "--type", "bogus", "--action", "x"]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/type|cron|webhook/i);
    });
  });
});
