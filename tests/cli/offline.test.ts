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

  describe("cue mcp config", () => {
    it("exits 1 on unknown client", () => {
      const r = run(["mcp", "config", "not-a-client"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("unknown client");
    });

    it("claude-code emits a copy-paste-ready `claude mcp add` command", () => {
      const home = mkdtempSync(join(tmpdir(), "cue-cli-mcpconfig-"));
      try {
        const r = run(["mcp", "config", "claude-code"], { CUE_HOME: home });
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(
          /# Sandbox namespace minted for this client: claude-code-[0-9a-z]+/,
        );
        // Command line, not JSON. One line with the real token inlined.
        const cmdLine = r.stdout
          .split("\n")
          .find((l) => l.startsWith("claude mcp add cue"));
        expect(cmdLine).toBeDefined();
        expect(cmdLine).toMatch(
          /^claude mcp add cue -- cue mcp --token atk_[0-9A-Z]+\.[0-9a-f]{64}$/,
        );
        // Output must NOT contain a JSON mcpServers block.
        expect(r.stdout).not.toMatch(/"mcpServers"/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("claude-desktop emits a JSON snippet (static config file client)", () => {
      const home = mkdtempSync(join(tmpdir(), "cue-cli-mcpconfig-"));
      try {
        const r = run(["mcp", "config", "claude-desktop"], { CUE_HOME: home });
        expect(r.status).toBe(0);
        const parsed = JSON.parse(
          r.stdout
            .split("\n")
            .filter((l) => !l.startsWith("#") && l.length > 0)
            .join("\n"),
        ) as { mcpServers: { cue: { args: string[] } } };
        const args = parsed.mcpServers.cue.args;
        expect(args).toEqual([
          "mcp",
          "--token",
          expect.stringMatching(/^atk_[0-9A-Z]+\.[0-9a-f]{64}$/),
        ]);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("each invocation produces a distinct namespace + token", () => {
      const home = mkdtempSync(join(tmpdir(), "cue-cli-mcpconfig-"));
      try {
        const a = run(["mcp", "config", "claude-code"], { CUE_HOME: home });
        const b = run(["mcp", "config", "claude-code"], { CUE_HOME: home });
        expect(a.status).toBe(0);
        expect(b.status).toBe(0);
        const nsA = /minted for this client: (\S+)/.exec(a.stdout)?.[1];
        const nsB = /minted for this client: (\S+)/.exec(b.stdout)?.[1];
        expect(nsA).toBeDefined();
        expect(nsB).toBeDefined();
        expect(nsA).not.toBe(nsB);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
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
      // doctor is fully local now — it probes each adapter in-process
      // and only pings /health for daemon liveness. No daemon → that
      // ping fails, but the command itself completes normally.
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

    it("cue action list with no daemon succeeds (pure disk read, empty)", () => {
      // Storage-only commands don't require the daemon anymore — the
      // CLI reads straight from `~/.cue/actions`. No entries → [].
      const r = run(["action", "list"], { CUE_HOME: home });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([]);
    });

    it("cue token list with no daemon succeeds (pure disk read)", () => {
      const r = run(["token", "list"], { CUE_HOME: home });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([]);
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
