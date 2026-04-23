import type { Policy } from "../store/index.js";
import { unitaskRuntime } from "./unitask.js";

export interface ActionRuntimeRunArgs {
  code: string;
  policy: Policy;
  stdin: string;
  timeoutMs: number;
  /**
   * Resolved secret values, keyed by name. Threaded into the unikernel via
   * unitask `--secret <name>` + a curated subprocess env. Only names the
   * action declared in `policy.secrets` and that the store resolved are
   * present; the daemon's own env is not leaked.
   */
  secrets: Record<string, string>;
  /**
   * State injection. Present iff the action declared `policy.state: true`
   * and the daemon resolved a namespace state token. Runtime adapters use
   * it to inject the `/cue-state.js` helper, the `CUE_STATE_URL`/`CUE_STATE_TOKEN`
   * env vars, and an allow-tcp entry for the daemon host:port.
   */
  state?: {
    url: string;
    token: string;
    hostPort: string;
  };
}

export interface ActionRuntimeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  runtimeRunId: string;
}

export interface ActionRuntimeDoctorResult {
  ok: boolean;
  details: Record<string, unknown>;
}

export interface ActionRuntime {
  name: string;
  doctor(): Promise<ActionRuntimeDoctorResult>;
  run(args: ActionRuntimeRunArgs): Promise<ActionRuntimeRunResult>;
}

export function pickRuntime(name: string): ActionRuntime {
  switch (name) {
    case "unitask":
      return unitaskRuntime();
    default:
      throw new Error(
        `Unknown runtime adapter: "${name}". Known adapters: unitask`,
      );
  }
}
