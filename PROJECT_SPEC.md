# Basic Auth Autofill — 仕様書

## 背景 / 課題
HTTP **Basic 認証** はブラウザがネイティブのダイアログ（OS レベルのモーダル）を出すため、
1Password などのパスワードマネージャの自動入力が効かない。毎回手入力が必要で手間。

## 解決方針
Chrome 拡張機能で `chrome.webRequest.onAuthRequired` をフックし、
登録済みの資格情報を該当ドメインに自動で供給する。これによりネイティブダイアログが出る前に認証を通す。

## 確定仕様（ユーザ合意済み）
- **進め方**: 仕様を固めてから実装
- **保存方式**: 拡張内に暗号化保存（chrome.storage.local）
- **暗号鍵**: マスターパスワード → PBKDF2(SHA-256, 250k iterations) で AES-GCM 256bit 鍵を導出
- **ビルド構成**: Manifest V3 + 素の HTML/CSS/JS（ビルド不要、unpacked で読み込み）

## アーキテクチャ
| コンポーネント | 役割 |
|---|---|
| `manifest.json` | MV3 マニフェスト。`webRequest` / `webRequestAuthProvider` / `storage` 権限 |
| `src/crypto.js` | WebCrypto ラッパ（鍵導出・AES-GCM 暗号/復号・base64） |
| `src/vault.js` | 金庫ロジック（初期化・解錠/施錠・エントリ CRUD・資格情報検索） |
| `src/background.js` | Service Worker。`onAuthRequired` をフックし資格情報を供給 |
| `src/popup.*` | ツールバーポップアップ（解錠/施錠・現在サイトのクイック登録） |
| `src/options.*` | 設定画面（マスターPW設定・全エントリの管理） |

## データモデル
### chrome.storage.local — `vault`（永続・暗号化）
```jsonc
{
  "salt": "<base64>",          // PBKDF2 salt
  "iv":   "<base64>",          // AES-GCM IV
  "ct":   "<base64>"           // 暗号文。復号すると { entries: Entry[] }
}
```
### Entry
```jsonc
{
  "host": "example.com",        // または "example.com:8443" / "*.example.com"
  "username": "user",
  "password": "pass",
  "label": "本番サーバ"          // 任意メモ
}
```
### chrome.storage.session — `sessionKey`（メモリのみ・ブラウザ終了で消滅）
解錠時に導出した AES 鍵を raw(base64) で保持。Service Worker が再起動しても解錠状態を維持。

## 認証フロー
1. ユーザがポップアップでマスターパスワードを入力 → 解錠（鍵を session に保存）
2. Basic 認証が発生 → `onAuthRequired` 発火
3. background がリクエスト URL の host を抽出 → `vault` を復号して一致する Entry を検索
4. 見つかれば `{authCredentials:{username,password}}` を供給。なければダイアログをそのまま表示
5. 一度供給した資格情報が誤っていた場合（同一 requestId で再発火）はループ防止のため供給せず、
   ユーザに手入力させる

## host マッチング規則
1. 完全一致（`example.com` / `example.com:8443`）
2. ワイルドカード（`*.example.com` は `a.example.com` にマッチ）
3. 複数該当時は完全一致を優先

## セキュリティ上の前提
- パスワードは AES-GCM で暗号化して保存。鍵はマスターパスワードからのみ導出（保存しない）。
- 解錠中は鍵が `storage.session`（メモリのみ）に存在。ブラウザを閉じると消える＝再解錠が必要。
- マスターパスワードを忘れると復号不可（リセット＝全データ削除）。
- content script からは触れない（TRUSTED_CONTEXTS のみ）。

## 非対象（今回のスコープ外）
- プロキシ認証（`isProxy`）への自動供給（拡張余地として枠だけ用意）
- 1Password 等外部マネージャ連携
- 同期（chrome.storage.sync）
