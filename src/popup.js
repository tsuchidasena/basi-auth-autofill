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
} from "./vault.js";

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
    $("bio-unlock-btn").hidden = !(await isBioEnabled());
    $("unlock-pw").focus();
    return;
  }
  setBadge("解錠済み", "unlocked");
  show("unlocked");

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

// --- setup ---
$("setup-btn").addEventListener("click", async () => {
  const pw = $("setup-pw").value;
  const pw2 = $("setup-pw2").value;
  if (pw.length < 8) return msg("マスターパスワードは8文字以上にしてください。");
  if (pw !== pw2) return msg("確認用パスワードが一致しません。");
  await initVault(pw);
  msg("設定しました。", true);
  await render();
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
  const host = $("qa-host").value.trim();
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
