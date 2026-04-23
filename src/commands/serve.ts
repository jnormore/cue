import { pickCron } from "../cron/index.js";
import { resolveConfig, writePort } from "../config.js";
import { loadProjectConfig } from "../policy.js";
import { pickRuntime } from "../runtime/index.js";
import { buildServer } from "../server/index.js";
import { pickState } from "../state/index.js";
import { pickStore } from "../store/index.js";

export interface ServeCliOpts {
  port?: number;
  host?: string;
  runtime?: string;
  store?: string;
  cron?: string;
  state?: string;
  cors?: string;
  cueVersion?: string;
}

export async function runServe(opts: ServeCliOpts = {}): Promise<void> {
  const project = loadProjectConfig();
  const config = resolveConfig({
    ...(opts.port !== undefined ? { portFlag: opts.port } : {}),
    ...(opts.runtime ? { runtimeFlag: opts.runtime } : {}),
    ...(opts.store ? { storeFlag: opts.store } : {}),
    ...(opts.cron ? { cronFlag: opts.cron } : {}),
    ...(opts.state ? { stateFlag: opts.state } : {}),
    ...(opts.cors !== undefined ? { corsFlag: opts.cors } : {}),
    project,
  });

  const store = pickStore(config.store, { home: config.home });
  const runtime = pickRuntime(config.runtime);
  const cronScheduler = pickCron(config.cron);
  const state = pickState(config.state, { home: config.home });

  const [storeDr, runtimeDr, cronDr, stateDr] = await Promise.all([
    store.doctor(),
    runtime.doctor(),
    cronScheduler.doctor(),
    state.doctor(),
  ]);
  if (!storeDr.ok) {
    bail(
      `store adapter "${store.name}" failed doctor: ${JSON.stringify(storeDr.details)}`,
    );
  }
  if (!runtimeDr.ok) {
    bail(
      `runtime adapter "${runtime.name}" failed doctor: ${JSON.stringify(runtimeDr.details)}`,
    );
  }
  if (!cronDr.ok) {
    bail(
      `cron scheduler "${cronScheduler.name}" failed doctor: ${JSON.stringify(cronDr.details)}`,
    );
  }
  if (!stateDr.ok) {
    bail(
      `state adapter "${state.name}" failed doctor: ${JSON.stringify(stateDr.details)}`,
    );
  }

  const host = opts.host ?? "127.0.0.1";
  const ceiling = project?.ceiling ?? {};

  // Base URL uses the requested port; we patch it after bind if needed.
  let baseUrl = `http://${host}:${config.port === 0 ? "PENDING" : config.port}`;
  const built = await buildServer({
    store,
    runtime,
    state,
    ceiling,
    token: config.token,
    baseUrl,
    cronScheduler,
    cueVersion: opts.cueVersion ?? "0.1.0",
    port: config.port,
    cors: config.cors,
    logger: true,
  });

  try {
    const address = await built.app.listen({ port: config.port, host });
    const actualPort = extractPort(address, host, config.port);
    baseUrl = `http://${host}:${actualPort}`;
    // Rebind baseUrl so URL helpers emit the right port.
    built.mcpDeps.invokeUrlFor = (id) => `${baseUrl}/a/${id}`;
    built.mcpDeps.webhookUrlFor = (id) => `${baseUrl}/w/${id}`;
    built.mcpDeps.port = actualPort;

    writePort(config.home, actualPort);

    const loaded = await built.cronRegistry.loadExisting();
    built.cronRegistry.watch();
    const corsLine =
      config.cors.length === 0
        ? "  cors:    (disabled — same-origin only)"
        : config.cors.includes("*")
          ? "  cors:    * (any origin)"
          : `  cors:    ${config.cors.join(", ")}`;
    process.stdout.write(
      [
        `cue serve — listening on ${baseUrl}`,
        `  store:   ${store.name}  (${config.home})`,
        `  runtime: ${runtime.name}`,
        `  cron:    ${cronScheduler.name}  (${loaded.scheduled.length} scheduled`,
        loaded.failed.length > 0
          ? `, ${loaded.failed.length} failed)`
          : ")",
        `  state:   ${state.name}`,
        corsLine,
        project
          ? `  ceiling: ${project.path}`
          : "  ceiling: (no .cue.toml found)",
        "",
      ].join("\n"),
    );

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) {
        process.stdout.write(`\n${signal} again — forcing exit\n`);
        process.exit(1);
      }
      shuttingDown = true;
      process.stdout.write(`\n${signal} — shutting down...\n`);
      const hardExit = setTimeout(() => {
        process.stdout.write("shutdown timed out — forcing exit\n");
        process.exit(1);
      }, 5000).unref();
      try {
        await built.cronRegistry.closeAll();
        await cronScheduler.close();
        await store.close();
        await state.close();
        await built.app.close();
      } finally {
        clearTimeout(hardExit);
        process.exit(0);
      }
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (err) {
    bail(`failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function extractPort(address: string, _host: string, requested: number): number {
  // Fastify's listen returns e.g. "http://127.0.0.1:4747"
  try {
    const url = new URL(address);
    const p = Number.parseInt(url.port, 10);
    if (Number.isFinite(p) && p > 0) return p;
  } catch {
    // fall through
  }
  return requested;
}

function bail(message: string): never {
  process.stderr.write(`cue serve: ${message}\n`);
  process.exit(1);
}
