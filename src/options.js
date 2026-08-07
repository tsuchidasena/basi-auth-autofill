import {
  isInitialized,
  isUnlocked,
  initVault,
  unlock,
  lock,
  getEntries,
  saveEntries,
  resetVault,
  isBioEnabled,
  enableBio,
  disableBio,
} from "./vault.js";
import {
  buildEncryptedExport,
  buildPlainExport,
  parseImport,
  mergeEntries,
} from "./transfer.js";

const $ = (id) => document.getElementById(id);

let editingHost = null; // host being edited, or null for "new"

// Import runs in two steps — read the file, then decide what to do about
// collisions — so the parsed entries have to outlive the first click.
let pendingImport = null; // Entry[] | null

function msg(el, text, ok = false) {
  el.textContent = text;
  el.className = "msg" + (ok ? " ok" : "");
}

async function render() {
  const initialized = await isInitialized();
  const unlocked = await isUnlocked();

  $("gate").hidden = initialized && unlocked;
  $("manager").hidden = !(initialized && unlocked);

  if (!initialized) {
    configureGate({
      title: "マスターパスワードの設定",
      hint: "資格情報の暗号化に使います。忘れると復号できません（リセットのみ可能）。",
      confirm: true,
      btn: "設定する",
    });
    return;
  }
  if (!unlocked) {
    configureGate({
      title: "解錠",
      hint: "マスターパスワードを入力してください。",
      confirm: false,
      btn: "解錠",
    });
    return;
  }
  await renderEntries();
  await renderBio();
}

// Touch ID rides on a macOS-only native host. Elsewhere the buttons would fail
// with "Specified native messaging host not found", which reads like a broken
// install rather than an unsupported platform — so the section is not shown at
// all. A "macOS only" note would invite the same misreading.
// Memoise the promise, not the resolved value: assigning after an await would
// let two concurrent callers both run the lookup.
let macCheck = null;
function onMac() {
  macCheck ??= chrome.runtime.getPlatformInfo().then(({ os }) => os === "mac");
  return macCheck;
}

async function renderBio() {
  if (!(await onMac())) {
    $("bio-card").hidden = true;
    return;
  }
  $("bio-card").hidden = false;

  const on = await isBioEnabled();
  $("bio-enable").hidden = on;
  $("bio-disable").hidden = !on;
  $("bio-note").textContent = on
    ? "有効です。ブラウザ起動後、ポップアップから Touch ID で解錠できます。"
    : "有効にすると、マスターパスワードの代わりに Touch ID で解錠できます。※鍵はこのMacのキーチェーンに保存され、ハードウェア保護ではありません（利便性向けの機能です）。";
}

function configureGate({ title, hint, confirm, btn }) {
  $("gate-title").textContent = title;
  $("gate-hint").textContent = hint;
  $("gate-btn").textContent = btn;
  $("gate-pw2").hidden = !confirm;
  $("gate-pw").value = "";
  $("gate-pw2").value = "";
  msg($("gate-msg"), "");
  $("gate-pw").focus();
}

async function renderEntries() {
  const entries = await getEntries();
  const body = $("entries-body");
  body.innerHTML = "";
  $("empty-note").hidden = entries.length > 0;

  for (const e of entries) {
    const tr = document.createElement("tr");

    const pick = document.createElement("td");
    pick.className = "pick";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.dataset.host = e.host;
    box.className = "ex-pick";
    box.addEventListener("change", refreshExportCount);
    pick.appendChild(box);

    const host = document.createElement("td");
    host.className = "host";
    host.textContent = e.host;

    const user = document.createElement("td");
    user.textContent = e.username;

    const label = document.createElement("td");
    label.textContent = e.label || "";

    const actions = document.createElement("td");
    actions.className = "actions";
    const editBtn = document.createElement("button");
    editBtn.textContent = "編集";
    editBtn.addEventListener("click", () => startEdit(e));
    const delBtn = document.createElement("button");
    delBtn.textContent = "削除";
    delBtn.className = "danger-btn";
    delBtn.addEventListener("click", () => removeEntry(e.host));
    actions.append(editBtn, delBtn);

    tr.append(pick, host, user, label, actions);
    body.appendChild(tr);
  }
  refreshExportCount();
}

// --- export (F-01) ---
function selectedHosts() {
  return [...document.querySelectorAll(".ex-pick")]
    .filter((b) => b.checked)
    .map((b) => b.dataset.host);
}

