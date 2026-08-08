# 開発

コードを触る人向け。使い方は [`../README.md`](../README.md)、
何を作るかと受け入れ条件は [`../PROJECT_SPEC.md`](../PROJECT_SPEC.md)。

## セットアップ

拡張本体は**ビルド不要**。`chrome://extensions` で `extension/` を unpacked 読み込みすれば動く。
以下は開発時だけ使う。

```sh
pnpm install                      # eslint のみ
pnpm lint
pnpm test                         # node --test。純粋モジュールが対象
node tools/local-401-server.js    # 動作確認用の 401 サーバ（user / passwd）
node tools/ui-preview.js          # 拡張の画面を Chrome の外で開く
node tools/gen-icons.js           # extension/icons/ を再生成
node tools/ext-id.js              # manifest の key から拡張 ID を算出
```

`tools/ui-preview.js` は `chrome.*` だけを差し替えて `extension/src/*.html` を配信する。
`vault.js` / `host.js` / `transfer.js` は実物のまま動く（localhost は secure context なので
`crypto.subtle` が使える）。Touch ID・ネイティブメッセージング・webRequest は対象外。

## ディレクトリ

```
extension/            Chrome が読むのはここだけ
  src/crypto.js       WebCrypto ラッパ           ┐
  src/host.js         host の正規化と照合         │ chrome.* に依存しない
  src/transfer.js     エクスポート/インポート      │ ＝ node --test で直接叩ける
  src/suggest.js      登録提案の判定             ┘
  src/vault.js        金庫（storage + native に依存）
  src/native.js       Native Messaging ラッパ
  src/background.js   Service Worker
  src/popup.* options.*   DOM とファイル入出力はここに閉じる
native/               Swift 製ネイティブホスト
tools/ test/ docs/ node_modules/    ブラウザには読み込ませない
```

**`extension/` には、ブラウザが読む必要のあるものだけを置く。** 開発用のファイルを混ぜると
起動時の読み込みが通らなくなる（後述）。

**`chrome.*` 依存の線が構造上いちばん重要。** 純粋な4モジュールに `chrome.*` を持ち込むと、
その瞬間 `test/` から触れなくなる。実際 `host.js` は v0.3.2 まで `vault.js` の中にあり、
そのせいでワイルドカード照合が一度もテストされていなかった。

## 規約

- ドキュメント・UI 文言・コミット本文は日本語。コード内コメントは英語
- コメントは「なぜ」を書く。「何を」はコードで読ませる
- エラーは `throw new Error("UPPER_SNAKE")` で種別を表し、呼び出し側が `message` で分岐する
- 命名・整形の機械的な部分は `eslint.config.js` に落とす
- コードを変えたコミットでは `extension/manifest.json` の `version` を patch +1 する。
  `chrome://extensions` の表示が「いま読み込まれているのがどのビルドか」の唯一の手がかり
- ブランチを切ってから編集する

## ストレージ

| 領域 | キー | 内容 | 寿命 |
|---|---|---|---|
| `storage.local` | `vault` | `{salt, iv, ct}`。復号すると `{entries}` | 永続 |
| `storage.local` | `bioWrap` | 金庫鍵を生体鍵で包んだ封筒 | 永続 |
| `storage.session` | `sessionKey` | 金庫鍵の raw(base64) | ブラウザ終了で消滅 |
| `storage.session` | `bioSuppressed` | 自動解錠の再試行を抑制中 | 同上 |
| `storage.session` | `suggestDismissed` | 登録提案を却下した host | 同上 |
| SW メモリ | `watching` / `suggestion` / `unlockInFlight` | — | SW 停止で消滅 |

抑制と却下が `storage.session` にあるのは、MV3 の Service Worker がアイドル数十秒で停止し、
モジュール変数が消えるため。メモリに持つと SW が一度落ちただけで抑制が解除され、
プロンプトが復活する。

## ネイティブホスト（Touch ID）

macOS のみ。`chrome.runtime.sendNativeMessage` で Swift 製ホストと JSON をやりとりする
（`status` / `enroll` / `unlock` / `reset`）。

32 バイトの生体鍵を login キーチェーンに置き、`LAContext.evaluatePolicy` を通過したときだけ返す。
拡張側はその鍵で金庫鍵をアンラップする。マスターパスワードは独立した解錠経路として併存する。

ハードウェア保護つきキーチェーン（`SecAccessControl` / Secure Enclave）は**有料 Apple Developer の
署名が必須**で、ad-hoc 署名では `errSecMissingEntitlement`（-34018）になる。そのため Touch ID は
**ソフトウェアゲート**であり、このユーザー権限でコード実行できる攻撃者は鍵を直接取れる。
at-rest 強度はマスターパスワードのみ運用に劣る。利便性レイヤーと割り切っている。

導入は `./native/install.sh`（引数なしで拡張 ID を算出する）。ホスト manifest の置き場所は
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`。
単体で切り分けたいときは `chrome-extension://<拡張ID>/src/native-test.html` を直接開く。

---

# 実測で分かったこと

**ドキュメントだけで判断して外したものが複数ある。** 以下はすべて実機で確かめた結果で、
これに反する実装をすると動かない。

