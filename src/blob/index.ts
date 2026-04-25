import { fsBlobStore } from "./fs/adapter.js";

/**
 * Pluggable blob storage. Holds large content that doesn't belong in
 * the relational store: run stdout/stderr, structured input/output
 * envelopes, and any other agent-produced bytes that grow without
 * bound.
 *
 * Keys are hierarchical strings, e.g. `runs/<id>/stdout`. Implementations
 * may interpret slashes as directories (fs adapter) or as opaque
 * string keys (S3 adapter); callers should not depend on either.
 */
export interface BlobStore {
  name: string;
  doctor(): Promise<{ ok: boolean; details: Record<string, unknown> }>;
  /** Idempotent: overwrites if the key already exists. */
  put(key: string, body: string | Buffer): Promise<void>;
  /** Returns the bytes as a string (utf8). null if not found. */
  get(key: string): Promise<string | null>;
  /** Idempotent: succeeds whether the key exists or not. */
  delete(key: string): Promise<void>;
  /** Removes all keys with the given prefix. Returns the count removed. */
  deleteByPrefix(prefix: string): Promise<number>;
  close(): Promise<void>;
}

export interface BlobPickOpts {
  home: string;
}

export function pickBlob(name: string, opts: BlobPickOpts): BlobStore {
  switch (name) {
    case "fs":
      return fsBlobStore(opts.home);
    default:
      throw new Error(`Unknown blob adapter: "${name}". Known adapters: fs`);
  }
}
