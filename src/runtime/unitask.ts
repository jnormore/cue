import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Policy } from "../store/index.js";
import {
  CUE_STATE_HELPER_FILENAME,
  CUE_STATE_HELPER_SOURCE,
} from "./cue-state-helper.js";
import type { ActionRuntime } from "./index.js";

/**
 * Name of the envelope file injected into the unikernel.
 * Action code reads it via `readFileSync("/cue-envelope.json", "utf8")`
 * (unitask mounts `--file <host>` at `/<basename>` inside the guest).
 */
export const ENVELOPE_FILENAME = "cue-envelope.json";

const DOCTOR_TIMEOUT_MS = 5_000;

export interface SubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SubprocessExecOpts {
  stdin: string;
  timeoutMs: number;
  /**
   * Explicit env for the child process. When provided, the child sees
   * exactly these variables and nothing inherited from the daemon.
   */
  env?: Record<string, string>;
}

export type SubprocessExec = (
  cmd: string,
  args: string[],
  opts: SubprocessExecOpts,
) => Promise<SubprocessResult>;

export interface UnitaskRuntimeOpts {
  bin?: string;
  exec?: SubprocessExec;
}

export function unitaskRuntime(opts: UnitaskRuntimeOpts = {}): ActionRuntime {
  const bin = opts.bin ?? process.env.CUE_UNITASK_BIN ?? "unitask";
  const exec = opts.exec ?? defaultExec;

  return {
    name: "unitask",

    async doctor() {
      try {
        const r = await exec(bin, ["doctor"], {
          stdin: "",
          timeoutMs: DOCTOR_TIMEOUT_MS,
        });
        const details: Record<string, unknown> = {
          bin,
          exitCode: r.exitCode,
        };
        if (r.stdout.trim()) details.stdout = r.stdout.trim();
        if (r.stderr.trim()) details.stderr = r.stderr.trim();
        return { ok: r.exitCode === 0, details };
      } catch (err) {
        return {
          ok: false,
          details: { bin, error: err instanceof Error ? err.message : String(err) },
        };
      }
    },

    async run(args) {
      const dir = await mkdtemp(join(tmpdir(), "cue-unitask-"));
      const codeFile = join(dir, "code.js");
      const envelopeFile = join(dir, ENVELOPE_FILENAME);
      try {
        await writeFile(codeFile, args.code);
        await writeFile(envelopeFile, args.stdin);
        const cmdArgs = [
          "run",
          "--code-file",
          codeFile,
          "--file",
          envelopeFile,
          "--json",
          ...policyToFlags(args.policy),
        ];
        const env = buildSubprocessEnv(args.secrets);
        if (args.state) {
          const helperFile = join(dir, CUE_STATE_HELPER_FILENAME);
          await writeFile(helperFile, CUE_STATE_HELPER_SOURCE);
          cmdArgs.push(
            "--file",
            helperFile,
            "--allow-tcp",
            args.state.hostPort,
            "--secret",
            "CUE_STATE_URL",
            "--secret",
            "CUE_STATE_TOKEN",
          );
          env.CUE_STATE_URL = args.state.url;
          env.CUE_STATE_TOKEN = args.state.token;
        }
        // `--secret X` is unitask's "forward env var X into the guest"
        // flag, AND it's strict — unitask exits 2 if X isn't set on the
        // host. We don't want that strictness for declared-but-unset
        // values: cron firing every minute when MONITOR_URL hasn't been
        // configured yet shouldn't spam "env var not set" errors. Better
        // to start the action with an undefined env var and let the
        // action decide (skip work, log "not configured", whatever).
        cmdArgs.push(...policyEnvFlags(args.policy, env));
        const r = await exec(bin, cmdArgs, {
          stdin: "",
          timeoutMs: args.timeoutMs,
          env,
        });
        // unitask --json emits a structured envelope on stdout regardless
        // of exit code. If parsing fails, unitask exploded before emitting.
        let parsed: {
          runId: string;
          exitCode: number;
          stdout: string;
          stderr: string;
          timedOut?: boolean;
        };
        try {
          parsed = JSON.parse(r.stdout);
        } catch {
          throw new Error(
            `unitask returned non-JSON output (host exit ${r.exitCode}). stdout: ${truncate(r.stdout, 200)} stderr: ${truncate(r.stderr, 200)}`,
          );
        }
        return {
          stdout: parsed.stdout,
          stderr: parsed.stderr,
          exitCode: parsed.timedOut ? 124 : parsed.exitCode,
          runtimeRunId: parsed.runId,
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Host env vars the unitask binary itself may need to run (PATH to find
 * its own backing tools, HOME for config, TMPDIR for scratch space, LANG
 * so text output isn't corrupted). Anything else from the daemon's env
 * is intentionally withheld — the only secret channel into the guest is
 * the `secrets` arg, resolved per-namespace.
 */
const HOST_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const;

export function buildSubprocessEnv(
  secrets: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of HOST_ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  // Secrets win over any accidental collision with allowlisted host vars.
  for (const [k, v] of Object.entries(secrets)) env[k] = v;
  return env;
}

/**
 * Translate a policy into unitask CLI flags. Note: env-var forwarding
 * flags (`--secret X`) are NOT emitted here — that's done by
 * `policyEnvFlags`, which gets the resolved env so it can skip names
 * that aren't actually set. See the call site in `run()` for why.
 */
export function policyToFlags(policy: Policy): string[] {
  const flags: string[] = [];
  if (policy.memoryMb !== undefined) {
    flags.push("--memory", String(policy.memoryMb));
  }
  if (policy.timeoutSeconds !== undefined) {
    flags.push("--timeout", String(policy.timeoutSeconds));
  }
  for (const host of policy.allowNet ?? []) flags.push("--allow-net", host);
  for (const tcp of policy.allowTcp ?? []) flags.push("--allow-tcp", tcp);
  for (const f of policy.files ?? []) flags.push("--file", f);
  for (const d of policy.dirs ?? []) flags.push("--dir", d);
  return flags;
}

/**
 * Emit `--secret`/`--env` for each declared secret/config that has an
 * actual value in `env`. Skipped names land in the guest as undefined;
 * the action is responsible for handling that case (e.g. logging "not
 * configured" and exiting cleanly). The alternative — emit the flag
 * unconditionally — makes unitask refuse to launch when any declared
 * name is unset, which spams cron firings and produces a worse error
 * than the action could surface itself.
 *
 * Secrets get `--secret`: redacted from output, only the name is
 * persisted to the run record.
 *
 * Configs get `--env`: NOT redacted, name+value persisted. Use for
 * non-sensitive runtime values (URLs, thresholds, channel names) that
 * the operator benefits from being able to see. Routing configs
 * through `--secret` would log them as `[REDACTED:NAME]` and break
 * any dashboard that echoes the config value back to the user.
 */
export function policyEnvFlags(
  policy: Policy,
  env: Record<string, string>,
): string[] {
  const flags: string[] = [];
  for (const s of policy.secrets ?? []) {
    if (env[s] !== undefined) flags.push("--secret", s);
  }
  for (const c of policy.configs ?? []) {
    if (env[c] !== undefined) flags.push("--env", c);
  }
  return flags;
}

const defaultExec: SubprocessExec = (cmd, args, opts) =>
  new Promise<SubprocessResult>((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ stdout, stderr, exitCode: 124 });
      } else {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? (signal ? 128 : 0),
        });
      }
    });

    child.stdin.write(opts.stdin);
    child.stdin.end();
  });
