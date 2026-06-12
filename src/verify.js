// Standalone verification: can this extension origin use WebAuthn PRF with TouchID?
// Not wired to the vault. Logs everything to the on-page console.

const logEl = document.getElementById("log");
const $ = (id) => document.getElementById(id);

const STORE = "verify"; // chrome.storage.local key: { credId, userId }
// Fixed salt so PRF output is stable across calls (this is what we'd derive a key from).
const PRF_SALT = new TextEncoder().encode("basic-auth-autofill/prf/v1");

const enc = new TextEncoder();
function rand(n) { return crypto.getRandomValues(new Uint8Array(n)); }
function b64(buf) {
  const b = new Uint8Array(buf);
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
function fromB64(s) {
  const bin = atob(s); const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

function log(msg, cls = "") {
  const line = document.createElement("span");
  if (cls) line.className = cls;
  line.textContent = msg + "\n";
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}
function logErr(e) {
  log(`✗ ${e.name || "Error"}: ${e.message}`, "err");
  if (e.name === "NotAllowedError") log("  (キャンセル / タイムアウト / この rp.id が拒否された 可能性)", "dim");
  if (e.name === "SecurityError") log("  (rp.id がオリジンと不整合。rp.id を変えて再試行)", "dim");
}

async function getStore() {
  const r = await chrome.storage.local.get(STORE);
  return r[STORE] || {};
}
async function setStore(v) {
  await chrome.storage.local.set({ [STORE]: v });
}

function rpId() {
  const v = $("rpid").value.trim();
  return v || undefined; // undefined => let the browser use the default for this origin
}

async function register() {
  try {
    log("--- create() 開始 ---", "dim");
    const store = await getStore();
    const userId = store.userId ? fromB64(store.userId) : rand(16);

    const publicKey = {
      challenge: rand(32),
      rp: { name: "Basic Auth Autofill (verify)", ...(rpId() ? { id: rpId() } : {}) },
      user: { id: userId, name: "local-unlock", displayName: "Local Unlock" },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },   // ES256
        { type: "public-key", alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform", // TouchID
        residentKey: "required",
        userVerification: "required",
      },
      timeout: 60000,
      extensions: { prf: { eval: { first: PRF_SALT } } },
    };
    log("rp.id = " + (rpId() ?? "(既定)"), "dim");

    const cred = await navigator.credentials.create({ publicKey });
    const ext = cred.getClientExtensionResults();
    const clientData = JSON.parse(new TextDecoder().decode(cred.response.clientDataJSON));

    log("✓ パスキー作成成功", "ok");
    log("  origin (clientDataJSON) = " + clientData.origin, "dim");
    log("  credentialId = " + b64(cred.rawId).slice(0, 24) + "…", "dim");
    log("  prf.enabled = " + JSON.stringify(ext?.prf?.enabled), ext?.prf?.enabled ? "ok" : "warn");
    if (ext?.prf?.results?.first) {
      log("  prf.results.first(create時) = " + b64(ext.prf.results.first), "ok");
    } else {
      log("  prf 値は create では未返却（②の get で取得します）", "dim");
    }

    await setStore({ credId: b64(cred.rawId), userId: b64(userId), rpId: rpId() || "" });
    log("→ 保存しました。②の『TouchID で PRF 取得』へ。", "ok");
  } catch (e) {
    logErr(e);
  }
}

async function getPrf(label) {
  try {
    log(`--- get() 開始 ${label} ---`, "dim");
    const store = await getStore();
    if (!store.credId) {
      log("先に①でパスキーを登録してください。", "warn");
      return;
    }
    const useRp = $("rpid").value.trim() || store.rpId || undefined;

    const publicKey = {
      challenge: rand(32),
      ...(useRp ? { rpId: useRp } : {}),
      allowCredentials: [{ type: "public-key", id: fromB64(store.credId) }],
      userVerification: "required",
      timeout: 60000,
      extensions: { prf: { eval: { first: PRF_SALT } } },
    };

    const assertion = await navigator.credentials.get({ publicKey });
    const ext = assertion.getClientExtensionResults();
    const first = ext?.prf?.results?.first;

    if (first) {
      const secret = b64(first);
      log("✓ TouchID 成功 / PRF 秘密値を取得", "ok");
      log("  prf.results.first = " + secret, "ok");
      // remember last to confirm stability
      if (window.__lastPrf && window.__lastPrf !== secret) {
        log("  ⚠ 前回と値が違います（鍵として不安定）", "err");
      } else if (window.__lastPrf) {
        log("  ✓ 前回と一致（安定＝AES鍵の素にできる）", "ok");
      }
      window.__lastPrf = secret;
    } else {
      log("✗ PRF 結果が空。この authenticator は PRF 非対応の可能性。", "err");
      log("  getClientExtensionResults = " + JSON.stringify(ext), "dim");
    }
  } catch (e) {
    logErr(e);
  }
}

async function clearStore() {
  await chrome.storage.local.remove(STORE);
  window.__lastPrf = undefined;
  log("保存済みクレデンシャルを消去しました。", "warn");
}

// init
$("origin").textContent = location.origin;
log("環境チェック", "dim");
log("  PublicKeyCredential 利用可: " + (typeof PublicKeyCredential !== "undefined"));
if (typeof PublicKeyCredential !== "undefined" &&
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
  PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
    .then((ok) => log("  platform authenticator(TouchID等)利用可: " + ok, ok ? "ok" : "warn"));
}
getStore().then((s) => {
  if (s.credId) {
    log("保存済みクレデンシャルあり（rp.id=" + (s.rpId || "既定") + "）。②から試せます。", "dim");
    if (s.rpId) $("rpid").value = s.rpId;
  } else {
    log("未登録。①から始めてください。", "dim");
  }
});

$("btn-register").addEventListener("click", register);
$("btn-get").addEventListener("click", () => getPrf("(1回目)"));
$("btn-get2").addEventListener("click", () => getPrf("(2回目)"));
$("btn-clear").addEventListener("click", clearStore);
