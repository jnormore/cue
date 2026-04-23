import type { Command } from "commander";
import { printJson } from "./admin-client.js";
import { runLocalStoreCmd } from "./local-store.js";

/**
 * Secrets are namespace-scoped files under `~/.cue/secrets/<ns>/<name>`
 * (mode 0600). Like agent tokens, they're pure storage — the daemon
 * reads fresh on every action invoke, so the CLI writes to disk
 * directly.
 */
export function registerSecretCommands(program: Command): void {
  const secret = program
    .command("secret")
    .description(
      "Manage namespace-scoped secrets. Declared by actions via `policy.secrets`; stored at ~/.cue/secrets/<ns>/<name> (mode 0600) and injected into the unikernel as env vars at invoke time.",
    );

  secret
    .command("set")
    .description("Store a secret for a namespace. Overwrites any existing value.")
    .requiredOption("-n, --namespace <ns>", "namespace")
    .requiredOption("-N, --name <name>", "secret name (env-var style, e.g. MY_API_KEY)")
    .requiredOption("-v, --value <value>", "secret value")
    .action(async (flags) => {
      await runLocalStoreCmd(async (store) => {
        await store.secrets.set(flags.namespace, flags.name, flags.value);
        printJson({ ok: true, namespace: flags.namespace, name: flags.name });
      });
    });

  secret
    .command("list")
    .description("List secret names in a namespace. Values are never returned.")
    .requiredOption("-n, --namespace <ns>", "namespace")
    .action(async (flags) => {
      await runLocalStoreCmd(async (store) => {
        printJson(await store.secrets.list(flags.namespace));
      });
    });

  secret
    .command("delete")
    .description("Delete a single secret.")
    .requiredOption("-n, --namespace <ns>", "namespace")
    .requiredOption("-N, --name <name>", "secret name")
    .action(async (flags) => {
      await runLocalStoreCmd(async (store) => {
        await store.secrets.delete(flags.namespace, flags.name);
        printJson({ deleted: flags.name, namespace: flags.namespace });
      });
    });
}
