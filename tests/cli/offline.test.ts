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

  it("cue --help lists the operator-only subcommand set", () => {
    // The CLI is intentionally narrow: serve + mcp bridge + ns lifecycle +
    // operator token mint + doctor. Apps are authored by agents through
    // MCP, not by humans through the CLI.
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    for (const cmd of ["serve", "mcp", "token", "ns", "doctor"]) {
      expect(r.stdout).toContain(cmd);
    }
    // Agent-shaped commands must NOT appear — they're MCP-only.
    expect(r.stdout).not.toMatch(/^\s*action\s/m);
    expect(r.stdout).not.toMatch(/^\s*trigger\s/m);
    expect(r.stdout).not.toMatch(/^\s*secret\s/m);
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
      const r = run(["doctor", "--json"], { CUE_HOME: home });
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

    it("cue doctor (default) prints a friendly text summary", () => {
      const r = run(["doctor"], { CUE_HOME: home });
      expect(r.status).toBe(0);
      // Summary lists each adapter with status + name; daemon is DOWN
      // because no port file exists for this fresh home.
      expect(r.stdout).toContain("cue 0.1.0");
      expect(r.stdout).toMatch(/daemon:\s+DOWN/);
      expect(r.stdout).toMatch(/store:\s+ok\s+sqlite/);
      expect(r.stdout).toMatch(/state:\s+ok\s+sqlite/);
      expect(r.stdout).toMatch(/runtime:\s+/);
      expect(r.stdout).toMatch(/cron:\s+ok\s+node-cron/);
      // No JSON in default mode.
      expect(r.stdout).not.toMatch(/^\s*\{/);
    });

    it("cue token list with no daemon fails fast with a clear message", () => {
      // Operator commands route through the daemon's HTTP admin API.
      // Without a daemon, the CLI surfaces a missing-token / unreachable
      // error rather than silently returning empty.
      const r = run(["token", "list"], { CUE_HOME: home });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/daemon|reach|token/i);
    });

    it("cue ns list with no daemon fails fast with a clear message", () => {
      const r = run(["ns", "list"], { CUE_HOME: home });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/daemon|reach|token/i);
    });
  });

  describe("arg validation", () => {
    it("cue token create without --namespace exits non-zero", () => {
      const r = run(["token", "create"]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/namespace|required/i);
    });

    it("cue ns delete without a name exits non-zero", () => {
      const r = run(["ns", "delete"]);
      expect(r.status).not.toBe(0);
    });
  });
});
