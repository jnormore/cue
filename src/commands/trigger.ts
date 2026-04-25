import type { Command } from "commander";
import {
  daemonEndpoint,
  deleteJson,
  getJson,
  postJson,
  printJson,
} from "./admin-client.js";

/**
 * Trigger ops go through `/admin/triggers`. The daemon picks up
 * created/deleted triggers via in-process notification (synchronous)
 * plus a 1-second poll fallback.
 */
export function registerTriggerCommands(program: Command): void {
  const trigger = program
    .command("trigger")
    .description("Create, list, and delete triggers (cron + webhook).");

  trigger
    .command("create")
    .description("Create a new trigger.")
    .requiredOption(
      "--type <type>",
      "'cron' or 'webhook'",
      (v) => {
        if (v !== "cron" && v !== "webhook") {
          throw new Error("--type must be 'cron' or 'webhook'");
        }
        return v;
      },
    )
    .requiredOption("-a, --action <id>", "action id to fire")
    .option("-s, --schedule <expr>", "cron expression (required for --type cron)")
    .option("--timezone <tz>", "timezone for cron triggers")
    .option("--namespace <ns>", "namespace (defaults to action's namespace)")
    .action(async (flags) => {
      const { baseUrl, token } = daemonEndpoint();
      // Resolve namespace via the daemon — fall back to the action's
      // namespace if unspecified.
      let namespace = flags.namespace as string | undefined;
      if (!namespace) {
        const action = await getJson<{ namespace: string }>(
          `${baseUrl}/admin/actions/${flags.action}`,
          token,
        );
        namespace = action.namespace;
      }
      const config =
        flags.type === "cron"
          ? (() => {
              if (!flags.schedule) {
                process.stderr.write(
                  "cue trigger: --schedule is required for cron triggers\n",
                );
                process.exit(1);
              }
              return {
                schedule: flags.schedule as string,
                ...(flags.timezone
                  ? { timezone: flags.timezone as string }
                  : {}),
              };
            })()
          : ({} as Record<string, never>);
      const created = await postJson<{
        id: string;
        type: "cron" | "webhook";
        actionId: string;
        namespace: string;
        config: { type: string; token?: string };
        webhookUrl?: string;
      }>(`${baseUrl}/admin/triggers`, token, {
        type: flags.type,
        actionId: flags.action,
        namespace,
        config,
      });
      const out: Record<string, unknown> = {
        id: created.id,
        type: created.type,
        actionId: created.actionId,
        namespace: created.namespace,
      };
      if (created.type === "webhook" && created.config.type === "webhook") {
        out.webhookUrl = created.webhookUrl;
        out.webhookToken = created.config.token;
      }
      printJson(out);
    });

  trigger
    .command("list")
    .description("List triggers.")
    .option("--namespace <ns>", "filter by namespace")
    .option("-a, --action <id>", "filter by action id")
    .action(async (flags) => {
      const { baseUrl, token } = daemonEndpoint();
      const url = new URL(`${baseUrl}/admin/triggers`);
      if (flags.namespace) url.searchParams.set("namespace", flags.namespace);
      if (flags.action) url.searchParams.set("actionId", flags.action);
      printJson(await getJson(url.toString(), token));
    });

  trigger
    .command("get <id>")
    .description("Return a trigger record.")
    .action(async (id) => {
      const { baseUrl, token } = daemonEndpoint();
      printJson(await getJson(`${baseUrl}/admin/triggers/${id}`, token));
    });

  trigger
    .command("delete <id>")
    .description("Delete a trigger.")
    .action(async (id) => {
      const { baseUrl, token } = daemonEndpoint();
      printJson(await deleteJson(`${baseUrl}/admin/triggers/${id}`, token));
    });
}
