# 04 — GitHub webhook auto-responder

> Agent builds a bot that receives GitHub webhook deliveries, parses the payload, and routes by event type. No external services; the cue webhook URL *is* the integration endpoint.
>
> Shows off the **`envelope.request`** side of the invocation envelope — headers, body, method all flow into the action exactly as HTTP delivered them.

## The conversation

### 1. "Make me an action that receives GitHub webhook deliveries and prints a one-line summary. Handle `pull_request.opened` and `issues.opened`; everything else labelled `unhandled`."

Claude calls `create_action` with code that inspects `env.request`:

```js
(async () => {
  const env   = JSON.parse(require("fs").readFileSync("/cue-envelope.json", "utf8"));
  const body  = env.request?.body ?? {};
  const event = env.request?.headers?.["x-github-event"] ?? "unknown";
  let out;
  if (event === "pull_request" && body.action === "opened" && body.pull_request) {
    const pr = body.pull_request;
    out = {
      type: "pr_opened",
      number: pr.number,
      title: pr.title,
      author: pr.user?.login,
      url: pr.html_url,
      diff: { additions: pr.additions, deletions: pr.deletions },
      summary: `📬 New PR #${pr.number}: "${pr.title}" by @${pr.user?.login} (+${pr.additions}/-${pr.deletions})`,
    };
  } else if (event === "issues" && body.action === "opened" && body.issue) {
    const i = body.issue;
    out = {
      type: "issue_opened",
      number: i.number,
      title: i.title,
      author: i.user?.login,
      summary: `🐛 New issue #${i.number}: "${i.title}" by @${i.user?.login}`,
    };
  } else {
    out = { type: "unhandled", event, action: body.action ?? null };
  }
  console.log(JSON.stringify(out));
})();
```

Policy: `{ timeoutSeconds: 10 }`. No network needed — this action just parses input.

cue returns:

```json
{ "id": "act_01KPY2SYN5030J5KFMZQBFZF7F", "name": "github-webhook-router",
  "namespace": "gh", "invokeUrl": "…" }
```

Then `create_trigger` with `{ type: "webhook", actionId: "act_…" }`:

```json
{ "id": "trg_01KPY2T68QY7FE9AMRMGMXDG7Y", "type": "webhook",
  "webhookUrl":   "http://127.0.0.1:53654/w/trg_01KPY2T68QY7FE9AMRMGMXDG7Y",
  "webhookToken": "tok_f04c38d8…" }
```

### 2. "Paste the webhook URL + token into GitHub repo Settings → Webhooks, or simulate it with curl to see the shape."

```bash
curl -X POST "http://127.0.0.1:53654/w/trg_…" \
  -H "Authorization: Bearer tok_f04c38d8…" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -d '{
    "action": "opened",
    "pull_request": {
      "number": 123,
      "title": "Add dark mode toggle",
      "html_url": "https://github.com/jnormore/cue/pull/123",
      "user": { "login": "alice" },
      "additions": 42,
      "deletions": 7
    }
  }'
```

Verbatim response:

```json
{
  "runId": "run_01KPY2T6BWVF6Z2E747MN8ZG1T",
  "exitCode": 0,
  "output": {
    "type": "pr_opened",
    "number": 123,
    "title": "Add dark mode toggle",
    "author": "alice",
    "url": "https://github.com/jnormore/cue/pull/123",
    "diff": { "additions": 42, "deletions": 7 },
    "summary": "📬 New PR #123: \"Add dark mode toggle\" by @alice (+42/-7)"
  },
  "runtimeRunId": "r_aacfa9fe",
  "denials": []
}
```

Same trigger, `issues.opened` event (`-H "X-GitHub-Event: issues"`):

```json
{
  "output": {
    "type": "issue_opened",
    "number": 7,
    "title": "Docs: add CORS example",
    "author": "bob",
    "summary": "🐛 New issue #7: \"Docs: add CORS example\" by @bob"
  }
}
```

A `push` event it doesn't handle:

```json
{
  "output": { "type": "unhandled", "event": "push", "action": null }
}
```

### 3. "Teardown."

```
cue ns delete gh
```

Cue cancels the webhook route, deletes the action. Past runs remain on disk as an audit trail.

---

## What just happened

cue gave your agent a **real public webhook endpoint** in one MCP call. The endpoint:

- authenticates via a scoped per-trigger token (no master-token sharing)
- hands the full HTTP request to the action as a JSON envelope (`method`, `url`, `query`, `headers`, `body`)
- runs each invocation in a fresh unikernel — no persistent state between events

The action itself is a switch statement over `x-github-event` headers and `body.action`. That's genuinely all a GitHub event router is. You can wire this behind an nginx `proxy_pass` or cloudflared tunnel to make it reachable from github.com.

## Variations

- **Auto-label PRs** by size — read `additions`/`deletions`, invoke GitHub's label API via an authenticated action (see [05-secrets](./05-secrets.md) for the auth pattern).
- **Push to Discord/Slack** — add policy `allowNet: ["discord.com"]`, POST the summary as a chat webhook message.
- **Fan-out** — one webhook trigger, action invokes multiple downstream actions (e.g., log + notify + file-an-issue).
- **Rate-gate** — action reads its own recent `list_action_runs` via cue's MCP and no-ops if the last fire was <5 min ago.
