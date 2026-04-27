import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SubprocessExec } from "../../../src/runtime/unitask.js";
import {
  ENVELOPE_FILENAME,
  buildSubprocessEnv,
  policyEnvFlags,
  policyToFlags,
  unitaskRuntime,
} from "../../../src/runtime/unitask.js";

const okRunJson = JSON.stringify({
  runId: "r_abcd1234",
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
});

const okExec = (): SubprocessExec =>
  vi.fn().mockResolvedValue({ stdout: okRunJson, stderr: "", exitCode: 0 });

describe("policyToFlags", () => {
  it("returns empty flags for an empty policy", () => {
    expect(policyToFlags({})).toEqual([]);
  });

  it("maps every supported field (env-forwarding handled separately)", () => {
    expect(
      policyToFlags({
        memoryMb: 256,
        timeoutSeconds: 30,
        allowNet: ["a", "b"],
        allowTcp: ["127.0.0.1:5432"],
        // secrets / configs are intentionally not in policyToFlags's
        // output — they're emitted by policyEnvFlags, which can see
        // the resolved env and skip unset names.
        secrets: ["GH_TOKEN"],
        files: ["/etc/x"],
        dirs: ["/var/cache"],
      }),
    ).toEqual([
      "--memory",
      "256",
      "--timeout",
      "30",
      "--allow-net",
      "a",
      "--allow-net",
      "b",
      "--allow-tcp",
      "127.0.0.1:5432",
      "--file",
      "/etc/x",
      "--dir",
      "/var/cache",
    ]);
  });

  it("omits fields that are undefined or empty arrays", () => {
    expect(policyToFlags({ allowNet: [], memoryMb: undefined })).toEqual([]);
  });
});

describe("policyEnvFlags", () => {
  it("emits --secret for every declared secret that has a value", () => {
    expect(
      policyEnvFlags(
        { secrets: ["GH_TOKEN", "STRIPE_KEY"] },
        { GH_TOKEN: "ghs_x", STRIPE_KEY: "sk_y" },
      ),
    ).toEqual([
      "--secret",
      "GH_TOKEN",
      "--secret",
      "STRIPE_KEY",
    ]);
  });

  it("emits --env (not --secret) for every declared config that has a value", () => {
    // The split matters: unitask redacts --secret values from output but
    // not --env values. Routing configs through --env keeps URLs,
    // thresholds, channel names etc. visible in dashboards/logs while
    // sensitive values stay opaque.
    expect(
      policyEnvFlags(
        { configs: ["MONITOR_URL", "THRESHOLD"] },
        { MONITOR_URL: "https://x", THRESHOLD: "100" },
      ),
    ).toEqual(["--env", "MONITOR_URL", "--env", "THRESHOLD"]);
  });

  it("skips declared names that are unset (the cron-fires-too-early case)", () => {
    expect(
      policyEnvFlags(
        { secrets: ["MISSING_SECRET"], configs: ["MONITOR_URL"] },
        { MONITOR_URL: "https://x" },
      ),
    ).toEqual(["--env", "MONITOR_URL"]);
  });

  it("mixes --secret for secrets and --env for configs in one call", () => {
    expect(
      policyEnvFlags(
        { secrets: ["GH_TOKEN"], configs: ["MONITOR_URL"] },
        { GH_TOKEN: "ghs_x", MONITOR_URL: "https://x" },
      ),
    ).toEqual(["--secret", "GH_TOKEN", "--env", "MONITOR_URL"]);
  });

  it("returns [] when policy has no secrets or configs", () => {
    expect(policyEnvFlags({}, {})).toEqual([]);
  });
});

describe("unitaskRuntime.doctor", () => {
  it("ok:true when subprocess exits 0", async () => {
    const exec = vi
      .fn()
      .mockResolvedValue({ stdout: "unitask 0.3.1", stderr: "", exitCode: 0 });
    const rt = unitaskRuntime({ bin: "unitask", exec });
    const r = await rt.doctor();
    expect(r.ok).toBe(true);
    expect(r.details).toMatchObject({ bin: "unitask", exitCode: 0 });
    expect(r.details.stdout).toBe("unitask 0.3.1");
    expect(exec).toHaveBeenCalledWith(
      "unitask",
      ["doctor"],
      expect.objectContaining({ stdin: "" }),
    );
  });

  it("ok:false when subprocess exits non-zero", async () => {
    const exec = vi
      .fn()
      .mockResolvedValue({ stdout: "", stderr: "broken", exitCode: 2 });
    const rt = unitaskRuntime({ exec });
    const r = await rt.doctor();
    expect(r.ok).toBe(false);
    expect(r.details).toMatchObject({ exitCode: 2, stderr: "broken" });
  });

  it("ok:false when subprocess errors (e.g. ENOENT)", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("spawn unitask ENOENT"));
    const rt = unitaskRuntime({ exec });
    const r = await rt.doctor();
    expect(r.ok).toBe(false);
    expect(r.details.error).toMatch(/ENOENT/);
  });
});

