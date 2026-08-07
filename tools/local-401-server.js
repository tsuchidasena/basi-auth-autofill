// Local Basic-auth endpoint for manually exercising the extension.
//
// Why not httpbin.org: it is unreliable, and Chrome caches Basic auth per
// (host, realm) — so a second attempt never reaches onAuthRequired and you have
// to restart the browser between runs. Here every 401 carries a fresh realm,
// which defeats that cache and makes the test repeatable.
//
// Usage: node tools/local-401-server.js   then open http://localhost:8765/
// Credentials: user / passwd

import { createServer } from "node:http";

const PORT = 8765;
const USER = "user";
const PASS = "passwd";

const started = Date.now();
const at = () => `${String(Date.now() - started).padStart(7)}ms`;

let seq = 0;

createServer((req, res) => {
  const n = ++seq;
  const auth = req.headers.authorization;

  if (!auth) {
    // Unique realm per request so Chrome cannot reuse a cached credential.
    const realm = `local-${Date.now()}-${n}`;
    console.log(`${at()}  #${n} ${req.method} ${req.url} -> 401 (realm ${realm})`);
    res.writeHead(401, {
      "WWW-Authenticate": `Basic realm="${realm}"`,
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end("401 — waiting for credentials\n");
    return;
  }

  const [, b64 = ""] = auth.split(" ");
  const [user, pass] = Buffer.from(b64, "base64").toString("utf8").split(":");
  const ok = user === USER && pass === PASS;

  console.log(`${at()}  #${n} ${req.method} ${req.url} -> ${ok ? 200 : 403} (got ${user}:${pass ? "***" : ""})`);
  res.writeHead(ok ? 200 : 403, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify({ authenticated: ok, user }, null, 2) + "\n");
}).listen(PORT, () => {
  console.log(`Local 401 server on http://localhost:${PORT}/  (${USER} / ${PASS})`);
  console.log("Every 401 uses a fresh realm, so you can re-run without restarting Chrome.");
  console.log("Ctrl-C to stop.\n");
});
