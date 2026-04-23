import { describe, expect, it, vi } from "vitest";
import type { NodeCronImpl } from "../../../src/cron/node-cron.js";
import { nodeCronScheduler } from "../../../src/cron/node-cron.js";

function fakeImpl(override: Partial<NodeCronImpl> = {}): NodeCronImpl {
  return {
    validate: vi.fn().mockReturnValue(true),
    schedule: vi.fn().mockReturnValue({ stop: vi.fn() }),
    ...override,
  };
}

describe("nodeCronScheduler.doctor", () => {
  it("ok:true when validate returns true", async () => {
    const impl = fakeImpl();
    const r = await nodeCronScheduler({ impl }).doctor();
    expect(r.ok).toBe(true);
    expect(impl.validate).toHaveBeenCalledWith("* * * * *");
  });

  it("ok:false when validate returns false", async () => {
    const impl = fakeImpl({ validate: vi.fn().mockReturnValue(false) });
    const r = await nodeCronScheduler({ impl }).doctor();
    expect(r.ok).toBe(false);
  });

  it("ok:false when validate throws", async () => {
    const impl = fakeImpl({
      validate: vi.fn().mockImplementation(() => {
        throw new Error("broken");
      }),
    });
    const r = await nodeCronScheduler({ impl }).doctor();
    expect(r.ok).toBe(false);
    expect(r.details.error).toContain("broken");
  });
});

describe("nodeCronScheduler.schedule", () => {
  it("rejects invalid cron expression without calling schedule", async () => {
    const impl = fakeImpl({ validate: vi.fn().mockReturnValue(false) });
    const s = nodeCronScheduler({ impl });
    await expect(
      s.schedule({
        triggerId: "trg_X",
        expression: "not-valid",
        handler: async () => {
          /* no-op */
        },
      }),
    ).rejects.toThrow(/Invalid cron/);
    expect(impl.schedule).not.toHaveBeenCalled();
  });

  it("calls node-cron.schedule with timezone when provided", async () => {
    const impl = fakeImpl();
    const s = nodeCronScheduler({ impl });
    await s.schedule({
      triggerId: "trg_X",
      expression: "0 9 * * *",
      timezone: "America/Toronto",
      handler: async () => {
        /* no-op */
      },
    });
    expect(impl.schedule).toHaveBeenCalledWith(
      "0 9 * * *",
      expect.any(Function),
      { timezone: "America/Toronto" },
    );
  });

  it("omits options when no timezone", async () => {
    const impl = fakeImpl();
    const s = nodeCronScheduler({ impl });
    await s.schedule({
      triggerId: "trg_X",
      expression: "* * * * *",
      handler: async () => {
        /* no-op */
      },
    });
    expect(impl.schedule).toHaveBeenCalledWith(
      "* * * * *",
      expect.any(Function),
      undefined,
    );
  });

  it("invokes the handler when the cron fn fires", async () => {
    let firedFn: (() => void) | null = null;
    const impl = fakeImpl({
      schedule: vi.fn().mockImplementation((_expr, fn) => {
        firedFn = fn;
        return { stop: vi.fn() };
      }),
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    const s = nodeCronScheduler({ impl });
    await s.schedule({
      triggerId: "trg_X",
      expression: "* * * * *",
      handler,
    });
    expect(firedFn).not.toBeNull();
    (firedFn as unknown as () => void)();
    await Promise.resolve();
    expect(handler).toHaveBeenCalled();
  });

  it("cancel calls task.stop", async () => {
    const stop = vi.fn();
    const impl = fakeImpl({
      schedule: vi.fn().mockReturnValue({ stop }),
    });
    const s = nodeCronScheduler({ impl });
    const h = await s.schedule({
      triggerId: "trg_X",
      expression: "* * * * *",
      handler: async () => {
        /* no-op */
      },
    });
    await h.cancel();
    expect(stop).toHaveBeenCalled();
  });
});
