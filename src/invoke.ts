import { intersectPolicy } from "./policy.js";
import type { ActionRuntime, ActionRuntimeRunArgs } from "./runtime/index.js";
import type { StateAdapter } from "./state/index.js";
import type { ActionRecord, Policy, StoreAdapter } from "./store/index.js";

export interface InvokeTrigger {
  type: "cron" | "webhook";
  triggerId: string;
  firedAt: string;
}

export interface WebhookRequestEnvelope {
  method: string;
  path: string;
  query: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  /**
   * How the request authenticated against the trigger's auth gate. Lets
   * action code make trust-level decisions without re-deriving from
   * headers/query. See WebhookAuthMode in store/index.ts for semantics.
   */
  auth: "bearer" | "public" | "artifact-session";
}

export interface InvokeEnvelope {
  trigger: InvokeTrigger | null;
  input?: unknown;
  request?: WebhookRequestEnvelope;
}

export interface InvokeResult {
  runId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  output: unknown | null;
  runtimeRunId: string;
  denials: string[];
}

export interface InvokeDeps {
  store: StoreAdapter;
  runtime: ActionRuntime;
  state: StateAdapter;
  ceiling: Policy;
  /**
   * The port this daemon is listening on. Used to build the
   * `CUE_STATE_URL` the unikernel reaches us on (`127.0.0.1:<port>`
   * via unitask's allow-tcp forward).
   */
  port: number;
}

const DEFAULT_TIMEOUT_SECONDS = 30;
const TIMEOUT_BUFFER_MS = 5_000;

export async function invokeAction(
  deps: InvokeDeps,
  action: ActionRecord,
  envelope: InvokeEnvelope,
): Promise<InvokeResult> {
  const { effective, denials } = intersectPolicy(action.policy, deps.ceiling);
  const firedAt = envelope.trigger?.firedAt ?? new Date().toISOString();
  const triggerId = envelope.trigger?.triggerId;

  const run = await deps.store.runs.create({
    actionId: action.id,
    ...(triggerId ? { triggerId } : {}),
    firedAt,
    input: envelope,
  });

  const timeoutSec = effective.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const timeoutMs = timeoutSec * 1000 + TIMEOUT_BUFFER_MS;

  const secrets = await deps.store.secrets.resolve(
    action.namespace,
    effective.secrets ?? [],
  );
  // Configs ride the same env-var channel as secrets at the runtime layer.
  // The split exists at the API/UI surface (configs are readable, secrets
  // aren't) — once we're running, both are just process env. If a config
  // and a secret share a name, the secret wins (last-write).
  const configs = await deps.store.configs.resolve(
    action.namespace,
    effective.configs ?? [],
  );
  const env: Record<string, string> = { ...configs, ...secrets };

  // Expand `$NAME` refs in network-allowlist policies against the
  // resolved env. Lets actions declare hostnames the user configures
  // at runtime — e.g. allowNet: ["$MONITOR_URL"] paired with
  // configs: ["MONITOR_URL"] makes the proxy follow whatever URL the
  // user pastes into the dashboard. Refs that are unset or don't
  // resolve to a usable host are dropped silently; the action's fetch
  // will be denied by the proxy, same as if the agent had never
  // declared that host. Literal hostnames pass through unchanged.
  // Fields stay undefined when not declared, to preserve the contract
  // that callers can distinguish "not set" from "empty allowlist".
  const policyForRuntime: Policy = {
    ...effective,
    ...(effective.allowNet
      ? { allowNet: expandHostRefs(effective.allowNet, env) }
      : {}),
    ...(effective.allowTcp
      ? { allowTcp: expandTcpRefs(effective.allowTcp, env) }
      : {}),
  };

  let stateArgs: ActionRuntimeRunArgs["state"];
  if (effective.state) {
    const token = await deps.state.tokens.resolveOrCreate(action.namespace);
    const hostPort = `127.0.0.1:${deps.port}`;
    stateArgs = {
      url: `http://${hostPort}`,
      token,
      hostPort,
    };
  }

  let result;
  try {
    result = await deps.runtime.run({
      code: action.code,
      policy: policyForRuntime,
      stdin: JSON.stringify(envelope),
      timeoutMs,
      // The runtime arg is named `secrets` for legacy reasons but is
      // really "env vars to inject" — we pass the merged config+secret
      // dict here, while `policy.configs`/`policy.secrets` separately
      // carry the names so unitask knows which env to forward.
      secrets: env,
      ...(stateArgs ? { state: stateArgs } : {}),
    });
  } catch (err) {
    // Runtime adapter itself failed before producing output. Finalize the
    // run with an error record so it isn't left orphaned (create-without-
    // finish), then rethrow so the caller sees the failure.
    const msg = err instanceof Error ? err.message : String(err);
    await deps.store.runs
      .finish(run.id, {
        exitCode: -1,
        stdout: "",
        stderr: `runtime adapter error: ${msg}`,
        finishedAt: new Date().toISOString(),
        denials,
      })
      .catch(() => {
        /* best-effort: already on the error path */
      });
    throw err;
  }

  const finishedAt = new Date().toISOString();
  await deps.store.runs.finish(run.id, {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    runtimeRunId: result.runtimeRunId,
    finishedAt,
    denials,
  });

  return {
    runId: run.id,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    output: parseJsonOrNull(result.stdout),
    runtimeRunId: result.runtimeRunId,
    denials,
  };
}

