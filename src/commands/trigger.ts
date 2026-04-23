import type { Command } from "commander";
import { printJson } from "./admin-client.js";
import { localBaseUrl, runLocalStoreCmd } from "./local-store.js";

/**
 * All trigger ops are pure file I/O. The daemon fs-watches its
 * triggers directory and reconciles its cron schedules within ~150ms
 * of any create/delete. No RPC needed.
 */
export function registerTriggerCommands(program: Command): void {
  const trigger = program
    .command("trigger")
    .description("Create, list, and delete triggers (cron + webhook).");

  trigger
    .command("create")
    .description(
      "Create a new trigger. The daemon picks up cron schedules automatically via fs-watch; webhook triggers are usable as soon as the file lands.",
    )
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
      await runLocalStoreCmd(async (store) => {
        // Resolve namespace the same way the tool handler did: fall
        // back to the action's namespace if unspecified.
        let namespace = flags.namespace as string | undefined;
        if (!namespace) {
          const action = await store.actions.get(flags.action);
          if (!action) {
            process.stderr.write(`cue: action ${flags.action} not found\n`);
            process.exit(1);
          }
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
        const created = await store.triggers.create({
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
          out.webhookUrl = `${localBaseUrl()}/w/${created.id}`;
          out.webhookToken = created.config.token;
        }
        printJson(out);
      });
    });

  trigger
    .command("list")
    .description("List triggers.")
    .option("--namespace <ns>", "filter by namespace")
    .option("-a, --action <id>", "filter by action id")
    .action(async (flags) => {
      await runLocalStoreCmd(async (store) => {
        const filter: { namespace?: string; actionId?: string } = {};
        if (flags.namespace) filter.namespace = flags.namespace;
        if (flags.action) filter.actionId = flags.action;
        printJson(await store.triggers.list(filter));
      });
    });

  trigger
    .command("get <id>")
    .description("Return a trigger record.")
    .action(async (id) => {
      await runLocalStoreCmd(async (store) => {
        const rec = await store.triggers.get(id);
        if (!rec) {
          process.stderr.write(`cue: trigger ${id} not found\n`);
          process.exit(1);
        }
        printJson(rec);
      });
    });

  trigger
    .command("delete <id>")
    .description(
      "Delete a trigger. The daemon cancels any cron schedule via fs-watch within ~150ms.",
    )
    .action(async (id) => {
      await runLocalStoreCmd(async (store) => {
        await store.triggers.delete(id);
        printJson({ deleted: id });
      });
    });
}
