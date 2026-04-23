import { pickState, type StateAdapter } from "../../src/state/index.js";

/**
 * Returns an fs-backed state adapter rooted at the given home. Test
 * convenience: every invoke/server test needs a StateAdapter in its
 * deps, and the fs adapter is cheap (it writes under `<home>/state/`).
 */
export function makeTestState(home: string): StateAdapter {
  return pickState("fs", { home });
}