function parseJsonOrNull(s: string): unknown | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Expand `$NAME` refs in `allowNet` against the resolved env.
 *
 * Each entry that starts with `$` is replaced by the hostname extracted
 * from `env[NAME]`. The value can be either a full URL ("https://x.com/p")
 * or a bare hostname ("x.com") — both yield "x.com". Refs that are
 * unset, empty, or don't parse as a host are dropped. Literal entries
 * (no leading `$`) pass through unchanged.
 *
 * Dropping unresolved refs (rather than throwing) keeps the action
 * launchable when a config hasn't been set yet — same shape as how
 * unset secrets are handled. The proxy then refuses CONNECT for that
 * host and the action's fetch fails with a clear error, which the
 * action can log as "not configured".
 */
export function expandHostRefs(
  entries: readonly string[],
  env: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("$")) {
      out.push(entry);
      continue;
    }
    const name = entry.slice(1);
    const value = env[name];
    if (!value) continue;
    const host = parseHost(value);
    if (host) out.push(host);
  }
  return out;
}

/**
 * Expand `$NAME:port` refs in `allowTcp`. Format mirrors the existing
 * tcp target shape: `host:port`. Either component can be a `$NAME` ref
 * (the host commonly is, the port rarely). When the host comes from a
 * config that's a full URL, we extract its hostname.
 */
export function expandTcpRefs(
  entries: readonly string[],
  env: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const colonIdx = entry.lastIndexOf(":");
    if (colonIdx <= 0 || colonIdx === entry.length - 1) {
      // Malformed — pass through; the runtime will reject it with a
      // clear error rather than us silently dropping it here.
      out.push(entry);
      continue;
    }
    const hostPart = entry.slice(0, colonIdx);
    const portPart = entry.slice(colonIdx + 1);
    const host = hostPart.startsWith("$")
      ? (() => {
          const v = env[hostPart.slice(1)];
          return v ? parseHost(v) : null;
        })()
      : hostPart;
    const port = portPart.startsWith("$")
      ? env[portPart.slice(1)] ?? null
      : portPart;
    if (host && port) out.push(`${host}:${port}`);
  }
  return out;
}

function parseHost(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // URL parser needs a scheme; if the user gave us a bare hostname,
  // synthesize one. We only care about the parsed `hostname` field, so
  // the choice of scheme is irrelevant.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.hostname || null;
  } catch {
    return null;
  }
}
