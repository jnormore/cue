/**
 * Source of the /cue-state.js module injected into an action's unikernel
 * when `policy.state: true`. Written to a tmpdir on each invoke and passed
 * via `unitask --file`, so it appears at `/cue-state.js` inside the guest.
 *
 * The helper MUST use `require('node:http')` rather than `fetch` — unitask's
 * `net.connect` rewrite (the thing that routes `127.0.0.1:<port>` back to
 * the host daemon) does not patch Node's built-in fetch/undici socket path.
 * Raw http.request goes through net.connect and gets the rewrite; fetch
 * hangs.
 */
export const CUE_STATE_HELPER_SOURCE = `"use strict";
const http = require("node:http");

const rawUrl = process.env.CUE_STATE_URL;
const token = process.env.CUE_STATE_TOKEN;
if (!rawUrl || !token) {
  throw new Error("/cue-state.js: CUE_STATE_URL or CUE_STATE_TOKEN is not set. Declare policy.state: true on this action.");
}
if (token.indexOf("stk_") !== 0) {
  throw new Error("/cue-state.js: unexpected token format (missing stk_ prefix).");
}
const _body = token.slice(4);
const _dot = _body.indexOf(".");
if (_dot <= 0) {
  throw new Error("/cue-state.js: unexpected token format (missing namespace).");
}
const namespace = _body.slice(0, _dot);

const parsed = new URL(rawUrl);
const HOST = parsed.hostname;
const PORT = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = {
      "Authorization": "Bearer " + token,
      "Accept": "application/json",
    };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }
    const req = http.request({ host: HOST, port: PORT, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          if (!text) { resolve(null); return; }
          try { resolve(JSON.parse(text)); }
          catch (e) { reject(new Error("cue-state: non-JSON response from " + method + " " + path + ": " + text)); }
        } else {
          reject(new Error("cue-state: " + method + " " + path + " -> HTTP " + res.statusCode + ": " + text));
        }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function encodeKey(key) {
  if (typeof key !== "string" || !/^[a-z0-9-]+$/.test(key)) {
    throw new Error("cue-state: invalid key \\"" + key + "\\" (must match /^[a-z0-9-]+$/)");
  }
  return key;
}

// URL-encode the namespace so a workspace-scoped name like
// "jason/uptime-monitor" sends as "jason%2Fuptime-monitor" — keeps the
// slash inside the :namespace path param instead of splitting into two
// path segments. Fastify's find-my-way decodes %2F back to "/" before
// extracting the param, so the daemon's handler sees the original
// namespace string.
const encodedNamespace = encodeURIComponent(namespace);

module.exports = {
  namespace: namespace,
  append(key, entry) {
    return request("POST", "/state/" + encodedNamespace + "/" + encodeKey(key) + "/append", { entry: entry });
  },
  read(key, opts) {
    const qs = [];
    if (opts && opts.since != null) qs.push("since=" + encodeURIComponent(String(opts.since)));
    if (opts && opts.limit != null) qs.push("limit=" + encodeURIComponent(String(opts.limit)));
    const query = qs.length ? ("?" + qs.join("&")) : "";
    return request("GET", "/state/" + encodedNamespace + "/" + encodeKey(key) + query, null);
  },
  delete(key) {
    return request("DELETE", "/state/" + encodedNamespace + "/" + encodeKey(key), null);
  },
};
`;

export const CUE_STATE_HELPER_FILENAME = "cue-state.js";
