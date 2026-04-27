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
  /**
   * Sensitive named values (API keys, signing secrets, tokens). Listed
   * here, the value is materialized into the action's env at run time
   * but never returned by any read API. Use for anything you wouldn't
   * want shown in logs or echoed back to the dashboard.
   */
  secrets?: string[];
  /**
   * Non-sensitive named values (URLs, thresholds, channel names,
   * recipient addresses). Materialized into the action's env at run
   * time the same way secrets are, but readable via the admin/MCP API
   * and rendered as plain text in the dashboard.
   */
  configs?: string[];
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

/**
 * How the daemon gates access to a webhook trigger's URL.
 *
 *   • "bearer" (default, backwards-compatible): caller must present the
 *     trigger's `token` via `Authorization: Bearer <token>` or `?t=<token>`.
 *     The right pick for server-to-server callers (cron, internal services).
 *
 *   • "public": no auth on the wire. The action MUST authenticate the
 *     caller itself (e.g. Stripe-Signature HMAC against a stored secret).
 *     The right pick for inbound webhooks from third parties that can't
 *     send arbitrary headers.
 *
 *   • "artifact-session": ?t=<token> must equal the viewToken of a
 *     non-public artifact in the same namespace. Lets a private dashboard
 *     served at /u/<ns>/index.html?t=<viewToken> call read-only triggers
 *     without baking a long-lived secret into HTML — the same token gates
 *     both the page and its data fetches.
 */
export type WebhookAuthMode = "bearer" | "public" | "artifact-session";

export type TriggerConfigData =
  | { type: "cron"; schedule: string; timezone?: string }
  | { type: "webhook"; token: string; authMode: WebhookAuthMode };

export interface TriggerRecord {
  id: TriggerId;
  type: TriggerType;
  actionId: ActionId;
  namespace: string;
  createdAt: string;
  config: TriggerConfigData;
}

export interface WebhookTriggerCreateConfig {
  /** Defaults to "bearer" if omitted (backwards-compat with pre-authMode callers). */
  authMode?: WebhookAuthMode;
}

