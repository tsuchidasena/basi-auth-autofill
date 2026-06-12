# Release Notes

## 0.2.0
- Touch ID 解錠を追加（macOS / 任意）
  - Native Messaging + macOS LocalAuthentication による完全ローカル方式（クラウド非依存）
  - マスターパスワードを独立したリカバリ経路として併存（エンベロープ方式で金庫鍵をラップ）
  - `native/`（Swift ホスト・build.sh・install.sh）, `src/native.js` を追加
- README をエンドユーザー向けの導入ガイドに刷新（インストール / 動作確認 / Touch ID 設定 / トラブルシュート）
- セキュリティ上の割り切り（鍵は login キーチェーン保存・非ハードウェア保護）を明記

## 0.1.0
- 初版。HTTP Basic 認証の自動入力
  - `chrome.webRequest.onAuthRequired` による資格情報供給
  - マスターパスワード（PBKDF2 + AES-GCM）で暗号化保存
  - host マッチング（完全一致 / ポート / `*.example.com`）、誤入力ループ防止
  - ポップアップ / 設定画面
