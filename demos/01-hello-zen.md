# 01 — Hello, Zen

> The minimum demo: a four-message conversation, a cron schedule, a webhook URL, and no ceremony. Proves the sandbox + scheduling story, no UI surface beyond terminal output.
>
> For a demo with a visible app UI (push notifications that hit your phone), continue to [02-push-notify](./02-push-notify.md).

The pitch of cue: **any MCP-aware agent can author a durable, sandboxed app in a handful of tool calls.** This walkthrough shows what that actually looks like.

You're in Claude Desktop (or Claude Code, Cursor, any MCP-aware client) with cue configured as an MCP server:

```json
{
  "mcpServers": {
    "cue": { "command": "cue", "args": ["mcp"] }
  }
}
```

`cue serve` is running in the background.

What you'll build: a tiny "GitHub Zen" tracker — an action that fetches a zen quote from the GitHub API, scheduled every five minutes, plus a webhook URL so you can fire it on demand.

---

## 1. "Make me an action that fetches a GitHub Zen quote."

Claude writes the code and calls `create_action`:

```js
// the action body Claude authors
(async () => {
  const env = JSON.parse(
    require("fs").readFileSync("/cue-envelope.json", "utf8"),
  );
  const r = await fetch("https://api.github.com/zen", {
    headers: { "User-Agent": "cue-demo" },
  });
  console.log(JSON.stringify({
    quote: (await r.text()).trim(),
    firedBy: env.trigger?.type ?? "direct",
  }));
})();
```

Policy: `{ allowNet: ["api.github.com"], timeoutSeconds: 15 }`. Namespace: `demo`.

cue returns:

```json
{
  "id": "act_01KPY1PTR4PQ5NXSFVG30G67S0",
  "name": "github-zen",
  "namespace": "demo",
  "invokeUrl": "http://127.0.0.1:52088/a/act_01KPY1PTR4PQ5NXSFVG30G67S0"
}
```

The action is now persisted. It survives agent restarts, machine reboots, and conversation turnover.

---

## 2. "Run it once so I can see."

Claude calls `invoke_action` with that id. cue spawns a unikernel (via unitask), runs the JS against the real GitHub API, captures stdout, tears the unikernel down, returns:

```json
{
  "runId": "run_01KPY1Q4B3NS16M95RGRPFPJR6",
  "exitCode": 0,
  "stdout": "{\"quote\":\"Favor focus over features.\",\"firedBy\":\"direct\"}",
  "stderr": "",
  "output": {
    "quote": "Favor focus over features.",
    "firedBy": "direct"
  },
  "runtimeRunId": "r_17eb24e3",
  "denials": []
}
```

The quote is real, fetched from `api.github.com/zen` inside a sandbox that's only allowed to talk to that hostname.

---

## 3. "Schedule it every five minutes, and give me a URL I can curl manually."

Claude calls `create_trigger` twice — once for cron, once for webhook:

```json
// cron
{ "id": "trg_01KPY1Q5BBWZ5NY653E2CR49QN", "type": "cron",
  "actionId": "act_01KPY1PTR4PQ5NXSFVG30G67S0" }

// webhook
{ "id": "trg_01KPY1Q5KEMX19FPP0KMY9FQZD", "type": "webhook",
  "actionId": "act_01KPY1PTR4PQ5NXSFVG30G67S0",
  "webhookUrl": "http://127.0.0.1:52088/w/trg_01KPY1Q5KEMX19FPP0KMY9FQZD",
  "webhookToken": "tok_931a06356f0926c8174f9e45cbc2acb34a2811fea4a0503cb2561f2977f446f2" }
```

Claude hands you a ready-to-paste curl command:

```bash
curl -X POST "http://127.0.0.1:52088/w/trg_01KPY1Q5KEMX19FPP0KMY9FQZD" \
  -H "Authorization: Bearer tok_931a..." \
  -H "Content-Type: application/json" \
  -d '{}'
```

You run it and get:

```json
{"runId":"run_01KPY1QB0DAFKQA8P4G0R0BSZF","exitCode":0,
 "stdout":"{\"quote\":\"Design for failure.\",\"firedBy\":\"webhook\"}",
 "output":{"quote":"Design for failure.","firedBy":"webhook"},
 "runtimeRunId":"r_a7d81315","denials":[]}
```

Notice the action picked up `firedBy: "webhook"` because the envelope told it the invocation came from a webhook trigger. Same code, context-aware.

Meanwhile, node-cron is wired to the `*/5 * * * *` schedule — the action will fire every five minutes until you remove the trigger, even if Claude is offline.

---

## 4. "Show me what's run so far, then tear it down."

Claude calls `list_action_runs`:

```json
[
  {
    "id": "run_01KPY1QB0DAFKQA8P4G0R0BSZF",
    "firedAt": "2026-04-23T20:50:23.373Z",
    "triggerId": "trg_01KPY1Q5KEMX19FPP0KMY9FQZD",
    "finishedAt": "2026-04-23T20:50:24.088Z",
    "exitCode": 0
  },
  {
    "id": "run_01KPY1Q4B3NS16M95RGRPFPJR6",
    "firedAt": "2026-04-23T20:50:16.547Z",
    "finishedAt": "2026-04-23T20:50:17.436Z",
    "exitCode": 0
  }
]
```

Then `delete_namespace("demo")`:

```json
{
  "deleted": {
    "actions": ["act_01KPY1PTR4PQ5NXSFVG30G67S0"],
    "triggers": [
      "trg_01KPY1Q5BBWZ5NY653E2CR49QN",
      "trg_01KPY1Q5KEMX19FPP0KMY9FQZD"
    ]
  }
}
```

Action and both triggers gone. The cron handle is cancelled — no more fires. **Run records are preserved** as an audit trail; if you care about a specific one, `inspect_run("run_…")` still works.

---

## What just happened

Four natural-language messages. Under the hood, exactly these MCP tool calls:

1. `create_action` → `{ id, invokeUrl }`
2. `invoke_action(id)` → stdout/exit/runtimeRunId
3. `create_trigger(cron)` + `create_trigger(webhook)` → `{ trigger ids, webhookUrl, webhookToken }`
4. `list_action_runs(id)` + `delete_namespace("demo")` → cascade delete

Each invocation ran in a fresh [unitask](https://github.com/jnormore/unitask) unikernel under a declarative policy (`allowNet: ["api.github.com"]`, nothing else). No long-running containers. No shared state between runs. No trust extended to the action code beyond what the policy explicitly allowed.

The action still exists on disk between fires. The cron trigger is held by node-cron inside the daemon. The webhook URL is addressable by anyone with the scoped token. The agent is no longer required for the app to function — it was authored, not hosted.

That's the distinction cue draws: agents build, the host runs.

---

## What else you could build with the same four-message pattern

- **Daily weather digest** — wttr.in or openweather, policy `allowNet: ["wttr.in"]`, cron `"0 9 * * *"`.
- **GitHub webhook responder** — webhook trigger, action parses `env.request.body.pull_request` and logs it.
- **Uptime pinger** — action fetches your service URL, logs status + latency, cron every minute.
- **Scheduled scrape** — action pulls a page, parses it, writes the result to run record. `inspect_run` later to get the data.
- **One-off reminder** — webhook trigger + cron trigger at a specific ISO time. Fire once, let it run, delete the namespace.

All five are four messages and a few MCP tool calls.
