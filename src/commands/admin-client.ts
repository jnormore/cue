import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, cuePaths } from "../config.js";

/**
 * The CLI talks to the daemon over HTTP. The master token at
 * `~/.cue/token` authenticates every request — both the public
 * surfaces (`/a/:id`) and the operator-only `/admin/*` routes.
 *
 * Helpers below cover the four verbs we actually use; each one
 * shares the same auth + error-translation path so commands stay
 * tight.
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

interface RequestOpts {
  url: string;
  token: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
}

async function request<T = unknown>(o: RequestOpts): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${o.token}`,
    Accept: "application/json",
  };
  let body: string | undefined;
  if (o.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(o.body);
  }
  let res: Response;
  try {
    res = await fetch(o.url, {
      method: o.method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
  } catch (err) {
    die(
      `cannot reach cue daemon at ${o.url} — is \`cue serve\` running?\n${err instanceof Error ? err.message : String(err)}`,
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

export async function postJson<T = unknown>(
  url: string,
  token: string,
  body: unknown,
): Promise<T> {
  return request<T>({ url, token, method: "POST", body: body ?? {} });
}

export async function getJson<T = unknown>(
  url: string,
  token: string,
): Promise<T> {
  return request<T>({ url, token, method: "GET" });
}

export async function patchJson<T = unknown>(
  url: string,
  token: string,
  body: unknown,
): Promise<T> {
  return request<T>({ url, token, method: "PATCH", body: body ?? {} });
}

export async function putJson<T = unknown>(
  url: string,
  token: string,
  body: unknown,
): Promise<T> {
  return request<T>({ url, token, method: "PUT", body: body ?? {} });
}

export async function deleteJson<T = unknown>(
  url: string,
  token: string,
): Promise<T> {
  return request<T>({ url, token, method: "DELETE" });
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
