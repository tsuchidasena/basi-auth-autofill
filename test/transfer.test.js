// Test names carry the feature ID so `weathering` can spot a v1 feature that
// has no test. Each case names the acceptance criterion it stands for.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EXPORT_KIND,
  EXPORT_VERSION,
  buildEncryptedExport,
  buildPlainExport,
  parseImport,
  mergeEntries,
} from "../extension/src/transfer.js";

const PASS = "correct horse battery staple";

const ENTRIES = [
  { host: "example.com", username: "alice", password: "pw1", label: "本番" },
  { host: "*.stg.example.com", username: "bob", password: "pw2", label: "" },
];

const rejects = (fn, message) => assert.rejects(fn, (e) => e.message === message);

// --- F-01 export ----------------------------------------------------------

test("F-01 (AC-01-2): パスフレーズで暗号化し、同じパスフレーズで復元できる", async () => {
  const file = await buildEncryptedExport(ENTRIES, PASS);
  assert.equal(typeof file.ct, "string");
  assert.notEqual(file.ct, "");
  assert.deepEqual(await parseImport(file, PASS), ENTRIES);
});

test("F-01 (AC-01-2): パスフレーズが空ならエクスポートしない", async () => {
  await rejects(() => buildEncryptedExport(ENTRIES, ""), "EMPTY_PASSPHRASE");
});

test("F-01 (AC-01-2): エクスポートのたびに salt と iv が変わる", async () => {
  const a = await buildEncryptedExport(ENTRIES, PASS);
  const b = await buildEncryptedExport(ENTRIES, PASS);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct); // 同じ平文でも暗号文が一致しない
});

test("F-01 (AC-01-3): 暗号化ファイルは kind と v を持ち、平文は含まない", async () => {
  const file = await buildEncryptedExport(ENTRIES, PASS);
  assert.equal(file.kind, EXPORT_KIND);
  assert.equal(file.v, EXPORT_VERSION);
  assert.equal(file.entries, undefined);
  assert.ok(!JSON.stringify(file).includes("alice"));
  assert.ok(!JSON.stringify(file).includes("pw1"));
});

test("F-01 (AC-01-3): 端末固有の項目を持ち込まない", async () => {
  const dirty = [{ ...ENTRIES[0], bioWrap: { iv: "x", ct: "y" }, noLock: true }];
  const [entry] = await parseImport(await buildEncryptedExport(dirty, PASS), PASS);
  assert.deepEqual(Object.keys(entry).sort(), ["host", "label", "password", "username"]);
});

test("F-01 (AC-01-3): 平文エクスポートも kind と v を持つ", () => {
  const file = buildPlainExport(ENTRIES);
  assert.equal(file.kind, EXPORT_KIND);
  assert.equal(file.v, EXPORT_VERSION);
  assert.equal(file.plaintext, true);
  assert.deepEqual(file.entries, ENTRIES);
});

// --- F-02 import ----------------------------------------------------------

test("F-02 (AC-02-1): 誤ったパスフレーズは WRONG_PASSPHRASE で弾く", async () => {
  const file = await buildEncryptedExport(ENTRIES, PASS);
  await rejects(() => parseImport(file, "wrong"), "WRONG_PASSPHRASE");
});

test("F-02 (AC-02-1): パスフレーズ未入力は WRONG_PASSPHRASE と区別する", async () => {
  const file = await buildEncryptedExport(ENTRIES, PASS);
  await rejects(() => parseImport(file, ""), "EMPTY_PASSPHRASE");
});

test("F-02 (AC-02-2): kind 不一致は BAD_FORMAT", async () => {
  await rejects(() => parseImport({ kind: "something-else", v: 1 }, PASS), "BAD_FORMAT");
  await rejects(() => parseImport({ hello: "world" }, PASS), "BAD_FORMAT");
  await rejects(() => parseImport(null, PASS), "BAD_FORMAT");
});

test("F-02 (AC-02-2): v 不一致は BAD_VERSION", async () => {
  await rejects(() => parseImport({ kind: EXPORT_KIND, v: 99 }, PASS), "BAD_VERSION");
});

test("F-02 (AC-02-2): 壊れたエントリは BAD_FORMAT", async () => {
  const bad = { kind: EXPORT_KIND, v: EXPORT_VERSION, plaintext: true, entries: [{ username: "x" }] };
  await rejects(() => parseImport(bad, PASS), "BAD_FORMAT");
});

test("F-02 (AC-02-2): 平文を装って entries が無いファイルも BAD_FORMAT", async () => {
  const bad = { kind: EXPORT_KIND, v: EXPORT_VERSION, plaintext: true };
  await rejects(() => parseImport(bad, PASS), "BAD_FORMAT");
});

// --- F-02 merge -----------------------------------------------------------

const EXISTING = [{ host: "example.com", username: "mine", password: "keep", label: "自分" }];
const INCOMING = [
  { host: "example.com", username: "theirs", password: "replace", label: "相手" },
  { host: "new.example.com", username: "new", password: "np", label: "" },
];

