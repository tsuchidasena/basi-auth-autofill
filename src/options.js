import {
  isInitialized,
  isUnlocked,
  initVault,
  unlock,
  lock,
  getEntries,
  saveEntries,
  resetVault,
} from "./vault.js";

const $ = (id) => document.getElementById(id);

let editingHost = null; // host being edited, or null for "new"

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

    tr.append(host, user, label, actions);
    body.appendChild(tr);
  }
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
  let next = editingHost && editingHost !== host
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

render();
