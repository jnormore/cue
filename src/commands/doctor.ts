import { existsSync } from "node:fs";
import type { Command } from "commander";
import { pickCron } from "../cron/index.js";
import { cuePaths, resolveConfig } from "../config.js";
import { loadProjectConfig } from "../policy.js";
import { pickRuntime } from "../runtime/index.js";
import { pickState } from "../state/index.js";
import { pickStore } from "../store/index.js";
import { printJson } from "./admin-client.js";

interface DoctorReport {
  cue: {
    version: string;
    home: string;
    daemonUp: boolean;
    port: number;
    daemonError?: string;
  };
  runtime: AdapterReport;
  store: AdapterReport;
  cron: AdapterReport;
  state: AdapterReport;
}

interface AdapterReport {
  name: string;
  ok: boolean;
  details: Record<string, unknown>;
}

/**
 * Health check, local-first. The CLI instantiates the same adapters
 * the daemon would, calls their `doctor()` probes directly, and pings
 * `/health` for daemon liveness. No RPC to the daemon for the adapter
 * probes — each adapter's `doctor()` is a stateless backend check.
 */
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description(
      "Health check: probes each adapter locally and pings the daemon for liveness.",
    )
    .option("--json", "emit machine-readable JSON instead of a text summary")
    .action(async (flags: { json?: boolean }) => {
      const project = loadProjectConfig();
      const config = resolveConfig({ project });
      const store = pickStore(config.store, { home: config.home });
      const runtime = pickRuntime(config.runtime);
      const cronScheduler = pickCron(config.cron);
      const state = pickState(config.state, { home: config.home });
      try {
        const [storeDr, runtimeDr, cronDr, stateDr] = await Promise.all([
          store.doctor(),
          runtime.doctor(),
          cronScheduler.doctor(),
          state.doctor(),
        ]);
        const portFileExists = existsSync(cuePaths(config.home).port);
        const daemon = portFileExists
          ? await probeDaemon(config.port)
          : { up: false, error: "no port file — daemon not started for this home" };

        const report: DoctorReport = {
          cue: {
            version: "0.1.0",
            home: config.home,
            daemonUp: daemon.up,
            port: config.port,
            ...(daemon.error ? { daemonError: daemon.error } : {}),
          },
          runtime: {
            name: runtime.name,
            ok: runtimeDr.ok,
            details: runtimeDr.details,
          },
          store: {
            name: store.name,
            ok: storeDr.ok,
            details: storeDr.details,
          },
          cron: {
            name: cronScheduler.name,
            ok: cronDr.ok,
            details: cronDr.details,
          },
          state: {
            name: state.name,
            ok: stateDr.ok,
            details: stateDr.details,
          },
        };

        if (flags.json) {
          printJson(report);
        } else {
          process.stdout.write(formatReport(report));
        }
      } finally {
        await store.close();
        await cronScheduler.close();
        await state.close();
      }
    });
}

/**
 * Pull the most useful one-line failure message out of an adapter's
 * details object. Different adapters surface errors under different
 * keys; this is best-effort.
 */
function failureDetail(details: Record<string, unknown>): string | null {
  if (typeof details.error === "string") return details.error;
  if (typeof details.message === "string") return details.message;
  // Last resort: stringify the whole thing so something visible shows up.
  if (Object.keys(details).length > 0) return JSON.stringify(details);
  return null;
}

// Indent for continuation lines (failure details). Matches the column
// where adapter names start in adapterLine().
const DETAIL_INDENT = "            ";

function adapterLine(label: string, rep: AdapterReport): string {
  const status = rep.ok ? "ok" : "FAIL";
  const head = `  ${(label + ":").padEnd(10)}${status.padEnd(6)}${rep.name}`;
  if (!rep.ok) {
    const detail = failureDetail(rep.details);
    return detail ? `${head}\n${DETAIL_INDENT}${detail}\n` : `${head}\n`;
  }
  return `${head}\n`;
}

function formatReport(r: DoctorReport): string {
  const lines: string[] = [];
  const url = `http://127.0.0.1:${r.cue.port}`;
  const daemonStatus = r.cue.daemonUp ? `up at ${url}` : "DOWN";
  lines.push(`cue ${r.cue.version}\n`);
  lines.push(`  ${"daemon:".padEnd(10)}${daemonStatus}\n`);
  if (!r.cue.daemonUp && r.cue.daemonError) {
    lines.push(`${DETAIL_INDENT}${r.cue.daemonError}\n`);
  }
  lines.push(adapterLine("store", r.store));
  lines.push(adapterLine("state", r.state));
  lines.push(adapterLine("runtime", r.runtime));
  lines.push(adapterLine("cron", r.cron));
  lines.push("\n");
  lines.push(`  home:     ${r.cue.home}\n`);

  const failures = [r.runtime, r.store, r.cron, r.state].filter(
    (a) => !a.ok,
  ).length;
  if (failures > 0 || !r.cue.daemonUp) {
    lines.push("\n");
    if (!r.cue.daemonUp) lines.push("  daemon is not running.\n");
    if (failures > 0) {
      lines.push(`  ${failures} adapter check${failures === 1 ? "" : "s"} failed.\n`);
    }
  }
  return lines.join("");
}

async function probeDaemon(
  port: number,
): Promise<{ up: boolean; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: controller.signal,
      });
      return { up: r.ok };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return {
      up: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
