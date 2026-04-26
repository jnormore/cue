import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unitaskRuntime } from "../../src/runtime/unitask.js";

const CUE_BIN = resolve(__dirname, "../../dist/index.js");

const unitaskAvailable = await (async () => {
  try {
    return (await unitaskRuntime().doctor()).ok;
  } catch {
    return false;
  }
})();

if (!unitaskAvailable) {
  console.log(
    "[cli:online] unitask not on PATH — skipping daemon-backed CLI tests",
  );
}

async function waitForFile(
  path: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${path}`);
}

describe.skipIf(!unitaskAvailable)(
  "cue CLI (online — real daemon as subprocess)",
  () => {
    let home: string;
    let serveProc: ChildProcess;

    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), "cue-cli-online-"));
      serveProc = spawn(
        process.execPath,
        [CUE_BIN, "serve", "--port", "0", "--host", "127.0.0.1"],
        {
          env: { ...process.env, CUE_HOME: home },
          stdio: "ignore",
        },
      );
      await waitForFile(join(home, "port"), 10_000);
    }, 15_000);

    afterAll(async () => {
      if (serveProc && !serveProc.killed) {
        serveProc.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
        if (!serveProc.killed) serveProc.kill("SIGKILL");
      }
      rmSync(home, { recursive: true, force: true });
    });

    function cue(args: string[]) {
      return spawnSync(process.execPath, [CUE_BIN, ...args], {
        encoding: "utf8",
        env: { ...process.env, CUE_HOME: home },
      });
    }

    it("cue doctor reports ok across adapters", () => {
      const r = cue(["doctor"]);
      expect(r.status).toBe(0);
      const body = JSON.parse(r.stdout);
      expect(body.cue.daemonUp).toBe(true);
      expect(body.runtime.ok).toBe(true);
      expect(body.store.ok).toBe(true);
      expect(body.cron.ok).toBe(true);
      expect(body.cue.port).toBe(
        Number.parseInt(
          readFileSync(join(home, "port"), "utf8").trim(),
          10,
        ),
      );
    });

    it("cue mcp config auto-mints a sandbox token and emits an HTTP snippet", () => {
      // Claude Desktop's config only accepts stdio servers, so --http emits
      // an `mcp-remote` bridge rather than a native url+headers snippet.
      const r = cue(["mcp", "config", "claude-desktop", "--http"]);
      expect(r.status).toBe(0);
      const body = JSON.parse(
        r.stdout
          .split("\n")
          .filter((l) => !l.startsWith("#") && l.length > 0)
          .join("\n"),
      ) as {
        mcpServers: { cue: { command: string; args: string[] } };
      };
      expect(body.mcpServers.cue.command).toBe("npx");
      const args = body.mcpServers.cue.args;
      expect(args[0]).toBe("-y");
      expect(args[1]).toBe("mcp-remote");
      expect(args[2]).toMatch(/\/mcp$/);
      expect(args[3]).toBe("--header");
      expect(args[4]).toMatch(
        /^Authorization: Bearer atk_[0-9A-Z]+\.[0-9a-f]{64}$/,
      );
      // Header comment reports the sandbox namespace.
      expect(r.stdout).toMatch(
        /# Sandbox namespace minted for this client: claude-desktop-[0-9a-z]+/,
      );
    });

    it("cue mcp config cursor --http emits a native url+headers snippet", () => {
      // Cursor supports HTTP MCP natively, so --http should keep the
      // url+headers shape rather than the mcp-remote bridge.
      const r = cue(["mcp", "config", "cursor", "--http"]);
      expect(r.status).toBe(0);
      const body = JSON.parse(
        r.stdout
          .split("\n")
          .filter((l) => !l.startsWith("#") && l.length > 0)
          .join("\n"),
      ) as {
        mcpServers: {
          cue: { url: string; headers: { Authorization: string } };
        };
      };
      expect(body.mcpServers.cue.url).toMatch(/\/mcp$/);
      expect(body.mcpServers.cue.headers.Authorization).toMatch(
        /^Bearer atk_[0-9A-Z]+\.[0-9a-f]{64}$/,
      );
    });

    it("cue mcp config for claude-code emits stdio snippet with --token", () => {
      const r = cue(["mcp", "config", "claude-desktop"]);
      expect(r.status).toBe(0);
      const body = JSON.parse(
        r.stdout
          .split("\n")
          .filter((l) => !l.startsWith("#") && l.length > 0)
          .join("\n"),
      ) as {
        mcpServers: { cue: { command: string; args: string[] } };
      };
      expect(body.mcpServers.cue.command).toBe("cue");
      expect(body.mcpServers.cue.args[0]).toBe("mcp");
      expect(body.mcpServers.cue.args[1]).toBe("--token");
      expect(body.mcpServers.cue.args[2]).toMatch(
        /^atk_[0-9A-Z]+\.[0-9a-f]{64}$/,
      );
    });

    it("each cue mcp config invocation produces a distinct sandbox namespace + token", () => {
      const a = cue(["mcp", "config", "claude-code"]);
      const b = cue(["mcp", "config", "claude-code"]);
      expect(a.status).toBe(0);
      expect(b.status).toBe(0);
      const nsA = /minted for this client: (\S+)/.exec(a.stdout)?.[1];
      const nsB = /minted for this client: (\S+)/.exec(b.stdout)?.[1];
      expect(nsA).toBeDefined();
      expect(nsB).toBeDefined();
      expect(nsA).not.toBe(nsB);
      // Tokens are baked into the emitted command; they must also differ.
      const tokA = /atk_[0-9A-Z]+\.[0-9a-f]{64}/.exec(a.stdout)?.[0];
      const tokB = /atk_[0-9A-Z]+\.[0-9a-f]{64}/.exec(b.stdout)?.[0];
      expect(tokA).toBeDefined();
      expect(tokA).not.toBe(tokB);
    });

    it("cue ns lifecycle: create → inspect → pause → resume → archive → delete", () => {
      const created = cue([
        "ns",
        "create",
        "lc-cli",
        "--display-name",
        "Lifecycle CLI test",
        "--description",
        "exercising every transition",
      ]);
      expect(created.status).toBe(0);
      const rec = JSON.parse(created.stdout);
      expect(rec.name).toBe("lc-cli");
      expect(rec.status).toBe("active");
      expect(rec.displayName).toBe("Lifecycle CLI test");

      const list = cue(["ns", "list"]);
      expect(list.status).toBe(0);
      const all = JSON.parse(list.stdout) as Array<{
        name: string;
        actionCount: number;
      }>;
      const found = all.find((n) => n.name === "lc-cli");
      expect(found).toBeDefined();
      expect(found?.actionCount).toBe(0);

      const inspected = cue(["ns", "inspect", "lc-cli"]);
      expect(inspected.status).toBe(0);
      const detail = JSON.parse(inspected.stdout);
      expect(detail.name).toBe("lc-cli");
      expect(detail.actionCount).toBe(0);
      expect(detail.triggerCount).toBe(0);

      expect(cue(["ns", "pause", "lc-cli"]).status).toBe(0);
      expect(JSON.parse(cue(["ns", "inspect", "lc-cli"]).stdout).status).toBe(
        "paused",
      );

      expect(cue(["ns", "resume", "lc-cli"]).status).toBe(0);
      expect(JSON.parse(cue(["ns", "inspect", "lc-cli"]).stdout).status).toBe(
        "active",
      );

      expect(cue(["ns", "archive", "lc-cli"]).status).toBe(0);
      expect(JSON.parse(cue(["ns", "inspect", "lc-cli"]).stdout).status).toBe(
        "archived",
      );

      // Cascade-delete works on archived namespaces.
      expect(cue(["ns", "delete", "lc-cli"]).status).toBe(0);
      const after = cue(["ns", "inspect", "lc-cli"]);
      expect(after.status).not.toBe(0);
    });
  },
);
