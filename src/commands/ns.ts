import type { Command } from "commander";
import { daemonEndpoint, deleteJson, printJson } from "./admin-client.js";

/**
 * Cascade-delete a namespace via the daemon's admin API: actions,
 * triggers, secrets, state logs, and the namespace's state token all
 * go in one transaction-shaped operation. The cron registry picks up
 * the trigger removals through its in-process subscription.
 */
export function registerNsCommands(program: Command): void {
  const ns = program.command("ns").description("Manage namespaces.");

  ns.command("delete <name>")
    .description(
      "Delete every action, trigger, secret, and state log tagged with the namespace.",
    )
    .action(async (name) => {
      const { baseUrl, token } = daemonEndpoint();
      printJson(
        await deleteJson(
          `${baseUrl}/admin/namespaces/${encodeURIComponent(name)}`,
          token,
        ),
      );
    });
}
