import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  StoreError,
  type StoreAdapter,
  type TriggerStore,
  pickStore,
} from "../../../src/store/index.js";

describe("sqlite triggers store", () => {
  let home: string;
  let store: StoreAdapter;
  let triggers: TriggerStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-triggers-"));
    store = pickStore("sqlite", { home });
    triggers = store.triggers;
  });

  afterEach(async () => {
    await store.close();
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

  describe("subscribe", () => {
    it("fires on create and delete", async () => {
      let count = 0;
      const sub = triggers.subscribe(() => {
        count += 1;
      });
      const t = await triggers.create({
        type: "webhook",
        actionId: "act_abc",
        namespace: "default",
        config: {},
      });
      await triggers.delete(t.id);
      sub.close();
      expect(count).toBe(2);
    });

    it("close unsubscribes", async () => {
      let count = 0;
      const sub = triggers.subscribe(() => {
        count += 1;
      });
      sub.close();
      await triggers.create({
        type: "webhook",
        actionId: "act_abc",
        namespace: "default",
        config: {},
      });
      expect(count).toBe(0);
    });
  });

  describe("claimFire", () => {
    it("returns true when the trigger exists", async () => {
      const t = await triggers.create({
        type: "cron",
        actionId: "act_abc",
        namespace: "default",
        config: { schedule: "* * * * *" },
      });
      expect(await triggers.claimFire(t.id, 5000)).toBe(true);
    });

    it("returns false when the trigger does not exist", async () => {
      expect(await triggers.claimFire("trg_ZZZ", 5000)).toBe(false);
    });
  });
});
