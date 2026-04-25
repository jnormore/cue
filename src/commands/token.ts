import type { Command } from "commander";
import {
  daemonEndpoint,
  deleteJson,
  getJson,
  postJson,
  printJson,
} from "./admin-client.js";

/**
 * Agent-token CRUD goes through `/admin/agent-tokens`. Mint returns the
 * bearer once (it's not retrievable later — only verifiable). The
 * master token (~/.cue/token) authenticates the operator request to
 * the daemon; the master token itself is rejected on /mcp.
 */
export function registerTokenCommands(program: Command): void {
  const token = program
    .command("token")
    .description(
      "Mint and manage scoped agent tokens. Agent tokens grant an MCP client access to a specific allowlist of namespaces and nothing else. The master token (~/.cue/token) is rejected on /mcp — agents cannot authenticate with master.",
    );

  token
    .command("create")
    .description(
      "Mint a scoped agent token. Bearer is printed once — save it somewhere safe. Repeat --namespace for multi-namespace scopes.",
    )
    .requiredOption(
      "-n, --namespace <ns...>",
      "namespace to grant (repeatable)",
    )
    .option("-l, --label <text>", "human-readable label to attach")
    .action(async (flags) => {
      const namespaces = Array.isArray(flags.namespace)
        ? flags.namespace
        : [flags.namespace];
      const { baseUrl, token: bearer } = daemonEndpoint();
      const body: { scope: { namespaces: string[] }; label?: string } = {
        scope: { namespaces },
      };
      if (flags.label !== undefined) body.label = flags.label;
      const minted = await postJson(
        `${baseUrl}/admin/agent-tokens`,
        bearer,
        body,
      );
      printJson(minted);
    });

  token
    .command("list")
    .description("List agent tokens (summary only; bearer value is not shown).")
    .action(async () => {
      const { baseUrl, token: bearer } = daemonEndpoint();
      printJson(await getJson(`${baseUrl}/admin/agent-tokens`, bearer));
    });

  token
    .command("delete <id>")
    .description("Revoke an agent token by id.")
    .action(async (id) => {
      const { baseUrl, token: bearer } = daemonEndpoint();
      printJson(
        await deleteJson(`${baseUrl}/admin/agent-tokens/${id}`, bearer),
      );
    });
}
