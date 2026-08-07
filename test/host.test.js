// Host normalisation and matching. Test names carry the feature ID.
//
// The bug behind these: an entry was saved as "http://localhost:8765/" — the
// URL straight from the address bar — which can never equal the
// `new URL(details.url).host` that background.js matches against
// ("localhost:8765"). It saved cleanly and silently never fired.

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeHost, hostMatches } from "../extension/src/host.js";

// --- normalizeHost --------------------------------------------------------

test("F-00 (host): 貼り付けた URL から host を取り出す", () => {
  assert.equal(normalizeHost("http://localhost:8765/"), "localhost:8765");
  assert.equal(normalizeHost("https://example.com"), "example.com");
  assert.equal(normalizeHost("https://example.com/admin/index.php"), "example.com");
  assert.equal(normalizeHost("https://example.com:8443/path?q=1#frag"), "example.com:8443");
});

test("F-00 (host): すでに host 形式のものはそのまま通す", () => {
  assert.equal(normalizeHost("example.com"), "example.com");
  assert.equal(normalizeHost("example.com:8443"), "example.com:8443");
  assert.equal(normalizeHost("localhost:8765"), "localhost:8765");
});

test("F-00 (host): ワイルドカードを保つ", () => {
  assert.equal(normalizeHost("*.example.com"), "*.example.com");
  assert.equal(normalizeHost("  *.Example.COM/  "), "*.example.com");
});

test("F-00 (host): パス・クエリ・フラグメントを落とす", () => {
  assert.equal(normalizeHost("example.com/admin"), "example.com");
  assert.equal(normalizeHost("example.com?a=1"), "example.com");
  assert.equal(normalizeHost("example.com#top"), "example.com");
});

test("F-00 (host): 埋め込み資格情報を落とす", () => {
  assert.equal(normalizeHost("user:pass@example.com"), "example.com");
  assert.equal(normalizeHost("http://user:pass@example.com/"), "example.com");
});

test("F-00 (host): 大文字と前後の空白を均す", () => {
  assert.equal(normalizeHost("  EXAMPLE.com  "), "example.com");
  assert.equal(normalizeHost("HTTP://Example.COM:8443/"), "example.com:8443");
});

test("F-00 (host): 末尾のドットを落とす", () => {
  assert.equal(normalizeHost("example.com."), "example.com");
});

test("F-00 (host): 空入力は空を返す", () => {
  assert.equal(normalizeHost(""), "");
  assert.equal(normalizeHost("   "), "");
  assert.equal(normalizeHost(null), "");
  assert.equal(normalizeHost(undefined), "");
});

test("F-00 (host): 正規化は冪等", () => {
  for (const raw of ["http://localhost:8765/", "*.Example.com/path", "user@example.com:1234/x"]) {
    const once = normalizeHost(raw);
    assert.equal(normalizeHost(once), once, `not idempotent for ${raw}`);
  }
});

test("F-00 (host): 正規化した結果が実際のリクエスト host と一致する", () => {
  // background.js は new URL(details.url).host で照合する。両者が揃うことが要件。
  for (const url of [
    "http://localhost:8765/",
    "https://example.com/admin",
    "https://example.com:8443/a/b?c=1",
  ]) {
    assert.equal(normalizeHost(url), new URL(url).host);
  }
});

// --- hostMatches ----------------------------------------------------------

test("F-00 (host): 完全一致", () => {
  assert.ok(hostMatches("example.com", "example.com"));
  assert.ok(hostMatches("example.com:8443", "example.com:8443"));
  assert.ok(!hostMatches("example.com", "example.com:8443"));
  assert.ok(!hostMatches("example.com", "notexample.com"));
});

test("F-00 (host): ワイルドカードはサブドメインと基底ドメインに当たる", () => {
  assert.ok(hostMatches("*.example.com", "a.example.com"));
  assert.ok(hostMatches("*.example.com", "a.b.example.com"));
  assert.ok(hostMatches("*.example.com", "example.com"));
});

test("F-00 (host): ワイルドカードが接尾辞だけの一致で誤爆しない", () => {
  assert.ok(!hostMatches("*.example.com", "notexample.com"));
  assert.ok(!hostMatches("*.example.com", "example.com.evil.test"));
});
