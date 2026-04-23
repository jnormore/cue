import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Policy } from "./store/index.js";

export interface ProjectConfig {
  path: string;
  runtime?: string;
  store?: string;
  cron?: string;
  state?: string;
  cors?: string[];
  ceiling: Policy;
}

export interface PolicyResult {
  effective: Policy;
  denials: string[];
}

const CONFIG_FILENAME = ".cue.toml";
const NUMERIC_FIELDS = ["memoryMb", "timeoutSeconds"] as const;
const LIST_FIELDS = [
  "allowNet",
  "allowTcp",
  "secrets",
  "files",
  "dirs",
] as const;
const BOOLEAN_FIELDS = ["state"] as const;

export function walkUpForConfig(
  startDir: string = process.cwd(),
): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadProjectConfig(
  startDir: string = process.cwd(),
): ProjectConfig | null {
  const path = walkUpForConfig(startDir);
  if (!path) return null;
  const raw = readFileSync(path, "utf8");
  let data: Record<string, unknown>;
  try {
    data = parseToml(raw) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${path}: ${msg}`);
  }
  const result: ProjectConfig = { path, ceiling: {} };
  if (typeof data.runtime === "string") result.runtime = data.runtime;
  if (typeof data.store === "string") result.store = data.store;
  if (typeof data.cron === "string") result.cron = data.cron;
  if (typeof data.state === "string") result.state = data.state;
  if (typeof data.cors === "string") {
    result.cors = [data.cors];
  } else if (Array.isArray(data.cors)) {
    result.cors = data.cors.filter((v): v is string => typeof v === "string");
  }
  for (const f of NUMERIC_FIELDS) {
    if (typeof data[f] === "number") result.ceiling[f] = data[f] as number;
  }
  for (const f of LIST_FIELDS) {
    const v = data[f];
    if (Array.isArray(v)) {
      result.ceiling[f] = v.filter((x): x is string => typeof x === "string");
    }
  }
  for (const f of BOOLEAN_FIELDS) {
    if (typeof data[f] === "boolean") result.ceiling[f] = data[f] as boolean;
  }
  return result;
}

export function intersectPolicy(
  requested: Policy,
  ceiling: Policy,
): PolicyResult {
  const effective: Policy = {};
  const denials: string[] = [];

  for (const f of NUMERIC_FIELDS) {
    const req = requested[f];
    const cap = ceiling[f];
    if (req !== undefined && cap !== undefined && req > cap) {
      denials.push(`${f}:${req}>${cap}`);
      effective[f] = cap;
    } else if (req !== undefined) {
      effective[f] = req;
    } else if (cap !== undefined) {
      effective[f] = cap;
    }
  }

  for (const f of LIST_FIELDS) {
    const req = requested[f];
    if (req === undefined) continue;
    const cap = ceiling[f];
    if (cap === undefined) {
      effective[f] = [...req];
      continue;
    }
    const capSet = new Set(cap);
    const ok: string[] = [];
    for (const v of req) {
      if (capSet.has(v)) ok.push(v);
      else denials.push(`${f}:${v}`);
    }
    effective[f] = ok;
  }

  for (const f of BOOLEAN_FIELDS) {
    const req = requested[f];
    const cap = ceiling[f];
    if (req === undefined) continue;
    if (cap === false && req === true) {
      denials.push(`${f}:true`);
      effective[f] = false;
    } else {
      effective[f] = req;
    }
  }

  return { effective, denials };
}
