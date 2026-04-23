import { describe, expect, it } from "vitest";
import type { CronScheduler } from "../../../src/cron/index.js";
import { pickCron } from "../../../src/cron/index.js";

describe("pickCron", () => {
  it("returns the node-cron adapter for 'node-cron'", () => {
    const s = pickCron("node-cron");
    expect(s.name).toBe("node-cron");
    expect(typeof s.schedule).toBe("function");
    expect(typeof s.doctor).toBe("function");
    expect(typeof s.close).toBe("function");
  });

  it("throws on unknown name", () => {
    expect(() => pickCron("bogus")).toThrow(/Unknown cron/);
  });
});

describe("CronScheduler interface (mock adapter conformance)", () => {
  const mock: CronScheduler = {
    name: "mock",
    async doctor() {
      return { ok: true, details: { mock: true } };
    },
    async schedule(_args) {
      return {
        async cancel() {
          /* no-op */
        },
      };
    },
    async close() {
      /* no-op */
    },
  };

  it("schedule returns a handle with cancel()", async () => {
    const h = await mock.schedule({
      triggerId: "trg_X",
      expression: "* * * * *",
      handler: async () => {
        /* no-op */
      },
    });
    expect(typeof h.cancel).toBe("function");
    await h.cancel();
  });
});
