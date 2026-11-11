# Firefox のストア（AMO）で公開する手順

Live Audio Enhancer を、Firefox のストア（addons.mozilla.org、以下 AMO）で一般公開するための手順。
2026-11-11 に Mozilla の公式の説明（Extension Workshop）と AMO の仕組みを調べて書いた。画面の表示は変わることがあるので、英語の表示名も併記する。

## 全体の流れ

1. 提出用のファイルを作る（`npm run pack:firefox`）
2. Developer Hub で、初回の提出をする（ファイルのアップロードと、ストアに載せる内容の入力）
3. 公開を待つ（ふつうは 24 時間以内。人の審査に回ると 3 日〜3 週間）
4. 公開されたら、アイコンとスクリーンショットを載せる
5. 2 回目以降の版は、`npm run release:firefox` で提出する

## 決めてあること

| 項目 | 内容 | 理由 |
|---|---|---|
| 拡張の ID | `live-audio-enhancer@mynicotools` | 一度ストアに出したら変えられない。読んで分かる形にした（2026-11-11 に確定） |
| 最初に出す版 | 0.22.0 | 1.0.0 にはせず、開発中の番号のまま出す（2026-11-11 に決めた） |
| データ収集の申告 | 集めない（`none`） | 2025-11 から新しい拡張に必須。この拡張はデータを集めない |
| 対応する Firefox | 140 以上（パソコン版のみ） | 140 からデータ収集の申告を表示できる。140 は長期サポート版（ESR） |
| ライセンス | MIT | ソースを公開してよいため。`extension/LICENSE` |
| サポートのメール | info_bobo@yahoo.co.jp | ストアに公開される |

ID・データ収集の申告・対応する Firefox は、共通の `extension/manifest.json` には書かず、提出用のファイルを作るときに足す（`tools/firefox.js`）。Chrome で「認識できないキー」の警告が出ないようにするため。

## 1. 提出用のファイルを作る

```
npm run pack:firefox
```

- `extension/` をコピーし、Firefox 用の項目（ID、データ収集の申告、対応する Firefox）を足し、不要なファイル（ソースマップ）を除く
- Mozilla の検査ツール（web-ext lint）にかけてから、`dist/live-audio-enhancer-<版>-firefox.zip` を作る
- 検査でエラーが出たら止まる。今の警告は 1 件だけで、提出には影響しない
  - 「Android 版 Firefox は 142 より前ではデータ収集の申告に対応していない」という警告。Android 向けには出さないので関係ない

提出の前に、自動検証（`npm run verify:twitch` と `npm run verify:firefox -- twitch`）が通ることを確かめておく。

## 2. 初回の提出（Developer Hub）

初回は、ストアに載せる内容を入力するので、ブラウザで行う。貼り付ける文章は `docs/amo/listing.md`、審査担当者へのメモは `docs/amo/reviewer-notes.md` にある。

1. **Developer Hub を開く**
   - https://addons.mozilla.org/developers/ を開き、ZOOM IMAGE for X(Twitter) を公開しているアカウントでログインする
   - 2026-12-01 から配布契約（Distribution Agreement）が新しくなる。同意を求められたら、内容を確かめて同意する
2. **新しいアドオンを提出する**
   - 「新しいアドオンを提出」（Submit a New Add-on）を押す
3. **配布のしかたを選ぶ**
   - 「このサイトで公開」（On this site）を選ぶ。AMO に載って、誰でも探してインストールできる
   - 「自分で配布」（On your own）は、ストアに載せず署名だけ受ける方法。今回は選ばない
4. **ファイルをアップロードする**
   - `dist/live-audio-enhancer-<版>-firefox.zip` を選ぶ
   - 自動の検査が走る。エラーが 1 件でもあると先に進めない。警告だけなら進める
5. **対応するプラットフォームを選ぶ**
   - 「Firefox」（パソコン版）だけにチェックを入れる。「Firefox for Android」は外す（Android では試していないため）
6. **ソースコードの提出**
   - 「ソースコードを提出する必要がありますか」には「いいえ」（No）と答える
   - 理由：自作のコードは手書きで、圧縮もまとめもしていない。同梱のライブラリは改変しておらず、出どころと SHA-256 を審査担当者へのメモに書いてある
   - 審査で求められたら、そのときに出す
7. **ストアに載せる内容を入力する**（Describe Add-on）
   - 名前、URL（slug）、要約、説明、カテゴリ、サポートのメール、ライセンスを `docs/amo/listing.md` のとおりに入れる。ここでは日本語の文章を入れる
   - 「試験的」（experimental）と「有料」のチェックは外したまま
   - プライバシーポリシーは入れない（データを集めず、外部にも送らないので不要）
   - 「審査担当者へのメモ」（Notes for Reviewers）に `docs/amo/reviewer-notes.md` の本文（線より下）を貼る
