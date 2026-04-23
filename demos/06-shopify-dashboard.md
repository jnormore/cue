# 06 — Shopify live dashboard with confetti on new orders

> A merchant gets a live ops dashboard (today's revenue, order count, low-stock SKUs) **and** every `orders/create` webhook from Shopify bursts confetti on the open browser tab.
>
> Shows how two independent actions — one polled by the browser, one fired by a webhook — cooperate via **`policy.state`**: cue's namespace-scoped append-only log. That's the fanout channel when you need a webhook event to reach a polling surface without either action knowing about the other.
>
> Unlike demos 01–05, the Shopify Admin API responses below are illustrative (numbers depend on your real store). The webhook → confetti flow is reproducible end-to-end with `curl`.

## The setup

One local bit before you talk to the agent:

```bash
cue serve --cors '*'               # CORS so the HTML page can hit the action
```

The Shopify custom app + access token come up *in the conversation* — the agent tells you exactly what to do.

Two actions in the `shop` namespace share a state log: `order-created` appends an entry every time Shopify fires a webhook; `tick` reads that log on each poll and hands any new entries to the dashboard. cue's state primitive is namespace-scoped by design — the `shop` namespace's log is unreachable from any other namespace. Credentials live under `~/.cue/secrets/shop/` via `set_secret`; see [05](./05-secrets.md) for the full secrets model.

## The conversation

### 1. "I run a Shopify store at acme-test.myshopify.com. Build me a dashboard I can leave open on my laptop — today's revenue, order count, any items running low on stock. Every time a new order comes in, I want confetti on the page with the amount."

Claude's reply (paraphrased):

> I'll build this as two cue actions + one webhook trigger + a single HTML file:
>
> - A **`tick`** action the dashboard polls every 3s. Hits Shopify's Admin API for today's orders, revenue, and inventory; also reads any new orders the webhook has appended to the namespace's state log.
> - An **`order-created`** action wired to a Shopify webhook. When Shopify fires `orders/create`, it appends one entry to the `shop` namespace's `orders` log via `require('/cue-state').append('orders', row)`. `tick` picks it up on its next poll using a `since` cursor.
> - The **HTML page** polls `tick`, updates the numbers, and bursts `canvas-confetti` for each new row — more particles for bigger orders, gold for $100+.
>
> I need an **Admin API access token** for your store. In Shopify admin: **Settings → Apps and sales channels → Develop apps → Create an app** → name it anything → **Configure Admin API scopes** → check `read_orders`, `read_products`, `read_inventory` → **Save** → **Install app** → under *Admin API access token*, **Reveal token once** (starts with `shpat_…`; Shopify only shows it once, so copy it). Paste it here when you have it.

Claude then calls `create_action` for `tick`:

```js
(async () => {
  const fs  = require("fs");
  const state = require("/cue-state");
  const env = JSON.parse(fs.readFileSync("/cue-envelope.json", "utf8"));
  const sinceSeq = Number(env.request?.body?.since ?? 0);

  const shop  = process.env.SHOPIFY_SHOP;
  const token = process.env.SHOPIFY_TOKEN;
  if (!shop || !token) {
    console.log(JSON.stringify({ error: "missing SHOPIFY_SHOP or SHOPIFY_TOKEN" }));
    process.exit(1);
  }
  const h = { "X-Shopify-Access-Token": token, "Accept": "application/json" };

  const todayMin = new Date(); todayMin.setUTCHours(0, 0, 0, 0);

  const ordersR = await fetch(
    `https://${shop}/admin/api/2024-10/orders.json` +
      `?status=any&created_at_min=${todayMin.toISOString()}&limit=250` +
      `&fields=id,total_price,created_at`,
    { headers: h },
  );
  const { orders = [] } = await ordersR.json();
  const revenue = orders.reduce((s, o) => s + Number(o.total_price || 0), 0);

  const productsR = await fetch(
    `https://${shop}/admin/api/2024-10/products.json?limit=100&fields=id,title,variants`,
    { headers: h },
  );
  const { products = [] } = await productsR.json();
  const lowStock = products.flatMap(p =>
    (p.variants || [])
      .filter(v => typeof v.inventory_quantity === "number" && v.inventory_quantity < 5)
      .map(v => ({ product: p.title, sku: v.sku, qty: v.inventory_quantity })),
  ).slice(0, 10);

  const { entries, lastSeq } = await state.read("orders", { since: sinceSeq });
  const newOrders = entries.map(e => e.entry);

  console.log(JSON.stringify({
    at:         new Date().toISOString(),
    revenue:    Number(revenue.toFixed(2)),
    orderCount: orders.length,
    lowStock,
    newOrders,
    lastSeq,
  }));
})();
```

Policy:

```json
{
  "allowNet":       ["acme-test.myshopify.com"],
  "secrets":        ["SHOPIFY_SHOP", "SHOPIFY_TOKEN"],
  "state":          true,
  "timeoutSeconds": 15
}
```

Namespace: `shop`. cue returns:

```json
{
  "id": "act_01KPZ3X7QHVMNR5F82CWAE1P9K",
  "name": "tick",
  "namespace": "shop",
  "invokeUrl": "http://127.0.0.1:4747/a/act_01KPZ3X7QHVMNR5F82CWAE1P9K"
}
```

Then — still in the same response — the `order-created` action:

```js
(async () => {
  const fs  = require("fs");
  const state = require("/cue-state");
  const env = JSON.parse(fs.readFileSync("/cue-envelope.json", "utf8"));
  const body = env.request?.body ?? {};
  const customer = body.customer
    ? `${body.customer.first_name ?? ""} ${body.customer.last_name ?? ""}`.trim() || null
    : null;
  const row = {
    id:          body.id ?? null,
    total_price: body.total_price ?? "0.00",
    customer,
  };
  const { seq, at } = await state.append("orders", row);
  console.log(JSON.stringify({ ok: true, seq, at, row }));
})();
```

Policy: `{ "state": true, "timeoutSeconds": 5 }`. No net, no filesystem — it just appends a row to the namespace's state log.

```json
{
  "id": "act_01KPZ40CFJA8WQMY6ZN2ERTBHV",
  "name": "order-created",
  "namespace": "shop"
}
```

And the webhook trigger — `create_trigger` with `{ type: "webhook", actionId: "act_01KPZ40CFJA8WQMY6ZN2ERTBHV", namespace: "shop" }`:

```json
{
  "id":           "trg_01KPZ41PQN3R9VTJK7SX2DFHAY",
  "type":         "webhook",
  "webhookUrl":   "http://127.0.0.1:4747/w/trg_01KPZ41PQN3R9VTJK7SX2DFHAY",
  "webhookToken": "tok_9c4f2a81e7b53d06..."
}
```

Claude flags a wrinkle here: Shopify webhooks sign with HMAC-SHA256 but don't let you set an `Authorization` header, and cue's `/w/:id` expects a bearer. For this demo we'll simulate the delivery with `curl` (below) so you see the confetti working end-to-end. For real production wiring, either route via **Shopify Flow** (supports custom headers on HTTP requests) or put a ~10-line HMAC-verifying relay in front that forwards to cue with the bearer.

Finally, the HTML page — a single file you can save as `dashboard.html` on your desktop:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Shop ops</title>
  <script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.2/dist/confetti.browser.min.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; padding: 3rem; color: #111; background: #fafaf9; margin: 0; }
    h1 { font-size: 4.5rem; margin: 0 0 .5rem; letter-spacing: -.02em; }
    h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; color: #666; font-weight: 500; text-transform: uppercase; letter-spacing: .08em; }
    .grid { display: grid; grid-template-columns: 2fr 1fr; gap: 3rem; max-width: 1100px; }
    .stat { font-size: 2.5rem; font-weight: 600; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { padding: .5rem 0; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; }
    li .qty { font-variant-numeric: tabular-nums; color: #c00; font-weight: 600; }
    small { color: #888; }
    .err { color: #c00; }
    #toasts { position: fixed; bottom: 2rem; right: 2rem; display: flex; flex-direction: column-reverse; gap: .5rem; pointer-events: none; }
    .toast { background: #111; color: white; padding: .9rem 1.4rem; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.2); font-weight: 500; opacity: 0; transform: translateX(120%); transition: opacity .3s, transform .3s; }
    .toast.in { opacity: 1; transform: translateX(0); }
  </style>
</head>
<body>
  <div class="grid">
    <div>
      <small>today's revenue</small>
      <h1 id="revenue">—</h1>
      <p><span class="stat" id="orders">—</span> <small>orders · <span id="at">loading…</span></small></p>
    </div>
    <div>
      <h2>Low stock</h2>
      <ul id="lowstock"><li><small>—</small></li></ul>
    </div>
  </div>
  <div id="toasts"></div>

  <script>
    const URL   = "http://127.0.0.1:4747/a/act_01KPZ3X7QHVMNR5F82CWAE1P9K";
    const TOKEN = "<paste ~/.cue/token here>";

    const $rev   = document.getElementById("revenue");
    const $ord   = document.getElementById("orders");
    const $at    = document.getElementById("at");
    const $low   = document.getElementById("lowstock");
    const $toasts = document.getElementById("toasts");

    let since = 0;  // state seq cursor — the server returns lastSeq each poll

    function celebrate(o) {
      const amount = Number(o.total_price || 0);
      const particleCount = Math.min(400, Math.max(40, Math.round(amount * 3)));
      const isBig = amount >= 100;
      confetti({
        particleCount,
        spread: 70,
        origin: { x: Math.random() * 0.6 + 0.2, y: 0.6 },
        colors: isBig ? ["#ffd700", "#ffed4e", "#ffffff", "#ffa500"] : undefined,
      });
      const t = document.createElement("div");
      t.className = "toast";
      t.textContent = `🎉 $${amount.toFixed(2)}${o.customer ? " from " + o.customer : ""}`;
      $toasts.appendChild(t);
      requestAnimationFrame(() => t.classList.add("in"));
      setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 400); }, 4000);
    }

    async function tick() {
      try {
        const r = await fetch(URL, {
          method: "POST",
          headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ since }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const { output } = await r.json();
        $rev.textContent = `$${output.revenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        $ord.textContent = output.orderCount;
        $at.textContent  = `updated ${new Date(output.at).toLocaleTimeString()}`;
        $at.className = "";
        $low.innerHTML = output.lowStock.length
          ? output.lowStock.map(s => `<li><span>${s.product}</span><span class="qty">${s.qty}</span></li>`).join("")
          : `<li><small>all stocked</small></li>`;
        for (const o of output.newOrders) celebrate(o);
        since = output.lastSeq;  // server-side cursor via state log
      } catch (e) {
        $at.textContent = `error: ${e.message}`;
        $at.className = "err";
      }
    }

    tick();
    setInterval(tick, 3000);
  </script>
