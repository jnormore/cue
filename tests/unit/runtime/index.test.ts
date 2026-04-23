import { describe, expect, it } from "vitest";
import type { ActionRuntime } from "../../../src/runtime/index.js";
import { pickRuntime } from "../../../src/runtime/index.js";

describe("pickRuntime", () => {
  it("returns the unitask adapter for 'unitask'", () => {
    const rt = pickRuntime("unitask");
    expect(rt.name).toBe("unitask");
    expect(typeof rt.doctor).toBe("function");
    expect(typeof rt.run).toBe("function");
  });

  it("throws on unknown adapter name", () => {
    expect(() => pickRuntime("bogus")).toThrow(/Unknown runtime/);
  });
});

describe("ActionRuntime interface (mock adapter conformance)", () => {
  const mock: ActionRuntime = {
    name: "mock",
    async doctor() {
      return { ok: true, details: { mock: true } };
    },
    async run(args) {
      return {
        stdout: `echoed: ${args.stdin}`,
        stderr: "",
        exitCode: 0,
        runtimeRunId: "mock_01",
      };
    },
  };

  it("doctor returns shape { ok, details }", async () => {
    const r = await mock.doctor();
    expect(r.ok).toBe(true);
    expect(r.details).toEqual({ mock: true });
  });

  it("run returns shape { stdout, stderr, exitCode, runtimeRunId }", async () => {
    const r = await mock.run({
      code: "console.log(1)",
      policy: {},
      stdin: "hello",
      timeoutMs: 1000,
      secrets: {},
    });
    expect(r).toEqual({
      stdout: "echoed: hello",
      stderr: "",
      exitCode: 0,
      runtimeRunId: "mock_01",
    });
  });
});
