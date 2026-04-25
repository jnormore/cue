import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { Policy } from "../store/index.js";
import {
  daemonEndpoint,
  deleteJson,
  getJson,
  postJson,
  printJson,
} from "./admin-client.js";

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
 * All action subcommands talk to the daemon over HTTP using the master
 * token. The daemon owns the database and runs unikernels — the CLI is
 * a thin client.
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
      const { baseUrl, token } = daemonEndpoint();
      const created = await postJson<{
        id: string;
        name: string;
        namespace: string;
        invokeUrl: string;
      }>(`${baseUrl}/admin/actions`, token, {
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
        invokeUrl: created.invokeUrl,
      });
    });

  action
    .command("list")
    .description("List actions.")
    .option("--namespace <ns>", "filter by namespace")
    .action(async (flags) => {
      const { baseUrl, token } = daemonEndpoint();
      const url = new URL(`${baseUrl}/admin/actions`);
      if (flags.namespace) url.searchParams.set("namespace", flags.namespace);
      printJson(await getJson(url.toString(), token));
    });

  action
    .command("get <id>")
    .description("Return the full action record.")
    .action(async (id) => {
      const { baseUrl, token } = daemonEndpoint();
      printJson(await getJson(`${baseUrl}/admin/actions/${id}`, token));
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
    .description("Delete an action and its triggers.")
    .action(async (id) => {
      const { baseUrl, token } = daemonEndpoint();
      printJson(await deleteJson(`${baseUrl}/admin/actions/${id}`, token));
    });

  action
    .command("runs <id>")
    .description("List recent runs for an action.")
    .option("--limit <n>", "max records", (v) => Number.parseInt(v, 10))
    .action(async (id, flags) => {
      const { baseUrl, token } = daemonEndpoint();
      const url = new URL(`${baseUrl}/admin/actions/${id}/runs`);
      if (flags.limit !== undefined) {
        url.searchParams.set("limit", String(flags.limit));
      }
      printJson(await getJson(url.toString(), token));
    });
}
