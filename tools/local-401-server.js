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

// A page whose subresources each need auth. Opening this is how you check that
// concurrent onAuthRequired events raise ONE Touch ID prompt and not five.
const MULTI_PAGE = `<!doctype html>
<meta charset="utf-8"><title>401 x5</title>
<h1>5 protected subresources</h1>
<p>Each image below is a separate 401. Exactly one Touch ID prompt should appear.</p>
${[1, 2, 3, 4, 5].map((i) => `<img src="/sub${i}.png" alt="sub${i}" width="80" height="80">`).join("\n")}
`;

createServer((req, res) => {
  const n = ++seq;
  const auth = req.headers.authorization;

  // The harness page itself is open; only its subresources are protected.
  if (req.url === "/multi") {
    console.log(`${at()}  #${n} ${req.method} ${req.url} -> 200 (harness page)`);
    res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" });
    res.end(MULTI_PAGE);
    return;
  }

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
  console.log(`  /        single protected request`);
  console.log(`  /multi   page with 5 protected subresources (single-flight check)`);
  console.log("Every 401 uses a fresh realm, so you can re-run without restarting Chrome.");
  console.log("Ctrl-C to stop.\n");
});
