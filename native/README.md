# Touch ID Native Host

完全ローカルで Touch ID 解錠を行うためのネイティブ補助プログラム（macOS / Swift）。
クラウド（Apple ID / Google アカウント）には一切依存しません。

## 仕組み（方式B: LAContext ゲート）
- ランダムな 32 バイトの「生体鍵」を **login キーチェーン**に通常の generic password として保存。
- 解錠時、ホストが `LAContext.evaluatePolicy(.deviceOwnerAuthentication)` で **Touch ID（端末パスコードにフォールバック可）** を要求し、成功した場合のみ鍵を返す。
- Chrome 拡張は `chrome.runtime.sendNativeMessage` でこのホストと通信し、受け取った鍵で「金庫の鍵」をアンラップする（マスターパスワードはリカバリ用に併存）。

### セキュリティ上の注意（重要）
ハードウェア保護つきキーチェーン（`SecAccessControl` / Secure Enclave）は **有料 Apple Developer の署名＋プロビジョニングプロファイルが必須**で、ad-hoc 署名では使えません（`errSecMissingEntitlement` / -34018）。本方式は Touch ID を**ソフトウェア的なゲート**として使い、鍵自体は login キーチェーンに置きます。そのため、**このユーザ権限でコード実行できる攻撃者は Touch ID を経ずに鍵を取り出せます**（"security theater"）。マスターパスワード解錠の強度（秘密が頭の中だけ）には及びません。利便性レイヤーと割り切って使ってください。

## 必要なもの
- macOS + Touch ID 搭載 Mac
- Xcode Command Line Tools（`xcode-select --install` で `swiftc` が入る）

## セットアップ
1. Chrome で拡張を unpacked 読み込みし、`chrome://extensions` の **拡張 ID** を控える
   （検証ページにも表示されます）。
2. ターミナルで：
   ```sh
   ./native/install.sh <拡張ID>
   ```
   これがビルド（`build.sh`）とネイティブホスト manifest の設置を行います。
3. Chrome を再起動（または拡張を再読み込み）。
4. 検証ページ（拡張のオプション）で status → enroll → unlock を試す。

## ホスト manifest の設置先
```
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.tsuchida.basic_auth_autofill.json
```

## コマンド（JSON / stdin・stdout）
| cmd | 説明 | 応答 |
|---|---|---|
| `status` | 登録済みか | `{ok, enrolled}` |
| `enroll` | 生体鍵を生成・保存し一度だけ返す | `{ok, key}` |
| `unlock` | Touch ID 後に鍵を返す | `{ok, key}` |
| `reset` | 生体鍵を削除 | `{ok}` |

## トラブルシュート
- **`Specified native messaging host not found`**: install.sh の拡張 ID が現在の ID と一致しているか、Chrome を再起動したか確認。
- **enroll は成功するが unlock でキーチェーンエラー**: ad-hoc 署名では生体保護項目が読めない環境がある。その場合は Developer ID で署名（`codesign -s "Developer ID Application: ..."`）するか、`build.sh` の署名行を調整。
- **Touch ID が出ない**: `システム設定 > Touch ID とパスコード` を確認。
