import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_PORT, cuePaths } from "../config.js";

export interface McpBridgeOpts {
  home?: string;
  port?: number;
  host?: string;
  cueVersion?: string;
  /**
   * The scoped agent token this bridge should forward with. Required
   * because /mcp no longer accepts the master token — every agent
   * MCP client must carry an agent token. `cue mcp config <client>`
   * generates a launch command with `--token <atk_…>` baked in.
   */
  token?: string;
}

export async function runMcpBridge(opts: McpBridgeOpts = {}): Promise<void> {
  const home = opts.home ?? process.env.CUE_HOME ?? join(homedir(), ".cue");
  const paths = cuePaths(home);

  const token = opts.token ?? process.env.CUE_AGENT_TOKEN;
  if (!token) {
    process.stderr.write(
      "cue mcp: --token <agent-token> is required. /mcp only accepts scoped agent tokens. Run `cue mcp config <client>` to generate the correct launch command with a fresh sandbox token, or mint one explicitly with `cue token create --namespace <ns>` and pass it via --token.\n",
    );
    process.exit(1);
  }
  const port =
    opts.port ??
    (() => {
      try {
        const raw = readFileSync(paths.port, "utf8").trim();
        const n = Number.parseInt(raw, 10);
        return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
      } catch {
        return DEFAULT_PORT;
      }
    })();
  const host = opts.host ?? "127.0.0.1";
  const url = new URL(`http://${host}:${port}/mcp`);

  const client = new Client(
    { name: "cue-mcp-bridge", version: opts.cueVersion ?? "0.1.0" },
    { capabilities: {} },
  );
  const httpTransport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  try {
    await client.connect(httpTransport);
  } catch (err) {
    process.stderr.write(
      `cue mcp: cannot reach daemon at ${url} — is \`cue serve\` running?\n${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const mcp = new McpServer(
    { name: "cue", version: opts.cueVersion ?? "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // Bridge is an "advanced use case" per the SDK docs: we forward raw
  // tools/list and tools/call through to the HTTP client. McpServer's
  // registerTool API isn't useful here — we don't know the tools at build
  // time. Reach for the underlying protocol via McpServer.server.
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => {
    return client.listTools();
  });

  mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return client.callTool(req.params);
  });

  const stdio = new StdioServerTransport();
  await mcp.connect(stdio);

  const shutdown = async () => {
    try {
      await mcp.close();
      await client.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

