import type { CronRegistry } from "../cron/registry.js";
import type { CronScheduler } from "../cron/index.js";
import { type InvokeDeps, invokeAction } from "../invoke.js";
import type { LogAppendResult, LogReadResult } from "../state/index.js";
import { validateKey } from "../state/index.js";
import {
  type ActionRecord,
  type ActionSummary,
  type ArtifactRecord,
  type ArtifactSummary,
  type CronConfig,
  type NamespaceRecord,
  type NamespaceStatus,
  StoreError,
  type TriggerRecord,
  deleteAction as cascadeDeleteAction,
  deleteNamespace as cascadeDeleteNamespace,
  type Policy,
  type RunRecord,
  type RunSummary,
  type ConfigEntry,
  validateConfigName,
  validateNamespace,
  validateSecretName,
} from "../store/index.js";
import {
  namespaceAllowed,
  type Principal,
  requireNamespace,
} from "./auth.js";
import {
  assertNamespaceActive,
  assertNamespaceMutable,
} from "./namespace-status.js";

export interface McpToolDeps extends InvokeDeps {
  cronScheduler: CronScheduler;
  cronRegistry: CronRegistry;
  invokeUrlFor: (id: string) => string;
  webhookUrlFor: (id: string) => string;
  artifactUrlFor: (namespace: string, path: string) => string;
  cueVersion: string;
  /**
   * The authenticated caller for this MCP session. Master principals
   * bypass all scope checks; agent principals are restricted to the
   * namespaces in their scope.
   */
  principal: Principal;
}

// `namespaceAllowed` from auth.ts is the canonical check; we used to
// duplicate it here. Kept the alias-by-import to avoid a sweeping
// rename across the dozens of call sites in this file.
const namespaceInScope = namespaceAllowed;

export interface ActionRef {
  id: string;
  name: string;
  namespace: string;
  invokeUrl: string;
}

async function toActionRef(
  deps: McpToolDeps,
  action: ActionRecord,
): Promise<ActionRef> {
  return {
    id: action.id,
    name: action.name,
    namespace: action.namespace,
    invokeUrl: deps.invokeUrlFor(action.id),
  };
}

export async function createAction(
  deps: McpToolDeps,
  args: {
    name: string;
    code: string;
    namespace?: string;
    policy?: Policy;
  },
): Promise<ActionRef> {
  // Agents must always pick a namespace. There's no "default" — apps
  // are namespaces, and silently dropping work into a namespace the
  // caller didn't name is exactly the bug we're avoiding. If the
  // caller doesn't know what's available, `whoami` lists in-scope
  // namespaces; `create_namespace` allocates a new one.
  if (!args.namespace) {
    throw new StoreError(
      "ValidationError",
      "namespace is required. Call whoami to see available namespaces, or create_namespace to allocate a new one.",
      { hint: "namespace" },
    );
  }
  requireNamespace(deps.principal, args.namespace, "create action in");
  await assertNamespaceMutable(deps.store, args.namespace);
  const action = await deps.store.actions.create({
    name: args.name,
    code: args.code,
    namespace: args.namespace,
    ...(args.policy ? { policy: args.policy } : {}),
  });
  return toActionRef(deps, action);
}

export async function updateAction(
  deps: McpToolDeps,
  args: {
    id: string;
    patch: { name?: string; code?: string; policy?: Policy };
  },
): Promise<ActionRef> {
  const existing = await deps.store.actions.get(args.id);
  if (!existing || !namespaceInScope(deps.principal, existing.namespace)) {
    // Hide out-of-scope existence behind NotFound.
    throw new StoreError("NotFound", `Action ${args.id} not found`, {
      id: args.id,
    });
  }
  await assertNamespaceMutable(deps.store, existing.namespace);
  const updated = await deps.store.actions.update(args.id, args.patch);
  return toActionRef(deps, updated);
}

export async function deleteActionTool(
  deps: McpToolDeps,
  args: { id: string },
): Promise<{ deleted: string; alsoDeleted: string[] }> {
  const existing = await deps.store.actions.get(args.id);
  if (!existing || !namespaceInScope(deps.principal, existing.namespace)) {
    throw new StoreError("NotFound", `Action ${args.id} not found`, {
      id: args.id,
    });
  }
  const result = await cascadeDeleteAction(deps.store, args.id);
  for (const tid of result.triggers) {
    await deps.cronRegistry.remove(tid);
  }
  return { deleted: result.action, alsoDeleted: result.triggers };
}

