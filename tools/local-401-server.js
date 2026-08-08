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

const PORT = Number(process.env.PORT) || 8765;
const USER = "user";
const PASS = "passwd";

const started = Date.now();
const at = () => `${String(Date.now() - started).padStart(7)}ms`;

let seq = 0;
const RUN_REALM = `local-${process.pid}`;

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

  // Chrome asks for a favicon on every navigation. Answering it without a
  // challenge keeps the log readable.
  if (req.url === "/favicon.ico") {
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
    return;
  }

  // Wrong or absent credentials both get a 401 with a fresh realm.
  //
  // Returning 403 for a bad password (which this used to do) is what wedges the
  // browser: 403 means "authenticated, but not allowed", so Chrome keeps the
  // cached credential, never re-challenges, and onAuthRequired never fires
  // again. Chrome also sends cached credentials pre-emptively on the same
  // origin, so once a bad one is cached nothing can dislodge it — you just see
  // an endless run of 403s. Only a 401 makes Chrome drop it and ask again.
  const challenge = (why) => {
    // One realm per server run, not per request. Rotating it defeats Chrome's
    // credential cache, which is handy for re-running a test — but it also
    // means the credentials just typed for the previous realm are not offered
    // for this one, which turns a poisoned cache entry into an endless dialog.
    // Restart the server to get a fresh realm.
    const realm = RUN_REALM;
    console.log(`${at()}  #${n} ${req.method} ${req.url} -> 401 ${why} (realm ${realm})`);
    res.writeHead(401, {
      "WWW-Authenticate": `Basic realm="${realm}"`,
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end(`401 — ${why}\n`);
  };

  if (!auth) {
    challenge("no credentials");
    return;
  }

  const [, b64 = ""] = auth.split(" ");
  const [user, pass = ""] = Buffer.from(b64, "base64").toString("utf8").split(":");

  if (user !== USER || pass !== PASS) {
    challenge(`rejected user=${JSON.stringify(user)} passLen=${pass.length} (want ${USER}/${PASS})`);
    return;
  }

  console.log(`${at()}  #${n} ${req.method} ${req.url} -> 200 accepted (${user})`);
  res.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify({ authenticated: true, user }, null, 2) + "\n");
// Loopback only — this thing hands out a known password, it has no business
// being reachable from the network.
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Local 401 server on http://localhost:${PORT}/  (${USER} / ${PASS})`);
  console.log(`  /        single protected request`);
  console.log(`  /multi   page with 5 protected subresources (single-flight check)`);
  console.log(`  realm: ${RUN_REALM}（起動ごとに変わります。やり直すときはサーバを再起動）`);
  console.log("Ctrl-C to stop.\n");
});
