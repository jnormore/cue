import { type StoreAdapter, StoreError } from "../store/index.js";

/**
 * Throws if the namespace is `paused` or `archived`. Used at every
 * invocation entry point (cron fire, webhook handler, MCP invoke) to
 * gate action execution by lifecycle status.
 *
 * Pre-bootstrap quirk: if the namespace has resources but no metadata
 * row yet, we treat it as `active` rather than blocking. The bootstrap
 * pass at daemon start populates these rows, so this only matters for
 * a brief window during upgrade — and even then, the conservative
 * choice is "let it run" rather than "block everything."
 */
export async function assertNamespaceActive(
  store: StoreAdapter,
  namespace: string,
): Promise<void> {
  const ns = await store.namespaces.get(namespace);
  if (!ns) return;
  if (ns.status === "paused") {
    throw new StoreError(
      "NamespacePaused",
      `Namespace "${namespace}" is paused`,
      { namespace },
    );
  }
  if (ns.status === "archived") {
    throw new StoreError(
      "NamespaceArchived",
      `Namespace "${namespace}" is archived`,
      { namespace },
    );
  }
}

/**
 * Throws if the namespace is `archived`. Used at every mutation entry
 * point (create/update of actions, triggers, secrets, state appends).
 * Paused namespaces still accept mutations — pause only stops
 * invocations. Deletes are NOT gated (you must be able to tear down
 * an archived namespace).
 */
export async function assertNamespaceMutable(
  store: StoreAdapter,
  namespace: string,
): Promise<void> {
  const ns = await store.namespaces.get(namespace);
  if (!ns) return;
  if (ns.status === "archived") {
    throw new StoreError(
      "NamespaceArchived",
      `Namespace "${namespace}" is archived; create/update operations are blocked`,
      { namespace },
    );
  }
}
