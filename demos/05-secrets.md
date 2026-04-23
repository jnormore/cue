# 05 — Authenticated API call with a secret

> Agent creates an action that uses a **real API key** without putting the key in the action's source, and stores the key directly through MCP — no out-of-band shell export, no daemon restart. Secrets are scoped to the action's namespace, so a rogue action in another namespace can't read them.
>
> Shows off **`policy.secrets`** (the declaration) + **`set_secret`** (the store).

## How it works

Each action declares the secret names it wants via `policy.secrets`. At invoke time, cue resolves those names against `~/.cue/secrets/<namespace>/<name>` (mode 0600) and passes only the matching values into the unikernel via a curated subprocess env. The daemon's own `process.env` is never forwarded — the namespace store is the only secret channel.

If the secret isn't set, the guest sees `undefined` and fails closed; the action's code decides whether to error or no-op.

## The conversation

### 1. "Make me an action that calls `httpbin.org/bearer` with `DEMO_API_KEY` as a Bearer token. Declare the secret in the policy so cue forwards it."

Claude calls `create_action` with namespace `secret`:

```js
(async () => {
  const apiKey = process.env.DEMO_API_KEY;
  if (!apiKey) {
    console.log(JSON.stringify({ error: "DEMO_API_KEY not set — call set_secret for this namespace" }));
    process.exit(1);
  }
  const r = await fetch("https://httpbin.org/bearer", {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  const body = await r.json();
  console.log(JSON.stringify({
    authenticated: body.authenticated === true,
    tokenEchoed: body.token === apiKey,
    maskedPreview: `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`,
  }));
})();
```

Policy:

```json
{
  "allowNet": ["httpbin.org"],
  "secrets":  ["DEMO_API_KEY"],
  "timeoutSeconds": 15
}
```

Note: the action **masks** the key in its stdout (`maskedPreview`). unitask also redacts any verbatim occurrence of the secret from stdout before cue persists it to `~/.cue/runs/<id>/stdout` — double protection.

### 2. "Invoke it — it should fail because the secret isn't set yet."

`invoke_action`:

```json
{
  "runId": "run_01KPZ5B1K8J2WQ3MNDFYXA7H4E",
  "exitCode": 1,
  "output": { "error": "DEMO_API_KEY not set — call set_secret for this namespace" },
  "runtimeRunId": "r_71f82d04",
  "denials": []
}
```

Fail closed, by the action author's choice. cue never invents a value.

### 3. "Stash the key with `set_secret`, then re-invoke."

Claude calls `set_secret`:

```json
{
  "namespace": "secret",
  "name":      "DEMO_API_KEY",
  "value":     "demo-fake-api-key-not-real-12345"
}
```

Response:

```json
{ "ok": true, "namespace": "secret", "name": "DEMO_API_KEY" }
```

Secret is now at `~/.cue/secrets/secret/DEMO_API_KEY` (mode 0600). Re-invoke:

```json
{
  "runId": "run_01KPZ5BJ4NCYA2D8VR1XM7FQPL",
  "exitCode": 0,
  "output": {
    "authenticated": true,
    "tokenEchoed": true,
    "maskedPreview": "demo…2345"
  },
  "runtimeRunId": "r_d83f5346",
  "denials": []
}
```

`tokenEchoed: true` confirms the full key made it through cue → unitask → unikernel → fetch → httpbin and back. Only the masked preview lands in the run record.

### 4. "Show me the scope — a second namespace must not see this."

Claude creates a second action in namespace `other` with the same policy and code, then invokes it without setting the secret:

```json
{
  "exitCode": 1,
  "output": { "error": "DEMO_API_KEY not set — call set_secret for this namespace" }
}
```

Even though `secret/DEMO_API_KEY` exists on disk, `other` gets `undefined`. Each namespace's secrets are an island.

### 5. "Teardown."

```
cue ns delete secret
```

Cue cascades: the `secret` action is gone, and `~/.cue/secrets/secret/` is wiped. The response lists what went:

```json
{
  "deleted": {
    "actions":  ["act_01KPZ58C2T…"],
    "triggers": [],
    "secrets":  ["DEMO_API_KEY"]
  }
}
```

---

## What just happened

A real API key flowed from your chat → cue's per-namespace secret store → the action's unikernel → an outbound HTTPS call — and not into the action's source, not into the run record beyond what the action chose to log, not across namespaces. Every boundary was a declared one.

The guarantee is transitive: because the unikernel's network policy only allowed `httpbin.org`, the key could not have been exfiltrated to an attacker-controlled host even if the action code had tried to. Policy is the floor, not the ceiling.

## Real-world secrets

- `GITHUB_TOKEN` — read/write repos, issues, PRs (`policy.allowNet: ["api.github.com"]`)
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` — model API calls (`allowNet: ["api.openai.com"]` / `api.anthropic.com`)
- `RESEND_API_KEY`, `MAILGUN_API_KEY` — transactional email
- `TWILIO_AUTH_TOKEN` — SMS
- `OPENWEATHER_API_KEY`, `WEATHERAPI_KEY` — weather APIs for daily digests

Typical flow: put a project `.cue.toml` at the repo root with `secrets = ["GITHUB_TOKEN", "OPENAI_API_KEY"]` on the ceiling. Each action picks from that list (or is denied). The ceiling is an allow-list — an action can't claim a secret the ceiling doesn't list, which prevents a rogue action from grabbing every env var. Each namespace still maintains its own values.

## Variations

- **Auto-label a GitHub PR by size** — receive the webhook from [04](./04-github-webhook.md), read `GITHUB_TOKEN`, POST to GitHub's label API.
- **Daily AI-written changelog** — action calls Anthropic API with recent commits from `GITHUB_TOKEN`, scheduled via cron, result POSTed to Slack via another secret.
- **Low-credit alert** — action checks your `OPENAI_API_KEY`'s remaining balance, ntfy-pushes when below a threshold.
- **Rotate without rebuilding** — re-call `set_secret` with the new value; the next invocation picks it up. No daemon restart, no action redeploy.
