import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreError, type TriggerStore } from "../../../src/store/index.js";
import { fsTriggers } from "../../../src/store/fs/triggers.js";

describe("fsTriggers", () => {
  let home: string;
  let triggers: TriggerStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-triggers-"));
    triggers = fsTriggers(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates a cron trigger", async () => {
      const rec = await triggers.create({
        type: "cron",
        actionId: "act_abc",
        namespace: "weather",
        config: { schedule: "0 9 * * *", timezone: "UTC" },
      });
      expect(rec.id).toMatch(/^trg_[0-9A-Z]{26}$/);
      expect(rec.type).toBe("cron");
      expect(rec.namespace).toBe("weather");
      expect(rec.config).toEqual({
        type: "cron",
        schedule: "0 9 * * *",
        timezone: "UTC",
      });
    });

    it("creates a webhook trigger with a generated token", async () => {
      const rec = await triggers.create({
        type: "webhook",
        actionId: "act_abc",
        namespace: "default",
        config: {},
      });
      expect(rec.type).toBe("webhook");
      expect(rec.config.type).toBe("webhook");
      if (rec.config.type === "webhook") {
        expect(rec.config.token).toMatch(/^tok_[0-9a-f]{64}$/);
      }
    });

    it("rejects unknown type", async () => {
      await expect(
        triggers.create({
          // biome-ignore lint: intentional invalid type
          type: "bogus" as "cron",
          actionId: "act_abc",
          namespace: "default",
          config: { schedule: "* * * * *" },
        }),
      ).rejects.toBeInstanceOf(StoreError);
    });

    it("rejects cron without schedule", async () => {
      await expect(
        triggers.create({
          type: "cron",
          actionId: "act_abc",
          namespace: "default",
          config: {} as never,
        }),
      ).rejects.toMatchObject({ kind: "ValidationError" });
    });

    it("rejects invalid namespace", async () => {
      await expect(
        triggers.create({
          type: "webhook",
          actionId: "act_abc",
          namespace: "Bad NS",
          config: {},
        }),
      ).rejects.toMatchObject({ kind: "ValidationError" });
    });
  });

  describe("get / list / delete", () => {
    it("get returns null for unknown id", async () => {
      expect(await triggers.get("trg_ZZZ")).toBeNull();
    });

    it("list filters by namespace and actionId", async () => {
      const a = await triggers.create({
        type: "cron",
        actionId: "act_A",
        namespace: "one",
        config: { schedule: "* * * * *" },
      });
      await triggers.create({
        type: "cron",
        actionId: "act_B",
        namespace: "one",
        config: { schedule: "* * * * *" },
      });
      await triggers.create({
        type: "webhook",
        actionId: "act_A",
        namespace: "two",
        config: {},
      });
      expect((await triggers.list({ namespace: "one" })).length).toBe(2);
      expect((await triggers.list({ actionId: "act_A" })).length).toBe(2);
      expect(
        (await triggers.list({ namespace: "one", actionId: "act_A" })).length,
      ).toBe(1);
      expect((await triggers.list({ actionId: "act_A" }))[0]?.id).toBe(a.id);
    });

    it("delete removes the trigger", async () => {
      const t = await triggers.create({
        type: "webhook",
        actionId: "act_abc",
        namespace: "default",
        config: {},
      });
      await triggers.delete(t.id);
      expect(await triggers.get(t.id)).toBeNull();
    });

    it("delete of unknown id fails with NotFound", async () => {
      await expect(triggers.delete("trg_ZZZ")).rejects.toMatchObject({
        kind: "NotFound",
      });
    });
  });
});