function refreshExportCount() {
  const n = selectedHosts().length;
  const total = document.querySelectorAll(".ex-pick").length;
  $("ex-count").textContent = `選択中の ${n} 件`;
  $("pick-all").checked = total > 0 && n === total;
  $("ex-run").disabled = n === 0;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function downloadJSON(obj, filename) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" })
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function runExport() {
  const hosts = new Set(selectedHosts());
  if (hosts.size === 0) return msg($("ex-msg"), "エクスポートする行を選んでください。");

  let entries;
  try {
    entries = (await getEntries()).filter((e) => hosts.has(e.host));
  } catch {
    return msg($("ex-msg"), "施錠されています。解錠してからやり直してください。");
  }

  if ($("ex-plain").checked) {
    const ok = confirm(
      `平文でエクスポートします。\n\n` +
        `ファイルを開けば誰でもパスワードを読めます。` +
        `保管場所と受け渡し経路に十分注意してください。\n\n続けますか？`
    );
    if (!ok) return msg($("ex-msg"), "中止しました。");
    downloadJSON(buildPlainExport(entries), `basic-auth-autofill-${stamp()}-PLAINTEXT.json`);
    return msg($("ex-msg"), `${entries.length} 件を平文で書き出しました。`, true);
  }

  const pass = $("ex-pass").value;
  if (!pass) return msg($("ex-msg"), "パスフレーズを入力してください。");
  // A typo here would not surface until the day the backup is needed, so the
  // confirmation field is worth the extra keystrokes.
  if (pass !== $("ex-pass2").value) return msg($("ex-msg"), "確認用パスフレーズが一致しません。");

  downloadJSON(await buildEncryptedExport(entries, pass), `basic-auth-autofill-${stamp()}.json`);
  $("ex-pass").value = "";
  $("ex-pass2").value = "";
  msg($("ex-msg"), `${entries.length} 件を書き出しました。パスフレーズは別経路で伝えてください。`, true);
}

// --- import (F-02) ---
function resetImport() {
  pendingImport = null;
  $("im-file").value = "";
  $("im-pass").value = "";
  $("im-pass-row").hidden = true;
  $("im-conflicts").hidden = true;
  $("im-conflicts-body").innerHTML = "";
}

async function readImportFile() {
  const file = $("im-file").files?.[0];
  if (!file) return null;
  try {
    return JSON.parse(await file.text());
  } catch {
    return "PARSE_ERROR";
  }
}

const IMPORT_ERRORS = {
  BAD_FORMAT: "この拡張のエクスポートファイルではないようです。",
  BAD_VERSION: "対応していないファイル形式です（拡張のバージョンを確認してください）。",
  EMPTY_PASSPHRASE: "このファイルにはパスフレーズが必要です。",
  WRONG_PASSPHRASE: "パスフレーズが違います。",
};

// Step 1: read the file and find out what collides. Nothing is saved yet.
async function readImport() {
  $("im-conflicts").hidden = true;
  const raw = await readImportFile();
  if (raw === null) return msg($("im-msg"), "ファイルを選んでください。");
  if (raw === "PARSE_ERROR") return msg($("im-msg"), IMPORT_ERRORS.BAD_FORMAT);

  // Encrypted files need a passphrase; plaintext ones must not ask for one.
  if (!raw.plaintext && !$("im-pass").value) {
    $("im-pass-row").hidden = false;
    $("im-pass").focus();
    return msg($("im-msg"), "このファイルのパスフレーズを入力して、もう一度「読み込む」を押してください。");
  }

  let incoming;
  try {
    incoming = await parseImport(raw, $("im-pass").value);
  } catch (e) {
    return msg($("im-msg"), IMPORT_ERRORS[e.message] || `読み込めませんでした: ${e.message}`);
  }

  let existing;
  try {
    existing = await getEntries();
  } catch {
    return msg($("im-msg"), "施錠されています。解錠してからやり直してください。");
  }

  pendingImport = incoming;
  const { conflicts } = mergeEntries(existing, incoming);
  if (conflicts.length === 0) return applyImport();

  renderConflicts(existing, incoming, conflicts);
  $("im-conflicts").hidden = false;
  msg($("im-msg"), `${conflicts.length} 件が既存の登録とぶつかっています。下で選んでください。`);
}

function renderConflicts(existing, incoming, conflicts) {
  const body = $("im-conflicts-body");
  body.innerHTML = "";
  const byHost = (list) => new Map(list.map((e) => [e.host, e]));
  const mine = byHost(existing);
  const theirs = byHost(incoming);

  for (const host of conflicts) {
    const tr = document.createElement("tr");

    const pick = document.createElement("td");
    pick.className = "pick";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.host = host; // unchecked by default: keep what is already here
    box.className = "im-pick";
    pick.appendChild(box);

    const h = document.createElement("td");
    h.className = "host";
    h.textContent = host;

    const a = document.createElement("td");
    a.className = "cmp";
    a.textContent = mine.get(host)?.username ?? "";

    const b = document.createElement("td");
    b.className = "cmp";
    b.textContent = theirs.get(host)?.username ?? "";

    tr.append(pick, h, a, b);
    body.appendChild(tr);
  }
}

// Step 2: merge for real, using whatever overwrites the user ticked.
async function applyImport() {
  if (!pendingImport) return msg($("im-msg"), "先にファイルを読み込んでください。");
  const overwrite = new Set(
    [...document.querySelectorAll(".im-pick")].filter((b) => b.checked).map((b) => b.dataset.host)
  );

  let existing;
  try {
    existing = await getEntries();
  } catch {
    return msg($("im-msg"), "施錠されています。解錠してからやり直してください。");
  }

  const r = mergeEntries(existing, pendingImport, overwrite);
  await saveEntries(r.next);
  resetImport();
  await renderEntries();
  msg(
    $("im-msg"),
    `取り込み ${r.added.length} 件 / スキップ ${r.skipped.length} 件 / 上書き ${r.overwritten.length} 件。`,
    true
  );
}

function startEdit(e) {
  editingHost = e.host;
  $("form-title").textContent = `編集: ${e.host}`;
  $("f-host").value = e.host;
  $("f-user").value = e.username;
  $("f-pass").value = e.password;
  $("f-label").value = e.label || "";
  $("f-cancel").hidden = false;
  msg($("form-msg"), "");
  $("f-host").scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetForm() {
  editingHost = null;
  $("form-title").textContent = "新規登録";
  $("f-host").value = "";
  $("f-user").value = "";
  $("f-pass").value = "";
  $("f-label").value = "";
  $("f-cancel").hidden = true;
  msg($("form-msg"), "");
}

async function removeEntry(host) {
  if (!confirm(`「${host}」を削除しますか？`)) return;
  const entries = await getEntries();
  await saveEntries(entries.filter((e) => e.host !== host));
  if (editingHost === host) resetForm();
  await renderEntries();
}

// --- gate (setup / unlock) ---
$("gate-btn").addEventListener("click", async () => {
  const pw = $("gate-pw").value;
  const confirmMode = !$("gate-pw2").hidden;
  if (confirmMode) {
    if (pw.length < 8) return msg($("gate-msg"), "8文字以上にしてください。");
    if (pw !== $("gate-pw2").value) return msg($("gate-msg"), "確認用パスワードが一致しません。");
    await initVault(pw);
    await render();
  } else {
    try {
      await unlock(pw);
      await render();
    } catch {
      msg($("gate-msg"), "パスワードが違います。");
    }
  }
});
$("gate-pw").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && $("gate-pw2").hidden) $("gate-btn").click();
});

