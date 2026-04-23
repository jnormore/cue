import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ulid } from "ulidx";
import { DEFAULT_PORT, cuePaths } from "../config.js";
import { openLocalStore } from "./local-store.js";

type Transport = "stdio" | "http";

interface JsonConfigTarget {
  /** This client reads a static JSON config file; we emit a JSON snippet. */
  kind: "json-config";
  /** Where the snippet should land on disk. */
  path: string;
  note?: string;
  transports: Transport[];
}

interface ShellCommandTarget {
  /**
   * This client has no static config file — it's registered via a CLI
   * (e.g., `claude mcp add`). We emit one copy-paste-ready shell
   * command with the real token substituted in, instead of a useless
   * JSON snippet.
   */
  kind: "shell-command";
  /** Builds the literal shell command using the minted token. */
  command(token: string): string;
  note?: string;
  /** Only stdio; this client doesn't accept direct HTTP wiring via config. */
  transports: ["stdio"];
}

type ClientTarget = JsonConfigTarget | ShellCommandTarget;

const CONFIG_PATHS: Record<string, ClientTarget> = {
  "claude-code": {
    kind: "shell-command",
    command: (token) => `claude mcp add cue -- cue mcp --token ${token}`,
    note: "Claude Code MCP servers are registered via the `claude mcp` CLI, not a static config file.",
    transports: ["stdio"],
  },
  "claude-desktop": {
    kind: "json-config",
    path:
      process.platform === "darwin"
        ? `${homedir()}/Library/Application Support/Claude/claude_desktop_config.json`
        : process.platform === "win32"
          ? `${homedir()}/AppData/Roaming/Claude/claude_desktop_config.json`
          : `${homedir()}/.config/Claude/claude_desktop_config.json`,
    transports: ["stdio", "http"],
  },
  cursor: {
    kind: "json-config",
    path: join(homedir(), ".cursor", "mcp.json"),
    transports: ["stdio", "http"],
  },
  "vscode-copilot": {
    kind: "json-config",
    path: "Add to your VS Code settings.json or workspace settings under the `github.copilot.chat.mcp.servers` key.",
    note: "Exact key may change across VS Code/Copilot versions.",
    transports: ["stdio", "http"],
  },
};

interface ConfigFlags {
  http?: boolean;
  url?: string;
  label?: string;
}

/**
 * Generate a fresh per-client sandbox namespace. The operator never
 * has to name or reason about it — the agent can only touch its own
 * sandbox. Example: "claude-code" → "claude-code-01kpz7abcd".
 */
function autoNamespace(client: string): string {
  return `${client}-${ulid().slice(0, 10).toLowerCase()}`;
}

interface MintedScopedToken {
  token: string;
  namespace: string;
}

async function mintSandboxToken(
  client: string,
  label: string | undefined,
): Promise<MintedScopedToken> {
  const namespace = autoNamespace(client);
  // Agent tokens are JSON files under ~/.cue/agent-tokens/. The daemon
  // reads fresh on every verify, so the CLI mints directly — no HTTP
  // hop, no running daemon required.
  const store = openLocalStore();
  try {
    const resolvedLabel = label ?? `${client} (auto-scoped)`;
    const minted = await store.agentTokens.mint({
      scope: { namespaces: [namespace] },
      label: resolvedLabel,
    });
    return { token: minted.token, namespace };
  } finally {
    await store.close();
  }
}

function buildStdioSnippet(token: string): object {
  return {
    mcpServers: {
      cue: { command: "cue", args: ["mcp", "--token", token] },
    },
  };
}

function resolveLocalUrl(home: string): string {
  try {
    const raw = readFileSync(cuePaths(home).port, "utf8").trim();
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return `http://127.0.0.1:${n}/mcp`;
  } catch {
    /* fall through */
  }
  return `http://127.0.0.1:${DEFAULT_PORT}/mcp`;
}

function buildHttpSnippet(flags: ConfigFlags, token: string): object {
  const home = process.env.CUE_HOME ?? join(homedir(), ".cue");
  const url = flags.url ?? resolveLocalUrl(home);
  return {
    mcpServers: {
      cue: {
        url,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
}

export function registerMcpConfigCommand(mcpCommand: Command): void {
  mcpCommand
    .command("config <client>")
    .description(
      "Print an MCP server config snippet for a client. Known clients: claude-code, claude-desktop, cursor, vscode-copilot.\n\n" +
        "Every invocation mints a fresh agent token scoped to a **new per-client sandbox namespace**. The agent can only touch its own sandbox — it cannot see other namespaces in ~/.cue/. For shared namespaces or explicit names, use `cue token create --namespace <ns>` directly.",
    )
    .option(
      "--http",
      "Emit an HTTP (streamable-HTTP) config. Default depends on the client; claude-code only supports stdio.",
    )
    .option(
      "--url <url>",
      "Override the daemon URL for --http (defaults to the local daemon's URL). Implies --http.",
    )
    .option(
      "--label <text>",
      "Override the auto-generated label attached to the minted agent token.",
    )
    .action(async (client: string, flags: ConfigFlags) => {
      const target = CONFIG_PATHS[client];
      if (!target) {
        process.stderr.write(
          `cue mcp config: unknown client "${client}". Known: ${Object.keys(
            CONFIG_PATHS,
          ).join(", ")}\n`,
        );
        process.exit(1);
      }

      // Transport selection. --http wins; else use the client's default.
      const wantHttp = Boolean(flags.http || flags.url);
      const canStdio = target.transports.includes("stdio");
      const canHttp =
        target.kind === "json-config" && target.transports.includes("http");
      const useHttp = wantHttp || !canStdio;
      if (useHttp && !canHttp) {
        process.stderr.write(
          `cue mcp config: client "${client}" does not support HTTP transport.\n`,
        );
        process.exit(1);
      }

      const { token, namespace } = await mintSandboxToken(client, flags.label);

      writeHeader(target, namespace, useHttp);

      if (target.kind === "shell-command") {
        // Copy-paste-ready: no JSON, just the command the operator runs.
        process.stdout.write(`${target.command(token)}\n`);
        return;
      }

      const snippet =
        useHttp && target.kind === "json-config"
          ? buildHttpSnippet(flags, token)
          : buildStdioSnippet(token);
      process.stdout.write(`${JSON.stringify(snippet, null, 2)}\n`);
    });
}

function writeHeader(
  target: ClientTarget,
  namespace: string,
  useHttp: boolean,
): void {
  if (target.kind === "json-config") {
    process.stdout.write(`# config path: ${target.path}\n`);
  } else {
    process.stdout.write("# run this command in your shell:\n");
  }
  if (target.note) process.stdout.write(`# ${target.note}\n`);
  if (useHttp) {
    process.stdout.write(
      "# HTTP transport — requires an MCP client that supports streamable-HTTP.\n",
    );
  }
  process.stdout.write(
    `# Sandbox namespace minted for this client: ${namespace}\n`,
  );
  process.stdout.write(
    "# The agent can only touch this namespace. List / revoke via `cue token list` and `cue token delete`.\n",
  );
  process.stdout.write(
    "# This token cannot be recovered later — save this output.\n",
  );
}
