// Render the extension's pages outside Chrome, for looking at them.
//
// options.html and popup.html are plain pages; what ties them to a browser
// extension is the chrome.* surface. Stub that and the real vault.js, host.js
// and transfer.js run untouched — crypto.subtle is available because localhost
// counts as a secure context. So this exercises the actual code paths, not a
// mock of them.
//
// What it cannot show: Touch ID, native messaging, webRequest, real storage.
// Those need the extension loaded in Chrome for real.
//
// Usage: node tools/ui-preview.js  then open http://localhost:8770/options.html
//   ?state=fresh      未初期化（マスターパスワード設定から）
//   ?state=locked     施錠中
//   ?state=unlocked   解錠済み・サンプル3件（既定）
//   ?host=missing     ネイティブホスト未導入（Touch ID の案内が出る）
//   ?suggest=new      ポップアップに保存提案
//   ?suggest=update   ポップアップに更新提案

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT) || 8770;
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "src");
const ICONS = join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "icons");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

const SHIM = `
// --- chrome.* shim ---------------------------------------------------------
const params = new URLSearchParams(location.search);
const STATE = params.get("state") || "unlocked";
const HOST_INSTALLED = params.get("host") !== "missing";
const SUGGEST = params.get("suggest");

const local = {}, session = {};
const area = (bag) => ({
  get: async (k) => (k == null ? { ...bag } : { [k]: bag[k] }),
  set: async (o) => Object.assign(bag, o),
  remove: async (k) => { for (const key of [].concat(k)) delete bag[key]; },
});

globalThis.chrome = {
  storage: { local: area(local), session: area(session), onChanged: { addListener() {} } },
  runtime: {
    lastError: null,
    getPlatformInfo: async () => ({ os: "mac" }),
    openOptionsPage: () => location.assign("/options.html" + location.search),
    sendNativeMessage: (_n, _m, cb) => {
      if (!HOST_INSTALLED) { chrome.runtime.lastError = { message: "Specified native messaging host not found." }; cb(undefined); chrome.runtime.lastError = null; return; }
      cb({ ok: true, enrolled: false });
    },
    sendMessage: async (msg) => {
      if (msg.type === "SUGGESTION_GET") {
        return SUGGEST
          ? { suggestion: { host: "stg.example.com", username: "deploy", kind: SUGGEST } }
          : { suggestion: null };
      }
      return { ok: true };
    },
  },
  tabs: { query: async () => [{ url: "https://stg.example.com/admin" }] },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  notifications: { create() {}, clear() {} },
};

// Seed the vault through the real code so the pages see genuine data.
if (STATE !== "fresh") {
  const { initVault, saveEntries, lock } = await import("./vault.js");
  await initVault("preview-password");
  await saveEntries([
    { host: "example.com", username: "alice", password: "pw1", label: "本番", hardReload: false },
    { host: "*.stg.example.com", username: "deploy", password: "pw2", label: "ステージング", hardReload: true },
    { host: "localhost:8765", username: "user", password: "passwd", label: "", hardReload: false },
  ]);
  if (STATE === "locked") await lock();
}
`;

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const name = url.pathname === "/" ? "/options.html" : url.pathname;

  try {
    if (name.startsWith("/icons/")) {
      const buf = await readFile(join(ICONS, name.slice(7)));
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(buf);
    }
    let body = await readFile(join(SRC, name));
    if (extname(name) === ".html") {
      // Import the page's own module *from* the shim rather than leaving it as
      // a second script tag: a top-level await in one module script does not,
      // in practice, hold back the next one, so the page would render before
      // the seed landed.
      body = String(body).replace(
        /<script type="module" src="([^"]+)"><\/script>/,
        (_m, src) => `<script type="module">${SHIM}\nawait import("./${src}");</script>`
      );
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(name)] || "text/plain", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`UI preview on http://localhost:${PORT}/options.html`);
  console.log("  ?state=fresh|locked|unlocked  ?host=missing  ?suggest=new|update");
});
