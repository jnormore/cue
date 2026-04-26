import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type NamespaceStore,
  pickStore,
  StoreError,
  type StoreAdapter,
} from "../../../src/store/index.js";

describe("sqlite namespaces store", () => {
  let home: string;
  let store: StoreAdapter;
  let namespaces: NamespaceStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-ns-store-"));
    store = pickStore("sqlite", { home });
    namespaces = store.namespaces;
  });

  afterEach(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("upsert creates a record; get returns it", async () => {
    const now = new Date().toISOString();
    await namespaces.upsert({
      name: "shop",
      displayName: "Shopify integration",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const fetched = await namespaces.get("shop");
    expect(fetched?.name).toBe("shop");
    expect(fetched?.status).toBe("active");
    expect(fetched?.displayName).toBe("Shopify integration");
  });

  it("get returns null for unknown name", async () => {
    expect(await namespaces.get("missing")).toBeNull();
  });

  it("upsert overwrites existing fields", async () => {
    const now = new Date().toISOString();
    await namespaces.upsert({
      name: "shop",
      displayName: "First",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await namespaces.upsert({
      name: "shop",
      displayName: "Second",
      status: "paused",
      createdAt: now,
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    });
    const fetched = await namespaces.get("shop");
    expect(fetched?.displayName).toBe("Second");
    expect(fetched?.status).toBe("paused");
  });

  it("update bumps updatedAt and patches selected fields", async () => {
    const now = new Date().toISOString();
    await namespaces.upsert({
      name: "shop",
      displayName: "Original",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await new Promise((r) => setTimeout(r, 5));
    const updated = await namespaces.update("shop", { status: "paused" });
    expect(updated.status).toBe("paused");
    expect(updated.displayName).toBe("Original");
    expect(updated.updatedAt).not.toBe(now);
  });

  it("update with displayName: null clears the field", async () => {
    const now = new Date().toISOString();
    await namespaces.upsert({
      name: "shop",
      displayName: "had one",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const updated = await namespaces.update("shop", { displayName: null });
    expect(updated.displayName).toBeUndefined();
  });

  it("update on missing name throws NotFound", async () => {
    await expect(
      namespaces.update("missing", { status: "paused" }),
    ).rejects.toBeInstanceOf(StoreError);
  });

  it("list returns all namespaces sorted by name", async () => {
    const now = new Date().toISOString();
    await namespaces.upsert({
      name: "weather",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await namespaces.upsert({
      name: "shop",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const list = await namespaces.list();
    expect(list.map((n) => n.name)).toEqual(["shop", "weather"]);
  });

  it("delete removes the record", async () => {
    const now = new Date().toISOString();
    await namespaces.upsert({
      name: "shop",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await namespaces.delete("shop");
    expect(await namespaces.get("shop")).toBeNull();
  });

  it("delete on missing name is a no-op", async () => {
    await expect(namespaces.delete("never")).resolves.toBeUndefined();
  });

  it("rejects invalid namespace names", async () => {
    const now = new Date().toISOString();
    await expect(
      namespaces.upsert({
        name: "Bad NS",
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toBeInstanceOf(StoreError);
  });
});
