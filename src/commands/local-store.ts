import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, cuePaths } from "../config.js";
import { StoreError, pickStore, type StoreAdapter } from "../store/index.js";

/**
 * Resolve the cue home the same way the daemon does: --home / $CUE_HOME
 * / ~/.cue (in order). Kept as a single helper so CLI commands and the
 * HTTP endpoint helper in admin-client.ts agree on which files they're
 * reading.
 */
export function resolveHome(): string {
  return process.env.CUE_HOME ?? join(homedir(), ".cue");
}

/**
 * Open the fs store adapter directly for CLI commands that mutate
 * on-disk state: agent tokens, action/trigger/secret records, run
 * history reads. The daemon fs-watches its trigger directory, so cron
 * schedules reconcile automatically when the CLI writes or deletes a
 * trigger file — no RPC needed.
 *
 * The one thing this does NOT cover is **action invocation**. That
 * requires the daemon to spawn a unikernel and record the run, and
 * goes through /a/:id instead (see `admin-client.ts`).
 */
export function openLocalStore(): StoreAdapter {
  const home = resolveHome();
  return pickStore("fs", { home });
}

/**
 * Best-effort daemon base URL. Reads `<home>/port` (written by `cue
 * serve`), falls back to the default port. Used by CLI output to
 * include `invokeUrl` / `webhookUrl` hints alongside action and
 * trigger records.
 */
export function localBaseUrl(): string {
  const home = resolveHome();
  const paths = cuePaths(home);
  let port = DEFAULT_PORT;
  try {
    const raw = readFileSync(paths.port, "utf8").trim();
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) port = n;
  } catch {
    /* leave as default */
  }
  return `http://127.0.0.1:${port}`;
}

/**
 * Invoke a thunk against the local store and translate StoreErrors
 * into CLI-friendly exits. Returns the thunk's result on success.
 */
export async function runLocalStoreCmd<T>(
  fn: (store: StoreAdapter) => Promise<T>,
): Promise<T> {
  const store = openLocalStore();
  try {
    return await fn(store);
  } catch (err) {
    if (err instanceof StoreError) {
      process.stderr.write(
        `cue: ${err.kind}: ${err.message}${err.details ? ` ${JSON.stringify(err.details)}` : ""}\n`,
      );
      process.exit(1);
    }
    throw err;
  } finally {
    await store.close();
  }
}
