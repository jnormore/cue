# 02 — Push notification agent

> Agent authors an app that pushes real notifications to your phone or browser. Uses [ntfy.sh](https://ntfy.sh) — free, no signup, no API key. You subscribe to a random topic; cue posts messages to that topic; your device rings.
>
> This is the first demo with a **visible UI surface**: messages actually appear in your notification center.

## Setup

One-time: install the [ntfy app](https://ntfy.sh/app) on your phone or open [ntfy.sh](https://ntfy.sh) in a browser. Pick a unique topic name — any random string works. For this walkthrough, we'll use `cue-demo-fb95457c123b` (generated with `openssl rand -hex 6`). **Use your own** — topics are unauthenticated, anyone with the name can post or subscribe.

Subscribe your phone/browser to the topic before continuing.

`cue serve` is running in the background. cue is configured as an MCP server in your agent.

## The conversation

### 1. "Make me an action that fetches a GitHub Zen quote and pushes it as a notification to my phone via ntfy.sh, topic `cue-demo-fb95457c123b`. Schedule it for 9am every morning, and give me a webhook URL for manual fires."

Claude calls `create_action`:

```js
(async () => {
  const env = JSON.parse(require("fs").readFileSync("/cue-envelope.json", "utf8"));
  const zen = await (await fetch("https://api.github.com/zen", {
    headers: { "User-Agent": "cue-demo" },
  })).text();
  const r = await fetch("https://ntfy.sh/cue-demo-fb95457c123b", {
    method: "POST",
    headers: { "Title": "cue: daily zen", "Tags": "robot,sparkles" },
    body: zen.trim(),
  });
  console.log(JSON.stringify({
    topic: "cue-demo-fb95457c123b",
    zen: zen.trim(),
    firedBy: env.trigger?.type ?? "direct",
    delivered: r.ok,
  }));
})();
```

with policy `{ allowNet: ["ntfy.sh", "api.github.com"], timeoutSeconds: 15 }`. Two hosts whitelisted — nothing else is reachable from inside the sandbox.

cue returns:

```json
{
  "id": "act_01KPY28155E4YQQXFE3FK9253G",
  "name": "daily-zen-notify",
  "namespace": "notify",
  "invokeUrl": "http://127.0.0.1:52746/a/act_01KPY28155E4YQQXFE3FK9253G"
}
```

Then `create_trigger` for cron (`"0 9 * * *"`) and `create_trigger` for webhook. The webhook response includes a scoped token:

```json
{
  "id": "trg_01KPY28NZJ2ACQHZJMCTFZT1EZ",
  "type": "webhook",
  "actionId": "act_01KPY28155E4YQQXFE3FK9253G",
  "webhookUrl": "http://127.0.0.1:52746/w/trg_01KPY28NZJ2ACQHZJMCTFZT1EZ",
  "webhookToken": "tok_c51eb8d8463eee952ac1dfd0e39597ecd35af6764a43c420c7d2a14c1707c0c3"
}
```

Claude hands you the webhook URL + token so you can fire on demand.

### 2. "Fire it once so I can see the notification land on my phone."

Claude calls `invoke_action`. A unikernel boots, fetches zen, POSTs to ntfy, tears down. ntfy pushes to every device subscribed to your topic.

**Your phone buzzes.** Notification banner:

> **cue: daily zen**
> Accessible for all.
> 🤖✨

cue returns to Claude:

```json
{
  "runId": "run_01KPY287ZHSZE6EXVTWC97WKTZ",
  "exitCode": 0,
  "stdout": "{\"topic\":\"cue-demo-fb95457c123b\",\"zen\":\"Accessible for all.\",\"firedBy\":\"direct\",\"delivered\":true}",
  "output": {
    "topic": "cue-demo-fb95457c123b",
    "zen": "Accessible for all.",
    "firedBy": "direct",
    "delivered": true
  },
  "runtimeRunId": "r_1a999b98",
  "denials": []
}
```

### 3. "Give me a terminal command I can run to fire it manually anytime."

Claude hands you:

```bash
curl -X POST "http://127.0.0.1:52746/w/trg_01KPY28NZJ2ACQHZJMCTFZT1EZ" \
  -H "Authorization: Bearer tok_c51eb8d8..." \
  -H "Content-Type: application/json" \
  -d '{}'
```

You run it. Phone buzzes again. Verbatim response:

```json
{"runId":"run_01KPY28P2QC2TD8D4XMHZNX1Z1","exitCode":0,
 "stdout":"{\"topic\":\"cue-demo-fb95457c123b\",\"zen\":\"Accessible for all.\",\"firedBy\":\"webhook\",\"delivered\":true}",
 "output":{...,"firedBy":"webhook","delivered":true},
 "runtimeRunId":"r_b82f8aee","denials":[]}
```

The action picked up `firedBy: "webhook"` this time — same code, context-aware via the envelope.

### 4. "Show me runs, then clean up."

Claude calls `list_action_runs`:

```json
[
  { "id": "run_01KPY28P2QC2TD8D4XMHZNX1Z1",
    "firedAt": "2026-04-23T20:59:51.767Z",
    "triggerId": "trg_01KPY28NZJ2ACQHZJMCTFZT1EZ",
    "finishedAt": "2026-04-23T20:59:53.073Z", "exitCode": 0 },
  { "id": "run_01KPY287ZHSZE6EXVTWC97WKTZ",
    "firedAt": "2026-04-23T20:59:37.329Z",
    "finishedAt": "2026-04-23T20:59:38.421Z", "exitCode": 0 }
]
```

Two invocations, ~1.1s each (unikernel boot + fetch + post + teardown). Then `delete_namespace("notify")`:

```json
{
  "deleted": {
    "actions": ["act_01KPY28155E4YQQXFE3FK9253G"],
    "triggers": [
      "trg_01KPY28NT2FBWFCA8WHD53QSP2",
      "trg_01KPY28NZJ2ACQHZJMCTFZT1EZ"
    ]
  }
}
```

Cron handle cancelled, webhook deactivated, action deleted. The 9am cron will not fire tomorrow.

---

## What just happened

An agent you talked to in English built you a scheduled push-notification app. Nothing about it was cue-specific from your perspective: you described what you wanted, your phone buzzed.

Under the hood:
- **Every invocation was sandboxed.** The action could reach `ntfy.sh` and `api.github.com` — nothing else. No filesystem, no other network, no host access.
- **The app outlives the conversation.** Close Claude, reboot your laptop. The 9am cron will still fire, the webhook URL will still work, as long as `cue serve` is running.
- **The agent wasn't a daemon.** It authored, then left. The cue daemon is the only long-running thing.

## Variations you could ask for instead

- Stock/crypto price alert on threshold crossing (`if price > X, ntfy`)
- GitHub notifications digest every morning (`fetch notifications, summarize, ntfy title + body`)
- Uptime pinger (`fetch your service, if !ok, ntfy`)
- Daily weather report (requires a weather API; policy adds that host)

Each is four messages to the agent, same shape as this one.