</body>
</html>
```

`TOKEN` is your daemon's `~/.cue/token` (Claude reminds you to paste it into the HTML). For public sharing you'd swap the HTML to hit `/w/<triggerId>` with the scoped webhook token instead — same pattern as demo 03's sidebar.

Claude closes the turn with: "That's everything wired up. Paste your Shopify Admin API token when you've got it and I'll stash it — the dashboard will stay stuck on 'error' until it can reach your store."

### 2. "Here's the token: shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

Claude calls `set_secret` twice — once for the store domain (already mentioned in your first message), once for the token — both scoped to namespace `shop`:

```json
{ "namespace": "shop", "name": "SHOPIFY_SHOP",  "value": "acme-test.myshopify.com" }
{ "namespace": "shop", "name": "SHOPIFY_TOKEN", "value": "shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
```

Each returns:

```json
{ "ok": true, "namespace": "shop", "name": "..." }
```

Secrets land at `~/.cue/secrets/shop/SHOPIFY_SHOP` and `~/.cue/secrets/shop/SHOPIFY_TOKEN` (mode 0600). Only actions in namespace `shop` can read them; rotate any time by re-calling `set_secret` with a new value — no daemon restart.

Claude then invokes `tick` once to verify everything resolves (illustrative — your numbers differ):

```json
{
  "runId": "run_01KPZ3Y2B0K7N3QXJ4MZFA8H9D",
  "exitCode": 0,
  "output": {
    "at": "2026-04-23T14:02:11.843Z",
    "revenue": 2847.50,
    "orderCount": 34,
    "lowStock": [
      { "product": "Midnight Tee", "sku": "TEE-MDN-L", "qty": 3 },
      { "product": "Beanie",        "sku": "BNE-BLK",   "qty": 1 }
    ],
    "newOrders": [],
    "lastSeq": 0
  },
  "denials": []
}
```

`newOrders: []`, `lastSeq: 0` — nothing has fired the webhook yet, so the `shop/orders` log is empty. Open `dashboard.html` in your browser: revenue + low-stock populate, "updated HH:MM:SS" ticks every 3s.

### 3. "I don't have an order coming right now — can we test the confetti?"

Claude fires a curl at the webhook URL, shaped like a real Shopify `orders/create` payload:

```bash
curl -X POST "http://127.0.0.1:4747/w/trg_01KPZ41PQN3R9VTJK7SX2DFHAY" \
  -H "Authorization: Bearer tok_9c4f2a81e7b53d06..." \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Topic: orders/create" \
  -d '{
    "id": 5123987412345,
    "total_price": "147.50",
    "customer": { "first_name": "Ada", "last_name": "Lovelace" },
    "line_items": [{ "title": "Midnight Tee", "quantity": 2 }]
  }'