describe("unitaskRuntime.run", () => {
  it("writes code and envelope to a temp dir, invokes unitask with --json, returns parsed JSON", async () => {
    let seenArgs: string[] = [];
    let seenCode = "";
    let seenEnvelope = "";
    const exec: SubprocessExec = vi.fn(async (_cmd, args) => {
      seenArgs = args;
      const codeIdx = args.indexOf("--code-file");
      seenCode = await readFile(args[codeIdx + 1] as string, "utf8");
      const fileIdx = args.indexOf("--file");
      seenEnvelope = await readFile(args[fileIdx + 1] as string, "utf8");
      return {
        stdout: JSON.stringify({
          runId: "r_deadbeef",
          exitCode: 0,
          stdout: "hello",
          stderr: "warn",
          timedOut: false,
        }),
        stderr: "",
        exitCode: 0,
      };
    });
    const rt = unitaskRuntime({ exec });
    const r = await rt.run({
      code: "console.log(1)",
      policy: { memoryMb: 128 },
      stdin: '{"trigger":null,"input":null}',
      timeoutMs: 1000,
      secrets: {},
    });
    expect(r.runtimeRunId).toBe("r_deadbeef");
    expect(r.stdout).toBe("hello");
    expect(r.stderr).toBe("warn");
    expect(r.exitCode).toBe(0);
    expect(seenCode).toBe("console.log(1)");
    expect(seenEnvelope).toBe('{"trigger":null,"input":null}');
    expect(seenArgs[0]).toBe("run");
    expect(seenArgs).toContain("--json");
    expect(seenArgs).toContain("--file");
    expect(seenArgs).not.toContain("--run-id");
    expect(seenArgs).toContain("--memory");
    expect(seenArgs).toContain("128");
  });

  it("envelope file is named so the unikernel sees it at /cue-envelope.json", async () => {
    let envelopePath = "";
    const exec: SubprocessExec = vi.fn(async (_cmd, args) => {
      const fileIdx = args.indexOf("--file");
      envelopePath = args[fileIdx + 1] as string;
      return { stdout: okRunJson, stderr: "", exitCode: 0 };
    });
    await unitaskRuntime({ exec }).run({
      code: "x",
      policy: {},
      stdin: "{}",
      timeoutMs: 1000,
      secrets: {},
    });
    expect(envelopePath).toMatch(
      new RegExp(`${ENVELOPE_FILENAME.replace(".", "\\.")}$`),
    );
  });

  it("maps timedOut:true to exitCode 124", async () => {
    const exec: SubprocessExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        runId: "r_1",
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: true,
      }),
      stderr: "",
      exitCode: 0,
    });
    const r = await unitaskRuntime({ exec }).run({
      code: "x",
      policy: {},
      stdin: "{}",
      timeoutMs: 100,
      secrets: {},
    });
    expect(r.exitCode).toBe(124);
  });

  it("throws a clear error when unitask emits non-JSON stdout", async () => {
    const exec: SubprocessExec = vi.fn().mockResolvedValue({
      stdout: "unitask: error: unknown flag\n",
      stderr: "boom",
      exitCode: 1,
    });
    await expect(
      unitaskRuntime({ exec }).run({
        code: "x",
        policy: {},
        stdin: "{}",
        timeoutMs: 1000,
        secrets: {},
      }),
    ).rejects.toThrow(/non-JSON/);
  });

  it("cleans up the temp directory after a successful run", async () => {
    let dir = "";
    const exec: SubprocessExec = vi.fn(async (_cmd, args) => {
      const idx = args.indexOf("--code-file");
      dir = dirname(args[idx + 1] as string);
      return { stdout: okRunJson, stderr: "", exitCode: 0 };
    });
    await unitaskRuntime({ exec }).run({
      code: "x",
      policy: {},
      stdin: "{}",
      timeoutMs: 1000,
      secrets: {},
    });
    expect(dir).not.toBe("");
    expect(existsSync(dir)).toBe(false);
  });

  it("cleans up the temp directory even when exec rejects", async () => {
    let dir = "";
    const exec: SubprocessExec = vi.fn(async (_cmd, args) => {
      const idx = args.indexOf("--code-file");
      dir = dirname(args[idx + 1] as string);
      throw new Error("boom");
    });
    await expect(
      unitaskRuntime({ exec }).run({
        code: "x",
        policy: {},
        stdin: "{}",
        timeoutMs: 1000,
        secrets: {},
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(dir)).toBe(false);
  });

  it("passes empty stdin to the subprocess (envelope is a file, not stdin)", async () => {
    const exec = okExec();
    await unitaskRuntime({ exec }).run({
      code: "x",
      policy: {},
      stdin: '{"hello":"world"}',
      timeoutMs: 1000,
      secrets: {},
    });
    expect(exec).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ stdin: "", timeoutMs: 1000 }),
    );
  });

  it("respects the bin option", async () => {
    const exec = okExec();
    await unitaskRuntime({ bin: "/opt/unitask/bin/unitask", exec }).run({
      code: "x",
      policy: {},
      stdin: "{}",
      timeoutMs: 1000,
      secrets: {},
    });
    expect(exec).toHaveBeenCalledWith(
      "/opt/unitask/bin/unitask",
      expect.any(Array),
      expect.anything(),
    );
  });
});

