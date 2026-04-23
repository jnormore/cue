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
      policy: effective,
      stdin: JSON.stringify(envelope),
      timeoutMs,
      secrets,
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
