import type { StoreAdapter } from "../store/index.js";

/**
 * Walk every namespace referenced by an action or trigger and ensure
 * a metadata row exists for it. Idempotent — safe to run on every
 * daemon start. Cheap: O(actions + triggers + distinct namespaces).
 *
 * This exists so namespaces created before lifecycle support land in
 * a known state (`active`) without operator intervention. New
 * namespaces should be created via the admin API directly, but the
 * bootstrap is a guardrail against missing rows after upgrades or
 * out-of-band edits.
 */
export async function bootstrapNamespaces(store: StoreAdapter): Promise<void> {
  const seen = new Set<string>();
  for (const a of await store.actions.list()) seen.add(a.namespace);
  for (const t of await store.triggers.list()) seen.add(t.namespace);
  const now = new Date().toISOString();
  for (const name of seen) {
    const existing = await store.namespaces.get(name);
    if (existing) continue;
    await store.namespaces.upsert({
      name,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  }
}
