import { describe, expect, it } from "vitest";
import { unitaskRuntime } from "../../src/runtime/unitask.js";

const rt = unitaskRuntime();
const unitaskAvailable = await (async () => {
  try {
    const dr = await rt.doctor();
    return dr.ok;
  } catch {
    return false;
  }
})();

if (!unitaskAvailable) {
  console.log(
    "[integration] unitask not on PATH or doctor failed — skipping real-runtime tests",
  );
}

describe.skipIf(!unitaskAvailable)("unitask runtime (real)", () => {
  it("doctor returns ok with platform details", async () => {
    const dr = await rt.doctor();
    expect(dr.ok).toBe(true);
    expect(dr.details.exitCode).toBe(0);
  });

  it(
    "runs a JS action end-to-end: reads envelope file, writes JSON stdout",
    async () => {
      const code = `
        const { readFileSync } = require("fs");
        const envelope = JSON.parse(readFileSync("/cue-envelope.json", "utf8"));
        console.log(JSON.stringify({
          ran: true,
          sawInput: envelope.input,
          hasTrigger: envelope.trigger !== null,
        }));
      `;
      const result = await rt.run({
        code,
        policy: { timeoutSeconds: 60, memoryMb: 256 },
        stdin: JSON.stringify({
          trigger: null,
          input: { hello: "unitask" },
        }),
        timeoutMs: 90_000,
        secrets: {},
      });
      expect(result.exitCode).toBe(0);
      expect(result.runtimeRunId).toMatch(/^r_/);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.ran).toBe(true);
      expect(parsed.sawInput).toEqual({ hello: "unitask" });
      expect(parsed.hasTrigger).toBe(false);
    },
    120_000,
  );

  it(
    "threads per-namespace secrets into the unikernel via process.env",
    async () => {
      // unitask redacts secret values from stdout, so never log the raw value —
      // assert via boolean compare so the run record stays clean.
      const code = `
        const secret = process.env.DEMO_SECRET;
        console.log(JSON.stringify({
          secretMatches: secret === "s3cret-val",
          secretLength: secret ? secret.length : 0,
          leakedCueHome: process.env.CUE_HOME ?? null,
          leakedPath: Boolean(process.env.PATH && process.env.PATH.length > 0),
        }));
      `;
      const result = await rt.run({
        code,
        policy: { timeoutSeconds: 60, memoryMb: 256, secrets: ["DEMO_SECRET"] },
        stdin: JSON.stringify({ trigger: null, input: null }),
        timeoutMs: 90_000,
        secrets: { DEMO_SECRET: "s3cret-val" },
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.secretMatches).toBe(true);
      expect(parsed.secretLength).toBe("s3cret-val".length);
      // The daemon's env should not leak in. CUE_HOME is commonly set on the
      // host but is not on the subprocess allowlist — guest must not see it.
      expect(parsed.leakedCueHome).toBeNull();
    },
    120_000,
  );
});
