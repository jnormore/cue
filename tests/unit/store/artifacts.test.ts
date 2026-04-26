import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ArtifactStore,
  pickStore,
  StoreError,
  type StoreAdapter,
  validateArtifactPath,
} from "../../../src/store/index.js";

describe("validateArtifactPath", () => {
  it("accepts simple paths", () => {
    expect(() => validateArtifactPath("index.html")).not.toThrow();
    expect(() => validateArtifactPath("js/app.js")).not.toThrow();
    expect(() => validateArtifactPath("a/b/c/d.css")).not.toThrow();
  });

  it("rejects empty / too-long / bad-character paths", () => {
    expect(() => validateArtifactPath("")).toThrow(StoreError);
    expect(() => validateArtifactPath("x".repeat(257))).toThrow(StoreError);
    expect(() => validateArtifactPath("hi there.html")).toThrow(StoreError);
    expect(() => validateArtifactPath("naïve.html")).toThrow(StoreError);
  });

  it("rejects traversal and odd separators", () => {
    expect(() => validateArtifactPath("../escape")).toThrow(StoreError);
    expect(() => validateArtifactPath("a/../b")).toThrow(StoreError);
    expect(() => validateArtifactPath("/abs")).toThrow(StoreError);
    expect(() => validateArtifactPath("trailing/")).toThrow(StoreError);
    expect(() => validateArtifactPath("double//slash")).toThrow(StoreError);
  });
});

