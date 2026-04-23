import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StateAdapter } from "../index.js";
import { fsLog } from "./log.js";
import { fsNamespaceTokens } from "./tokens.js";

export function fsStateAdapter(home: string): StateAdapter {
  const stateDir = join(home, "state");
  return {
    name: "fs",
    log: fsLog(home),
    tokens: fsNamespaceTokens(home),

    async doctor() {
      const probe = join(stateDir, ".doctor.probe");
      try {
        await mkdir(stateDir, { recursive: true });
        await writeFile(probe, "ok");
        await rm(probe);
        const st = await stat(stateDir);
        return {
          ok: st.isDirectory(),
          details: { path: stateDir, isDirectory: st.isDirectory() },
        };
      } catch (err) {
        return {
          ok: false,
          details: { path: stateDir, error: String(err) },
        };
      }
    },

    async close() {
      // no-op for fs adapter
    },
  };
}