describe("buildSubprocessEnv", () => {
  const SENTINEL = "CUE_TEST_SECRET_LEAK_SENTINEL";

  it("includes PATH/HOME/TMPDIR/LANG/LC_ALL from parent when present", () => {
    const env = buildSubprocessEnv({});
    if (process.env.PATH !== undefined) expect(env.PATH).toBe(process.env.PATH);
    if (process.env.HOME !== undefined) expect(env.HOME).toBe(process.env.HOME);
  });

  it("does not leak arbitrary parent env", () => {
    process.env[SENTINEL] = "this-should-not-leak";
    try {
      const env = buildSubprocessEnv({});
      expect(env[SENTINEL]).toBeUndefined();
    } finally {
      delete process.env[SENTINEL];
    }
  });

  it("merges in provided secrets", () => {
    const env = buildSubprocessEnv({ SHOPIFY_TOKEN: "shpat_abc", OTHER: "v" });
    expect(env.SHOPIFY_TOKEN).toBe("shpat_abc");
    expect(env.OTHER).toBe("v");
  });

  it("secrets win over allowlisted host vars on name collision", () => {
    const env = buildSubprocessEnv({ PATH: "/overridden" });
    expect(env.PATH).toBe("/overridden");
  });
});

describe("unitaskRuntime.run env curation", () => {
  it("passes a curated env (including the secrets) to the subprocess", async () => {
    let seenEnv: Record<string, string> | undefined;
    const exec: SubprocessExec = vi.fn(async (_cmd, _args, opts) => {
      seenEnv = opts.env;
      return { stdout: okRunJson, stderr: "", exitCode: 0 };
    });
    await unitaskRuntime({ exec }).run({
      code: "x",
      policy: { secrets: ["MY_SECRET"] },
      stdin: "{}",
      timeoutMs: 1000,
      secrets: { MY_SECRET: "value-42" },
    });
    expect(seenEnv).toBeDefined();
    expect(seenEnv?.MY_SECRET).toBe("value-42");
  });

  it("does not leak arbitrary parent env into the subprocess", async () => {
    const SENTINEL = "CUE_TEST_RUN_LEAK_SENTINEL";
    process.env[SENTINEL] = "must-not-appear";
    let seenEnv: Record<string, string> | undefined;
    const exec: SubprocessExec = vi.fn(async (_cmd, _args, opts) => {
      seenEnv = opts.env;
      return { stdout: okRunJson, stderr: "", exitCode: 0 };
    });
    try {
      await unitaskRuntime({ exec }).run({
        code: "x",
        policy: {},
        stdin: "{}",
        timeoutMs: 1000,
        secrets: {},
      });
    } finally {
      delete process.env[SENTINEL];
    }
    expect(seenEnv?.[SENTINEL]).toBeUndefined();
  });
});

// silence tsc unused-import warning when tests don't need join
void join;
