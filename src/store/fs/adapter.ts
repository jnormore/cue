import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoreAdapter } from "../index.js";
import { fsActions } from "./actions.js";
import { fsAgentTokens } from "./agent-tokens.js";
import { fsRuns } from "./runs.js";
import { fsSecrets } from "./secrets.js";
import { fsTriggers } from "./triggers.js";

export function fsAdapter(home: string): StoreAdapter {
  return {
    name: "fs",
    actions: fsActions(home),
    triggers: fsTriggers(home),
    runs: fsRuns(home),
    secrets: fsSecrets(home),
    agentTokens: fsAgentTokens(home),

    async doctor() {
      const probe = join(home, ".doctor.probe");
      try {
        await mkdir(home, { recursive: true });
        await writeFile(probe, "ok");
        await rm(probe);
        const st = await stat(home);
        return {
          ok: st.isDirectory(),
          details: { path: home, isDirectory: st.isDirectory() },
        };
      } catch (err) {
        return {
          ok: false,
          details: { path: home, error: String(err) },
        };
      }
    },

    async close() {
      // no-op for fs adapter
    },
  };
}
