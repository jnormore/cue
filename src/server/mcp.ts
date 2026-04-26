import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { StoreError } from "../store/index.js";
import { ScopeError } from "./auth.js";
import {
  createAction,
  createTrigger,
  deleteActionTool,
  deleteNamespaceTool,
  deleteStateKey,
  deleteTrigger,
  doctor,
  getAction,
  getNamespace,
  getTrigger,
  inspectRun,
  invokeActionTool,
  listActionRuns,
  listActions,
  listTriggers,
  type McpToolDeps,
  readState,
  appendState,
  setSecret,
  updateAction,
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
        "Declared primitives (all optional; each is off unless the action opts in):\n" +
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
        "                            as the next `since` cursor.\n" +
        "  timeoutSeconds, memoryMb — runtime caps.\n\n" +
        "Example code using state (a webhook that logs every hit):\n" +
        "  const state = require('/cue-state');\n" +
        "  const env = JSON.parse(require('fs').readFileSync('/cue-envelope.json','utf8'));\n" +
        "  await state.append('hits', { body: env.request?.body, at: new Date().toISOString() });\n",
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
        "Create a cron or webhook trigger for an action. Webhooks return a scoped token + URL.",
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
        "Returns the caller's principal type ('master' | 'agent') and the list of namespaces they can touch — each entry includes status, so the agent can detect paused/archived namespaces before attempting to invoke. For an agent, this enumerates the token's scope; for master, every namespace.",
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