export async function invokeActionTool(
  deps: McpToolDeps,
  args: { id: string; input?: unknown },
) {
  const action = await deps.store.actions.get(args.id);
  if (!action || !namespaceInScope(deps.principal, action.namespace)) {
    throw new StoreError("NotFound", `Action ${args.id} not found`, {
      id: args.id,
    });
  }
  // Surfaces NamespacePaused / NamespaceArchived to the MCP client so
  // the agent can see why their invoke failed and offer to resume.
  await assertNamespaceActive(deps.store, action.namespace);
  return invokeAction(deps, action, {
    trigger: null,
    input: args.input ?? null,
  });
}

export async function getAction(
  deps: McpToolDeps,
  args: { id: string },
): Promise<ActionRecord> {
  const action = await deps.store.actions.get(args.id);
  if (!action || !namespaceInScope(deps.principal, action.namespace)) {
    throw new StoreError("NotFound", `Action ${args.id} not found`, {
      id: args.id,
    });
  }
  return action;
}

export async function listActions(
  deps: McpToolDeps,
  args: { namespace?: string },
): Promise<ActionSummary[]> {
  // If a specific namespace was requested and it's out of scope, return [].
  // Same silent-empty behavior as if the namespace had no actions.
  if (args.namespace && !namespaceInScope(deps.principal, args.namespace)) {
    return [];
  }
  const all = await deps.store.actions.list(
    args.namespace ? { namespace: args.namespace } : undefined,
  );
  if (deps.principal.type === "master") return all;
  return all.filter((a) => namespaceAllowed(deps.principal, a.namespace));
}

export async function listActionRuns(
  deps: McpToolDeps,
  args: { id: string; limit?: number },
): Promise<RunSummary[]> {
  const action = await deps.store.actions.get(args.id);
  if (!action || !namespaceInScope(deps.principal, action.namespace)) {
    throw new StoreError("NotFound", `Action ${args.id} not found`, {
      id: args.id,
    });
  }
  return deps.store.runs.list({
    actionId: args.id,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  });
}

export interface InspectedRun extends RunRecord {
  stdout: string;
  stderr: string;
  input: unknown;
}

export async function inspectRun(
  deps: McpToolDeps,
  args: { runId: string },
): Promise<InspectedRun> {
  const meta = await deps.store.runs.get(args.runId);
  if (!meta) {
    throw new StoreError("NotFound", `Run ${args.runId} not found`, {
      id: args.runId,
    });
  }
  const action = await deps.store.actions.get(meta.actionId);
  // Hide runs whose action is out of scope (or was deleted into a
  // namespace we can't see).
  if (!action || !namespaceInScope(deps.principal, action.namespace)) {
    throw new StoreError("NotFound", `Run ${args.runId} not found`, {
      id: args.runId,
    });
  }
  const [stdout, stderr, input] = await Promise.all([
    deps.store.runs.readStdout(args.runId),
    deps.store.runs.readStderr(args.runId),
    deps.store.runs.readInput(args.runId),
  ]);
  return { ...meta, stdout, stderr, input };
}

export interface TriggerRef {
  id: string;
  type: "cron" | "webhook";
  actionId: string;
  webhookUrl?: string;
  /**
   * The trigger's bearer credential. Only meaningful when `authMode` is
   * "bearer" — in "public" and "artifact-session" modes this token is
   * not consulted by the daemon and SHOULD NOT be embedded in artifacts.
   */
  webhookToken?: string;
  /** "bearer" | "public" | "artifact-session"; webhook only. */
  authMode?: "bearer" | "public" | "artifact-session";
}

