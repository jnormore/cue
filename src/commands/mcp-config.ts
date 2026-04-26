import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { DEFAULT_PORT, cuePaths } from "../config.js";
import { daemonEndpoint, postJson } from "./admin-client.js";

type Transport = "stdio" | "http";

interface JsonConfigTarget {
  /** This client reads a static JSON config file; we emit a JSON snippet. */
  kind: "json-config";
  /** Where the snippet should land on disk. */
  path: string;
  note?: string;
  transports: Transport[];
  /**
   * Override the HTTP snippet shape. Some clients (Claude Desktop) only
   * accept stdio-style configs, so `--http` must emit a stdio wrapper
   * around an HTTP bridge like `mcp-remote`. Default shape is native
   * `url`+`headers`.
   */
  httpSnippet?: (url: string, token: string) => object;
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
    // Claude Desktop's config only understands stdio servers, so --http
    // has to bridge through `mcp-remote` (an npx-launched stdio↔HTTP proxy).
    httpSnippet: (url, token) => ({
      mcpServers: {
        cue: {
          command: "npx",
          args: [
            "-y",
            "mcp-remote",
            url,
            "--header",
            `Authorization: Bearer ${token}`,
          ],
        },
      },
    }),
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

interface MintedToken {
  token: string;
}

/**
 * Mint a wildcard-scoped token for a client. In OSS local-dev, the
 * agent connected to your daemon is trusted to author and operate
 * many apps (each = a namespace). Per-client sandboxing is no longer
 * the default — agents create namespaces freely via `create_namespace`.
 *
 * For multi-tenant deployments (e.g., Cloud), don't use this command;
 * mint a scoped token explicitly with `cue token create --namespace
 * <pattern>` (where `<pattern>` is a literal name or `prefix-*`).
 */
async function mintLocalToken(
  client: string,
  label: string | undefined,
): Promise<MintedToken> {
  const { baseUrl, token: bearer } = daemonEndpoint();
  const resolvedLabel = label ?? `${client} (local)`;
  const minted = await postJson<{ token: string }>(
    `${baseUrl}/admin/agent-tokens`,
    bearer,
    {
      scope: { namespaces: ["*"] },
      label: resolvedLabel,
    },
  );
  return { token: minted.token };
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

function buildHttpSnippet(
  target: JsonConfigTarget,
  flags: ConfigFlags,
  token: string,
): object {
  const home = process.env.CUE_HOME ?? join(homedir(), ".cue");
  const url = flags.url ?? resolveLocalUrl(home);
  if (target.httpSnippet) return target.httpSnippet(url, token);
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
        "Every invocation mints a fresh wildcard-scoped agent token (`*`). The agent can create and manage as many namespaces as it wants — apps are namespaces, and a single client can author many. For multi-tenant deployments, use `cue token create --namespace <pattern>` with explicit literals or prefix patterns (e.g. `acme-*`).",
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

      const { token } = await mintLocalToken(client, flags.label);

      writeHeader(target, useHttp);

      if (target.kind === "shell-command") {
        // Copy-paste-ready: no JSON, just the command the operator runs.
        process.stdout.write(`${target.command(token)}\n`);
        return;
      }

      const snippet =
        useHttp && target.kind === "json-config"
          ? buildHttpSnippet(target, flags, token)
          : buildStdioSnippet(token);
      process.stdout.write(`${JSON.stringify(snippet, null, 2)}\n`);
    });
}

function writeHeader(target: ClientTarget, useHttp: boolean): void {
  if (target.kind === "json-config") {
    process.stdout.write(`# config path: ${target.path}\n`);
  } else {
    process.stdout.write("# run this command in your shell:\n");
  }
  if (target.note) process.stdout.write(`# ${target.note}\n`);
  if (useHttp) {
    if (target.kind === "json-config" && target.httpSnippet) {
      process.stdout.write(
        "# HTTP transport — bridged via `mcp-remote` (stdio↔HTTP). Requires `npx` on PATH.\n",
      );
    } else {
      process.stdout.write(
        "# HTTP transport — requires an MCP client that supports streamable-HTTP.\n",
      );
    }
  }
  process.stdout.write(
    "# Wildcard-scoped agent token: the connected agent can create and manage any namespace.\n",
  );
  process.stdout.write(
    "# List / revoke via `cue token list` and `cue token delete`.\n",
  );
  process.stdout.write(
    "# This token cannot be recovered later — save this output.\n",
  );
}
