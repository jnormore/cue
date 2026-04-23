# 03 — Live dashboard with a browser page

> Agent authors **both sides** of a mini app in one conversation: a cue action that returns data, and a small HTML page that polls the action's invoke URL and renders it. The user opens the page in a browser and sees live data.
>
> This is the first demo with a **graphical UI surface** (HTML in your browser, not just notifications).

## The unlock: CORS

Browsers enforce same-origin for cross-origin fetches by default. For an HTML page at `file://` (or any non-cue origin) to call cue's `/a/:id` endpoint, cue has to send CORS headers.

cue ships with CORS disabled by default (strict, same-origin only). Enable it for development:

```bash
cue serve --cors '*'                                        # any origin (dev only)
cue serve --cors 'https://your-browser-origin.example.com'  # allow-list
CUE_CORS='https://a.example.com,https://b.example.com' cue serve
```

Or pin per project in `.cue.toml`:

```toml
cors = ["https://a.example.com", "https://b.example.com"]
# or:
cors = "*"
```

**Don't run `--cors '*'` on anything reachable from the public internet.** It grants any origin the ability to call your daemon (still bearer-gated, but the bearer is easily lifted via CSRF from a malicious page). For local dev on `127.0.0.1`, it's fine.

## The conversation

### 1. "Make me a cue action that returns GitHub star/fork counts for `anthropics/claude-code`, and an HTML page I can open in a browser that polls it every 10 seconds."

Claude calls `create_action`:

```js
(async () => {
  const r = await fetch(
    "https://api.github.com/repos/anthropics/claude-code",
    { headers: { "User-Agent": "cue-demo", "Accept": "application/vnd.github+json" } },
  );
  const repo = await r.json();
  console.log(JSON.stringify({
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    at: new Date().toISOString(),
  }));
})();
```

with policy `{ allowNet: ["api.github.com"], timeoutSeconds: 10 }`, namespace `dashboard`.

cue returns:

```json
{
  "id": "act_01KPY37G0FM7VTF5NR81FCRFGA",
  "name": "stars",
  "namespace": "dashboard",
  "invokeUrl": "http://127.0.0.1:54456/a/act_01KPY37G0FM7VTF5NR81FCRFGA"
}
```

### 2. "Invoke it once so I can see the shape."

`invoke_action`:

```json
{
  "runId": "run_01KPY37QBWWF1WYXPGE04NG4D2",
  "exitCode": 0,
  "output": {
    "stars": 117305,
    "forks": 19521,
    "at": "2026-04-23T21:16:49.210Z"
  },
  "runtimeRunId": "r_3be70086",
  "denials": []
}
```

Real counts from the live GitHub API, fetched inside a unikernel that's only allowed to talk to `api.github.com`.

### 3. "Now the HTML."

Claude writes a self-contained file you can save as `dashboard.html` and open from your desktop (or return it inline as a Claude.ai artifact):

```html
<!doctype html>
<html>
<body style="font-family: system-ui; padding: 2rem;">
  <h1>⭐ <span id="stars">—</span> &nbsp; 🍴 <span id="forks">—</span></h1>
  <p><small id="at">loading…</small></p>
  <script>
  const URL   = "http://127.0.0.1:54456/a/act_01KPY37G0FM7VTF5NR81FCRFGA";
  const TOKEN = "<paste your daemon's ~/.cue/token here>";
  async function tick() {
    try {
      const r = await fetch(URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      const j = await r.json();
      document.getElementById("stars").textContent = j.output.stars.toLocaleString();
      document.getElementById("forks").textContent = j.output.forks.toLocaleString();
      document.getElementById("at").textContent    = `updated ${j.output.at}`;
    } catch (e) {
      document.getElementById("at").textContent = `error: ${e.message}`;
    }
  }
  tick();
  setInterval(tick, 10_000);
  </script>
</body>
</html>
```

### 4. "Which bearer token do I use?"

Claude points you at `~/.cue/token` — that's the master daemon token. Each invocation via `/a/:id` needs it.

**For sharing publicly**, Claude would instead create a **webhook trigger** and use the scoped `webhookToken` — lower blast radius, easily revoked, doesn't expose the master key. Rewriting the HTML to hit `/w/:triggerId` with the scoped token works the same way.

### 5. "Open the page."

You save the HTML, open it in a browser. The page immediately makes a cross-origin POST to cue (because `file://` ≠ `http://127.0.0.1:54456`). With CORS enabled, the browser sees:

```
POST /a/act_01KPY37G0FM7VTF5NR81FCRFGA
< HTTP/1.1 200 OK
< vary: Origin
< access-control-allow-origin: https://example.com
< content-type: application/json; charset=utf-8
{"stars":117305,"forks":19521,"at":"2026-04-23T21:16:50.213Z",...}
```

(Verified from the daemon with a curl simulating the browser: `curl -H "Origin: https://example.com" …` → `access-control-allow-origin: https://example.com` on both the OPTIONS preflight and the POST.)

Dashboard updates. 10 seconds later it refreshes. Each refresh is a real unikernel boot behind the scenes.

### 6. "Teardown."

```
cue ns delete dashboard
```

Action gone. The HTML page starts erroring (404 from `/a/:id`). Delete the HTML file too.

---

## What just happened

You described a dashboard in English; Claude shipped a backend (sandboxed, policy-bounded, persisted) + a frontend (vanilla HTML fetch loop) that talks to it. Neither side required build tooling or framework conventions — the backend is a 10-line snippet that runs in a fresh unikernel; the frontend is plain HTML you can open from your desktop.

The pattern generalises: any time you want "a page that shows live data from an API I can only safely call with a key", this is the shape. Action holds the key + the policy; HTML is static and keyless for the user's data flow (because only the cue daemon token authenticates it to cue — the underlying API key never leaves the unikernel).

## Variations

- **Scoped token instead of master**: agent creates a webhook trigger, HTML posts to `/w/:id` with the `webhookToken`. You can paste the HTML anywhere without leaking the master.
- **Push instead of poll**: action POSTs data to a realtime service (Ably, Pusher, Supabase realtime) on each fire; HTML subscribes to that. Good when you want sub-second updates without hitting the action on every tick.
- **Multiple data sources**: one page fetches N actions in parallel, renders a grid.
- **Claude.ai artifact**: if you want Claude.ai to *render* the HTML for you (not save to disk), the artifact fetches against a publicly-reachable cue URL — run cue behind `cloudflared tunnel --url http://localhost:<port>` and point the artifact at the tunnel URL. Future dedicated demo pending.
