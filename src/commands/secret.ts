import type { Command } from "commander";
import {
  daemonEndpoint,
  deleteJson,
  getJson,
  printJson,
  putJson,
} from "./admin-client.js";

/**
 * Secrets are namespace-scoped, declared by actions via
 * `policy.secrets`, and injected into the unikernel as env vars at
 * invoke time. The daemon owns storage; the CLI is HTTP only.
 */
export function registerSecretCommands(program: Command): void {
  const secret = program
    .command("secret")
    .description(
      "Manage namespace-scoped secrets. Declared by actions via `policy.secrets`; stored on the daemon and injected into the unikernel as env vars at invoke time.",
    );

  secret
    .command("set")
    .description("Store a secret for a namespace. Overwrites any existing value.")
    .requiredOption("-n, --namespace <ns>", "namespace")
    .requiredOption("-N, --name <name>", "secret name (env-var style, e.g. MY_API_KEY)")
    .requiredOption("-v, --value <value>", "secret value")
    .action(async (flags) => {
      const { baseUrl, token } = daemonEndpoint();
      await putJson(
        `${baseUrl}/admin/secrets/${encodeURIComponent(flags.namespace)}/${encodeURIComponent(flags.name)}`,
        token,
        { value: flags.value },
      );
      printJson({ ok: true, namespace: flags.namespace, name: flags.name });
    });

  secret
    .command("list")
    .description("List secret names in a namespace. Values are never returned.")
    .requiredOption("-n, --namespace <ns>", "namespace")
    .action(async (flags) => {
      const { baseUrl, token } = daemonEndpoint();
      const out = await getJson<{ names: string[] }>(
        `${baseUrl}/admin/secrets/${encodeURIComponent(flags.namespace)}`,
        token,
      );
      printJson(out.names);
    });

  secret
    .command("delete")
    .description("Delete a single secret.")
    .requiredOption("-n, --namespace <ns>", "namespace")
    .requiredOption("-N, --name <name>", "secret name")
    .action(async (flags) => {
      const { baseUrl, token } = daemonEndpoint();
      printJson(
        await deleteJson(
          `${baseUrl}/admin/secrets/${encodeURIComponent(flags.namespace)}/${encodeURIComponent(flags.name)}`,
          token,
        ),
      );
    });
}
