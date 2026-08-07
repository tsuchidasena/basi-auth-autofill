import { sendNative } from "./native.js";

const logEl = document.getElementById("log");
const $ = (id) => document.getElementById(id);
let lastKey;

function log(msg, cls = "") {
  const line = document.createElement("span");
  if (cls) line.className = cls;
  line.textContent = msg + "\n";
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

async function run(cmd, label) {
  log(`--- ${label} (cmd=${cmd}) ---`, "dim");
  try {
    const resp = await sendNative({ cmd });
    if (!resp) {
      log("✗ 応答が空。ホスト未登録/起動失敗の可能性。", "err");
      return;
    }
    if (resp.ok === false) {
      log(`✗ error: ${resp.error}${resp.code != null ? ` (code ${resp.code})` : ""}`, "err");
      return;
    }
    if (cmd === "status") {
      log(`✓ enrolled = ${resp.enrolled}`, resp.enrolled ? "ok" : "warn");
    } else if (cmd === "enroll") {
      log("✓ 登録成功。鍵を受領（base64）:", "ok");
      log("  " + resp.key, "dim");
    } else if (cmd === "unlock") {
      log("✓ Touch ID 成功。鍵を取得:", "ok");
      log("  " + resp.key, "dim");
      if (lastKey && lastKey !== resp.key) log("  ⚠ 前回と値が違う（不安定）", "err");
      else if (lastKey) log("  ✓ 前回と一致（安定＝鍵として使える）", "ok");
      lastKey = resp.key;
    } else if (cmd === "reset") {
      log("✓ 登録解除しました。", "ok");
      lastKey = undefined;
    }
  } catch (e) {
    log(`✗ ${e.message}`, "err");
    log("  install.sh を正しい拡張IDで実行したか / Chrome再起動したか 確認してください。", "dim");
  }
}

$("ext-id").textContent = chrome.runtime.id;
log("拡張ID: " + chrome.runtime.id, "dim");
log("ホスト: com.tsuchida.basic_auth_autofill", "dim");

$("btn-status").addEventListener("click", () => run("status", "状態確認"));
$("btn-enroll").addEventListener("click", () => run("enroll", "登録"));
$("btn-unlock").addEventListener("click", () => run("unlock", "取得(1回目)"));
$("btn-unlock2").addEventListener("click", () => run("unlock", "取得(2回目)"));
$("btn-reset").addEventListener("click", () => run("reset", "登録解除"));
