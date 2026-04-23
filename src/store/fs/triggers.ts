import { watch, mkdirSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type CronConfig,
  StoreError,
  type TriggerRecord,
  type TriggerStore,
  type TriggerSubscription,
  newTriggerId,
  newWebhookToken,
  validateNamespace,
} from "../index.js";
import { isENOENT, writeJsonAtomic } from "./util.js";

export function fsTriggers(home: string): TriggerStore {
  const triggersDir = join(home, "triggers");

  const dirFor = (id: string) => join(triggersDir, id);
  const metaFor = (id: string) => join(dirFor(id), "meta.json");

  async function readMeta(id: string): Promise<TriggerRecord | null> {
    try {
      const raw = await readFile(metaFor(id), "utf8");
      return JSON.parse(raw) as TriggerRecord;
    } catch (err) {
      if (isENOENT(err)) return null;
      throw err;
    }
  }

  return {
    async create(input) {
      validateNamespace(input.namespace);
      if (input.type !== "cron" && input.type !== "webhook") {
        throw new StoreError(
          "ValidationError",
          `Unknown trigger type "${input.type}"`,
          { type: input.type },
        );
      }
      let config: TriggerRecord["config"];
      if (input.type === "cron") {
        const c = input.config as CronConfig;
        if (!c || !c.schedule) {
          throw new StoreError(
            "ValidationError",
            "cron trigger requires schedule",
          );
        }
        config = {
          type: "cron",
          schedule: c.schedule,
          ...(c.timezone ? { timezone: c.timezone } : {}),
        };
      } else {
        config = { type: "webhook", token: newWebhookToken() };
      }
      const id = newTriggerId();
      const now = new Date().toISOString();
      const record: TriggerRecord = {
        id,
        type: input.type,
        actionId: input.actionId,
        namespace: input.namespace,
        createdAt: now,
        config,
      };
      await mkdir(dirFor(id), { recursive: true });
      await writeJsonAtomic(metaFor(id), record);
      return record;
    },

    async get(id) {
      return readMeta(id);
    },

    async list(filter) {
      let entries: string[];
      try {
        entries = await readdir(triggersDir);
      } catch (err) {
        if (isENOENT(err)) return [];
        throw err;
      }
      const results: TriggerRecord[] = [];
      for (const entry of entries) {
        if (!entry.startsWith("trg_")) continue;
        const meta = await readMeta(entry);
        if (!meta) continue;
        if (filter?.namespace && meta.namespace !== filter.namespace) continue;
        if (filter?.actionId && meta.actionId !== filter.actionId) continue;
        results.push(meta);
      }
      return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async delete(id) {
      try {
        await rm(dirFor(id), { recursive: true, force: false });
      } catch (err) {
        if (isENOENT(err)) {
          throw new StoreError("NotFound", `Trigger ${id} not found`, { id });
        }
        throw err;
      }
    },

    subscribe(onChange): TriggerSubscription {
      // The directory must exist before fs.watch can attach. Create
      // it synchronously — no-op if it's already there.
      mkdirSync(triggersDir, { recursive: true });
      // fs.watch fires on any create/delete inside the directory.
      // Platform quirks (macOS fsevents coalescing, inotify under
      // load, Windows atomic renames) mean we don't trust the event
      // payload — we just use the event as a signal to poke the
      // subscriber, which must re-list to learn the actual state.
      const watcher = watch(triggersDir, { persistent: false }, () => {
        // Swallow subscriber errors; the store must not crash the
        // daemon because a caller's callback threw.
        try {
          onChange();
        } catch {
          /* ignore */
        }
      });
      watcher.on("error", () => {
        /* watcher errors (rare) shouldn't kill the daemon */
      });
      return {
        close() {
          watcher.close();
        },
      };
    },
  };
}
