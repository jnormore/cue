import type { Command } from "commander";
import { printJson } from "./admin-client.js";
import { runLocalStoreCmd } from "./local-store.js";

/**
 * Token CRUD is pure storage — agent-token records live at
 * ~/.cue/agent-tokens/<id>.json and the daemon reads fresh on every
 * verify. The CLI opens the store directly; no HTTP hop is needed.
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
      await runLocalStoreCmd(async (store) => {
        const input: { scope: { namespaces: string[] }; label?: string } = {
          scope: { namespaces },
        };
        if (flags.label !== undefined) input.label = flags.label;
        const minted = await store.agentTokens.mint(input);
        printJson(minted);
      });
    });

  token
    .command("list")
    .description("List agent tokens (summary only; bearer value is not shown).")
    .action(async () => {
      await runLocalStoreCmd(async (store) => {
        printJson(await store.agentTokens.list());
      });
    });

  token
    .command("delete <id>")
    .description("Revoke an agent token by id.")
    .action(async (id) => {
      await runLocalStoreCmd(async (store) => {
        await store.agentTokens.delete(id);
        printJson({ deleted: id });
      });
    });
}