export async function createTrigger(
  deps: McpToolDeps,
  args: {
    type: "cron" | "webhook";
    actionId: string;
    namespace?: string;
    config?: Partial<CronConfig>;
    /** Webhook only. Defaults to "bearer". See WebhookAuthMode. */
    auth?: "bearer" | "public" | "artifact-session";
  },
): Promise<TriggerRef> {
  const action = await deps.store.actions.get(args.actionId);
  if (!action || !namespaceInScope(deps.principal, action.namespace)) {
    throw new StoreError("NotFound", `Action ${args.actionId} not found`, {
      id: args.actionId,
    });
  }
  const namespace = args.namespace ?? action.namespace;
  requireNamespace(deps.principal, namespace, "create trigger in");
  await assertNamespaceMutable(deps.store, namespace);
  if (args.auth !== undefined && args.type !== "webhook") {
    throw new StoreError(
      "ValidationError",
      `auth is only valid for type="webhook"`,
      { type: args.type, auth: args.auth },
    );
  }
  const config =
    args.type === "cron"
      ? {
          schedule: args.config?.schedule ?? "",
          ...(args.config?.timezone ? { timezone: args.config.timezone } : {}),
        }
      : { authMode: args.auth ?? "bearer" };
  const trigger = await deps.store.triggers.create({
    type: args.type,
    actionId: args.actionId,
    namespace,
    config,
  });
  if (trigger.type === "cron") {
    await deps.cronRegistry.add(trigger);
  }
  const ref: TriggerRef = {
    id: trigger.id,
    type: trigger.type,
    actionId: trigger.actionId,
  };
  if (trigger.type === "webhook" && trigger.config.type === "webhook") {
    ref.webhookUrl = deps.webhookUrlFor(trigger.id);
    ref.authMode = trigger.config.authMode;
    // Only return webhookToken in `bearer` mode — for `public` and
    // `artifact-session` the token is never consulted at the wire and
    // the agent has no business embedding it. Returning the value
    // anyway tempts the model into hard-coding it into HTML, which
    // (a) leaks a credential the daemon won't even check and
    // (b) would still be discoverable in artifact source. Fail closed
    // by simply not returning the field.
    if (trigger.config.authMode === "bearer") {
      ref.webhookToken = trigger.config.token;
    }
  }
  return ref;
}

export async function deleteTrigger(
  deps: McpToolDeps,
  args: { id: string },
): Promise<{ deleted: string }> {
  const existing = await deps.store.triggers.get(args.id);
  if (!existing || !namespaceInScope(deps.principal, existing.namespace)) {
    throw new StoreError("NotFound", `Trigger ${args.id} not found`, {
      id: args.id,
    });
  }
  await deps.cronRegistry.remove(args.id);
  await deps.store.triggers.delete(args.id);
  return { deleted: args.id };
}

export async function getTrigger(
  deps: McpToolDeps,
  args: { id: string },
): Promise<TriggerRecord> {
  const t = await deps.store.triggers.get(args.id);
  if (!t || !namespaceInScope(deps.principal, t.namespace)) {
    throw new StoreError("NotFound", `Trigger ${args.id} not found`, {
      id: args.id,
    });
  }
  return t;
}

export async function listTriggers(
  deps: McpToolDeps,
  args: { namespace?: string; actionId?: string },
): Promise<TriggerRecord[]> {
  if (args.namespace && !namespaceInScope(deps.principal, args.namespace)) {
    return [];
  }
  const filter: { namespace?: string; actionId?: string } = {};
  if (args.namespace) filter.namespace = args.namespace;
  if (args.actionId) filter.actionId = args.actionId;
  const all = await deps.store.triggers.list(filter);
  if (deps.principal.type === "master") return all;
  return all.filter((t) => namespaceAllowed(deps.principal, t.namespace));
}

export async function deleteNamespaceTool(
  deps: McpToolDeps,
  args: { name: string },
): Promise<{
  deleted: {
    actions: string[];
    triggers: string[];
    secrets: string[];
    stateKeys: string[];
    artifacts: string[];
  };
}> {
  requireNamespace(deps.principal, args.name, "delete");
  const result = await cascadeDeleteNamespace(deps.store, deps.state, args.name);
  for (const tid of result.triggers) {
    await deps.cronRegistry.remove(tid);
  }
  return {
    deleted: {
      actions: result.actions,
      triggers: result.triggers,
      secrets: result.secrets,
      stateKeys: result.stateKeys,
      artifacts: result.artifacts,
    },
  };
}

// ---------- artifacts ----------

export interface ArtifactRef {
  namespace: string;
  path: string;
  url: string;
  /** Empty when public. Returned only on create/update if non-public. */
  viewToken?: string;
  mimeType: string;
  size: number;
  public: boolean;
  createdAt: string;
  updatedAt: string;
}

