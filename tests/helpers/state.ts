import { pickState, type StateAdapter } from "../../src/state/index.js";
import { pickStore } from "../../src/store/index.js";

/**
 * Returns a sqlite-backed state adapter rooted at the given home. The
 * sqlite state adapter assumes the schema already exists, so this
 * helper opens (and immediately closes) a store first to trigger
 * migrations. Tests that already opened a store can skip this helper
 * and call `pickState("sqlite", { home })` directly.
 */
export function makeTestState(home: string): StateAdapter {
  // Touch the store to ensure migrations have run.
  const store = pickStore("sqlite", { home });
  void store.close();
  return pickState("sqlite", { home });
}