## Chrome は `onAuthRequired` のコールバックを待ち続ける

180 秒保留しても諦めず、`onErrorOccurred` も発火しない。MV3 の Service Worker も
**保留中は停止しない**（アイドル 30 秒停止はこの経路で効かない）。保留後に資格情報を渡せば
そのまま認証が通る。

**制約は Chrome ではなくオリジンサーバ側にあった。** 180 秒保留したときの `503` は
`onErrorOccurred` ではなく `onCompleted` で観測された＝ワイヤ越しの応答で、長時間保留された
サーバが先に接続を諦めた跡。nginx の `keepalive_timeout` は既定 75 秒、Apache の `Timeout` は 60 秒。

→ `BIO_TIMEOUT_MS = 15_000` の根拠はここ。「どのサーバ設定でも確実に間に合う値」であって、
Chrome の上限を避けるための値ではない。

## ブラウザの認証ダイアログに入力された資格情報は観測できない

同じリクエストについて、拡張からは `onBeforeSendHeaders` と `onSendHeaders` の**両方で
`Authorization` が見えない**のに、サーバには `Authorization` 付きで到達していた。
**Chrome の認証ハンドラは webRequest の観測点より下流で差し込んでいる。**

公式ドキュメントの「`Authorization` は `extraHeaders` を指定すれば見える」は、**拡張自身が
組み立てるリクエスト**の話であって、ブラウザのダイアログが入れる資格情報には当てはまらない。

→ 登録提案は「入力を 1 回で済ませる」設計を諦め、「**2xx で完了したのに未登録**」を検知して
登録を促す形にした。副次的に、拡張が平文の資格情報を保持する必要が消えた。

## `declarativeNetRequest` では host 意味論を表現できない

`urlFilter: "||example.com"` は**サブドメインにも当たる**ので完全一致とワイルドカードの区別が潰れ、
`localhost:8765` のような**ポート指定を表現する手段がない**（`requestDomains` もポートを持てない）。

→ 「常にハードリロード」は dNR を使わず、`onCompleted` の `fromCache` を見て
`chrome.tabs.reload({bypassCache:true})` する。照合は `host.js` のまま一本で済み、追加権限も要らない。
キャッシュ迂回が効くかどうか以前に、この理由で落とした。

## 拡張ディレクトリに `node_modules` があると起動時に読み込めない

開発ツールチェーンを導入した際、リポジトリのルートを Chrome に読み込ませたままにしていた。
拡張として必要な 40 ファイルに対し、実際には 1890 ファイル（シンボリックリンク 192 本、
`_` 始まりのファイル多数）を読ませていた。

**Chrome を再起動するたびに拡張が一覧から消える**状態になり、`chrome://extensions` には
エラーも出なかった（`registry_status` は `ENABLED` のまま）。原因特定に長時間を要した。

## Chrome の認証キャッシュは空の資格情報も覚える

ダイアログを空のまま閉じると Chrome が `Authorization: Basic Og==`（`:`）をキャッシュし、
以後それを先回りして送り続ける。サーバが **403 を返すと詰む** — 403 は「認証済みだが権限がない」
なので、ブラウザは再チャレンジしない。

→ `tools/local-401-server.js` は誤った資格情報にも **401** を返す。それでも詰まった場合は
**Chrome の再起動**でキャッシュが消える（メモリ上にあるため）。realm はサーバ起動ごとなので、
やり直すときはサーバも再起動する。

---

# 壊しやすい場所

**`transfer.js` のエントリ射影** — `normalizeEntry`（内部用・`hardReload` を保つ）と
`toExportEntry`（出力用・落とす）を 1 つの関数で兼ねない。`mergeEntries` が `existing.map()` を
通す経路があるため、兼ねるとインポートのたびに端末ごとの設定が消える。上書き時も `hardReload` は
引き継ぐ（フラグは資格情報ではなく、取り込んだファイルはこの設定について意見を持たない）。

**単一飛行（`unlockInFlight`）** — 1 ページに 401 のサブリソースが複数あると `onAuthRequired` が
同時多発する。素直に書くと Touch ID プロンプトがその数だけ出て操作不能になる。

**バッジの意味が 2 つある** — `!`（赤・解錠が必要）と `+`（青・登録の提案あり）。**`!` が優先**
（施錠中の金庫には登録もできないので、先に `+` を見せると行き止まりに誘導する）。バッジは
ブラウザ側の状態で SW より長生きするため、**SW 起動時に `refreshBadge()` を呼ぶ**。

**`manifest.json` の `key`** — 変えると拡張 ID が変わり、`storage.local` が丸ごと参照できなくなる。
`native/install.sh` の再実行も必要。秘密鍵はリポジトリに置かない。

---

# 既知の割り切り

- **未登録の host でも Touch ID が出る** — 施錠中は「その host の登録があるか」を判定できない
  （判定に復号が要り、復号に解錠が要る）。回避するにはホスト一覧を平文で持つ必要があり、そちらが損
- **認証不要のパスが 200 を返しても登録提案が出る** — 検知は「401 を返した host への 2xx」なので
  区別できない。1 度却下すればそのセッション中は黙る
- **プロキシ認証は対象外** — `isProxy` はブラウザに委ねる
