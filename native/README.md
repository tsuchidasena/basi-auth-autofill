# Touch ID Native Host

完全ローカルで Touch ID 解錠を行うためのネイティブ補助プログラム（macOS / Swift）。
クラウド（Apple ID / Google アカウント）には一切依存しません。

## 仕組み
- ランダムな 32 バイトの「生体鍵」を **login キーチェーン**に保存。
- そのキーチェーン項目は `SecAccessControl(.userPresence)` で保護され、**読み出しに Touch ID（または端末パスコード）が必要**。
- Chrome 拡張は `chrome.runtime.sendNativeMessage` でこのホストと通信し、解錠時に Touch ID を経て鍵を受け取る。
- 拡張はその鍵で「金庫の鍵」をアンラップする（マスターパスワードはリカバリ用に併存）。

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
