import type { CronRegistry } from "../cron/registry.js";
import type { CronScheduler } from "../cron/index.js";
import { type InvokeDeps, invokeAction } from "../invoke.js";
import type { LogAppendResult, LogReadResult } from "../state/index.js";
import { validateKey } from "../state/index.js";
import {
  type ActionRecord,
  type ActionSummary,
  type CronConfig,
  DEFAULT_NAMESPACE,
  type NamespaceRecord,
  type NamespaceStatus,
  StoreError,
  type TriggerRecord,
  deleteAction as cascadeDeleteAction,
  deleteNamespace as cascadeDeleteNamespace,
  type Policy,
  type RunRecord,
  type RunSummary,
  validateNamespace,
  validateSecretName,
} from "../store/index.js";
import { type Principal, requireNamespace } from "./auth.js";
import {
  assertNamespaceActive,
  assertNamespaceMutable,
} from "./namespace-status.js";

export interface McpToolDeps extends InvokeDeps {
  cronScheduler: CronScheduler;
  cronRegistry: CronRegistry;
  invokeUrlFor: (id: string) => string;
  webhookUrlFor: (id: string) => string;
  cueVersion: string;
  /**
   * The authenticated caller for this MCP session. Master principals
   * bypass all scope checks; agent principals are restricted to the
   * namespaces in their scope.
   */
  principal: Principal;
}

function namespaceInScope(principal: Principal, namespace: string): boolean {
  if (principal.type === "master") return true;
  return principal.scope.namespaces.includes(namespace);
}

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
  const namespace = args.namespace ?? DEFAULT_NAMESPACE;
  requireNamespace(deps.principal, namespace, "create action in");
  await assertNamespaceMutable(deps.store, namespace);
  const action = await deps.store.actions.create({
    name: args.name,
    code: args.code,
    namespace,
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
  const allowed = new Set(deps.principal.scope.namespaces);
  return all.filter((a) => allowed.has(a.namespace));
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
  webhookToken?: string;
}

export async function createTrigger(
  deps: McpToolDeps,
  args: {
    type: "cron" | "webhook";
    actionId: string;
    namespace?: string;
    config?: Partial<CronConfig>;
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
  const config =
    args.type === "cron"
      ? {
          schedule: args.config?.schedule ?? "",
          ...(args.config?.timezone ? { timezone: args.config.timezone } : {}),
        }
      : ({} as Record<string, never>);
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
    ref.webhookToken = trigger.config.token;
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
  const allowed = new Set(deps.principal.scope.namespaces);
  return all.filter((t) => allowed.has(t.namespace));
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
    },
  };
}

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
  const out: WhoamiNamespace[] = [];
  for (const name of deps.principal.scope.namespaces) {
    const existing = await deps.store.namespaces.get(name);
    if (existing) {
      out.push(toWhoamiNamespace(existing));
    } else {
      // No metadata row yet — synthesize an active stub. Mirrors how
      // assertNamespaceActive treats missing rows.
      out.push({ name, status: "active" });
    }
  }
  return { principal: "agent", namespaces: out };
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
