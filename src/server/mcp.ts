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
        "  allowNet: string[]    — hostnames (not URLs) the action can reach over HTTP(S).\n" +
        "  allowTcp: string[]    — 'host:port' entries for raw TCP. Includes loopback (e.g. 127.0.0.1:5432).\n" +
        "  secrets:  string[]    — names of secrets (set via set_secret) forwarded as env vars. Namespace-scoped.\n" +
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
        "  • webhook  — returns { webhookUrl, webhookToken }. The webhookUrl is a single endpoint of shape `http://<daemon>/w/<triggerId>` — there are NO path sub-routes (do not append /increment, /reset, etc.; the URL is opaque). Dispatch happens inside the action by reading `env.request.method` and `env.request.query`.\n\n" +
        "**Webhook auth** accepts the token via `Authorization: Bearer <webhookToken>` OR `?t=<webhookToken>` query param. Programmatic callers should use the header. Browser-clickable URLs should put the token in the query string so a plain GET works without setting headers.\n\n" +
        "**Method semantics:**\n" +
        "  • POST → request body lands at `env.input`; full HTTP context at `env.request`.\n" +
        "  • GET  → `env.input` is null; query params at `env.request.query` for REST-shaped reads.\n\n" +
        "Webhook URLs are served on the SAME origin as artifacts — UIs uploaded via create_artifact can fetch the webhook URL with no CORS or mixed-content. Bake the URL+token into your HTML at deploy time. See create_artifact for the composition pattern.\n\n" +
        "**Webhook URLs are not page URLs.** Don't have an action serve HTML on GET — that's an SSR anti-pattern that boots a unikernel per page load. Use create_artifact for the page; have the page's JS fetch the webhook for dynamic data.\n\n" +
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
        "Store a secret scoped to a namespace. Read by actions in that same namespace that declare the name in policy.secrets. Secrets are write-only from this surface; values materialize only inside the action unikernel.",
      inputSchema: {
        namespace: z.string(),
        name: z.string(),
        value: z.string(),
      },
    },
    (args) => wrap(() => setSecret(deps, args)),
  );

  server.registerTool(
    "create_artifact",
    {
      description:
        "**This is the right tool for serving HTML, JS, CSS, or images** — anything where the bytes don't depend on the caller. Bytes go to the daemon and are served at `GET /u/<namespace>/<path>` directly from the blob store (no unikernel boot, no per-request cost). Do NOT have an action return HTML on every page load; use an artifact for the static shell and have its JS fetch webhooks for dynamic data.\n\n" +
        "Public artifacts (default) need no auth on the URL; non-public artifacts return a `viewToken` at create time — share the URL as `<url>?t=<viewToken>`.\n\n" +
        "**Why artifacts exist:** giving the agent's app a UI. The same cue daemon serves both `/u/<ns>/*` (artifacts) and `/w/:id` (webhooks), so HTML/JS uploaded as artifacts can `fetch()` webhook URLs on the **same origin** — no CORS, no mixed-content blocking, no third-party iframe sandbox to fight. This is the unlock for browser-rendered agent apps.\n\n" +
        "**Compose with actions and triggers** to build a working app:\n" +
        "  1. create_action — backend logic, e.g. `record-visit` that appends to state\n" +
        "  2. create_trigger({ type: 'webhook', actionId }) — returns webhookUrl + webhookToken\n" +
        "  3. create_artifact({ path: 'index.html', content: <bake the webhook URL+token into the HTML> })\n" +
        "  4. open `http://<daemon>/u/<ns>/index.html` in a browser → the JS calls the webhook on same origin\n\n" +
        "**HTML skeleton** (agent bakes the webhook URL/token in at deploy time — they're already known from create_trigger):\n" +
        "  <!doctype html>\n" +
        "  <html><body>\n" +
        "    <button id=hit>Visit</button>\n" +
        "    <pre id=out></pre>\n" +
        "    <script>\n" +
        "      const URL = 'http://127.0.0.1:4747/w/<triggerId>';\n" +
        "      const TOKEN = 'tok_<webhookToken>';\n" +
        "      document.getElementById('hit').onclick = async () => {\n" +
        "        const r = await fetch(URL, {\n" +
        "          method: 'POST',\n" +
        "          headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },\n" +
        "          body: JSON.stringify({})\n" +
        "        });\n" +
        "        document.getElementById('out').textContent = await r.text();\n" +
        "      };\n" +
        "    </script>\n" +
        "  </body></html>\n\n" +
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