```

Response:

```json
{
  "runId": "run_01KPZ42H5CM4PWZ08FQJYX7R3B",
  "exitCode": 0,
  "output": {
    "ok": true,
    "seq": 1,
    "at": "2026-04-23T14:02:34.118Z",
    "row": {
      "id": 5123987412345,
      "total_price": "147.50",
      "customer": "Ada Lovelace"
    }
  },
  "denials": []
}
```

Within ≤ 3s the open dashboard tab:

- Spawns ~440 gold-tinted particles from a random x, `y: 0.6`
- Slides a toast in from the right: `🎉 $147.50 from Ada Lovelace`
- Picks up the row on the next poll via the `since` cursor (seq 1)

Fire it again with `total_price: "12.00"` — smaller burst, default colors, no gold. Response shows `seq: 2`, the dashboard's `since` advances to 2, and the tick only returns newer entries.

### 4. "Teardown."

```
cue ns delete shop
```

Both actions, the webhook trigger, both secrets, the `shop/orders` state log, and the `shop` namespace's state token — all gone in one call. The dashboard starts 404-ing on `/a/:id`.

---

## What just happened

Two actions with non-overlapping jobs, cooperating through the daemon's state log:

```
Shopify ──► /w/:id ─► [order-created action] ──► state.append('orders', row)
                                                          │
                                                          ▼
                                             daemon's state adapter
                                                          ▲
            Browser ─► /a/:id ─► [tick action] ──── state.read('orders', {since})
                         ▲                      │
                         └── polls every 3s ◄───┘
                              seq-based cursor
