import {
  isInitialized,
  isUnlocked,
  initVault,
  unlock,
  lock,
  getEntries,
  saveEntries,
  findCredentials,
  isBioEnabled,
  isNativeHostInstalled,
} from "./vault.js";
import { normalizeHost } from "./host.js";

const $ = (id) => document.getElementById(id);
const views = {
  setup: $("view-setup"),
  locked: $("view-locked"),
  unlocked: $("view-unlocked"),
};

function show(view) {
  for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
}

function setBadge(text, cls) {
  const b = $("state-badge");
  b.textContent = text;
  b.className = "badge" + (cls ? " " + cls : "");
}

function msg(text, ok = false) {
  const m = $("msg");
  m.textContent = text;
  m.className = "msg" + (ok ? " ok" : "");
}

async function currentTabHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    return new URL(tab.url).host || null;
  } catch {
    return null;
  }
}

async function render() {
  msg("");
  if (!(await isInitialized())) {
    setBadge("未設定");
    show("setup");
    return;
  }
  if (!(await isUnlocked())) {
    setBadge("施錠中", "locked");
    show("locked");
    // Touch ID needs a macOS-only native host; off a Mac the button could only
    // ever fail, so it is not offered. See options.js for the reasoning.
    const { os } = await chrome.runtime.getPlatformInfo();
    $("bio-unlock-btn").hidden = os !== "mac" || !(await isBioEnabled());
    $("unlock-pw").focus();
    return;
  }
  setBadge("解錠済み", "unlocked");
  show("unlocked");
  await renderSuggestion();

  const host = await currentTabHost();
  $("current-host").textContent = host || "（対象外のページ）";
  $("qa-host").value = host || "";

  const status = $("match-status");
  if (host) {
    const cred = await findCredentials(host).catch(() => null);
    if (cred) {
      status.textContent = `✓ 登録済み（${cred.username}）— 自動入力されます`;
      status.className = "match-status found";
    } else {
      status.textContent = "未登録 — 下から登録できます";
      status.className = "match-status none";
    }
  } else {
    status.textContent = "";
  }
}

// --- suggestion (F-08) ---
// The offer lives in the service worker; this page only ever learns the host,
// the username and whether it is a new entry or an update. The password stays
// on the other side of the message boundary.
async function renderSuggestion() {
  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({ type: "SUGGESTION_GET" });
  } catch {
    // Worker asleep or gone; nothing to offer.
  }
  const s = resp?.suggestion;
  $("suggestion").hidden = !s;
  if (!s) return;

  $("sg-title").textContent =
    s.kind === "update" ? "登録済みの資格情報を更新しますか？" : "この資格情報を保存しますか？";
  $("sg-host").textContent = s.host;
  $("sg-user").textContent = s.username;
  $("sg-label").value = "";
}

$("sg-save").addEventListener("click", async () => {
  const r = await chrome.runtime
    .sendMessage({ type: "SUGGESTION_SAVE", label: $("sg-label").value.trim() })
    .catch(() => null);
  if (r?.ok) {
    msg("保存しました。", true);
    await render();
  } else {
    msg(r?.error ? "保存に失敗しました: " + r.error : "保存に失敗しました。");
  }
});

$("sg-dismiss").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "SUGGESTION_DISMISS" }).catch(() => null);
  await render();
});

// --- setup ---
$("setup-btn").addEventListener("click", async () => {
  const pw = $("setup-pw").value;
  const pw2 = $("setup-pw2").value;
  if (pw.length < 8) return msg("マスターパスワードは8文字以上にしてください。");
  if (pw !== pw2) return msg("確認用パスワードが一致しません。");
  await initVault(pw);
  await render();

  // Point at Touch ID while setup is still on the user's mind. The guidance
  // itself lives in the options page — this popup is too small to carry a
  // terminal command, and the setup is a once-ever step.
  const { os } = await chrome.runtime.getPlatformInfo();
  const needsHost = os === "mac" && !(await isNativeHostInstalled());
  msg(
    needsHost
      ? "設定しました。Touch ID 解錠も使えます —「すべての登録を管理」から設定してください。"
      : "設定しました。",
    true
  );
});

// --- unlock ---
async function doUnlock() {
  const pw = $("unlock-pw").value;
  if (!pw) return;
  try {
    await unlock(pw);
    $("unlock-pw").value = "";
    await render();
  } catch {
    msg("パスワードが違います。");
  }
}
$("unlock-btn").addEventListener("click", doUnlock);
$("unlock-pw").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doUnlock();
});

// --- Touch ID unlock (driven by the background service worker) ---
$("bio-unlock-btn").addEventListener("click", async () => {
  msg("Touch ID を確認中…");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "BIO_UNLOCK" });
    if (resp?.ok) await render();
    else msg(resp?.error || "解錠に失敗しました。");
  } catch {
    // The popup may have closed when the OS prompt took focus; the background
    // completes the unlock regardless. Reopening the popup shows it unlocked.
  }
});

// --- quick add ---
$("qa-save").addEventListener("click", async () => {
  const host = normalizeHost($("qa-host").value);
  const username = $("qa-user").value;
  const password = $("qa-pass").value;
  if (!host || !username) return msg("host とユーザ名は必須です。");
  const entries = await getEntries();
  const idx = entries.findIndex((e) => e.host === host);
  const entry = { host, username, password, label: "" };
  if (idx >= 0) entries[idx] = { ...entries[idx], ...entry };
  else entries.push(entry);
  await saveEntries(entries);
  $("qa-user").value = "";
  $("qa-pass").value = "";
  $("quick-add").open = false;
  msg("保存しました。", true);
  await render();
});

// --- footer ---
$("options-btn").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("lock-btn").addEventListener("click", async () => {
  await lock();
  await render();
});

render();