describe("sqlite artifacts store", () => {
  let home: string;
  let store: StoreAdapter;
  let artifacts: ArtifactStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cue-art-"));
    store = pickStore("sqlite", { home });
    artifacts = store.artifacts;
  });

  afterEach(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates a public artifact with auto-detected MIME and no view token", async () => {
      const r = await artifacts.create({
        namespace: "demo",
        path: "index.html",
        content: "<h1>hi</h1>",
      });
      expect(r.namespace).toBe("demo");
      expect(r.path).toBe("index.html");
      expect(r.mimeType).toBe("text/html; charset=utf-8");
      expect(r.size).toBe(11);
      expect(r.public).toBe(true);
      expect(r.viewToken).toBe("");
    });

    it("non-public artifact mints a viewToken", async () => {
      const r = await artifacts.create({
        namespace: "demo",
        path: "secret.html",
        content: "<h1>private</h1>",
        public: false,
      });
      expect(r.public).toBe(false);
      expect(r.viewToken).toMatch(/^art_[0-9a-f]{48}$/);
    });

    it("explicit mimeType wins over auto-detect", async () => {
      const r = await artifacts.create({
        namespace: "demo",
        path: "weird.bin",
        content: "...",
        mimeType: "image/png",
      });
      expect(r.mimeType).toBe("image/png");
    });

    it("rejects size > ARTIFACT_MAX_BYTES", async () => {
      const huge = Buffer.alloc(11 * 1024 * 1024); // 11MB
      await expect(
        artifacts.create({ namespace: "demo", path: "big.bin", content: huge }),
      ).rejects.toMatchObject({ kind: "ValidationError" });
    });

    it("rejects collision on (namespace, path)", async () => {
      await artifacts.create({
        namespace: "demo",
        path: "a.html",
        content: "1",
      });
      await expect(
        artifacts.create({
          namespace: "demo",
          path: "a.html",
          content: "2",
        }),
      ).rejects.toMatchObject({ kind: "NameCollision" });
    });

    it("allows same path in different namespaces", async () => {
      await artifacts.create({
        namespace: "a",
        path: "shared.html",
        content: "A",
      });
      await artifacts.create({
        namespace: "b",
        path: "shared.html",
        content: "B",
      });
      expect((await artifacts.get("a", "shared.html"))?.size).toBe(1);
      expect((await artifacts.get("b", "shared.html"))?.size).toBe(1);
    });
  });

  describe("read", () => {
    it("returns the bytes back", async () => {
      await artifacts.create({
        namespace: "demo",
        path: "x.txt",
        content: "hello world",
      });
      expect(await artifacts.read("demo", "x.txt")).toBe("hello world");
    });

    it("returns null for unknown path", async () => {
      expect(await artifacts.read("demo", "missing.txt")).toBeNull();
    });
  });

  describe("update", () => {
    it("replaces content and bumps size", async () => {
      const r = await artifacts.create({
        namespace: "demo",
        path: "x.txt",
        content: "short",
      });
      const updated = await artifacts.update("demo", "x.txt", {
        content: "longer text",
      });
      expect(updated.size).toBe(11);
      expect(updated.updatedAt).not.toBe(r.updatedAt);
      expect(await artifacts.read("demo", "x.txt")).toBe("longer text");
    });

    it("public ↔ non-public toggles rotate the viewToken", async () => {
      const r = await artifacts.create({
        namespace: "demo",
        path: "a.html",
        content: "1",
      });
      expect(r.viewToken).toBe("");
      const non = await artifacts.update("demo", "a.html", { public: false });
      expect(non.viewToken).toMatch(/^art_/);
      const back = await artifacts.update("demo", "a.html", { public: true });
      expect(back.viewToken).toBe("");
      const non2 = await artifacts.update("demo", "a.html", { public: false });
      expect(non2.viewToken).not.toBe(non.viewToken);
    });

    it("re-detects MIME when content changes and mimeType is omitted", async () => {
      // A path whose extension implies HTML, created with explicit text/plain
      const r = await artifacts.create({
        namespace: "demo",
        path: "a.html",
        content: "raw",
        mimeType: "text/plain; charset=utf-8",
      });
      expect(r.mimeType).toBe("text/plain; charset=utf-8");
      const updated = await artifacts.update("demo", "a.html", {
        content: "<h1>now html</h1>",
      });
      // Re-detected from the .html extension.
      expect(updated.mimeType).toBe("text/html; charset=utf-8");
    });

    it("throws NotFound on unknown path", async () => {
      await expect(
        artifacts.update("demo", "missing.txt", { content: "x" }),
      ).rejects.toMatchObject({ kind: "NotFound" });
    });
  });

  describe("list", () => {
    it("returns summaries sorted by path", async () => {
      await artifacts.create({
        namespace: "demo",
        path: "z.html",
        content: "1",
      });
      await artifacts.create({
        namespace: "demo",
        path: "a.html",
        content: "1",
      });
      const list = await artifacts.list("demo");
      expect(list.map((a) => a.path)).toEqual(["a.html", "z.html"]);
    });

    it("returns [] for a namespace with no artifacts", async () => {
      expect(await artifacts.list("empty")).toEqual([]);
    });
  });

  describe("delete + cascade", () => {
    it("delete removes one artifact's bytes + row", async () => {
      await artifacts.create({
        namespace: "demo",
        path: "a.html",
        content: "1",
      });
      await artifacts.delete("demo", "a.html");
      expect(await artifacts.get("demo", "a.html")).toBeNull();
      expect(await artifacts.read("demo", "a.html")).toBeNull();
    });

    it("delete on unknown path throws NotFound", async () => {
      await expect(artifacts.delete("demo", "ghost")).rejects.toMatchObject({
        kind: "NotFound",
      });
    });

    it("deleteNamespace returns paths and wipes all of namespace's artifacts", async () => {
      await artifacts.create({
        namespace: "demo",
        path: "a.html",
        content: "1",
      });
      await artifacts.create({
        namespace: "demo",
        path: "js/app.js",
        content: "2",
      });
      await artifacts.create({
        namespace: "other",
        path: "a.html",
        content: "X",
      });
      const paths = await artifacts.deleteNamespace("demo");
      expect(paths.sort()).toEqual(["a.html", "js/app.js"].sort());
      expect(await artifacts.list("demo")).toEqual([]);
      // unrelated namespace untouched
      expect((await artifacts.list("other")).length).toBe(1);
    });
  });
});
