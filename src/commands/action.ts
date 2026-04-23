import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  deleteAction as cascadeDeleteAction,
  type Policy,
} from "../store/index.js";
import { daemonEndpoint, postJson, printJson } from "./admin-client.js";
import { localBaseUrl, runLocalStoreCmd } from "./local-store.js";

function resolveCode(opts: { code?: string; codeFile?: string }): string {
  if (opts.code !== undefined) return opts.code;
  if (opts.codeFile !== undefined) return readFileSync(opts.codeFile, "utf8");
  throw new Error("either --code or --code-file is required");
}

function parseJson<T>(value: string | undefined): T | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(value) as T;
}

/**
 * Storage-only subcommands (create/list/get/delete/runs) open the
 * store directly — same files the daemon reads, no RPC needed. The
 * daemon fs-watches the triggers directory, so action deletes that
 * cascade triggers propagate to the cron registry within ~150ms.
 *
 * `invoke` is the one operation that genuinely requires the daemon
 * (it spawns the unikernel and records the run). It hits `/a/:id` —
 * the same route agents use, with the master token.
 */
export function registerActionCommands(program: Command): void {
  const action = program
    .command("action")
    .description("Create, list, and invoke actions.");

  action
    .command("create")
    .description("Create a new action.")
    .requiredOption("-n, --name <name>", "action name")
    .option("-c, --code <code>", "inline JS source")
    .option("-f, --code-file <path>", "path to JS source file")
    .option("--namespace <ns>", "namespace (default: 'default')")
    .option("--policy <json>", "policy object as JSON")
    .action(async (flags) => {
      const code = resolveCode({
        ...(flags.code !== undefined ? { code: flags.code } : {}),
        ...(flags.codeFile !== undefined ? { codeFile: flags.codeFile } : {}),
      });
      await runLocalStoreCmd(async (store) => {
        const created = await store.actions.create({
          name: flags.name,
          code,
          ...(flags.namespace ? { namespace: flags.namespace } : {}),
          ...(flags.policy
            ? { policy: parseJson<Policy>(flags.policy) as Policy }
            : {}),
        });
        printJson({
          id: created.id,
          name: created.name,
          namespace: created.namespace,
          invokeUrl: `${localBaseUrl()}/a/${created.id}`,
        });
      });
    });

  action
    .command("list")
    .description("List actions.")
    .option("--namespace <ns>", "filter by namespace")
    .action(async (flags) => {
      await runLocalStoreCmd(async (store) => {
        const items = await store.actions.list(
          flags.namespace ? { namespace: flags.namespace } : undefined,
        );
        printJson(items);
      });
    });

  action
    .command("get <id>")
    .description("Return the full action record.")
    .action(async (id) => {
      await runLocalStoreCmd(async (store) => {
        const rec = await store.actions.get(id);
        if (!rec) {
          process.stderr.write(`cue: action ${id} not found\n`);
          process.exit(1);
        }
        printJson(rec);
      });
    });

  action
    .command("invoke <id>")
    .description(
      "Invoke an action synchronously. Posts to /a/:id with the master token — the daemon spawns the unikernel.",
    )
    .option("-i, --input <json>", "input payload as JSON")
    .action(async (id, flags) => {
      const input = flags.input ? parseJson(flags.input) : null;
      const { baseUrl, token } = daemonEndpoint();
      printJson(await postJson(`${baseUrl}/a/${id}`, token, input));
    });

  action
    .command("delete <id>")
    .description(
      "Delete an action and its triggers. Direct file ops; the daemon's fs-watch picks up the cascade.",
    )
    .action(async (id) => {
      await runLocalStoreCmd(async (store) => {
        const result = await cascadeDeleteAction(store, id);
        printJson({
          deleted: result.action,
          alsoDeleted: result.triggers,
        });
      });
    });

  action
    .command("runs <id>")
    .description("List recent runs for an action.")
    .option("--limit <n>", "max records", (v) => Number.parseInt(v, 10))
    .action(async (id, flags) => {
      await runLocalStoreCmd(async (store) => {
        const items = await store.runs.list({
          actionId: id,
          ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
        });
        printJson(items);
      });
    });
}
