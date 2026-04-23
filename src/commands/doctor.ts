import { existsSync } from "node:fs";
import type { Command } from "commander";
import { pickCron } from "../cron/index.js";
import { cuePaths, resolveConfig } from "../config.js";
import { loadProjectConfig } from "../policy.js";
import { pickRuntime } from "../runtime/index.js";
import { pickState } from "../state/index.js";
import { pickStore } from "../store/index.js";
import { printJson } from "./admin-client.js";

/**
 * Health check, local-first. The CLI instantiates the same adapters
 * the daemon would, calls their `doctor()` probes directly, and pings
 * `/health` for daemon liveness. No RPC to the daemon for the adapter
 * probes — each adapter's `doctor()` is a stateless backend check.
 *
 * If the daemon was started with different env than the CLI has at
 * hand, the reported adapter names will surface that divergence — a
 * mismatch we used to hide behind an RPC that always reflected the
 * daemon's choices.
 */
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description(
      "Health check: probes each adapter locally and pings the daemon for liveness. No RPC — runs the same doctors the daemon does, in-process.",
    )
    .action(async () => {
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
        // Only ping if the port file exists for this home — otherwise
        // we'd be probing whatever happens to be bound to DEFAULT_PORT,
        // which may not be "our" daemon at all.
        const portFileExists = existsSync(cuePaths(config.home).port);
        const daemon = portFileExists
          ? await probeDaemon(config.port)
          : { up: false, error: "no port file — daemon not started for this home" };
        printJson({
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
        });
      } finally {
        await store.close();
        await cronScheduler.close();
        await state.close();
      }
    });
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
