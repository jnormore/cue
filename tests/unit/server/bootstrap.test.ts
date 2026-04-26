import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapNamespaces } from "../../../src/server/bootstrap.js";
import { pickStore, type StoreAdapter } from "../../../src/store/index.js";

describe("bootstrapNamespaces", () => {
  let home: string;
  let store: StoreAdapter;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-bootstrap-"));
    store = pickStore("sqlite", { home });
  });

  afterEach(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("creates a metadata row for any namespace referenced by an action", async () => {
    await store.actions.create({
      name: "a",
      code: "x",
      namespace: "shop",
    });
    expect(await store.namespaces.get("shop")).toBeNull();
    await bootstrapNamespaces(store);
    const ns = await store.namespaces.get("shop");
    expect(ns?.name).toBe("shop");
    expect(ns?.status).toBe("active");
  });

  it("creates a row for each distinct namespace across actions and triggers", async () => {
    const a = await store.actions.create({
      name: "a",
      code: "x",
      namespace: "ns1",
    });
    await store.triggers.create({
      type: "webhook",
      actionId: a.id,
      namespace: "ns2",
      config: {},
    });
    await bootstrapNamespaces(store);
    const all = await store.namespaces.list();
    expect(all.map((n) => n.name).sort()).toEqual(["ns1", "ns2"]);
  });

  it("is idempotent — running twice produces the same state", async () => {
    await store.actions.create({
      name: "a",
      code: "x",
      namespace: "shop",
    });
    await bootstrapNamespaces(store);
    const first = await store.namespaces.get("shop");
    await bootstrapNamespaces(store);
    const second = await store.namespaces.get("shop");
    expect(second).toEqual(first);
  });

  it("does not overwrite an existing record's status or metadata", async () => {
    const now = new Date().toISOString();
    await store.namespaces.upsert({
      name: "shop",
      displayName: "Hand-curated",
      status: "paused",
      createdAt: now,
      updatedAt: now,
    });
    await store.actions.create({
      name: "a",
      code: "x",
      namespace: "shop",
    });
    await bootstrapNamespaces(store);
    const ns = await store.namespaces.get("shop");
    expect(ns?.status).toBe("paused");
    expect(ns?.displayName).toBe("Hand-curated");
  });
});
