import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlobStore } from "../index.js";

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

async function writeAtomic(path: string, body: string | Buffer): Promise<void> {
  const tmp = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, body);
  await rename(tmp, path);
}

/**
 * Local-filesystem blob store. Stores blobs under `<home>/blobs/<key>`,
 * with key segments mapped to directories. Atomic writes via rename;
 * idempotent delete; recursive prefix-delete.
 */
export function fsBlobStore(home: string): BlobStore {
  const root = join(home, "blobs");
  const pathFor = (key: string) => join(root, key);

  return {
    name: "fs",

    async doctor() {
      const probe = join(root, ".doctor.probe");
      try {
        await mkdir(root, { recursive: true });
        await writeFile(probe, "ok");
        await rm(probe);
        const st = await stat(root);
        return {
          ok: st.isDirectory(),
          details: { path: root, isDirectory: st.isDirectory() },
        };
      } catch (err) {
        return {
          ok: false,
          details: { path: root, error: String(err) },
        };
      }
    },

    async put(key, body) {
      await writeAtomic(pathFor(key), body);
    },

    async get(key) {
      try {
        return await readFile(pathFor(key), "utf8");
      } catch (err) {
        if (isENOENT(err)) return null;
        throw err;
      }
    },

    async delete(key) {
      try {
        await rm(pathFor(key));
      } catch (err) {
        if (isENOENT(err)) return;
        throw err;
      }
    },

    async deleteByPrefix(prefix) {
      const path = pathFor(prefix);
      try {
        // Count files first so we can return a real number; rm -rf
        // does not surface this directly.
        const count = await countFiles(path);
        await rm(path, { recursive: true, force: true });
        return count;
      } catch (err) {
        if (isENOENT(err)) return 0;
        throw err;
      }
    },

    async close() {
      // no-op for fs adapter
    },
  };
}

async function countFiles(path: string): Promise<number> {
  // Lazy require to avoid pulling readdirSync into the hot path.
  const { readdir } = await import("node:fs/promises");
  let total = 0;
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (err) {
    if (isENOENT(err)) return 0;
    throw err;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await countFiles(child);
    else total += 1;
  }
  return total;
}