// --- entry form ---
$("f-save").addEventListener("click", async () => {
  const host = $("f-host").value.trim();
  const username = $("f-user").value;
  const password = $("f-pass").value;
  const label = $("f-label").value.trim();
  if (!host || !username) return msg($("form-msg"), "Host とユーザ名は必須です。");

  const entries = await getEntries();
  const entry = { host, username, password, label };

  // If host changed during edit, drop the old key.
  const next = editingHost && editingHost !== host
    ? entries.filter((e) => e.host !== editingHost)
    : entries.slice();

  const idx = next.findIndex((e) => e.host === host);
  if (idx >= 0) next[idx] = entry;
  else next.push(entry);

  await saveEntries(next);
  resetForm();
  await renderEntries();
  msg($("form-msg"), "保存しました。", true);
});
$("f-cancel").addEventListener("click", resetForm);

// --- export / import ---
$("pick-all").addEventListener("change", (e) => {
  for (const b of document.querySelectorAll(".ex-pick")) b.checked = e.target.checked;
  refreshExportCount();
});
$("ex-plain").addEventListener("change", (e) => {
  const plain = e.target.checked;
  $("ex-pass").disabled = plain;
  $("ex-pass2").disabled = plain;
  msg($("ex-msg"), plain ? "平文で書き出します。パスフレーズは使いません。" : "");
});
$("ex-run").addEventListener("click", async () => {
  msg($("ex-msg"), "");
  try {
    await runExport();
  } catch (e) {
    msg($("ex-msg"), "エクスポートに失敗しました: " + e.message);
  }
});

// Picking a different file invalidates anything read from the previous one.
$("im-file").addEventListener("change", () => {
  pendingImport = null;
  $("im-conflicts").hidden = true;
  $("im-pass-row").hidden = true;
  $("im-pass").value = "";
  msg($("im-msg"), "");
});
$("im-read").addEventListener("click", async () => {
  msg($("im-msg"), "");
  try {
    await readImport();
  } catch (e) {
    msg($("im-msg"), "読み込みに失敗しました: " + e.message);
  }
});
$("im-apply").addEventListener("click", async () => {
  try {
    await applyImport();
  } catch (e) {
    msg($("im-msg"), "取り込みに失敗しました: " + e.message);
  }
});
$("im-cancel").addEventListener("click", () => {
  resetImport();
  msg($("im-msg"), "中止しました。");
});

// --- toolbar ---
$("lock-btn").addEventListener("click", async () => {
  await lock();
  await render();
});
$("reset-btn").addEventListener("click", async () => {
  if (!confirm("本当にすべての資格情報を削除してリセットしますか？この操作は取り消せません。")) return;
  await resetVault();
  resetForm();
  await render();
});

// --- Touch ID ---
$("bio-enable").addEventListener("click", async () => {
  msg($("bio-msg"), "Touch ID を確認中…");
  try {
    await enableBio();
    msg($("bio-msg"), "有効化しました。", true);
  } catch (e) {
    const hint = /native|host/i.test(e.message)
      ? "（native/install.sh を実行し Chrome を再起動したか確認してください）"
      : "";
    msg($("bio-msg"), "失敗: " + e.message + hint);
  }
  await renderBio();
});
$("bio-disable").addEventListener("click", async () => {
  await disableBio();
  msg($("bio-msg"), "無効化しました。", true);
  await renderBio();
});

render();
