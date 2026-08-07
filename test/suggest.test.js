// Test names carry the feature ID so `weathering` can spot a v1 feature with
// no test.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseBasicAuth, classifySuggestion } from "../extension/src/suggest.js";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// --- parseBasicAuth --------------------------------------------------------

test("F-08: Basic ヘッダからユーザ名とパスワードを取り出す", () => {
  assert.deepEqual(parseBasicAuth(`Basic ${b64("user:passwd")}`), {
    username: "user",
    password: "passwd",
  });
});

test("F-08: パスワードにコロンが含まれても最初の1つだけで分割する", () => {
  assert.deepEqual(parseBasicAuth(`Basic ${b64("user:a:b:c")}`), {
    username: "user",
    password: "a:b:c",
  });
});

test("F-08: パスワードが空でも取り出す", () => {
  assert.deepEqual(parseBasicAuth(`Basic ${b64("user:")}`), {
    username: "user",
    password: "",
  });
});

test("F-08: Basic 以外のスキームは無視する", () => {
  assert.equal(parseBasicAuth("Bearer abcdef"), null);
  assert.equal(parseBasicAuth("Digest username=x"), null);
});

test("F-08: ユーザ名が空なら null（ダイアログを空で閉じたとき Chrome が送る形）", () => {
  assert.equal(parseBasicAuth(`Basic ${b64(":")}`), null);
  assert.equal(parseBasicAuth(`Basic ${b64(":passwd")}`), null);
});

test("F-08: 壊れたヘッダで例外を投げない", () => {
  for (const bad of ["", "Basic", "Basic ", "Basic !!!not-base64!!!", null, undefined, 42, {}]) {
    assert.equal(parseBasicAuth(bad), null, `threw or returned for ${JSON.stringify(bad)}`);
  }
});

test("F-08: スキーム名の大文字小文字を問わない", () => {
  assert.deepEqual(parseBasicAuth(`basic ${b64("u:p")}`), { username: "u", password: "p" });
  assert.deepEqual(parseBasicAuth(`BASIC ${b64("u:p")}`), { username: "u", password: "p" });
});

// --- classifySuggestion ----------------------------------------------------

const ENTRIES = [
  { host: "example.com", username: "alice", password: "pw1", label: "" },
  { host: "localhost:8765", username: "user", password: "passwd", label: "" },
];

test("F-08 (AC-08-5): 未登録の host は new", () => {
  assert.equal(classifySuggestion(ENTRIES, "new.example.com", "bob", "pw"), "new");
});

test("F-08 (AC-08-5): 完全に一致すれば same（提案しない）", () => {
  assert.equal(classifySuggestion(ENTRIES, "example.com", "alice", "pw1"), "same");
});

test("F-08 (AC-08-5): パスワードだけ違えば update", () => {
  assert.equal(classifySuggestion(ENTRIES, "example.com", "alice", "changed"), "update");
});

test("F-08 (AC-08-5): ユーザ名だけ違えば update", () => {
  assert.equal(classifySuggestion(ENTRIES, "example.com", "bob", "pw1"), "update");
});

test("F-08 (AC-08-5): 保存済みの host が URL 形式でも一致とみなす", () => {
  // 0.3.2 以前に保存された登録が残っていても、毎回 new と誤判定して
  // 提案が出続けることがないように。
  const legacy = [{ host: "http://example.com/", username: "alice", password: "pw1", label: "" }];
  assert.equal(classifySuggestion(legacy, "example.com", "alice", "pw1"), "same");
  assert.equal(classifySuggestion(legacy, "example.com", "alice", "other"), "update");
});

test("F-08 (AC-08-5): ポートが違えば別の host", () => {
  assert.equal(classifySuggestion(ENTRIES, "localhost:9999", "user", "passwd"), "new");
});

test("F-08: 金庫が空でも落ちない", () => {
  assert.equal(classifySuggestion([], "example.com", "u", "p"), "new");
  assert.equal(classifySuggestion(null, "example.com", "u", "p"), "new");
});
