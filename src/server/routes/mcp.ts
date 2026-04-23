import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyPluginAsync } from "fastify";
import { buildMcpServer } from "../mcp.js";
import type { McpToolDeps } from "../mcp-tools.js";
import {
  principalFromRequest,
  requireAgentPrincipal,
} from "../auth.js";

export function mcpRoutes(opts: {
  deps: Omit<McpToolDeps, "principal">;
  token: string;
}): FastifyPluginAsync {
  const { deps, token } = opts;
  // /mcp is the **agent-only** surface. Master-token callers are
  // rejected here — the operator uses local filesystem access and
  // /a/:id for invocations, never /mcp.
  const guard = requireAgentPrincipal({
    masterToken: token,
    store: deps.store,
  });
  return async (app) => {
    app.all("/mcp", { preHandler: guard }, async (req, reply) => {
      reply.hijack();
      const principal = principalFromRequest(req);
      const server = buildMcpServer({ ...deps, principal });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      reply.raw.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req.raw, reply.raw, req.body);
      } catch (err) {
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { "content-type": "application/json" });
          reply.raw.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
    });
  };
}
