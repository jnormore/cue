# Demos

Each demo is a self-contained conversation between you and an MCP-aware agent (Claude Desktop, Claude Code, Cursor, …) with cue configured as an MCP server. They get progressively more real.

| #                                  | Demo                                              | UI surface                              | Setup cost                                                      |
| ---------------------------------- | ------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------- |
| [01](./01-hello-zen.md)            | Hello, Zen                                        | terminal output                         | none                                                            |
| [02](./02-push-notify.md)          | Push-notification agent                           | phone/browser notifications via ntfy.sh | ~30s (install ntfy app, pick topic)                             |
| [03](./03-live-dashboard.md)       | Live dashboard with a browser page                | HTML in a browser tab                   | enable `--cors` on `cue serve`                                  |
| [04](./04-github-webhook.md)       | GitHub webhook auto-responder                     | action fires on GitHub events           | ~1 min (register GitHub webhook, or curl a synthetic payload)   |
| [05](./05-secrets.md)              | Authenticated API call with a secret              | terminal output (masked)                | export an env var before `cue serve`                            |
| [06](./06-shopify-dashboard.md)    | Shopify live dashboard with confetti on new orders | HTML in a browser tab + webhook         | ~2 min (Shopify custom-app token, `--cors` on `cue serve`)      |
| 07 (planned)                       | Daily digest → Discord/Slack channel              | chat channel message                    | ~1 min (paste a channel webhook URL into the action)            |
| 08 (planned)                       | Claude.ai artifact + cue action                   | rich React/HTML artifact in chat        | requires tunneling (cloudflared / ngrok)                        |

Every demo ends with:

- a `delete_namespace` teardown
- a "what just happened" paragraph
- 3–5 variations you could ask the agent for instead

Demos 01–05 also include verbatim output (real ids, real tokens, real results) from a recorded run. 06 is end-to-end reproducible via curl; the Shopify Admin API responses are illustrative since they depend on your real store.

## Capabilities covered

| Capability                                  | 01  | 02  | 03  | 04  | 05  | 06  |
| ------------------------------------------- | --- | --- | --- | --- | --- | --- |
| `create_action` + `invoke_action`           | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  |
| `create_trigger` cron                       | ✅  | ✅  |     |     |     |     |
| `create_trigger` webhook (outbound POST)    | ✅  | ✅  |     |     |     |     |
| `create_trigger` webhook (inbound events)   |     |     |     | ✅  |     | ✅  |
| `policy.allowNet`                           |     | ✅  | ✅  |     | ✅  | ✅  |
| `policy.secrets`                            |     |     |     |     | ✅  | ✅  |
| `policy.state` (shared log across actions)  |     |     |     |     |     | ✅  |
| CORS for browser callers                    |     |     | ✅  |     |     | ✅  |
| envelope `request.body` / `request.headers` |     |     |     | ✅  |     | ✅  |
| Agent authors both sides (action + HTML)    |     |     | ✅  |     |     | ✅  |

## Pre-reqs shared across demos

- [unitask](https://github.com/jnormore/unitask) on PATH (`unitask doctor` green)
- `cue serve` running: `CUE_HOME=~/.cue cue serve` (or a clean `CUE_HOME=/tmp/cue-demo cue serve` for throwaway state)
- cue configured as an MCP server in your agent: `cue mcp config claude-desktop` (or `claude-code` / `cursor`) — paste the snippet, restart the agent

Every demo uses a throwaway `namespace` (`demo`, `notify`, etc.) so you can try multiple and tear each one down cleanly.
