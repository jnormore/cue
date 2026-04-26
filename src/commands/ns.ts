import type { Command } from "commander";
import {
  daemonEndpoint,
  deleteJson,
  getJson,
  patchJson,
  postJson,
  printJson,
} from "./admin-client.js";

/**
 * Namespace lifecycle CLI. All commands route through the daemon's
 * `/admin/namespaces` HTTP surface.
 */
export function registerNsCommands(program: Command): void {
  const ns = program.command("ns").description("Manage namespaces.");

  ns.command("create <name>")
    .description("Create a namespace metadata record (status=active).")
    .option("--display-name <text>", "human-readable display name")
    .option("--description <text>", "free-form description")
    .action(async (name, flags) => {
      const { baseUrl, token } = daemonEndpoint();
      const body: {
        name: string;
        displayName?: string;
        description?: string;
      } = { name };
      if (flags.displayName !== undefined) body.displayName = flags.displayName;
      if (flags.description !== undefined) body.description = flags.description;
      printJson(await postJson(`${baseUrl}/admin/namespaces`, token, body));
    });

  ns.command("list")
    .description("List namespaces with action and trigger counts.")
    .action(async () => {
      const { baseUrl, token } = daemonEndpoint();
      printJson(await getJson(`${baseUrl}/admin/namespaces`, token));
    });

  ns.command("inspect <name>")
    .description("Show a namespace's record + resource counts.")
    .action(async (name) => {
      const { baseUrl, token } = daemonEndpoint();
      printJson(
        await getJson(
          `${baseUrl}/admin/namespaces/${encodeURIComponent(name)}`,
          token,
        ),
      );
    });

  ns.command("pause <name>")
    .description(
      "Stop firing triggers and reject new invocations. State, actions, and triggers stay; mutations still work.",
    )
    .action(async (name) => {
      await transition(name, "paused");
    });

  ns.command("resume <name>")
    .description("Move a paused or archived namespace back to active.")
    .action(async (name) => {
      await transition(name, "active");
    });

  ns.command("archive <name>")
    .description(
      "Read-only: no invocations, no creates/updates. Reads still work. Cascade-delete still works.",
    )
    .action(async (name) => {
      await transition(name, "archived");
    });

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

async function transition(
  name: string,
  status: "active" | "paused" | "archived",
): Promise<void> {
  const { baseUrl, token } = daemonEndpoint();
  printJson(
    await patchJson(
      `${baseUrl}/admin/namespaces/${encodeURIComponent(name)}`,
      token,
      { status },
    ),
  );
}
