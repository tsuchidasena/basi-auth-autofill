# basic-auth-autofill — repo conventions

HTTP Basic 認証の資格情報を暗号化保存して自動入力する Chrome 拡張（Manifest V3）。
利用者は2人（社内・両者 macOS）。Chrome ウェブストアには出さず、git clone で配布する。

- 要件: [`PROJECT_SPEC.md`](../PROJECT_SPEC.md)
- 開発: [`docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md)
- タスク台帳: `~/Documents/claude-shared/basic-auth-autofill/tasks.md`（repo 外・コミットしない）

## 構成の大原則

**`extension/` の中には、ブラウザに読み込ませるものだけを置く。** Chrome に渡すのは
`extension/` であってリポジトリのルートではない。開発用のものを混ぜると起動時の読み込みが
通らなくなり、**再起動のたびに拡張が消える**（実際に踏んだ。経緯は `docs/DEVELOPMENT.md`）。

**拡張本体はビルド不要。** バンドラ導入やトランスパイル前提のコードは入れない。

**`chrome.*` 依存の線**が設計上いちばん重要。`crypto.js` `host.js` `transfer.js` `suggest.js` は
`chrome.*` を参照しない（Node でテストできる）。DOM とファイル入出力は `popup.js` `options.js` に閉じる。

## コマンド

```sh
pnpm install          # 初回のみ（devDependency は eslint のみ）
pnpm lint             # ESLint 9 flat config
pnpm test             # node --test（transfer.js の純粋ロジック）
node tools/gen-icons.js   # icons/ を再生成
node tools/ext-id.js      # manifest.json の key から拡張 ID を算出
```

`check` スキルは lint と test を回す。typecheck / build は存在しない。

`.claude/settings.json` はサンドボックスが書き込みを拒否する。hook を足すときは
`/update-config` を使うか、ユーザーに実行してもらう。

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
"version": "0.2.7",                     // extension/manifest.json。作業ごとに patch +1
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

`node tools/ext-id.js` で manifest から ID を再算出できる。Chrome には `extension/` を読み込ませる。
ネイティブホストの登録は `./native/install.sh lddkfmdklnjalpkojbfajlkcgghidjhc`。
秘密鍵は .crx 署名に切り替える場合にのみ必要。失うと ID を再現できないので消さない。

## 触るときに注意が要る場所

`docs/DEVELOPMENT.md` の「壊しやすい場所」と「実測で分かったこと」を読むこと。要点だけ:

- `transfer.js` の射影は `normalizeEntry` と `toExportEntry` を兼ねない
- `background.js` の単一飛行（`unlockInFlight`）を壊すと Touch ID が多重に出る
- バッジは `!`（解錠）が `+`（登録提案）に優先する
- `manifest.json` の `key` を変えると拡張 ID が変わり保存データが参照できなくなる
- `extension/src/native.js` ↔ `native/src/main.swift` の契約は片方だけ変えない
