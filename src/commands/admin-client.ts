import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, cuePaths } from "../config.js";

/**
 * The CLI uses the master token against two surfaces:
 *   1. The filesystem directly (see local-store.ts) for storage ops.
 *   2. `/a/:id` for action invocation — the one thing the daemon
 *      uniquely owns (spawns the unikernel, records the run).
 * This helper resolves the master token + daemon URL + timeouts that
 * the invoke path needs. No `/admin/*` routes exist — anything you
 * might have reached for via admin is either file I/O or (for invoke)
 * goes through the public `/a/:id` surface.
 */
export interface DaemonEndpoint {
  baseUrl: string;
  token: string;
}

export function daemonEndpoint(): DaemonEndpoint {
  const home = process.env.CUE_HOME ?? join(homedir(), ".cue");
  const paths = cuePaths(home);
  const token = readTokenOrDie(paths.token);
  const port = readPortOrDefault(paths.port);
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function postJson<T = unknown>(
  url: string,
  token: string,
  body: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    die(
      `cannot reach cue daemon at ${url} — is \`cue serve\` running?\n${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* leave as string */
    }
  } else {
    parsed = null;
  }
  if (!res.ok) {
    const msg =
      typeof parsed === "object" && parsed && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : typeof parsed === "string"
          ? parsed
          : `HTTP ${res.status}`;
    process.stderr.write(`cue: ${msg}\n`);
    process.exit(1);
  }
  return parsed as T;
}

function readTokenOrDie(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    die(
      `daemon token not found at ${path} — start the daemon with \`cue serve\` first.`,
    );
  }
}

function readPortOrDefault(path: string): number {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* fall through */
  }
  return DEFAULT_PORT;
}

function die(msg: string): never {
  process.stderr.write(`cue: ${msg}\n`);
  process.exit(1);
}
