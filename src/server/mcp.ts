import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { StoreError } from "../store/index.js";
import { ScopeError } from "./auth.js";
import {
  createAction,
  createArtifact,
  createNamespace,
  createTrigger,
  deleteActionTool,
  deleteArtifactTool,
  deleteNamespaceTool,
  deleteStateKey,
  deleteTrigger,
  doctor,
  getAction,
  getArtifact,
  getNamespace,
  getTrigger,
  inspectRun,
  invokeActionTool,
  listActionRuns,
  listActions,
  listArtifacts,
  listTriggers,
  type McpToolDeps,
  readArtifact,
  readState,
  appendState,
  setConfig,
  getConfig,
  listConfigs,
  deleteConfig,
  setSecret,
  updateAction,
  updateArtifact,
  updateNamespaceTool,
  whoami,
} from "./mcp-tools.js";

const PolicyShape = z
  .object({
    memoryMb: z.number().optional(),
    timeoutSeconds: z.number().optional(),
    allowNet: z.array(z.string()).optional(),
    allowTcp: z.array(z.string()).optional(),
    secrets: z.array(z.string()).optional(),
    configs: z.array(z.string()).optional(),
    files: z.array(z.string()).optional(),
    dirs: z.array(z.string()).optional(),
    state: z.boolean().optional(),
  })
  .optional();

function textResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(err: unknown): CallToolResult {
  if (err instanceof ScopeError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            kind: "Forbidden",
            message: err.message,
            namespace: err.namespace,
          }),
        },
      ],
    };
  }
  if (err instanceof StoreError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            kind: err.kind,
            message: err.message,
            details: err.details,
          }),
        },
      ],
    };
  }
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: err instanceof Error ? err.message : String(err),
      },
    ],
  };
}

async function wrap<T>(thunk: () => Promise<T>): Promise<CallToolResult> {
  try {
    return textResult(await thunk());
  } catch (err) {
    return errorResult(err);
  }
}

