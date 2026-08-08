// Test names carry the feature ID so `weathering` can spot a v1 feature with
// no test.

import { test } from "node:test";
import assert from "node:assert/strict";

import { hasEntryFor, classifySuggestion, existingUsername } from "../extension/src/suggest.js";

const ENTRIES = [
  { host: "example.com", username: "alice", password: "pw1", label: "" },
  { host: "localhost:8765", username: "user", password: "passwd", label: "" },
];

test("F-08 (AC-08-3): 登録が無い host は new", () => {
  assert.equal(classifySuggestion(ENTRIES, "new.example.com", false), "new");
});

test("F-08 (AC-08-5): 供給した資格情報が拒否されていれば update", () => {
  assert.equal(classifySuggestion(ENTRIES, "example.com", true), "update");
});

test("F-08 (AC-08-5): 登録があれば supplied でなくても update", () => {
  // 施錠中に手入力された場合など、供給していなくても登録は存在しうる。
  assert.equal(classifySuggestion(ENTRIES, "example.com", false), "update");
});

test("F-08 (AC-08-5): 保存済みの host が URL 形式でも一致とみなす", () => {
  // 0.3.2 以前に保存された登録が残っていても、毎回 new と誤判定しないように。
  const legacy = [{ host: "http://example.com/", username: "alice", password: "pw1", label: "" }];
  assert.equal(classifySuggestion(legacy, "example.com", false), "update");
});

test("F-08: ポートが違えば別の host", () => {
  assert.equal(classifySuggestion(ENTRIES, "localhost:9999", false), "new");
});

test("F-08: 金庫が空でも落ちない", () => {
  assert.equal(classifySuggestion([], "example.com", false), "new");
  assert.equal(classifySuggestion(null, "example.com", false), "new");
  assert.equal(hasEntryFor(null, "example.com"), false);
});

test("F-08 (AC-08-4): 更新のときは既存のユーザ名を返す", () => {
  assert.equal(existingUsername(ENTRIES, "example.com"), "alice");
  assert.equal(existingUsername(ENTRIES, "http://example.com/"), "alice");
  assert.equal(existingUsername(ENTRIES, "unknown.com"), "");
  assert.equal(existingUsername(null, "example.com"), "");
});