export interface TriggerCreateInput {
  type: TriggerType;
  actionId: ActionId;
  namespace: string;
  config: CronConfig | WebhookTriggerCreateConfig;
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
 * Static assets the agent publishes under a namespace. Bytes live in
 * the blob store at `artifacts/<namespace>/<path>`; metadata rows
 * track MIME, size, and per-artifact view tokens for non-public
 * artifacts.
 *
 * URL: GET /u/<namespace>/<path>. Public artifacts (the default) have
 * no auth on the URL. Non-public artifacts require ?t=<viewToken>
 * (URL-bearable so a `<script src>` / `<link href>` works without a
 * custom Authorization header).
 */
export interface ArtifactRecord {
  namespace: string;
  path: string;
  mimeType: string;
  size: number;
  public: boolean;
  /** Per-artifact view token; empty string when public. */
  viewToken: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactSummary {
  namespace: string;
  path: string;
  mimeType: string;
  size: number;
  public: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactCreateInput {
  namespace: string;
  path: string;
  /** Bytes as a string (utf8) or Buffer. Capped at ARTIFACT_MAX_BYTES. */
  content: string | Buffer;
  /** Defaults to ext-based detection; agent can override. */
  mimeType?: string;
  /** Defaults to true. Non-public artifacts get a viewToken. */
  public?: boolean;
}

export interface ArtifactPatch {
  /** Replace bytes. */
  content?: string | Buffer;
  /** Override MIME (re-detect if undefined and content changed). */
  mimeType?: string;
  /** Toggle public/non-public. Token rotates on every transition. */
  public?: boolean;
}

export interface ArtifactStore {
  get(namespace: string, path: string): Promise<ArtifactRecord | null>;
  list(namespace: string): Promise<ArtifactSummary[]>;
  create(input: ArtifactCreateInput): Promise<ArtifactRecord>;
  update(
    namespace: string,
    path: string,
    patch: ArtifactPatch,
  ): Promise<ArtifactRecord>;
  delete(namespace: string, path: string): Promise<void>;
  /** Cascade — used by deleteNamespace. Returns the paths removed. */
  deleteNamespace(namespace: string): Promise<string[]>;
  /** Read raw content as utf8 string. null if not found. */
  read(namespace: string, path: string): Promise<string | null>;
  /**
   * Look up a non-public artifact in the namespace whose viewToken matches.
   * Returns null if no match. Comparisons are constant-time per row to avoid
   * leaking which token, if any, was a near-match. Used by the webhook
   * route's "artifact-session" auth mode.
   */
  findByViewToken(
    namespace: string,
    token: string,
  ): Promise<ArtifactRecord | null>;
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

export interface ConfigEntry {
  name: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Per-namespace config store. Same runtime injection channel as secrets,
 * but values are READABLE from the admin/MCP surface — for non-sensitive
 * configuration like URLs, thresholds, channel names, recipient
 * addresses. Use this whenever the user benefits from being able to
 * see/edit the value in the dashboard. Use SecretStore for credentials.
 */
export interface ConfigStore {
  set(namespace: string, name: string, value: string): Promise<void>;
  /** Get a single value (returns null if unset). */
  get(namespace: string, name: string): Promise<string | null>;
  /** List all entries with values — different from SecretStore.list. */
  list(namespace: string): Promise<ConfigEntry[]>;
  /** Resolve a subset by name; same shape as SecretStore.resolve. */
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

export interface AgentTokenPatch {
  /** Replace the full scope. De-duped and sorted by the store. */
  scope?: AgentScope;
  /** Set to null to clear. */
  label?: string | null;
}

/**
 * Scoped per-agent tokens. The master token at `~/.cue/token` stays
 * untouched; agent tokens are purely additive. Tokens have the shape
 * `atk_<id>.<hex>` — the id is embedded so the HTTP layer can look up
 * the scope without scanning the store.
 *
 * Agent tokens cannot mint other agent tokens. Only the master
 * principal may call `mint` / `update` / `delete`.
 */
export interface AgentTokenStore {
  mint(input: AgentTokenCreateInput): Promise<AgentTokenRecord>;
  list(): Promise<AgentTokenSummary[]>;
  get(id: AgentTokenId): Promise<AgentTokenSummary | null>;
  /**
   * Update an existing token's scope and/or label. Replace-style:
   * `scope` overwrites the full namespace list (de-duped, sorted).
   * `label` set to null clears it. Throws `StoreError("NotFound")` if
   * the id is unknown. The bearer string is unchanged — callers using
   * the existing token continue to work, with the new scope applied
   * on the next request.
   */
  update(id: AgentTokenId, patch: AgentTokenPatch): Promise<AgentTokenSummary>;
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
  configs: ConfigStore;
  artifacts: ArtifactStore;
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
export const ARTIFACT_PATH_MAX = 256;
export const ARTIFACT_MAX_BYTES = 10 * 1024 * 1024; // 10MB
export const DEFAULT_NAMESPACE = "default";
const NAME_RE = /^[a-z0-9-]+$/;
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ARTIFACT_PATH_RE = /^[a-zA-Z0-9._/-]+$/;
/**
 * Namespaces are either a single dash-segment (legacy, e.g. "default" or
 * "jason-mnqr84bv") or two dash-segments separated by a single slash
 * (the cloud-allocated shape, e.g. "jason/uptime-monitor-mnqr84bv").
 * The slash form lets agent tokens scope to "<workspace>/*" wildcards
 * and reads as a path in URLs (`/u/jason/uptime-monitor/index.html`).
 */
const NAMESPACE_RE = /^[a-z0-9-]+(?:\/[a-z0-9-]+)?$/;

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
  if (!ns || ns.length > NAMESPACE_MAX || !NAMESPACE_RE.test(ns)) {
    throw new StoreError(
      "ValidationError",
      `Invalid namespace "${ns}" (must match ${NAMESPACE_RE} and be ≤${NAMESPACE_MAX} chars)`,
      { namespace: ns },
    );
  }
}

/**
 * Match a scope pattern against a concrete namespace name. Patterns:
 *
 *   "*"            — wildcard, match-all (the local-dev default)
 *   "prefix-*"     — dash-prefix match (legacy)
 *   "workspace/*"  — workspace-scoped wildcard (matches any namespace
 *                    in that workspace, e.g. "jason/*" matches
 *                    "jason/uptime-monitor-abc")
 *   "literal"      — exact match (the explicit-allowlist case)
 *
 * The set of pattern shapes is deliberately closed: no middle-of-string
 * globs, no regex. This keeps the matcher trivial and lets a future
 * Postgres adapter translate prefix patterns into `name LIKE 'prefix%'`
 * queries without an interpreter.
 */
export function scopePatternMatches(
  pattern: string,
  namespace: string,
): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    return namespace.startsWith(pattern.slice(0, -1));
  }
  return pattern === namespace;
}

/**
 * Validate a scope pattern. Accepts the four shapes documented on
 * {@link scopePatternMatches}. Throws ValidationError for anything
 * else (middle-of-string globs, empty strings, etc.).
 */
export function validateScopePattern(pattern: string): void {
  if (pattern === "*") return;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    if (!prefix) {
      throw new StoreError(
        "ValidationError",
        "scope pattern must be '*', a prefix like 'foo-*' or 'workspace/*', or a literal namespace name",
        { pattern },
      );
    }
    // The prefix is what comes BEFORE the trailing star. Two valid
    // shapes: dash-style ("foo-") or workspace-style ("workspace/").
    // Match against the same character class as the namespace itself.
    const trailingChar = prefix[prefix.length - 1];
    const isDashPrefix = trailingChar === "-" && NAME_RE.test(prefix.slice(0, -1));
    const isSlashPrefix =
      trailingChar === "/" && NAME_RE.test(prefix.slice(0, -1));
    if (
      prefix.length > NAMESPACE_MAX ||
      !(isDashPrefix || isSlashPrefix)
    ) {
      throw new StoreError(
        "ValidationError",
        `scope prefix "${prefix}" must end in '-' or '/' and the part before it must match ${NAME_RE} (≤${NAMESPACE_MAX} chars)`,
        { pattern },
      );
    }
    return;
  }
  validateNamespace(pattern);
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

// Configs share the env-var-identifier shape with secrets; same regex,
// same length cap. Distinct function so error messages name the right
// concept and so future divergence (e.g. allowing dotted names) lands
// in one place.
export const CONFIG_NAME_MAX = SECRET_NAME_MAX;
export function validateConfigName(name: string): void {
  if (!name || name.length > CONFIG_NAME_MAX || !SECRET_NAME_RE.test(name)) {
    throw new StoreError(
      "ValidationError",
      `Invalid config name "${name}" (must match ${SECRET_NAME_RE} and be ≤${CONFIG_NAME_MAX} chars)`,
      { name },
    );
  }
}

/**
 * Validate an artifact path. The blob-store fs adapter normalizes
 * paths via `path.join`, but we reject anything funky at the API
 * boundary so the contract is explicit and traversal attempts fail
 * loudly rather than silently landing in an unexpected directory.
 */
export function validateArtifactPath(p: string): void {
  if (!p || p.length > ARTIFACT_PATH_MAX || !ARTIFACT_PATH_RE.test(p)) {
    throw new StoreError(
      "ValidationError",
      `Invalid artifact path "${p}" (must match ${ARTIFACT_PATH_RE} and be ≤${ARTIFACT_PATH_MAX} chars)`,
      { path: p },
    );
  }
  if (p.startsWith("/") || p.endsWith("/")) {
    throw new StoreError(
      "ValidationError",
      `Invalid artifact path "${p}" (must not start or end with '/')`,
      { path: p },
    );
  }
  if (p.includes("..") || p.includes("//")) {
    throw new StoreError(
      "ValidationError",
      `Invalid artifact path "${p}" (must not contain '..' or '//')`,
      { path: p },
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
  /** Config names that existed in this namespace and got wiped. */
  configs: string[];
  /** Log keys that existed in this namespace and got wiped. */
  stateKeys: string[];
  /** Artifact paths that existed in this namespace and got wiped. */
  artifacts: string[];
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
  const configEntries = await store.configs.list(namespace);
  await store.configs.deleteNamespace(namespace);
  const stateKeys = await state.log.list(namespace);
  await state.log.deleteNamespace(namespace);
  await state.tokens.deleteNamespace(namespace);
  const artifactPaths = await store.artifacts.deleteNamespace(namespace);
  // Last: drop the metadata row. Doing this last means a partial
  // failure leaves the metadata in place so the cascade can be
  // retried; the metadata is the bookkeeping for the contents below.
  await store.namespaces.delete(namespace);
  return {
    actions: nsActions.map((a) => a.id),
    triggers: toKill.map((t) => t.id),
    secrets: secretNames,
    configs: configEntries.map((c) => c.name),
    stateKeys,
    artifacts: artifactPaths,
  };
}