export function buildMcpServer(deps: McpToolDeps): McpServer {
  const server = new McpServer(
    { name: "cue", version: deps.cueVersion },
    { capabilities: {} },
  );

  server.registerTool(
    "create_action",
    {
      description:
        "Create a named action. Code runs under the action's policy inside the runtime adapter.\n\n" +
        "**What actions are for.** A discrete unit of work — a webhook handler, a cron tick, an explicit `invoke_action` call. Each invocation boots a fresh sandboxed unikernel; cold-start latency is on the order of hundreds of milliseconds. Don't use actions to render pages on every request — that's what `create_artifact` is for. Static HTML/JS/CSS belongs in artifacts (served instantly from the daemon's blob store); actions are the dynamic backend the artifact's JS calls into.\n\n" +
        "Rule of thumb: if your code returns the same bytes regardless of input, it should be an artifact, not an action.\n\n" +
        "Input envelope (mounted as a file at /cue-envelope.json):\n" +
        "  { trigger, input, request? }\n" +
        "  • input    — payload from the caller. ALWAYS read from here, regardless of whether the\n" +
        "               action was fired by invoke_action, a webhook, or cron. For invoke_action\n" +
        "               and cron, this is the data the caller passed; for webhooks, this is the\n" +
        "               request body. (env.request is also populated for webhooks for HTTP-specific\n" +
        "               context — method, headers, query — but the payload itself is at env.input.)\n" +
        "  • trigger  — { type: 'cron' | 'webhook', triggerId, firedAt } when fired by a trigger,\n" +
        "               null when called via invoke_action.\n" +
        "  • request  — { method, path, query, headers, body } for webhook triggers only.\n\n" +
        "Output: write JSON to stdout. If stdout parses as JSON, the caller receives `output` as a\n" +
        "parsed value; otherwise as a raw string. Don't `console.log` non-JSON before your final\n" +
        "JSON output, or `output` will be null.\n\n" +
        "Declared primitives in `policy` (all optional; each is off unless the action opts in):\n" +
        "  allowNet: string[]    — hostnames (not URLs) the action can reach over HTTP(S). Three forms:\n" +
        "                            • literal hostname for known endpoints: 'api.stripe.com', 'slack.com'.\n" +
        "                            • '$CONFIG_NAME' for hostnames the user supplies at runtime — at invoke time\n" +
        "                              this resolves to URL.hostname(env[CONFIG_NAME]). Use whenever the action\n" +
        "                              fetches a URL the user puts in a config (e.g. allowNet: ['$MONITOR_URL']\n" +
        "                              paired with configs: ['MONITOR_URL']). Refs to unset configs are silently\n" +
        "                              dropped — the action can detect that with `if (!process.env.MONITOR_URL)`.\n" +
        "                            • '*' for any host. Escape hatch for code that fetches across arbitrary\n" +
        "                              domains (RSS readers, link summarizers, anything that takes a URL list).\n" +
        "                              Prefer '$NAME' when the action only ever fetches one user-configured\n" +
        "                              destination — narrower allowlist, same UX.\n" +
        "  allowTcp: string[]    — 'host:port' entries for raw TCP. Includes loopback (e.g. 127.0.0.1:5432).\n" +
        "                            host can also be a $CONFIG_NAME ref (e.g. '$DB_HOST:5432').\n" +
        "  secrets:  string[]    — names of SENSITIVE values (API keys, signing secrets, tokens) forwarded as env vars. Set via set_secret; values are write-only at the API surface, never returned by any read tool. Namespace-scoped.\n" +
        "  configs:  string[]    — names of NON-SENSITIVE values (URLs, thresholds, channel names, recipient addresses) forwarded as env vars. Set via set_config; values are readable via get_config / list_configs and shown in the dashboard. Use these for anything the user benefits from being able to see and edit. Namespace-scoped.\n" +
        "  files:    string[]    — host file paths injected read-only; appear inside the guest at /<basename>.\n" +
        "  dirs:     string[]    — host directories injected read-only; appear inside the guest at /<basename>/.\n" +
        "  state:    boolean     — when true, `require('/cue-state')` inside the action yields:\n" +
        "                            { namespace, append(key, entry), read(key, {since, limit}), delete(key) }.\n" +
        "                            State is a durable append-only log per (namespace, key). Scoped to the\n" +
        "                            action's namespace; the daemon enforces this via a scoped token.\n" +
        "                            Reads return { entries: [{seq, at, entry}], lastSeq }. Use the lastSeq\n" +
        "                            as the next `since` cursor (entries are filtered by seq > since).\n" +
        "  timeoutSeconds, memoryMb — runtime caps.\n\n" +
        "Skeleton (input + state, works for both invoke_action and webhook firing):\n" +
        "  const fs = require('fs');\n" +
        "  const state = require('/cue-state');\n" +
        "  const env = JSON.parse(fs.readFileSync('/cue-envelope.json', 'utf8'));\n" +
        "  const input = env.input ?? {};\n" +
        "  // ... do work ...\n" +
        "  await state.append('events', { input, at: new Date().toISOString() });\n" +
        "  console.log(JSON.stringify({ ok: true }));\n",
      inputSchema: {
        name: z.string(),
        code: z.string(),
        namespace: z.string().optional(),
        policy: PolicyShape,
      },
    },
    (args) => wrap(() => createAction(deps, args)),
  );

  server.registerTool(
    "update_action",
    {
      description: "Patch an action's name, code, or policy.",
      inputSchema: {
        id: z.string(),
        patch: z.object({
          name: z.string().optional(),
          code: z.string().optional(),
          policy: PolicyShape,
        }),
      },
    },
    (args) => wrap(() => updateAction(deps, args)),
  );

  server.registerTool(
    "delete_action",
    {
      description:
        "Delete an action and all of its triggers. Run records are preserved.",
      inputSchema: { id: z.string() },
    },
    (args) => wrap(() => deleteActionTool(deps, args)),
  );

  server.registerTool(
    "invoke_action",
    {
      description:
        "Synchronously run an action. Waits up to the action's timeoutSeconds. Returns stdout/stderr/exit + parsed output if JSON.",
      inputSchema: {
        id: z.string(),
        input: z.unknown().optional(),
      },
    },
    (args) => wrap(() => invokeActionTool(deps, args)),
  );

  server.registerTool(
    "get_action",
    {
      description: "Return the full action record including code and policy.",
      inputSchema: { id: z.string() },
    },
    (args) => wrap(() => getAction(deps, args)),
  );

  server.registerTool(
    "list_actions",
    {
      description: "List action summaries, optionally filtered by namespace.",
      inputSchema: { namespace: z.string().optional() },
    },
    (args) => wrap(() => listActions(deps, args)),
  );

  server.registerTool(
    "list_action_runs",
    {
      description: "List recent run records for an action (most-recent first).",
      inputSchema: {
        id: z.string(),
        limit: z.number().optional(),
      },
    },
    (args) => wrap(() => listActionRuns(deps, args)),
  );

  server.registerTool(
    "inspect_run",
    {
      description: "Return a run record including stdout, stderr, and the input envelope.",
      inputSchema: { runId: z.string() },
    },
    (args) => wrap(() => inspectRun(deps, args)),
  );

  server.registerTool(
    "create_trigger",
    {
      description:
        "Create a cron or webhook trigger for an action.\n\n" +
        "  • cron     — fires the action on a schedule. config: { schedule: '* * * * *', timezone? }. Cron expressions are 5- or 6-field standard form.\n" +
        "  • webhook  — returns { webhookUrl, webhookToken, authMode }. The webhookUrl is a single endpoint of shape `http://<daemon>/w/<triggerId>` — there are NO path sub-routes (do not append /increment, /reset, etc.; the URL is opaque). Dispatch happens inside the action by reading `env.request.method` and `env.request.query`.\n\n" +
        "**Webhook auth modes** (the `auth` arg, default `bearer`):\n" +
        "  • `bearer` — caller presents `webhookToken` via `Authorization: Bearer …` or `?t=<webhookToken>`. Pick this for server-to-server callers (other actions, scripts, internal services) where the token can be stored as a secret, not in HTML.\n" +
        "  • `public` — no token check on the wire. The action MUST authenticate the caller itself (e.g. verify Stripe-Signature against a STRIPE_WEBHOOK_SECRET secret). Pick this for inbound webhooks from third parties (Stripe, GitHub, Slack) that can't include a custom Authorization header.\n" +
        "  • `artifact-session` — `?t=<token>` must equal the viewToken of a non-public artifact in this trigger's namespace. Pick this for triggers a private dashboard reads from: serve the dashboard as `create_artifact({ public: false })`, get back its viewToken, and have the page JS read `new URLSearchParams(location.search).get('t')` and pass it as `?t=` on its fetches. The user bookmarks `…/index.html?t=<viewToken>`; sharing that URL = sharing dashboard access. NEVER hard-code webhookToken into artifacts — that's what this mode is for.\n\n" +
        "**Method semantics** (orthogonal to auth):\n" +
        "  • POST → request body lands at `env.input`; full HTTP context at `env.request`.\n" +
        "  • GET  → `env.input` is null; query params at `env.request.query` for REST-shaped reads.\n\n" +
        "Webhook URLs are served on the SAME origin as artifacts — UIs uploaded via create_artifact can fetch the webhook URL with no CORS or mixed-content.\n\n" +
        "**Webhook URLs are not page URLs.** Don't have an action serve HTML on GET — that's an SSR anti-pattern that boots a unikernel per page load. Use create_artifact for the page; have the page's JS fetch the webhook for dynamic data.\n\n" +
        "**Common Stripe-style pattern:** ONE namespace, ONE action that handles both ingest and read by switching on `env.request.method`, but TWO triggers pointing at it: a `public` POST trigger (Stripe sends events here, action verifies signature) and an `artifact-session` GET trigger (dashboard fetches stored data here).\n\n" +
        "When `namespace` is omitted, the trigger inherits the action's namespace.",
      inputSchema: {
        type: z.enum(["cron", "webhook"]),
        actionId: z.string(),
        namespace: z.string().optional(),
        config: z
          .object({
            schedule: z.string().optional(),
            timezone: z.string().optional(),
          })
          .optional(),
        auth: z
          .enum(["bearer", "public", "artifact-session"])
          .optional()
          .describe(
            "Webhook only. Default 'bearer'. Use 'public' for inbound third-party webhooks (action verifies signatures); use 'artifact-session' for dashboards reading their own data via the artifact's viewToken.",
          ),
      },
    },
    (args) => wrap(() => createTrigger(deps, args)),
  );

  server.registerTool(
    "delete_trigger",
    {
      description: "Delete a trigger.",
      inputSchema: { id: z.string() },
    },
    (args) => wrap(() => deleteTrigger(deps, args)),
  );

  server.registerTool(
    "get_trigger",
    {
      description: "Return a trigger record.",
      inputSchema: { id: z.string() },
    },
    (args) => wrap(() => getTrigger(deps, args)),
  );

  server.registerTool(
    "list_triggers",
    {
      description: "List triggers, optionally filtered by namespace or actionId.",
      inputSchema: {
        namespace: z.string().optional(),
        actionId: z.string().optional(),
      },
    },
    (args) => wrap(() => listTriggers(deps, args)),
  );

  server.registerTool(
    "create_namespace",
    {
      description:
        "Allocate a new namespace — a self-contained app on this cue daemon. " +
        "Each namespace is the unit of work and the unit of teardown.\n\n" +
        "An app in cue is a namespace containing some combination of these primitives:\n" +
        "  • actions    — named JS code that runs in a sandboxed unikernel (see create_action)\n" +
        "  • triggers   — cron schedules and webhook endpoints that fire actions (see create_trigger)\n" +
        "  • state      — an append-only log per (namespace, key), shared across the namespace's actions (`require('/cue-state')` inside an action)\n" +
        "  • secrets    — per-namespace key=value, declared in `policy.secrets` and injected as env vars at invoke time (see set_secret)\n" +
        "  • artifacts  — static files (HTML/JS/CSS/images) served at GET /u/<namespace>/<path> on the SAME origin as webhooks (see create_artifact). Lets the agent ship a UI alongside its backend with no CORS.\n\n" +
        "Typical agent workflow when building a new app:\n" +
        "  1. whoami — see what's already here\n" +
        "  2. create_namespace({ name: 'my-app' }) — pick a meaningful name\n" +
        "  3. create_action({...}) — backend logic\n" +
        "  4. create_trigger({...}) — wire it to cron and/or a webhook URL\n" +
        "  5. create_artifact({...}) — ship the UI (optional)\n" +
        "  6. delete_namespace later cleanly tears down the entire app\n\n" +
        "Token scope must permit the chosen name. Wildcard `*` and prefix `foo-*` scopes grant creation; literal allowlists do not. Agents typically allocate a fresh namespace per app rather than crowding many apps into one — `delete_namespace` is the clean teardown.",
      inputSchema: {
        name: z.string(),
        displayName: z.string().optional(),
        description: z.string().optional(),
      },
    },
    (args) => wrap(() => createNamespace(deps, args)),
  );

  server.registerTool(
    "delete_namespace",
    {
      description:
        "Delete every action, trigger, secret, and state log tagged with the namespace. Run records preserved.",
      inputSchema: { name: z.string() },
    },
    (args) => wrap(() => deleteNamespaceTool(deps, args)),
  );

  server.registerTool(
    "get_namespace",
    {
      description:
        "Read a namespace's metadata record (status, displayName, description, timestamps). Useful for an agent to detect that its namespace is paused/archived before invoking and surface that to the user.",
      inputSchema: { name: z.string() },
    },
    (args) => wrap(() => getNamespace(deps, args)),
  );

  server.registerTool(
    "whoami",
    {
      description:
        "**Call this first when starting work in cue.** Returns the caller's principal type ('master' | 'agent') and the list of namespaces (apps) the token can touch — each with status (active/paused/archived) and labels.\n\n" +
        "From there: pick an existing namespace and call `create_action` / `create_artifact` / etc. inside it, OR call `create_namespace` to allocate a fresh app. A namespace is one app — see create_namespace's description for the full mental model.",
      inputSchema: {},
    },
    () => wrap(() => whoami(deps)),
  );

  server.registerTool(
    "update_namespace",
    {
      description:
        "Update a namespace's labels (displayName, description). Status changes (pause/resume/archive) are operator-only — they go through the CLI/admin API, not MCP.",
      inputSchema: {
        name: z.string(),
        patch: z.object({
          displayName: z.string().nullable().optional(),
          description: z.string().nullable().optional(),
        }),
      },
    },
    (args) => wrap(() => updateNamespaceTool(deps, args)),
  );

  server.registerTool(
    "set_secret",
    {
      description:
        "Store a SENSITIVE value (API key, signing secret, token, password) scoped to a namespace. Read by actions in that same namespace that declare the name in policy.secrets. Secrets are write-only from this surface; values materialize only inside the action unikernel and are never returned by any read tool.\n\n" +
        "Use `set_config` instead for non-sensitive named values (URLs, thresholds, channel names, recipient addresses) — those benefit from being readable and editable in the dashboard.",
      inputSchema: {
        namespace: z.string(),
        name: z.string(),
        value: z.string(),
      },
    },
    (args) => wrap(() => setSecret(deps, args)),
  );

  server.registerTool(
    "set_config",
    {
      description:
        "Store a NON-SENSITIVE value (URL, threshold, channel name, recipient address, etc.) scoped to a namespace. Read by actions that declare the name in policy.configs. Unlike secrets, config values are READABLE — list_configs returns the values, get_config returns a single value, and the dashboard shows them in plain text. Use this for anything the user benefits from being able to see and edit.\n\n" +
        "Pick `set_secret` for credentials and signing material; pick `set_config` for everything else the user sets at runtime.",
      inputSchema: {
        namespace: z.string(),
        name: z.string(),
        value: z.string(),
      },
    },
    (args) => wrap(() => setConfig(deps, args)),
  );

  server.registerTool(
    "get_config",
    {
      description:
        "Return a single config's value. 404 if unset. Has no secret-side analogue — secrets are write-only by design.",
      inputSchema: {
        namespace: z.string(),
        name: z.string(),
      },
    },
    (args) => wrap(() => getConfig(deps, args)),
  );

  server.registerTool(
    "list_configs",
    {
      description:
        "List all configs in a namespace, including their values and timestamps. Use this when an action needs to discover what's already configured, or to render a settings UI.",
      inputSchema: {
        namespace: z.string(),
      },
    },
    (args) => wrap(() => listConfigs(deps, args)),
  );

  server.registerTool(
    "delete_config",
    {
      description: "Remove a config. Idempotent on missing keys.",
      inputSchema: {
        namespace: z.string(),
        name: z.string(),
      },
    },
    (args) => wrap(() => deleteConfig(deps, args)),
  );

  server.registerTool(
    "create_artifact",
    {
      description:
        "**This is the right tool for serving HTML, JS, CSS, or images** — anything where the bytes don't depend on the caller. Bytes go to the daemon and are served at `GET /u/<namespace>/<path>` directly from the blob store (no unikernel boot, no per-request cost). Do NOT have an action return HTML on every page load; use an artifact for the static shell and have its JS fetch webhooks for dynamic data.\n\n" +
        "Public artifacts (default `public: true`) need no auth on the URL. Non-public artifacts (`public: false`) return a `viewToken` at create time — share the URL as `<url>?t=<viewToken>`.\n\n" +
        "**SECURITY: never embed a webhookToken in artifact HTML/JS.** Anyone who can fetch the artifact will read it from page source. For dashboards that need a stable bookmarkable URL AND read live data, use the **artifact-session** pattern (see below) instead.\n\n" +
        "**Why artifacts exist:** giving the agent's app a UI. The same cue daemon serves both `/u/<ns>/*` (artifacts) and `/w/:id` (webhooks), so HTML/JS uploaded as artifacts can `fetch()` webhook URLs on the **same origin** — no CORS, no mixed-content blocking, no third-party iframe sandbox to fight.\n\n" +
        "**Pattern A — public artifact + bearer webhook** (use when the dashboard is genuinely public, e.g. status page that shows already-public data):\n" +
        "  1. create_action — backend logic\n" +
        "  2. create_trigger({ type: 'webhook', actionId, auth: 'bearer' }) — token MUST stay server-side\n" +
        "  3. create_artifact({ path: 'index.html', public: true, content: ... }) — never bakes the token in\n" +
        "  This pattern only works if the dashboard doesn't need to call the webhook from the browser.\n\n" +
        "**Pattern B — private dashboard reading its own data** (the common case for `bookmark this page` UIs):\n" +
        "  1. create_action — handles GET (read) and POST (write) by switching on env.request.method\n" +
        "  2. create_trigger({ type: 'webhook', actionId, auth: 'artifact-session' }) — returns webhookUrl; webhookToken is unused in this mode\n" +
        "  3. create_artifact({ path: 'index.html', public: false, content: ... }) — returns a viewToken\n" +
        "  4. The user bookmarks `http://<daemon>/u/<ns>/index.html?t=<viewToken>`. The page JS does:\n" +
        "       const t = new URLSearchParams(location.search).get('t');\n" +
        "       const r = await fetch('<webhookUrl>?t=' + encodeURIComponent(t) + '&limit=100');\n" +
        "  The `?t=` token gates BOTH the page load and the data fetch; sharing the URL = sharing the dashboard. No long-lived secret in HTML.\n\n" +
        "**Pattern C — third-party ingest + private dashboard** (Stripe-style):\n" +
        "  Reuse Pattern B for the dashboard. Add a SECOND trigger pointing at the same action with `auth: 'public'` for the third-party POST. The action verifies signatures (e.g. Stripe-Signature HMAC) using a stored secret. Two triggers, one action, one artifact.\n\n" +
        "Each create_artifact call uploads ONE file. For multi-file apps (HTML + separate JS/CSS), call create_artifact once per file with paths like `index.html`, `js/app.js`, `styles/main.css`. The HTML can reference siblings via relative paths (`<script src='js/app.js'>`).\n\n" +
        "**MIME** is auto-detected from the path's extension when omitted; explicit `mimeType` wins. Size cap: 10MB per artifact. Path constraints: `[a-zA-Z0-9._/-]+`, no leading/trailing `/`, no `..` or `//`.",
      inputSchema: {
        namespace: z.string(),
        path: z.string(),
        content: z.string(),
        mimeType: z.string().optional(),
        public: z.boolean().optional(),
      },
    },
    (args) => wrap(() => createArtifact(deps, args)),
  );

  server.registerTool(
    "update_artifact",
    {
      description:
        "Update an existing artifact's bytes, MIME, or public flag. Toggling `public: false → true` clears the viewToken; toggling `true → false` mints a fresh one. The URL stays the same.",
      inputSchema: {
        namespace: z.string(),
        path: z.string(),
        patch: z.object({
          content: z.string().optional(),
          mimeType: z.string().optional(),
          public: z.boolean().optional(),
        }),
      },
    },
    (args) => wrap(() => updateArtifact(deps, args)),
  );

  server.registerTool(
    "get_artifact",
    {
      description:
        "Return an artifact's metadata + URL (no bytes). Use read_artifact to fetch content.",
      inputSchema: {
        namespace: z.string(),
        path: z.string(),
      },
    },
    (args) => wrap(() => getArtifact(deps, args)),
  );

  server.registerTool(
    "read_artifact",
    {
      description:
        "Return an artifact's raw content as a utf8 string. Useful when the agent needs to read back what it deployed.",
      inputSchema: {
        namespace: z.string(),
        path: z.string(),
      },
    },
    (args) => wrap(() => readArtifact(deps, args)),
  );

  server.registerTool(
    "list_artifacts",
    {
      description:
        "List all artifacts in a namespace (metadata only, no content).",
      inputSchema: { namespace: z.string() },
    },
    (args) => wrap(() => listArtifacts(deps, args)),
  );

  server.registerTool(
    "delete_artifact",
    {
      description:
        "Delete one artifact. The full namespace's artifacts are also wiped on delete_namespace.",
      inputSchema: {
        namespace: z.string(),
        path: z.string(),
      },
    },
    (args) => wrap(() => deleteArtifactTool(deps, args)),
  );

  server.registerTool(
    "state_append",
    {
      description:
        "Append an entry to the namespace's append-only log at the given key. Returns {seq, at}. " +
        "Same primitive actions reach via `require('/cue-state').append(key, entry)`. Useful for pre-seeding " +
        "a log during development or from outside a unikernel.",
      inputSchema: {
        namespace: z.string(),
        key: z.string(),
        entry: z.unknown(),
      },
    },
    (args) => wrap(() => appendState(deps, args)),
  );

  server.registerTool(
    "state_read",
    {
      description:
        "Read from the namespace's append-only log at the given key. Returns {entries:[{seq,at,entry}], lastSeq}. " +
        "`since` filters to entries with seq > since (exclusive cursor). Use the returned lastSeq as the next since.",
      inputSchema: {
        namespace: z.string(),
        key: z.string(),
        since: z.number().optional(),
        limit: z.number().optional(),
      },
    },
    (args) => wrap(() => readState(deps, args)),
  );

  server.registerTool(
    "state_delete",
    {
      description:
        "Delete a single log key in a namespace. No-op if the key does not exist. To wipe all keys plus " +
        "the namespace's state token, call delete_namespace.",
      inputSchema: {
        namespace: z.string(),
        key: z.string(),
      },
    },
    (args) => wrap(() => deleteStateKey(deps, args)),
  );

  server.registerTool(
    "doctor",
    {
      description: "Health report: daemon, runtime adapter, store adapter, cron scheduler.",
      inputSchema: {},
    },
    () => wrap(() => doctor(deps)),
  );

  return server;
}
