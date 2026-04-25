import { randomBytes } from "node:crypto";
import {
  NAMESPACE_MAX,
  StoreError,
  validateNamespace,
} from "../store/index.js";
import { sqliteStateAdapter } from "./sql/sqlite/adapter.js";

export const KEY_MAX = 128;
const KEY_RE = /^[a-z0-9-]+$/;

const TOKEN_PREFIX = "stk_";
const TOKEN_RANDOM_BYTES = 32;

/**
 * Maximum size (bytes, JSON-serialized) for a single state log entry.
 * Larger payloads bloat the row store; callers should put bytes in the
 * blob store and keep a reference in the entry.
 */
export const ENTRY_MAX_BYTES = 64 * 1024;

export function validateKey(key: string): void {
  if (!key || key.length > KEY_MAX || !KEY_RE.test(key)) {
    throw new StoreError(
      "ValidationError",
      `Invalid state key "${key}" (must match ${KEY_RE} and be ≤${KEY_MAX} chars)`,
      { key },
    );
  }
}

/**
 * Throws ValidationError if the JSON-serialized entry exceeds
 * ENTRY_MAX_BYTES. Returns the serialized string so the caller can
 * reuse it for the actual write — avoids serializing twice.
 */
export function validateEntrySize(entry: unknown): string {
  const serialized = JSON.stringify(entry);
  // Byte length, not character length — multibyte characters count for more.
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > ENTRY_MAX_BYTES) {
    throw new StoreError(
      "ValidationError",
      `State log entry is ${bytes} bytes, exceeds ${ENTRY_MAX_BYTES} byte cap`,
      { bytes, maxBytes: ENTRY_MAX_BYTES },
    );
  }
  return serialized;
}

export interface LogEntry {
  seq: number;
  at: string;
  entry: unknown;
}

export interface LogAppendResult {
  seq: number;
  at: string;
}

export interface LogReadResult {
  entries: LogEntry[];
  lastSeq: number;
}

export interface LogReadOpts {
  /** Return entries with seq > since. Defaults to 0 (all). */
  since?: number;
  /** Cap on entries returned. Defaults to 1000. */
  limit?: number;
}

/**
 * Append-only log keyed by (namespace, key). Single writer per (ns, key)
 * within a daemon; the fs adapter uses an in-process mutex. seq is
 * monotonic-per-key and starts at 1.
 */
export interface LogStore {
  append(
    namespace: string,
    key: string,
    entry: unknown,
  ): Promise<LogAppendResult>;
  read(
    namespace: string,
    key: string,
    opts?: LogReadOpts,
  ): Promise<LogReadResult>;
  list(namespace: string): Promise<string[]>;
  delete(namespace: string, key: string): Promise<void>;
  deleteNamespace(namespace: string): Promise<void>;
}

/**
 * Per-namespace static state token. Lazily materialized — the first time
 * an action in namespace `ns` is invoked with `policy.state: true`, the
 * daemon calls `resolveOrCreate(ns)` which returns an existing token or
 * mints a new one.
 *
 * Tokens have the shape `stk_<namespace>.<hex>`. The namespace is encoded
 * in the token so the HTTP layer can route an incoming request without a
 * reverse index.
 */
export interface NamespaceTokenStore {
  resolveOrCreate(namespace: string): Promise<string>;
  /**
   * Returns the namespace the token is bound to if the token is valid,
   * else null. Must be constant-time against the stored value to avoid
   * token-comparison timing leaks.
   */
  verify(token: string): Promise<string | null>;
  deleteNamespace(namespace: string): Promise<void>;
}

export interface StateAdapter {
  name: string;
  doctor(): Promise<{ ok: boolean; details: Record<string, unknown> }>;
  log: LogStore;
  tokens: NamespaceTokenStore;
  close(): Promise<void>;
}

export interface StatePickOpts {
  home: string;
}

export function pickState(name: string, opts: StatePickOpts): StateAdapter {
  switch (name) {
    case "sqlite":
      return sqliteStateAdapter(opts.home);
    default:
      throw new Error(
        `Unknown state adapter: "${name}". Known adapters: sqlite`,
      );
  }
}

/**
 * Parse a state token of shape `stk_<namespace>.<hex>`. Returns the
 * namespace on success, null on malformed input. Does not verify the
 * token — callers must follow up with `tokens.verify()`.
 */
export function parseTokenNamespace(token: string): string | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const body = token.slice(TOKEN_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot === body.length - 1) return null;
  const ns = body.slice(0, dot);
  // Defer full validation to the store; a cheap regex check keeps bad
  // input out of the filesystem layer.
  if (ns.length === 0 || ns.length > NAMESPACE_MAX) return null;
  try {
    validateNamespace(ns);
  } catch {
    return null;
  }
  return ns;
}

export function mintToken(namespace: string): string {
  validateNamespace(namespace);
  const rand = randomBytes(TOKEN_RANDOM_BYTES).toString("hex");
  return `${TOKEN_PREFIX}${namespace}.${rand}`;
}