```

Each invocation is a fresh unikernel — the actions don't share memory, can't race on shared state in-process. The daemon's state adapter is the durable buffer. Inside the guest, `/cue-state.js` is a tiny helper that translates `append`/`read`/`delete` into authenticated HTTP calls to `127.0.0.1:<daemon-port>/state/<namespace>/<key>`, using a per-namespace token that cue injects as an env var when `policy.state: true`.

The interesting bit isn't the confetti — it's that a merchant described an ops dashboard + an event reaction in four messages, and the whole thing is bounded by declared policy (`allowNet` to one hostname, `secrets` to two env vars, `state` scoped to one namespace) with no external infra beyond cue itself.

## Going real with Shopify webhooks

The curl above works because it sends `Authorization: Bearer`. Shopify's own webhook delivery doesn't — it sends `X-Shopify-Hmac-Sha256` over the raw body, signed with the shared secret you configured on the webhook. Two honest paths:

- **Shopify Flow** → step: "Send HTTP request" → set `Authorization: Bearer tok_…` as a custom header. Flow is available on Shopify, Advanced, and Plus plans.
- **HMAC-verifying relay** (any plan) → ~10 lines of Node/Worker that verifies the HMAC, then refires the payload at cue's `/w/:id` with the bearer. One more hop, no more work.

A future variation could land HMAC verification inside cue itself (e.g., a per-trigger `hmacSecret` config), which would let Shopify's delivery hit cue directly. Not shipped today.

## Variations

- **Revenue target ring** — pass a monthly goal from the HTML; `tick` returns `% of goal`; the dashboard animates a progress ring. Confetti when the ring crosses 100%.
- **Slack/Discord parallel ping** — `order-created` also POSTs a summary to a channel webhook (add `allowNet: ["hooks.slack.com"]`, a `SLACK_WEBHOOK_URL` secret).
- **Refund radar** — a second webhook trigger for `refunds/create`; append to a separate `refunds` key in the same namespace (`state.append('refunds', row)`); dashboard shows a "refunds last hour" counter, pulses red if non-zero.
- **Order-auto-tagging** — on `orders/create`, fetch the full order, tag it in Shopify (`VIP` if total > $500, `first-time` if customer has 1 order). Add `write_orders` scope to the Shopify app and a second `allowNet` entry.
- **Scoped dashboard token** — create a second webhook trigger on the `tick` action; dashboard calls `/w/:id` with its scoped token instead of the master. Now you can paste the HTML into a shared Frame without leaking `~/.cue/token`.
- **Swap the state backend** — point `CUE_STATE` at a Redis adapter (once shipped) to take the log off local disk. Action code and policy shape don't change; the primitive is the same, just stored elsewhere.
