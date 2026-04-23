# cue

_"Make each program do one thing well"_ assumed humans were writing them — slow, deliberate, by hand. Agents flip this. They can author small, single-purpose programs constantly: for one task, for one user, torn down when no longer useful. The philosophy scales in a way its authors couldn't have imagined.

But durable work needs somewhere to live. Not a conversation context that evaporates. Not a workflow SaaS built for humans clicking through a GUI.

**cue is that runtime.** Any MCP-supporting agent — Claude Code, Cursor, Codex, a chatbot backend, an eval harness — calls `create_action` and `create_trigger` and walks away with a persistent, sandboxed, addressable mini-app. Actions the agent authors become callable — by a schedule, a webhook, an app the agent spun up, another agent. Each invocation runs in a fresh [unitask](https://github.com/jnormore/unitask) unikernel under declarative policy, so scale doesn't mean blast radius.

"App" here is deliberately minimal: **actions** (named code snippets that run on demand) + **triggers** (cron schedules, webhook endpoints). No UI layer — whatever medium the agent is talking to the user on _is_ the UI surface. Claude.ai artifact, Claude Code terminal output, Slack message, your own app — all the same on the backend.

```
  agent  ──authors──▶   cue action   ──fires on──▶  cron
                        (durable)                    webhook POST
                        (sandboxed)                  HTTP URL
                        (addressable)                another agent
```

**Here's how an agent OS starts.** See [demos/](./demos/README.md) for end-to-end walkthroughs of an agent building real apps in ~4 messages (push notifications, live dashboards, …) with verbatim captured output.

## Features

- **Actions** — named JS snippets stored on disk, invoked on demand, each call runs in a fresh unikernel
- **Triggers** — `cron` and `webhook`, managed by the daemon, fire actions with captured input
- **Addressable** — every action gets a stable `http://<host>:<port>/a/<id>` invoke URL + bearer token so UIs, webhooks, and humans can call it
- **MCP server** — stdio _and_ streamable-HTTP transports, same tool surface, one daemon. Local agents over stdio; remote/multi-tenant over HTTP.
- **Policy** (inherited from unitask) — per-action `allowNet`, `allowTcp`, `secrets`, `files`, `dirs`, `timeoutSeconds`, `memoryMb`. Project-root `.cue.toml` sets the ceiling; effective policy = intersection.
- **Namespaces** — flat action/trigger lists with an optional `namespace` tag. `cue ns delete <name>` tears the whole thing down.
- **Run records** — every invocation logs stdout, stderr, exit, input, trigger id, and the unitask run id at `~/.cue/runs/<id>/`
- **`doctor`** — verifies unitask is on PATH, the daemon is up, the port is reachable

## Prereqs

- [unitask](https://github.com/jnormore/unitask) on PATH (`unitask doctor` green)
- Node.js ≥ 20

## Install

```bash
git clone https://github.com/jnormore/cue.git
cd cue
npm install && npm run build && npm link
cue doctor
```

## Run the daemon

```bash
cue serve     # starts HTTP + MCP + cron on localhost
```

Leave it running — terminal pane, tmux, launchd, systemd, your call. Everything else (`cue mcp`, the CLI subcommands, the MCP clients agents spawn) talks to this one process over HTTP.

Binds to `127.0.0.1` by default — local agents over stdio need nothing more. For a remote or shared daemon, bind to a routable interface with `--host`, terminate TLS at a reverse proxy, and give each client a scoped agent token (see [Agent tokens](#agent-tokens)). `/mcp` refuses the master token, so an exposed daemon can't be taken over by a misconfigured client.

The daemon generates a master token at `~/.cue/token` (mode 0600) on first start. It is the operator's credential for the two things that need authentication: `POST /a/:id` (action invocation) and `/state/:ns/:key` (state log reads/writes). All other operator work happens by editing `~/.cue/` directly — the `cue` CLI does this for you, and the daemon's `fs.watch` picks up any change within ~150ms. **`/mcp` does not accept the master token**; every MCP client must carry a scoped agent token minted via `cue token create` (see [Agent tokens](#agent-tokens)). This split means a misconfigured agent client cannot silently run as operator. Webhook triggers and state logs have their own scoped tokens.

## Use via MCP

### From a local agent (stdio)

```bash
cue mcp config claude-code       # → JSON snippet + the path it goes in
cue mcp config claude-desktop    # also: cursor, vscode-copilot
```

Every invocation auto-mints a fresh agent token bound to a brand-new per-client sandbox namespace (e.g. `claude-code-01kpz7abcd`). The agent can only touch that namespace — no other namespace in `~/.cue/` is visible to it. The emitted snippet's header comment reports the sandbox name so you can find it via `cue token list`.

For a stdio client:

```json
{
  "mcpServers": {
    "cue": { "command": "cue", "args": ["mcp", "--token", "atk_..."] }
  }
}
```

`cue mcp --token <agent-token>` is the stdio↔HTTP bridge. It forwards tool calls to the running daemon using the supplied agent token — it does not read the master token. Paste, restart, done.

**Want multiple agents to share a namespace** (e.g., two clients both working in `shop`)? Skip `cue mcp config` and mint manually with `cue token create --namespace shop`, then paste the token into each client's MCP config yourself. `cue mcp config` is the auto-sandbox path; `cue token create` is the explicit-namespace path.

### From a remote agent (HTTP)

Point any MCP client that supports streamable-HTTP directly at the daemon:

```bash
cue mcp config claude-desktop --http
cue mcp config claude-desktop --url https://cue.example.com/mcp
```

Same auto-sandbox behavior as the stdio path. The snippet:

```json
{
  "mcpServers": {
    "cue": {
      "url": "http://cue.example.com/mcp",
      "headers": { "Authorization": "Bearer atk_..." }
    }
  }
}
```

No bridge needed — the client handles HTTP directly. The bearer is a scoped agent token (never the master token). Use this for a remote/shared daemon. For local single-user setups, stdio is simpler.

#### From a custom Node backend

If you're writing a backend that talks to cue over MCP, use the SDK with a **scoped agent token** (never the master token — `/mcp` rejects it):

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const agentToken = "atk_..."; // minted via `cue token create --namespace <ns>`
const client = new Client(
  { name: "my-app", version: "0.1.0" },
  { capabilities: {} },
);
await client.connect(
  new StreamableHTTPClientTransport(new URL("http://cue.example.com/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${agentToken}` } },
  }),
);
await client.callTool({
  name: "create_action",
  arguments: {
    /* ... — must target a namespace in the token's scope */
  },
});
```

For operator-style tooling (minting tokens, managing all namespaces, invoking actions outside of MCP), skip the MCP SDK and talk to `~/.cue/` + `/a/:id` directly — see [Agent tokens](#agent-tokens) and the operator model section below.

### MCP tools

- `create_action(name, code, namespace?, policy?)` → `{ id, invokeUrl }`
- `update_action(id, patch)` / `delete_action(id)`
- `invoke_action(id, input?)` → `{ stdout, stderr, exitCode, runId }`
- `get_action(id)` / `list_actions(namespace?)` / `list_action_runs(id)` / `inspect_run(runId)`
- `create_trigger({ type, config, actionId, namespace? })` → `{ id, webhookUrl? }`
- `delete_trigger(id)` / `get_trigger(id)` / `list_triggers(namespace?)`
- `set_secret(namespace, name, value)` — store a secret scoped to one namespace; read by actions declaring it in `policy.secrets`
- `state_append(namespace, key, entry)` → `{ seq, at }` — append to a namespace's shared log (see [State](#state))
- `state_read(namespace, key, since?, limit?)` → `{ entries, lastSeq }`
- `state_delete(namespace, key)`
- `delete_namespace(name)` — cascades actions, triggers, secrets, state
- `doctor()`

Operator-only operations (minting/revoking agent tokens) happen locally via the `cue` CLI, which writes to `~/.cue/` directly — they are not MCP tools and have no HTTP route. See [Agent tokens](#agent-tokens).

### Secrets

Secrets are **scoped to a namespace** and stored at `~/.cue/secrets/<namespace>/<name>` (mode 0600). The daemon's own `process.env` is never forwarded — the only way a value reaches an action's unikernel is `set_secret` + a matching `policy.secrets` entry on the action. Cross-namespace reads are prohibited: an action in `namespace: "evil"` cannot resolve `shop/SHOPIFY_TOKEN`.

Typical agent-driven flow:

1. Agent writes an action declaring `policy.secrets: ["SHOPIFY_TOKEN"]`.
2. Invoke fails — `process.env.SHOPIFY_TOKEN` is `undefined` inside the guest.
3. Agent asks the user for the token, calls `set_secret({ namespace: "shop", name: "SHOPIFY_TOKEN", value: "shpat_…" })`.
4. Re-invoke succeeds. unitask redacts the value from the run record's stdout.

`delete_namespace` wipes the namespace's secrets along with its actions and triggers.

### State

A namespace-scoped, durable, append-only log that multiple actions in the same namespace can share. Exists because actions run in fresh unikernels that can't see each other's memory, and the `dirs` injection is read-only — so when a webhook-fired action needs to hand data to a polled action, or vice versa, you need a primitive that outlives the unikernel and lives on the daemon.

An action opts in with `policy.state: true`. Inside the unikernel, `require('/cue-state')` returns:

```js
const state = require("/cue-state");
await state.append("orders", { total: 99 }); // → { seq, at }
const { entries, lastSeq } = await state.read("orders", { since: 0 });
await state.delete("orders"); // wipe one key
```

All calls are implicitly scoped to the action's namespace — the helper carries a per-namespace token and the daemon enforces that the URL's namespace matches. An action in `ns: evil` cannot read `ns: shop`'s log.

Storage is backed by a `StateAdapter`, picked the same way as the store/runtime/cron adapters (`CUE_STATE=fs` by default, `.cue.toml` key `state = "fs"`). The `fs` adapter writes to `~/.cue/state/logs/<namespace>/<key>.ndjson` with monotonic `seq` per key, and keeps per-namespace tokens at `~/.cue/state/tokens/<namespace>` (mode 0600). Concurrent appends within a single daemon serialize via a per-key in-process mutex. For scale-out, swap the fs adapter for a Redis or Postgres adapter without touching action code — the interface doesn't change.

From outside a unikernel (agents pre-seeding, debugging, inspection) use the `state_append` / `state_read` / `state_delete` MCP tools or the `/state/:namespace/:key` HTTP routes. `delete_namespace` cascades state (logs + tokens) along with actions, triggers, and secrets.

### Agent tokens

cue has two principal types:

| Principal  | Bearer           | Where it's honored                                                   | Used by                                                |
| ---------- | ---------------- | -------------------------------------------------------------------- | ------------------------------------------------------ |
| **master** | `~/.cue/token`   | `POST /a/:id`, `/state/:ns/:key`, and filesystem access to `~/.cue/` | the local `cue` CLI, operator scripts                  |
| **agent**  | `atk_<id>.<hex>` | `/mcp`, `POST /a/:id`, `/state/:ns/:key`                             | MCP clients (Claude Desktop, Claude Code, Cursor, ...) |

**The master token is not accepted on `/mcp`.** Every MCP client must carry a scoped agent token — there is no way to configure an agent to run as the operator. There is no master-only HTTP surface; master's power comes from filesystem ownership of `~/.cue/`, which the OS gates (the token file is mode 0600).

An agent token is a scoped bearer bound to an explicit namespace allowlist. When an MCP client authenticates with one, the daemon:

- **Filters** `list_actions` / `list_triggers` to the in-scope namespaces.
- **Returns `NotFound`** for `get_action` / `invoke_action` / `inspect_run` / `list_action_runs` / `get_trigger` / `delete_action` / `delete_trigger` / `update_action` on records whose namespace is out of scope — existence is hidden, not just access.
- **Returns `Forbidden`** on `create_action` / `create_trigger` / `set_secret` / `state_append` / `state_read` / `state_delete` / `delete_namespace` targeting an out-of-scope namespace.
- **Never exposes** agent-token CRUD over MCP — minting and revoking happen via the local `cue token` CLI, which writes to `~/.cue/agent-tokens/` directly.

Mint one (CLI writes to `~/.cue/agent-tokens/<id>.json`; no daemon required):

```bash
cue token create --namespace shop --namespace weather --label "claude-desktop"
# → { "id": "atk_...", "token": "atk_....<hex>", "scope": { "namespaces": ["shop","weather"] }, ... }
```

The bearer string is printed **once**; there's no way to recover it later. Re-mint if you lose it.

Or wire an MCP client with an auto-sandbox in one command:

```bash
cue mcp config claude-desktop
```

Every invocation mints a token bound to a fresh per-client sandbox namespace (e.g. `claude-desktop-01kpz7abcd`) and emits an MCP config snippet. For stdio clients, the snippet contains `cue mcp --token atk_...`; for HTTP clients it contains the bearer in the `Authorization` header. The master token never leaves the box. There is no way to emit a config snippet carrying the master token — `cue mcp config` is a sandbox-only path. Use `cue token create --namespace <ns>` above for shared namespaces.

Inspect and revoke:

```bash
cue token list
cue token delete atk_01K...
```

Revocation is immediate — the token's next MCP or HTTP request returns 401.

Storage: `~/.cue/agent-tokens/<id>.json` (mode 0600). Cross-adapter: the `AgentTokenStore` interface lives under `StoreAdapter` alongside `SecretStore`, so a future non-fs store adapter slots in without changing call sites. Tokens use constant-time compare on verify to avoid timing leaks.

**Webhook tokens are orthogonal.** A webhook trigger's scoped token gates _one_ specific trigger's URL and is unaffected by any agent-token scope. A webhook firing into `shop/order-created` still works even if the caller has no agent-token scope for `shop`.

#### Operator model: daemon as observer of disk

Operators don't RPC to the daemon. They mutate `~/.cue/` directly (via the `cue` CLI or any file-writing tool) and the daemon **watches its own store** for changes. Specifically:

- **CLI → filesystem, directly.** Every `cue action`, `cue trigger`, `cue token`, `cue secret`, `cue ns` command opens the store adapter in-process and writes JSON files under `~/.cue/`. No HTTP hop. No running daemon required. `cue action list` works with the daemon stopped; `cue token create` mints a token and writes it to disk regardless of whether `cue serve` is up.
- **Daemon `fs.watch`es its trigger directory.** When a trigger file appears or disappears (because the CLI created/deleted it, or because a `delete_namespace` cascade wiped a subset), the daemon's `CronRegistry` reconciles within ~150ms — scheduling new crons, cancelling vanished ones. No "tell the daemon about this change" RPC exists; the daemon reads fresh from disk.
- **Action invocation uses `/a/:id`.** The one operation that genuinely needs the daemon (spawn a unikernel, stream output, record a run) goes through the same route agents use. Master token works there too.
- **`cue doctor` runs local.** Instantiates each adapter in-process and calls its `doctor()` probe. Separately pings `/health` (unauth) to report daemon liveness. Works with no daemon running — `daemonUp: false` is a valid result.

**The complete HTTP surface:**

| Route                      | Auth                                                     | Purpose                        |
| -------------------------- | -------------------------------------------------------- | ------------------------------ |
| `GET /health`              | none                                                     | liveness probe                 |
| `POST /a/:id`              | master **or** agent (scoped)                             | invoke an action               |
| `POST /w/:id`              | webhook token (per-trigger)                              | fire a webhook                 |
| `/state/:ns/:key[/append]` | master **or** state-token (scoped) **or** agent (scoped) | append-log I/O                 |
| `/mcp`                     | agent only — **master rejected**                         | MCP streamable-HTTP for agents |

There is no master-gated HTTP surface. The operator's power comes from filesystem access — the OS already gates that via `~/.cue/` ownership and the 0600 mode on `~/.cue/token`. If a process can read those files, it's the operator; if it can't, it isn't.

If you're writing operator tooling in another language: **write to `~/.cue/`** for storage-level changes (schema is stable; see `src/store/fs/` for the exact layout), and **POST to `/a/:id`** with the master token for action invocation. That's it.

## CLI quickstart

`cue` is a usable CLI on its own.

```bash
# one action, one cron trigger, one namespace — a daily greeting
cue action create --name hello --namespace demo \
  --code 'console.log("hi at", new Date().toISOString())'

cue trigger create --type cron --action <id> --schedule "0 9 * * *"

# an action behind a webhook, callable from anywhere with the token
cue action create --name echo --namespace demo \
  --code-file echo.js
cue trigger create --type webhook --action <id>
# → http://localhost:4747/w/<triggerId>  (token in response)

# invoke directly
cue action invoke <id> --input '{"name":"world"}'

# tear down
cue ns delete demo
```

Everything else: `cue --help`, `cue action --help`, `cue trigger --help`.

## Configuration

cue reads configuration from three places: CLI flags on `cue serve`, environment variables, and a project-level `.cue.toml` (walked up from cwd, like `git`/`tsc`). Flag > env > `.cue.toml` > default.

### Environment variables

| Variable          | What it does                                            | Default                                    |
| ----------------- | ------------------------------------------------------- | ------------------------------------------ |
| `CUE_HOME`        | State directory (token, port, actions, triggers, runs). | `~/.cue`                                   |
| `CUE_PORT`        | Daemon port.                                            | `4747`, or last value in `<CUE_HOME>/port` |
| `CUE_RUNTIME`     | Runtime adapter. Shipped: `unitask`.                    | `unitask`                                  |
| `CUE_STORE`       | Store adapter. Shipped: `fs`.                           | `fs`                                       |
| `CUE_CRON`        | Cron scheduler. Shipped: `node-cron`.                   | `node-cron`                                |
| `CUE_STATE`       | State adapter. Shipped: `fs`.                           | `fs`                                       |
| `CUE_UNITASK_BIN` | Path to the `unitask` binary.                           | resolved via `PATH`                        |

### `cue serve` flags

`--port <n>` / `-p`, `--host <h>` (default `127.0.0.1`), `--runtime <name>`, `--store <name>`, `--cron <name>`. `cue serve --help` for the full list.

Unknown runtime/store/cron names hard-fail at startup, as does a failed `doctor()` on the selected adapter — there's no silent fallback.

### `.cue.toml` — policy ceilings and adapter pinning

Drop a `.cue.toml` in your project root (or any parent — cue walks up) to cap every action's requested policy. Same shape as `.unitask.toml`:

```toml
memoryMb       = 512
timeoutSeconds = 60
allowNet       = ["api.github.com", "api.openai.com"]
allowTcp       = ["127.0.0.1:5432"]
secrets        = ["GITHUB_TOKEN", "OPENAI_API_KEY"]
files          = ["/Users/me/work/config.yml"]
dirs           = ["/Users/me/work"]
```

Effective policy = requested ∩ ceiling. Denials land in the run record for the audit trail. Missing fields mean no ceiling on that field.

The same file can pin adapter selection for the project:

```toml
runtime = "unitask"
store   = "fs"
cron    = "node-cron"
state   = "fs"
```

## Tests

```bash
npm test             # unit
npm run smoke        # boots a real daemon, drives both MCP transports
npm run cli          # exercises the `cue` CLI against a real daemon
npm run integration  # hits a real `unitask` binary (must be on PATH)
npm run verify       # typecheck + build + unit + smoke + cli
```

## License

MIT.