8. **提出する**
   - 「バージョンを提出」（Submit Version）を押す

## 3. 公開を待つ

- 自動の検査と署名が済むと公開される。ふつうは 24 時間以内
- 一部の提出は、公開の前に人の審査に回される。そのときは 3 日〜3 週間ほどかかる（2026 年の Mozilla の担当者の発言による）。初回の提出で人の審査に回ると、審査が終わるまでストアのページは公開されない
- 結果は、Mozilla のアカウントのメールアドレスに届く。審査で質問や修正の依頼が来たら、Developer Hub で返事をする
- 修正の依頼に応える版には、関係のない変更を入れない（Mozilla の決まり）

## 4. 公開されたら：アイコン・スクリーンショット・英語の説明

アイコンとスクリーンショットは、提出の画面では入れられないので、公開されたあとにストアのページの編集画面で入れる。manifest のアイコンは、ストアのページには自動では使われない。

1. Developer Hub の「マイアドオン」（My Add-ons）から Live Audio Enhancer を開く
2. 「ストアのページを編集」（Edit Product Page）を開く
3. **アイコン**：`extension/icons/icon-128.png` をアップロードする
4. **スクリーンショット**：`docs/amo/screenshots/1-overview.png` と `2-auto.png` をアップロードし、説明（Caption）を `docs/amo/listing.md` のとおりに入れる
5. **英語の説明**：言語の切り替えで English を選び、名前・要約・説明を `docs/amo/listing.md` の英語の文章で入れる。英語の Firefox を使っている人には英語で表示される

## 5. 2 回目以降の版を出す

### 準備（一度だけ）：AMO の API キーを作る

1. https://addons.mozilla.org/developers/addon/api/key/ を開き、API キーを作る
2. 「JWT issuer」（`user:12345:67` のような形）と「JWT secret」が表示される。secret は人に見せない
3. パソコンの環境変数に入れる（PowerShell で次を実行し、ターミナルを開き直す）

   ```
   [Environment]::SetEnvironmentVariable('WEB_EXT_API_KEY', 'user:12345:67', 'User')
   [Environment]::SetEnvironmentVariable('WEB_EXT_API_SECRET', '（JWT secret）', 'User')
   ```

   - リポジトリのファイルには書かない

### 版を出すたびに

1. `extension/manifest.json` の `version` を上げる。前に出した版より大きい数字にする（同じ数字や、取り下げた版の数字は使えない）
2. 自動検証（Chrome と Firefox）が通ることを確かめる
3. 次を実行する

   ```
   npm run release:firefox
   ```

   - 提出用のファイルを作り、新しい版として AMO に提出する。審査の結果は待たずに終わる
   - 公開されるまでは初回と同じ（ふつうは 24 時間以内。人の審査に回ることもある）
   - 利用者の Firefox には、公開されたあと自動で更新が届く

ブラウザで出す場合は、Developer Hub で Live Audio Enhancer を開き、「新しいバージョンをアップロード」（Upload New Version）から `npm run pack:firefox` で作ったファイルを上げる。新しいアドオンとして出し直さないこと（別の拡張として扱われてしまう）。

## 気をつけること

- **ID は変えない**：`tools/firefox.js` の ID を変えると、別の拡張として扱われて更新できなくなる
- **データ収集の申告は外さない**：一度使い始めたら、以後のすべての版に必要
- **ライブラリを更新したら**：`docs/amo/reviewer-notes.md` の版・リンク・SHA-256 を書き直す。ライブラリを改変してはいけない（Mozilla の決まり）
- **UI を変えたら**：`npm run amo:screenshots` でスクリーンショットを作り直し、ストアのページの画像を差し替える
- **サイトへのアクセス**：Firefox 127 以降は、対象サイトへのアクセスがインストール時に許可される。ただし、版の更新で対象サイトを足しても、利用者には知らされない（Firefox の不具合 1893232）。利用者が許可を取り消すこともできる

## 調べたときの出典

- 提出の流れ：https://extensionworkshop.com/documentation/publish/submitting-an-add-on/
- 署名と公開までの時間：https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/
- データ収集の申告：https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
- 拡張の ID：https://extensionworkshop.com/documentation/develop/extensions-and-the-add-on-id/
- アドオンの決まり：https://extensionworkshop.com/documentation/publish/add-on-policies/
- ライブラリの扱い：https://extensionworkshop.com/documentation/publish/third-party-library-usage/
- ソースコードの提出：https://extensionworkshop.com/documentation/publish/source-code-submission/
- web-ext：https://extensionworkshop.com/documentation/develop/web-ext-command-reference/
- サイトへのアクセス（MV3）：https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/
- 人の審査にかかる日数（Mozilla の担当者の発言）：https://discourse.mozilla.org/t/important-update-addressing-the-long-manual-review-times/148498