function toArtifactRef(deps: McpToolDeps, rec: ArtifactRecord): ArtifactRef {
  const out: ArtifactRef = {
    namespace: rec.namespace,
    path: rec.path,
    url: deps.artifactUrlFor(rec.namespace, rec.path),
    mimeType: rec.mimeType,
    size: rec.size,
    public: rec.public,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
  if (!rec.public && rec.viewToken) out.viewToken = rec.viewToken;
  return out;
}

export async function createArtifact(
  deps: McpToolDeps,
  args: {
    namespace: string;
    path: string;
    content: string;
    mimeType?: string;
    public?: boolean;
  },
): Promise<ArtifactRef> {
  validateNamespace(args.namespace);
  requireNamespace(deps.principal, args.namespace, "create artifact in");
  await assertNamespaceMutable(deps.store, args.namespace);
  const created = await deps.store.artifacts.create({
    namespace: args.namespace,
    path: args.path,
    content: args.content,
    ...(args.mimeType !== undefined ? { mimeType: args.mimeType } : {}),
    ...(args.public !== undefined ? { public: args.public } : {}),
  });
  return toArtifactRef(deps, created);
}

export async function updateArtifact(
  deps: McpToolDeps,
  args: {
    namespace: string;
    path: string;
    patch: { content?: string; mimeType?: string; public?: boolean };
  },
): Promise<ArtifactRef> {
  validateNamespace(args.namespace);
  requireNamespace(deps.principal, args.namespace, "update artifact in");
  await assertNamespaceMutable(deps.store, args.namespace);
  const updated = await deps.store.artifacts.update(
    args.namespace,
    args.path,
    {
      ...(args.patch.content !== undefined
        ? { content: args.patch.content }
        : {}),
      ...(args.patch.mimeType !== undefined
        ? { mimeType: args.patch.mimeType }
        : {}),
      ...(args.patch.public !== undefined
        ? { public: args.patch.public }
        : {}),
    },
  );
  return toArtifactRef(deps, updated);
}

export async function getArtifact(
  deps: McpToolDeps,
  args: { namespace: string; path: string },
): Promise<ArtifactRef> {
  validateNamespace(args.namespace);
  requireNamespace(deps.principal, args.namespace, "read artifact in");
  const rec = await deps.store.artifacts.get(args.namespace, args.path);
  if (!rec) {
    throw new StoreError(
      "NotFound",
      `Artifact "${args.path}" not found in namespace "${args.namespace}"`,
      { namespace: args.namespace, path: args.path },
    );
  }
  return toArtifactRef(deps, rec);
}

export async function readArtifact(
  deps: McpToolDeps,
  args: { namespace: string; path: string },
): Promise<{ content: string }> {
  validateNamespace(args.namespace);
  requireNamespace(deps.principal, args.namespace, "read artifact in");
  const content = await deps.store.artifacts.read(args.namespace, args.path);
  if (content === null) {
    throw new StoreError(
      "NotFound",
      `Artifact "${args.path}" not found in namespace "${args.namespace}"`,
      { namespace: args.namespace, path: args.path },
    );
  }
  return { content };
}

export async function listArtifacts(
  deps: McpToolDeps,
  args: { namespace: string },
): Promise<ArtifactSummary[]> {
  validateNamespace(args.namespace);
  requireNamespace(deps.principal, args.namespace, "list artifacts in");
  return deps.store.artifacts.list(args.namespace);
}

export async function deleteArtifactTool(
  deps: McpToolDeps,
  args: { namespace: string; path: string },
): Promise<{ deleted: { namespace: string; path: string } }> {
  validateNamespace(args.namespace);
  requireNamespace(deps.principal, args.namespace, "delete artifact in");
  await assertNamespaceMutable(deps.store, args.namespace);
  await deps.store.artifacts.delete(args.namespace, args.path);
  return { deleted: { namespace: args.namespace, path: args.path } };
}

// ---------- whoami ----------

export interface WhoamiNamespace {
  name: string;
  status: NamespaceStatus;
  displayName?: string;
  description?: string;
}

export interface WhoamiResult {
  /** "master" → operator credential; "agent" → scoped agent token. */
  principal: "master" | "agent";
  /**
   * Namespaces this caller can touch. For master, every namespace
   * with a metadata row. For an agent, every namespace in the token's
   * scope — including a synthesized active stub for any in-scope
   * namespace that doesn't yet have a metadata row (brand-new
   * sandboxes, pre-bootstrap upgrades).
   */
  namespaces: WhoamiNamespace[];
}

function toWhoamiNamespace(rec: NamespaceRecord): WhoamiNamespace {
  const out: WhoamiNamespace = { name: rec.name, status: rec.status };
  if (rec.displayName !== undefined) out.displayName = rec.displayName;
  if (rec.description !== undefined) out.description = rec.description;
  return out;
}

export async function whoami(deps: McpToolDeps): Promise<WhoamiResult> {
  if (deps.principal.type === "master") {
    const all = await deps.store.namespaces.list();
    return { principal: "master", namespaces: all.map(toWhoamiNamespace) };
  }
  const patterns = deps.principal.scope.namespaces;
  const hasPattern = patterns.some(
    (p) => p === "*" || p.endsWith("*"),
  );
  // For wildcard or prefix scope, list-and-filter the existing
  // namespaces. There's no useful "synthesized stub" answer when the
  // scope is open-ended — we'd be inventing names.
  if (hasPattern) {
    const all = await deps.store.namespaces.list();
    const matching = all.filter((ns) =>
      namespaceAllowed(deps.principal, ns.name),
    );
    return {
      principal: "agent",
      namespaces: matching.map(toWhoamiNamespace),
    };
  }
  // Pure exact-match scope: enumerate the explicit allowlist; missing
  // rows get a synthesized "active" stub so the agent always sees a
  // complete entry.
  const out: WhoamiNamespace[] = [];
  for (const name of patterns) {
    const existing = await deps.store.namespaces.get(name);
    if (existing) {
      out.push(toWhoamiNamespace(existing));
    } else {
      out.push({ name, status: "active" });
    }
  }
  return { principal: "agent", namespaces: out };
}

export async function createNamespace(
  deps: McpToolDeps,
  args: { name: string; displayName?: string; description?: string },
): Promise<NamespaceRecord> {
  validateNamespace(args.name);
  // Token must permit this namespace. With wildcard scope (the local
  // dev default), any name is allowed. With a prefix scope like
  // "acme-*", only names under that prefix succeed.
  requireNamespace(deps.principal, args.name, "create namespace");
  // Idempotent: if the principal can already see the namespace, return
  // the existing record rather than throwing NameCollision. The
  // alternative is what we used to do — throw on existing — and that
  // turns harmless retries (network blip on the agent side, cron
  // re-fire after a transient failure) into hard errors. Since the
  // scope check above already guarantees the caller is allowed to
  // operate inside this namespace, surfacing NameCollision here adds
  // no security and removes a real footgun. Two callers racing to
  // create the same name converge on the same record.
  const existing = await deps.store.namespaces.get(args.name);
  if (existing) return existing;
  const now = new Date().toISOString();
  const record: NamespaceRecord = {
    name: args.name,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  if (args.displayName !== undefined) record.displayName = args.displayName;
  if (args.description !== undefined) record.description = args.description;
  return deps.store.namespaces.upsert(record);
}

export async function getNamespace(
  deps: McpToolDeps,
  args: { name: string },
): Promise<NamespaceRecord> {
  requireNamespace(deps.principal, args.name, "read");
  const ns = await deps.store.namespaces.get(args.name);
  if (!ns) {
    throw new StoreError(
      "NotFound",
      `Namespace "${args.name}" not found`,
      { name: args.name },
    );
  }
  return ns;
}

export async function updateNamespaceTool(
  deps: McpToolDeps,
  args: {
    name: string;
    patch: { displayName?: string | null; description?: string | null };
  },
): Promise<NamespaceRecord> {
  requireNamespace(deps.principal, args.name, "update");
  // Status changes are operator-only — agents may only update labels
  // (`displayName`, `description`). The MCP surface deliberately
  // excludes `status` from this tool's contract; an agent that wants
  // to pause a namespace asks the user to do it via CLI.
  const patch: { displayName?: string | null; description?: string | null } = {};
  if (args.patch.displayName !== undefined)
    patch.displayName = args.patch.displayName;
  if (args.patch.description !== undefined)
    patch.description = args.patch.description;
  return deps.store.namespaces.update(args.name, patch);
}

export async function setSecret(
  deps: McpToolDeps,
  args: { namespace: string; name: string; value: string },
): Promise<{ ok: true; namespace: string; name: string }> {
  validateNamespace(args.namespace);
  validateSecretName(args.name);
  requireNamespace(deps.principal, args.namespace, "write secrets in");
  await assertNamespaceMutable(deps.store, args.namespace);
  await deps.store.secrets.set(args.namespace, args.name, args.value);
  return { ok: true, namespace: args.namespace, name: args.name };
}

export async function setConfig(
  deps: McpToolDeps,
  args: { namespace: string; name: string; value: string },
): Promise<{ ok: true; namespace: string; name: string }> {
  validateNamespace(args.namespace);
  validateConfigName(args.name);
  requireNamespace(deps.principal, args.namespace, "write configs in");
  await assertNamespaceMutable(deps.store, args.namespace);
  await deps.store.configs.set(args.namespace, args.name, args.value);
  return { ok: true, namespace: args.namespace, name: args.name };
}

export async function getConfig(
  deps: McpToolDeps,
  args: { namespace: string; name: string },
): Promise<{ namespace: string; name: string; value: string }> {
  validateNamespace(args.namespace);
  validateConfigName(args.name);
  requireNamespace(deps.principal, args.namespace, "read configs in");
  const value = await deps.store.configs.get(args.namespace, args.name);
  if (value === null) {
    throw new StoreError(
      "NotFound",
      `Config "${args.name}" not set in namespace "${args.namespace}"`,
      { namespace: args.namespace, name: args.name },
    );
  }
  return { namespace: args.namespace, name: args.name, value };
}

export async function listConfigs(
  deps: McpToolDeps,
  args: { namespace: string },
): Promise<{ namespace: string; entries: ConfigEntry[] }> {
  validateNamespace(args.namespace);
  requireNamespace(deps.principal, args.namespace, "list configs in");
  const entries = await deps.store.configs.list(args.namespace);
  return { namespace: args.namespace, entries };
}

export async function deleteConfig(
  deps: McpToolDeps,
  args: { namespace: string; name: string },
): Promise<{ deleted: string; namespace: string }> {
  validateNamespace(args.namespace);
  validateConfigName(args.name);
  requireNamespace(deps.principal, args.namespace, "delete configs in");
  await assertNamespaceMutable(deps.store, args.namespace);
  await deps.store.configs.delete(args.namespace, args.name);
  return { deleted: args.name, namespace: args.namespace };
}

export async function appendState(
  deps: McpToolDeps,
  args: { namespace: string; key: string; entry: unknown },
): Promise<LogAppendResult> {
  validateNamespace(args.namespace);
  validateKey(args.key);
  requireNamespace(deps.principal, args.namespace, "append state in");
  await assertNamespaceMutable(deps.store, args.namespace);
  return deps.state.log.append(args.namespace, args.key, args.entry);
}

export async function readState(
  deps: McpToolDeps,
  args: { namespace: string; key: string; since?: number; limit?: number },
): Promise<LogReadResult> {
  validateNamespace(args.namespace);
  validateKey(args.key);
  requireNamespace(deps.principal, args.namespace, "read state in");
  const opts: { since?: number; limit?: number } = {};
  if (args.since !== undefined) opts.since = args.since;
  if (args.limit !== undefined) opts.limit = args.limit;
  return deps.state.log.read(args.namespace, args.key, opts);
}

export async function deleteStateKey(
  deps: McpToolDeps,
  args: { namespace: string; key: string },
): Promise<{ ok: true; namespace: string; key: string }> {
  validateNamespace(args.namespace);
  validateKey(args.key);
  requireNamespace(deps.principal, args.namespace, "delete state in");
  await deps.state.log.delete(args.namespace, args.key);
  return { ok: true, namespace: args.namespace, key: args.key };
}

export interface DoctorResult {
  cue: { version: string; daemonUp: true; port: number };
  runtime: { name: string; ok: boolean; details: Record<string, unknown> };
  store: { name: string; ok: boolean; details: Record<string, unknown> };
  cron: { name: string; ok: boolean; details: Record<string, unknown> };
  state: { name: string; ok: boolean; details: Record<string, unknown> };
}

export async function doctor(deps: McpToolDeps): Promise<DoctorResult> {
  const [runtimeDr, storeDr, cronDr, stateDr] = await Promise.all([
    deps.runtime.doctor(),
    deps.store.doctor(),
    deps.cronScheduler.doctor(),
    deps.state.doctor(),
  ]);
  return {
    cue: { version: deps.cueVersion, daemonUp: true, port: deps.port },
    runtime: {
      name: deps.runtime.name,
      ok: runtimeDr.ok,
      details: runtimeDr.details,
    },
    store: {
      name: deps.store.name,
      ok: storeDr.ok,
      details: storeDr.details,
    },
    cron: {
      name: deps.cronScheduler.name,
      ok: cronDr.ok,
      details: cronDr.details,
    },
    state: {
      name: deps.state.name,
      ok: stateDr.ok,
      details: stateDr.details,
    },
  };
}
