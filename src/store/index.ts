import { randomBytes } from "node:crypto";
import { ulid } from "ulidx";
import type { StateAdapter } from "../state/index.js";
import { sqliteStore } from "./sql/sqlite/adapter.js";

export type ActionId = string;
export type TriggerId = string;
export type RunId = string;

export type TriggerType = "cron" | "webhook";

export interface Policy {
  memoryMb?: number;
  timeoutSeconds?: number;
  allowNet?: string[];
  allowTcp?: string[];
  secrets?: string[];
  files?: string[];
  dirs?: string[];
  /**
   * Opt into the cue-native shared state primitive. When true, the
   * action's unikernel sees `CUE_STATE_URL`/`CUE_STATE_TOKEN` env vars
   * and can `require('/cue-state')` to append/read its namespace's log.
   * State access is always namespace-scoped — tokens are bound to the
   * action's namespace and enforced at the daemon's /state routes.
   */
  state?: boolean;
}

export interface ActionSummary {
  id: ActionId;
  name: string;
  namespace: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActionRecord extends ActionSummary {
  code: string;
  policy: Policy;
}

export interface ActionCreateInput {
  name: string;
  code: string;
  namespace?: string;
  policy?: Policy;
}

export interface ActionPatch {
  name?: string;
  code?: string;
  policy?: Policy;
}

export interface CronConfig {
  schedule: string;
  timezone?: string;
}

export type TriggerConfigData =
  | { type: "cron"; schedule: string; timezone?: string }
  | { type: "webhook"; token: string };

export interface TriggerRecord {
  id: TriggerId;
  type: TriggerType;
  actionId: ActionId;
  namespace: string;
  createdAt: string;
  config: TriggerConfigData;
}

export interface TriggerCreateInput {
  type: TriggerType;
  actionId: ActionId;
  namespace: string;
  config: CronConfig | Record<string, never>;
}

export interface RunSummary {
  id: RunId;
  actionId: ActionId;
  triggerId?: TriggerId;
  firedAt: string;
  finishedAt?: string;
  exitCode?: number;
}

export interface RunRecord extends RunSummary {
  runtimeRunId?: string;
  denials?: string[];
}

export interface RunCreateInput {
  actionId: ActionId;
  triggerId?: TriggerId;
  firedAt: string;
  input: unknown;
}

export interface RunFinishInput {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Undefined when the runtime adapter itself failed before producing output. */
  runtimeRunId?: string;
  denials?: string[];
  finishedAt: string;
}

export type StoreErrorKind =
  | "NotFound"
  | "NameCollision"
  | "ValidationError"
  | "NamespacePaused"
  | "NamespaceArchived";

export class StoreError extends Error {
  readonly kind: StoreErrorKind;
  readonly details?: Record<string, unknown>;
  constructor(
    kind: StoreErrorKind,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StoreError";
    this.kind = kind;
    this.details = details;
  }
}

export interface ActionStore {
  create(input: ActionCreateInput): Promise<ActionRecord>;
  get(id: ActionId): Promise<ActionRecord | null>;
  list(filter?: { namespace?: string }): Promise<ActionSummary[]>;
  update(id: ActionId, patch: ActionPatch): Promise<ActionRecord>;
  delete(id: ActionId): Promise<void>;
}

export interface TriggerSubscription {
  close(): void;
}

export interface TriggerStore {
  create(input: TriggerCreateInput): Promise<TriggerRecord>;
  get(id: TriggerId): Promise<TriggerRecord | null>;
  list(filter?: {
    namespace?: string;
    actionId?: ActionId;
  }): Promise<TriggerRecord[]>;
  delete(id: TriggerId): Promise<void>;
  /**
   * Observe changes to the trigger set. The callback fires on any
   * create/delete (possibly coalesced); it is **not** expected to
   * carry diff information — subscribers must re-`list()` to learn
   * the new state. Implementations may miss events under heavy load
   * or platform quirks, so callers must treat each notification as a
   * hint to reconcile from scratch, not as an authoritative delta.
   */
  subscribe(onChange: () => void): TriggerSubscription;
  /**
   * Atomically claim the right to fire this trigger. Returns true if
   * claimed by this caller, false if another daemon got there first.
   * Single-node SQLite always returns true (the only daemon always
   * wins). Postgres implements this for fleet coordination.
   *
   * `leaseMs` is how long the claim is valid before another daemon
   * may try again — useful for crash recovery when the claimer dies
   * mid-fire.
   */
  claimFire(triggerId: TriggerId, leaseMs: number): Promise<boolean>;
}

export interface RunStore {
  create(input: RunCreateInput): Promise<RunRecord>;
  finish(id: RunId, result: RunFinishInput): Promise<RunRecord>;
  get(id: RunId): Promise<RunRecord | null>;
  list(filter?: {
    actionId?: ActionId;
    limit?: number;
  }): Promise<RunSummary[]>;
  readStdout(id: RunId): Promise<string>;
  readStderr(id: RunId): Promise<string>;
  readInput(id: RunId): Promise<unknown>;
}

export type NamespaceStatus = "active" | "paused" | "archived";

export interface NamespaceRecord {
  name: string;
  displayName?: string;
  description?: string;
  status: NamespaceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface NamespacePatch {
  /** Set to null to clear. */
  displayName?: string | null;
  description?: string | null;
  status?: NamespaceStatus;
}

/**
 * First-class namespace records. The metadata sits alongside the
 * resources tagged with each namespace (actions, triggers, secrets,
 * state). Lifecycle status is enforced at the invocation entry points
 * (cron, webhook, MCP invoke) and at mutation entry points (archive
 * makes mutations fail).
 */
export interface NamespaceStore {
  get(name: string): Promise<NamespaceRecord | null>;
  list(): Promise<NamespaceRecord[]>;
  /** Create-or-update by name. Used both by the create CLI and by bootstrap. */
  upsert(record: NamespaceRecord): Promise<NamespaceRecord>;
  update(name: string, patch: NamespacePatch): Promise<NamespaceRecord>;
  delete(name: string): Promise<void>;
}

/**
 * Per-namespace secret store. Secrets are read-only from the MCP surface
 * (materialized only inside the action unikernel). Writing happens via
 * `set_secret`; tearing down a namespace wipes its secrets.
 */
export interface SecretStore {
  set(namespace: string, name: string, value: string): Promise<void>;
  list(namespace: string): Promise<string[]>;
  resolve(namespace: string, names: string[]): Promise<Record<string, string>>;
  delete(namespace: string, name: string): Promise<void>;
  deleteNamespace(namespace: string): Promise<void>;
}

export type AgentTokenId = string;

export interface AgentScope {
  /** Namespaces this token is allowed to touch. Exact-match only in v1. */
  namespaces: string[];
}

export interface AgentTokenSummary {
  id: AgentTokenId;
  scope: AgentScope;
  label?: string;
  createdAt: string;
}

export interface AgentTokenRecord extends AgentTokenSummary {
  /** The full bearer string. Stored so verify() can constant-time compare. */
  token: string;
}

export interface AgentTokenCreateInput {
  scope: AgentScope;
  label?: string;
}

/**
 * Scoped per-agent tokens. The master token at `~/.cue/token` stays
 * untouched; agent tokens are purely additive. Tokens have the shape
 * `atk_<id>.<hex>` — the id is embedded so the HTTP layer can look up
 * the scope without scanning the store.
 *
 * Agent tokens cannot mint other agent tokens. Only the master
 * principal may call `mint` / `delete`.
 */
export interface AgentTokenStore {
  mint(input: AgentTokenCreateInput): Promise<AgentTokenRecord>;
  list(): Promise<AgentTokenSummary[]>;
  get(id: AgentTokenId): Promise<AgentTokenSummary | null>;
  /**
   * Constant-time verify. Returns the summary (without the raw token
   * value) on match, null otherwise. Null covers: unknown id, token
   * length mismatch, byte-compare mismatch, or malformed token input.
   */
  verify(token: string): Promise<AgentTokenSummary | null>;
  delete(id: AgentTokenId): Promise<void>;
}

export interface StoreAdapter {
  name: string;
  doctor(): Promise<{ ok: boolean; details: Record<string, unknown> }>;
  namespaces: NamespaceStore;
  actions: ActionStore;
  triggers: TriggerStore;
  runs: RunStore;
  secrets: SecretStore;
  agentTokens: AgentTokenStore;
  /**
   * Run `fn` inside a transaction. The adapter passed to `fn` is the
   * same shape as the outer one, but all writes are atomic — they
   * commit on return, roll back on throw. SQLite uses BEGIN IMMEDIATE;
   * Postgres uses BEGIN. Nesting is not supported.
   */
  transaction<T>(fn: (tx: StoreAdapter) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const NAME_MAX = 128;
export const NAMESPACE_MAX = 64;
export const SECRET_NAME_MAX = 128;
export const DEFAULT_NAMESPACE = "default";
const NAME_RE = /^[a-z0-9-]+$/;
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateName(name: string): void {
  if (!name || name.length > NAME_MAX || !NAME_RE.test(name)) {
    throw new StoreError(
      "ValidationError",
      `Invalid name "${name}" (must match ${NAME_RE} and be ≤${NAME_MAX} chars)`,
      { name },
    );
  }
}

export function validateNamespace(ns: string): void {
  if (!ns || ns.length > NAMESPACE_MAX || !NAME_RE.test(ns)) {
    throw new StoreError(
      "ValidationError",
      `Invalid namespace "${ns}" (must match ${NAME_RE} and be ≤${NAMESPACE_MAX} chars)`,
      { namespace: ns },
    );
  }
}

export function validateSecretName(name: string): void {
  if (!name || name.length > SECRET_NAME_MAX || !SECRET_NAME_RE.test(name)) {
    throw new StoreError(
      "ValidationError",
      `Invalid secret name "${name}" (must match ${SECRET_NAME_RE} and be ≤${SECRET_NAME_MAX} chars)`,
      { name },
    );
  }
}

export const newActionId = (): ActionId => `act_${ulid()}`;
export const newTriggerId = (): TriggerId => `trg_${ulid()}`;
export const newRunId = (): RunId => `run_${ulid()}`;
export const newAgentTokenId = (): AgentTokenId => `atk_${ulid()}`;
export const newWebhookToken = (): string =>
  `tok_${randomBytes(32).toString("hex")}`;

/**
 * Mint an `atk_<id>.<hex>` bearer string for a given agent-token id.
 * The id is embedded so the HTTP layer can resolve a token to its
 * record without scanning the whole store.
 */
export function mintAgentTokenBearer(id: AgentTokenId): string {
  return `${id}.${randomBytes(32).toString("hex")}`;
}

/**
 * Parse the id out of an `atk_<id>.<hex>` bearer string. Returns null
 * on malformed input. Callers must still verify the bearer against the
 * stored record.
 */
export function parseAgentTokenId(bearer: string): AgentTokenId | null {
  if (!bearer.startsWith("atk_")) return null;
  const dot = bearer.indexOf(".");
  if (dot <= 4 || dot === bearer.length - 1) return null;
  return bearer.slice(0, dot);
}

export interface StorePickOpts {
  home: string;
}

export function pickStore(name: string, opts: StorePickOpts): StoreAdapter {
  switch (name) {
    case "sqlite":
      return sqliteStore(opts.home);
    default:
      throw new Error(
        `Unknown store adapter: "${name}". Known adapters: sqlite`,
      );
  }
}

export async function deleteAction(
  adapter: StoreAdapter,
  id: ActionId,
): Promise<{ action: ActionId; triggers: TriggerId[] }> {
  const triggers = await adapter.triggers.list({ actionId: id });
  for (const t of triggers) await adapter.triggers.delete(t.id);
  await adapter.actions.delete(id);
  return { action: id, triggers: triggers.map((t) => t.id) };
}

export interface NamespaceDeletion {
  actions: ActionId[];
  triggers: TriggerId[];
  secrets: string[];
  /** Log keys that existed in this namespace and got wiped. */
  stateKeys: string[];
}

export async function deleteNamespace(
  store: StoreAdapter,
  state: StateAdapter,
  namespace: string,
): Promise<NamespaceDeletion> {
  const nsActions = await store.actions.list({ namespace });
  const actionIdSet = new Set(nsActions.map((a) => a.id));
  const allTriggers = await store.triggers.list();
  const toKill = allTriggers.filter(
    (t) => t.namespace === namespace || actionIdSet.has(t.actionId),
  );
  for (const t of toKill) await store.triggers.delete(t.id);
  for (const a of nsActions) await store.actions.delete(a.id);
  const secretNames = await store.secrets.list(namespace);
  await store.secrets.deleteNamespace(namespace);
  const stateKeys = await state.log.list(namespace);
  await state.log.deleteNamespace(namespace);
  await state.tokens.deleteNamespace(namespace);
  // Last: drop the metadata row. Doing this last means a partial
  // failure leaves the metadata in place so the cascade can be
  // retried; the metadata is the bookkeeping for the contents below.
  await store.namespaces.delete(namespace);
  return {
    actions: nsActions.map((a) => a.id),
    triggers: toKill.map((t) => t.id),
    secrets: secretNames,
    stateKeys,
  };
}
