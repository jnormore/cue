import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProjectConfig } from "./policy.js";

export const DEFAULT_PORT = 4747;
export const DEFAULT_RUNTIME = "unitask";
export const DEFAULT_STORE = "fs";
export const DEFAULT_CRON = "node-cron";
export const DEFAULT_STATE = "fs";
export const DEFAULT_CORS: readonly string[] = [];
const TOKEN_BYTES = 32;

export interface CuePaths {
  home: string;
  token: string;
  port: string;
  actions: string;
  triggers: string;
  runs: string;
}

export interface CueConfig {
  home: string;
  paths: CuePaths;
  port: number;
  token: string;
  runtime: string;
  store: string;
  cron: string;
  state: string;
  /**
   * Allowed CORS origins for the daemon's HTTP surface.
   * [] = no CORS (default). ["*"] = allow any origin. Otherwise an allow-list.
   */
  cors: string[];
}

export interface ResolveOpts {
  portFlag?: number;
  runtimeFlag?: string;
  storeFlag?: string;
  cronFlag?: string;
  stateFlag?: string;
  /** CSV list of origins, or "*". Parsed into cors[]. */
  corsFlag?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  project?: ProjectConfig | null;
}

export function cuePaths(home: string): CuePaths {
  return {
    home,
    token: join(home, "token"),
    port: join(home, "port"),
    actions: join(home, "actions"),
    triggers: join(home, "triggers"),
    runs: join(home, "runs"),
  };
}

function ensureHome(paths: CuePaths): void {
  for (const dir of [paths.home, paths.actions, paths.triggers, paths.runs]) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadOrCreateToken(paths: CuePaths): string {
  if (existsSync(paths.token)) {
    return readFileSync(paths.token, "utf8").trim();
  }
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  writeFileSync(paths.token, token, { mode: 0o600 });
  // Some platforms ignore mode on create; force it.
  chmodSync(paths.token, 0o600);
  return token;
}

function readPortFile(portPath: string): number | null {
  if (!existsSync(portPath)) return null;
  const raw = readFileSync(portPath, "utf8").trim();
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
}

function resolvePort(
  opts: ResolveOpts,
  paths: CuePaths,
  env: NodeJS.ProcessEnv,
): number {
  if (opts.portFlag !== undefined) return opts.portFlag;
  if (env.CUE_PORT) {
    const n = Number.parseInt(env.CUE_PORT, 10);
    if (!Number.isFinite(n) || n < 0 || n >= 65536) {
      throw new Error(`CUE_PORT=${env.CUE_PORT} is not a valid port`);
    }
    return n;
  }
  const fromFile = readPortFile(paths.port);
  if (fromFile !== null) return fromFile;
  return DEFAULT_PORT;
}

function resolveRuntime(opts: ResolveOpts, env: NodeJS.ProcessEnv): string {
  if (opts.runtimeFlag) return opts.runtimeFlag;
  if (env.CUE_RUNTIME) return env.CUE_RUNTIME;
  if (opts.project?.runtime) return opts.project.runtime;
  return DEFAULT_RUNTIME;
}

function resolveStore(opts: ResolveOpts, env: NodeJS.ProcessEnv): string {
  if (opts.storeFlag) return opts.storeFlag;
  if (env.CUE_STORE) return env.CUE_STORE;
  if (opts.project?.store) return opts.project.store;
  return DEFAULT_STORE;
}

function resolveCron(opts: ResolveOpts, env: NodeJS.ProcessEnv): string {
  if (opts.cronFlag) return opts.cronFlag;
  if (env.CUE_CRON) return env.CUE_CRON;
  if (opts.project?.cron) return opts.project.cron;
  return DEFAULT_CRON;
}

function resolveState(opts: ResolveOpts, env: NodeJS.ProcessEnv): string {
  if (opts.stateFlag) return opts.stateFlag;
  if (env.CUE_STATE) return env.CUE_STATE;
  if (opts.project?.state) return opts.project.state;
  return DEFAULT_STATE;
}

function parseCorsCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function resolveCors(opts: ResolveOpts, env: NodeJS.ProcessEnv): string[] {
  if (opts.corsFlag !== undefined) return parseCorsCsv(opts.corsFlag);
  if (env.CUE_CORS !== undefined) return parseCorsCsv(env.CUE_CORS);
  if (opts.project?.cors) return [...opts.project.cors];
  return [...DEFAULT_CORS];
}

function resolveHome(opts: ResolveOpts, env: NodeJS.ProcessEnv): string {
  return opts.home ?? env.CUE_HOME ?? join(homedir(), ".cue");
}

export function resolveConfig(opts: ResolveOpts = {}): CueConfig {
  const env = opts.env ?? process.env;
  const home = resolveHome(opts, env);
  const paths = cuePaths(home);
  ensureHome(paths);
  const token = loadOrCreateToken(paths);
  const port = resolvePort(opts, paths, env);
  const runtime = resolveRuntime(opts, env);
  const store = resolveStore(opts, env);
  const cron = resolveCron(opts, env);
  const state = resolveState(opts, env);
  const cors = resolveCors(opts, env);
  return { home, paths, port, token, runtime, store, cron, state, cors };
}

export function writePort(home: string, port: number): void {
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) {
    throw new Error(`writePort: invalid port ${port}`);
  }
  const paths = cuePaths(home);
  writeFileSync(paths.port, `${port}\n`);
}

export function tokenMode(paths: CuePaths): number | null {
  if (!existsSync(paths.token)) return null;
  return statSync(paths.token).mode & 0o777;
}
