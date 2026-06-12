# Basic Auth Autofill

HTTP **Basic 認証**（ブラウザが出すネイティブなユーザー名/パスワードのダイアログ）に、
暗号化保存した資格情報を自動入力する Chrome 拡張機能です。

1Password などのパスワードマネージャーは、Basic 認証のダイアログがウェブページの DOM ではなく
**ブラウザ本体の UI** であるため入力できません。本拡張は `chrome.webRequest.onAuthRequired` を
フックし、ダイアログが出る前に資格情報を供給します。

- 対応ブラウザ: **Google Chrome 108 以上**（`webRequestAuthProvider` 権限のため）
- 対応 OS: 拡張本体はクロスプラットフォーム。**Touch ID 解錠は macOS のみ**（任意機能）

## 特長
- 🔐 マスターパスワードで AES-GCM 暗号化（PBKDF2 / SHA-256 / 250k iterations）
- 🧠 解錠中のみ鍵をメモリ（`storage.session`）に保持。ブラウザを閉じると要再解錠
- 🎯 host 単位のマッチング（完全一致 / ポート指定 / `*.example.com` ワイルドカード）
- 🔁 誤った資格情報での無限ループを防止（一度失敗したら手入力にフォールバック）
- 🍎 任意で **Touch ID 解錠**（完全ローカル / クラウドアカウント不要）
- 🛠 ビルド不要。素の Manifest V3 + HTML/CSS/JS

---

## 1. インストール（拡張本体）

1. このリポジトリをダウンロード / クローンする
   ```sh
   git clone <このリポジトリのURL> basic-auth-autofill
   ```
2. Chrome で `chrome://extensions` を開く
3. 右上の **デベロッパーモード** をオン
4. **パッケージ化されていない拡張機能を読み込む** をクリック
5. クローンしたフォルダ（`manifest.json` がある場所）を選択
6. ツールバーにアイコンが出れば完了。固定しておくと便利です

> 💡 unpacked 拡張の **拡張 ID は読み込んだフォルダのパスから決まります**。
> フォルダを移動・改名すると ID が変わり、保存データはリセット、Touch ID も再設定が必要です。
> 置き場所は決めてから読み込んでください。

## 2. 初期設定と使い方

1. アイコンをクリック → 初回は **マスターパスワード**（8文字以上）を設定
2. Basic 認証のあるサイトの資格情報を登録
   - ポップアップの「このサイトの資格情報を登録」から、または
   - 「すべての登録を管理」→ 設定画面でまとめて追加/編集
3. 以降、登録済みドメインで Basic 認証が出ると**自動でログイン**されます
4. ブラウザを再起動した後は、最初の認証の前にポップアップから **解錠** してください
   （Touch ID を有効にしていれば「Touch ID で解錠」が使えます）

### host の指定方法
| 指定 | マッチ対象 |
|---|---|
| `example.com` | `example.com`（デフォルトポート） |
| `example.com:8443` | ポート 8443 |
| `*.example.com` | `example.com` および全サブドメイン |

完全一致がワイルドカードより優先されます。

### 動作確認（任意）
公開のテスト用エンドポイントで試せます。
1. host `httpbin.org` / ユーザー名 `user` / パスワード `passwd` を登録
2. 解錠した状態で `https://httpbin.org/basic-auth/user/passwd` を開く
3. ダイアログが出ずに `{"authenticated": true, ...}` が表示されれば成功
   （一度通すと Chrome がキャッシュするので、再テストはシークレットウィンドウで）

---

## 3. Touch ID 解錠の設定（任意・macOS のみ）

マスターパスワードの代わりに Touch ID で解錠できます。**完全ローカル**で動作し、
Apple ID や Google アカウントなどのクラウドには一切依存しません。

### 必要なもの
- Touch ID 搭載の Mac
- Xcode Command Line Tools（未導入なら `xcode-select --install`）

### 手順
1. 拡張を読み込み、`chrome://extensions` でこの拡張の **ID** を控える
   （拡張のオプションや検証ページにも表示されます）
2. ターミナルで、クローンしたフォルダ内の install スクリプトを実行：
   ```sh
   ./native/install.sh <拡張ID>
   ```
   → Swift 製ネイティブホストをビルドし、Chrome に登録します
3. **Chrome を再起動**（または拡張を再読み込み）
4. 拡張のオプション → マスターパスワードで解錠 → **「Touch ID 解錠を有効化」**
5. 以降、施錠後にポップアップの **「Touch ID で解錠」** が使えます

詳細・仕組みは [`native/README.md`](native/README.md) を参照。

> ⚠️ **セキュリティ上の注意**: 鍵は login キーチェーンに保存され、**ハードウェア保護ではありません**
> （ハードウェア保護には有料 Apple Developer 署名が必要なため）。このユーザー権限で
> コード実行できる攻撃者は Touch ID を経ずに鍵を取り出せます。**at-rest 強度はマスターパスワード
> のみ運用に劣る**、あくまで利便性向けの機能と位置づけてください。

---

## セキュリティ
- パスワードは平文で保存しません。鍵はマスターパスワードから都度導出します（鍵自体は保存しない）。
- 解錠状態はメモリのみ（`storage.session`）。ブラウザ終了で破棄されます。
- マスターパスワードを忘れると復号できません。設定画面の **リセット** で全削除のみ可能です。
- content script からはアクセスできません（拡張内の信頼コンテキストのみ）。

## トラブルシュート
| 症状 | 対処 |
|---|---|
| 自動入力されずダイアログが出る | host が一致しているか / 解錠済みか確認 |
| 一度入れたら以後ダイアログが出ない | Chrome が資格情報をキャッシュ。シークレットウィンドウか再起動で再現 |
| `Specified native messaging host not found` | `install.sh` に渡した拡張 ID が現在の ID と一致するか / Chrome を再起動したか |
| 有効化時に native/host エラー | `./native/install.sh <拡張ID>` を実行したか確認（`native/README.md`） |
| Touch ID が出ない | システム設定 > Touch ID とパスコード を確認 |

## ファイル構成
```
manifest.json        MV3 マニフェスト
src/crypto.js        WebCrypto ラッパ（鍵導出・暗号/復号）
src/vault.js         金庫ロジック（初期化・解錠・CRUD・検索・Touch ID）
src/native.js        Native Messaging ラッパ
src/background.js     Service Worker（onAuthRequired フック・Touch ID 解錠）
src/popup.*          ツールバーポップアップ
src/options.*        設定画面
src/native-test.*    Touch ID ネイティブホストの検証用ページ（開発用）
native/              Swift 製ネイティブホスト（build.sh / install.sh / README）
PROJECT_SPEC.md      仕様書
RELEASE_NOTE.md      変更履歴
```

## 制限事項 / 今後
- プロキシ認証（`isProxy`）の自動供給は対象外（コード上に枠のみ）
- `chrome.storage.sync` による端末間同期は未対応
- ハードウェア保護の Touch ID は未対応（有料 Apple Developer 署名が必要なため）
- アイコン画像は未同梱（必要なら `manifest.json` の `action.default_icon` を追加）
