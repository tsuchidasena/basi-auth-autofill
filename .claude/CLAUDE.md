# basic-auth-autofill — repo conventions

HTTP Basic 認証の資格情報を暗号化保存して自動入力する Chrome 拡張（Manifest V3）。
利用者は2人（社内・両者 macOS）。Chrome ウェブストアには出さず、git clone で配布する。

- 要件: [`PROJECT_SPEC.md`](../PROJECT_SPEC.md)
- 詳細設計: [`docs/DESIGN.md`](../docs/DESIGN.md)
- タスク台帳: `~/Documents/claude-shared/basic-auth-autofill/tasks.md`（repo 外・コミットしない）

## 構成の大原則

**拡張本体はビルド不要**。`chrome://extensions` に unpacked で読み込めばそのまま動く。
Node のツールチェーンは開発時のみで、配布物には一切含めない（`node_modules/` `tools/` `test/`）。
この性質を壊す変更（バンドラ導入・トランスパイル前提のコード）は入れない。

## `chrome.*` 依存の境界

設計上いちばん重要な線。

- `src/crypto.js` `src/transfer.js` — `chrome.*` を**参照しない**。Node でそのままテストできる
- `src/vault.js` `src/background.js` — `chrome.storage` / `chrome.webRequest` / native に依存
- DOM 操作・ファイル入出力は `src/options.js` `src/popup.js` に閉じる

純粋モジュールに `chrome.*` を持ち込むと `test/` が動かなくなる。

## コマンド

```sh
pnpm install          # 初回のみ（devDependency は eslint のみ）
pnpm lint             # ESLint 9 flat config
pnpm test             # node --test（transfer.js の純粋ロジック）
node tools/gen-icons.js   # icons/ を再生成
node tools/ext-id.js      # manifest.json の key から拡張 ID を算出
```

`check` スキルは lint と test を回す。typecheck / build は存在しない。

## 規約

- 言語: ドキュメント・UI 文言・コミットメッセージ本文は日本語。コード内コメントは英語（既存に合わせる）
- コメントは「なぜ」を書く。「何を」はコードで読ませる
- エラーは `throw new Error("UPPER_SNAKE")` で種別を表し、呼び出し側が `message` で分岐する（`vault.js` の既存流儀）
- 命名・整形の機械的な部分は `eslint.config.js` に落とす。散文の規約を増やさない

## Git

- ブランチを切ってから編集する（`main` で直接編集しない）
- コミットメッセージ本文は日本語、1行目は英語の要約でよい（既存履歴に合わせる）
- 秘密鍵（`manifest.json` の `key` に対応する `.pem`）は**repo 外**に置く。`.gitignore` に頼らない

## バージョニング（必須）

**コードに手を入れたコミットでは必ず `manifest.json` の `version` を patch +1 する。**
`chrome://extensions` の表示がそのまま「いま読み込まれているのがどのビルドか」の唯一の手がかりで、
これが動かないと再読み込みが効いたのか判断できない。

```jsonc
"version": "0.2.7",                     // 作業ごとに patch +1
"version_name": "0.2.7 — T-009 バッジ/通知"  // 何が入ったビルドか
```

- `version_name` は `chrome://extensions` で `version` の代わりに表示される。直近のタスク ID を入れる
- `package.json` の `version` も同じ値に揃える（食い違うと後で必ず迷う）
- ドキュメントだけの変更（README・docs/・.claude/）では上げなくてよい
- リリース時（T-012）に `version` を `0.3.0` に上げ、`version_name` は削除する

## 拡張 ID と秘密鍵

`manifest.json` の `key` により **ID はパスに依存せず固定**（v0.3.0 で導入）。

```
拡張 ID : lddkfmdklnjalpkojbfajlkcgghidjhc
秘密鍵  : ~/Developers/basic-auth-autofill-keys/extension-key.pem （repo 外・600）
```

`node tools/ext-id.js` で manifest から ID を再算出できる。
ネイティブホストの登録は `./native/install.sh lddkfmdklnjalpkojbfajlkcgghidjhc`。
秘密鍵は .crx 署名に切り替える場合にのみ必要。失うと ID を再現できないので消さない。

## 触るときに注意が要る場所

- `src/background.js` の `onAuthRequired` — `asyncBlocking` のコールバックを保留する設計。
  単一飛行（`unlockInFlight`）を壊すと Touch ID プロンプトが多重に出る
- `src/native.js` ↔ `native/src/main.swift` — Native Messaging の契約。片方だけ変えない
- `manifest.json` の `key` — 変えると拡張 ID が変わり、保存データが参照できなくなる。
  `native/install.sh` の再実行も必要になる