test("F-02 (AC-02-3): 既定では衝突をスキップし、既存を残す", () => {
  const r = mergeEntries(EXISTING, INCOMING);
  assert.deepEqual(r.conflicts, ["example.com"]);
  assert.deepEqual(r.skipped, ["example.com"]);
  assert.deepEqual(r.overwritten, []);
  assert.equal(r.next.find((e) => e.host === "example.com").username, "mine");
});

test("F-02 (AC-02-3): 指定した host だけ上書きする", () => {
  const r = mergeEntries(EXISTING, INCOMING, new Set(["example.com"]));
  assert.deepEqual(r.overwritten, ["example.com"]);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.next.find((e) => e.host === "example.com").username, "theirs");
});

test("F-02 (AC-02-3): overwriteHosts は配列でも受け付ける", () => {
  const r = mergeEntries(EXISTING, INCOMING, ["example.com"]);
  assert.deepEqual(r.overwritten, ["example.com"]);
});

test("F-02 (AC-02-3): 衝突しない host はそのまま追加する", () => {
  const r = mergeEntries(EXISTING, INCOMING);
  assert.deepEqual(r.added, ["new.example.com"]);
  assert.equal(r.next.length, 2);
});

test("F-02 (AC-02-4): 取り込み / スキップ / 上書きの件数が合う", () => {
  const incoming = [
    { host: "example.com", username: "a", password: "1", label: "" },
    { host: "b.com", username: "b", password: "2", label: "" },
    { host: "c.com", username: "c", password: "3", label: "" },
  ];
  const r = mergeEntries(EXISTING, incoming, new Set(["example.com"]));
  assert.equal(r.added.length, 2);
  assert.equal(r.overwritten.length, 1);
  assert.equal(r.skipped.length, 0);
  assert.equal(r.added.length + r.overwritten.length + r.skipped.length, incoming.length);
  assert.equal(r.next.length, EXISTING.length + r.added.length);
});

test("F-02 (AC-02-3): 元の配列を書き換えない", () => {
  const existing = structuredClone(EXISTING);
  mergeEntries(existing, INCOMING, new Set(["example.com"]));
  assert.deepEqual(existing, EXISTING);
});

test("F-02 (AC-02-3): 空の金庫への取り込みは全件 added", () => {
  const r = mergeEntries([], INCOMING);
  assert.equal(r.added.length, 2);
  assert.deepEqual(r.conflicts, []);
});

test("F-02 (AC-02-3): incoming 内の重複 host も衝突として報告する", () => {
  const dup = [
    { host: "dup.com", username: "first", password: "1", label: "" },
    { host: "dup.com", username: "second", password: "2", label: "" },
  ];
  const r = mergeEntries([], dup);
  assert.deepEqual(r.added, ["dup.com"]);
  assert.deepEqual(r.conflicts, ["dup.com"]);
  assert.equal(r.next.length, 1);
});

// --- round trip -----------------------------------------------------------

test("F-01/F-02: 暗号化 → 復号 → マージが一周する", async () => {
  const file = await buildEncryptedExport(INCOMING, PASS);
  const parsed = await parseImport(file, PASS);
  const r = mergeEntries(EXISTING, parsed, new Set(["example.com"]));
  assert.equal(r.next.length, 2);
  assert.equal(r.next.find((e) => e.host === "example.com").password, "replace");
});

// --- F-10 hardReload の射影（v0.4） ---------------------------------------

test("F-10 (AC-10-1): hardReload はエクスポートに含めない", async () => {
  const withFlag = [{ ...ENTRIES[0], hardReload: true }];
  const file = await buildEncryptedExport(withFlag, PASS);
  const [entry] = await parseImport(file, PASS);
  assert.equal(entry.hardReload, undefined);
  assert.deepEqual(Object.keys(entry).sort(), ["host", "label", "password", "username"]);
});

test("F-10 (AC-10-1): 平文エクスポートにも hardReload を含めない", () => {
  const file = buildPlainExport([{ ...ENTRIES[0], hardReload: true }]);
  assert.equal(file.entries[0].hardReload, undefined);
});

test("F-10 (AC-10-1): マージは既存の hardReload を保つ", () => {
  const existing = [{ host: "example.com", username: "mine", password: "keep", label: "", hardReload: true }];
  const r = mergeEntries(existing, [{ host: "new.com", username: "n", password: "p", label: "" }]);
  assert.equal(r.next.find((e) => e.host === "example.com").hardReload, true);
});

test("F-10 (AC-10-1): 上書きしても hardReload は引き継ぐ", () => {
  // フラグは「この端末でその host をどう見るか」であって資格情報ではない。
  // 取り込んだファイルはこの設定について何の意見も持っていない。
  const existing = [{ host: "example.com", username: "mine", password: "keep", label: "", hardReload: true }];
  const incoming = [{ host: "example.com", username: "theirs", password: "replace", label: "" }];
  const r = mergeEntries(existing, incoming, new Set(["example.com"]));
  const merged = r.next.find((e) => e.host === "example.com");
  assert.equal(merged.username, "theirs");
  assert.equal(merged.hardReload, true);
});

test("F-10 (AC-10-1): 新規に取り込んだエントリの hardReload は false", () => {
  const r = mergeEntries([], [{ host: "new.com", username: "n", password: "p", label: "" }]);
  assert.equal(r.next[0].hardReload, false);
});
