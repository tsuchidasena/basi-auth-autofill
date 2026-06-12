# Basic Auth Autofill

HTTP **Basic 認証**（ブラウザのネイティブなユーザ名/パスワードダイアログ）に、
暗号化保存した資格情報を自動入力する Chrome 拡張機能です。

1Password などのパスワードマネージャは Basic 認証のネイティブダイアログに入力できません。
この拡張は `chrome.webRequest.onAuthRequired` をフックし、ダイアログが出る前に資格情報を供給します。

## 特長
- 🔐 マスターパスワードで AES-GCM 暗号化（PBKDF2 / SHA-256 / 250k iterations）
- 🧠 解錠中のみ鍵をメモリ（`storage.session`）に保持。ブラウザを閉じると要再解錠
- 🎯 host 単位のマッチング（完全一致 / ポート指定 / `*.example.com` ワイルドカード）
- 🔁 誤った資格情報での無限ループを防止（一度失敗したら手入力にフォールバック）
- 🛠 ビルド不要。素の Manifest V3 + HTML/CSS/JS

## インストール（unpacked）
1. Chrome で `chrome://extensions` を開く
2. 右上の **デベロッパーモード** をオン
3. **パッケージ化されていない拡張機能を読み込む** をクリック
4. このディレクトリ（`manifest.json` がある場所）を選択

> Chrome 108 以上が必要です（`webRequestAuthProvider` 権限のため）。

## 使い方
1. ツールバーの拡張アイコンをクリック → 初回は**マスターパスワード**を設定
2. Basic 認証のあるサイトを開いた状態でポップアップを開き、ユーザ名/パスワードを登録
   （「すべての登録を管理」から設定画面でまとめて管理も可能）
3. 以降、登録済みドメインの Basic 認証は自動でログインされます
4. ブラウザ再起動後は、最初の認証前にポップアップから**解錠**してください

## Touch ID 解錠（任意・macOS のみ）
マスターパスワードの代わりに Touch ID で解錠できます（完全ローカル / クラウド不要）。
1. `native/install.sh <拡張ID>` を実行（Swift ネイティブホストをビルド＆登録。`native/README.md` 参照）
2. Chrome を再起動 → 拡張のオプション →「Touch ID 解錠を有効化」
3. 以降、ポップアップに「Touch ID で解錠」が出ます

> ⚠️ 鍵は login キーチェーンに保存され**ハードウェア保護ではありません**（ad-hoc 署名の制約）。
> at-rest 強度はマスターPWのみ運用に劣る、利便性向けの機能です。詳細は `native/README.md`。

## host の指定例
| 指定 | マッチ対象 |
|---|---|
| `example.com` | `example.com`（デフォルトポート） |
| `example.com:8443` | ポート 8443 |
| `*.example.com` | `example.com` および全サブドメイン |

完全一致がワイルドカードより優先されます。

## セキュリティ
- パスワードは平文で保存しません。鍵はマスターパスワードから都度導出します。
- 解錠状態はメモリのみ（`storage.session`）。ブラウザ終了で破棄されます。
- マスターパスワードを忘れると復号できません。設定画面の**リセット**で全削除のみ可能です。
- content script からはアクセスできません（拡張内の信頼コンテキストのみ）。

## ファイル構成
```
manifest.json        MV3 マニフェスト
src/crypto.js        WebCrypto ラッパ（鍵導出・暗号/復号）
src/vault.js         金庫ロジック（初期化・解錠・CRUD・検索）
src/background.js     Service Worker（onAuthRequired フック）
src/popup.*          ツールバーポップアップ
src/options.*        設定画面
PROJECT_SPEC.md      仕様書
```

## 制限事項 / 今後
- プロキシ認証（`isProxy`）の自動供給は対象外（コード上に枠のみ）
- chrome.storage.sync による端末間同期は未対応
- アイコン画像は未同梱（必要なら `manifest.json` の `action.default_icon` を追加）
