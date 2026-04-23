import type { Command } from "commander";
import { pickState } from "../state/index.js";
import { deleteNamespace as cascadeDeleteNamespace } from "../store/index.js";
import { printJson } from "./admin-client.js";
import { resolveHome, runLocalStoreCmd } from "./local-store.js";

/**
 * Pure file I/O cascade: delete actions, triggers, secrets, state
 * logs, and the namespace's state token. The daemon fs-watches
 * triggers so any cron schedules are cancelled within ~150ms — no
 * RPC required.
 */
export function registerNsCommands(program: Command): void {
  const ns = program.command("ns").description("Manage namespaces.");

  ns.command("delete <name>")
    .description(
      "Delete every action, trigger, secret, and state log tagged with the namespace.",
    )
    .action(async (name) => {
      const home = resolveHome();
      const state = pickState("fs", { home });
      try {
        await runLocalStoreCmd(async (store) => {
          const result = await cascadeDeleteNamespace(store, state, name);
          printJson({
            deleted: {
              actions: result.actions,
              triggers: result.triggers,
              secrets: result.secrets,
              stateKeys: result.stateKeys,
            },
          });
        });
      } finally {
        await state.close();
      }
    });
}
