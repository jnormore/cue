#!/usr/bin/env node
import { Command, Option } from "commander";
import { registerActionCommands } from "./commands/action.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { runMcpBridge } from "./commands/mcp.js";
import { registerMcpConfigCommand } from "./commands/mcp-config.js";
import { registerNsCommands } from "./commands/ns.js";
import { registerSecretCommands } from "./commands/secret.js";
import { runServe } from "./commands/serve.js";
import { registerTokenCommands } from "./commands/token.js";
import { registerTriggerCommands } from "./commands/trigger.js";

const VERSION = "0.1.0";

const program = new Command();

program
  .name("cue")
  .description("An app runtime for agents. Actions, triggers, BYO UI.")
  .version(VERSION);

program
  .command("serve")
  .description("Start the cue daemon (HTTP + cron + MCP).")
  .option("-p, --port <n>", "port to bind", (v) => Number.parseInt(v, 10))
  .option("--host <h>", "host to bind", "127.0.0.1")
  .addOption(
    new Option("--runtime <name>", "runtime adapter name").choices(["unitask"]),
  )
  .addOption(new Option("--store <name>", "store adapter name").choices(["fs"]))
  .addOption(
    new Option("--cron <name>", "cron scheduler name").choices(["node-cron"]),
  )
  .option(
    "--cors <origins>",
    'Comma-separated allowed CORS origins, or "*" for any. Default: no CORS headers.',
  )
  .action(async (flags) => {
    await runServe({
      ...(flags.port !== undefined ? { port: flags.port } : {}),
      ...(flags.host ? { host: flags.host } : {}),
      ...(flags.runtime ? { runtime: flags.runtime } : {}),
      ...(flags.store ? { store: flags.store } : {}),
      ...(flags.cron ? { cron: flags.cron } : {}),
      ...(flags.cors !== undefined ? { cors: flags.cors } : {}),
      cueVersion: VERSION,
    });
  });

const mcpCmd = program
  .command("mcp")
  .description(
    "Run the stdio↔HTTP MCP bridge. Agents spawn this to talk to the daemon. Requires a scoped agent token: --token <atk_…> or CUE_AGENT_TOKEN. The master token is not accepted on /mcp.",
  )
  .option("-p, --port <n>", "daemon port (defaults to ~/.cue/port)", (v) =>
    Number.parseInt(v, 10),
  )
  .option("--host <h>", "daemon host", "127.0.0.1")
  .option(
    "--token <agent-token>",
    "scoped agent token to forward to /mcp (mint via `cue token create --namespace <ns>`; defaults to $CUE_AGENT_TOKEN)",
  )
  .action(async (flags) => {
    // `cue mcp` with no subcommand runs the stdio bridge.
    if (mcpCmd.args.length === 0) {
      await runMcpBridge({
        ...(flags.port !== undefined ? { port: flags.port } : {}),
        ...(flags.host ? { host: flags.host } : {}),
        ...(flags.token ? { token: flags.token } : {}),
        cueVersion: VERSION,
      });
    }
  });

registerMcpConfigCommand(mcpCmd);
registerActionCommands(program);
registerTriggerCommands(program);
registerTokenCommands(program);
registerSecretCommands(program);
registerNsCommands(program);
registerDoctorCommand(program);

program.parseAsync().catch((err) => {
  process.stderr.write(
    `cue: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
