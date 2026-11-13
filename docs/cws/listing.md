# Chrome ウェブストアに載せる内容

デベロッパー ダッシュボードの各欄に、そのまま貼り付けて使う。提出するファイルは `npm run pack:chrome` で作る `dist/live-audio-enhancer-<版>-chrome.zip`。
2026-11-11 に、Chrome の公式の説明（developer.chrome.com/docs/webstore）を調べて書いた。出典は末尾。

## 提出の前に確かめること

- **公開できるアイテムの数の上限**：2026-08-20 から、公開できる拡張の数に上限がある。新しい公開者は 2 つまでで、それ以前から公開していた人は、その時点で公開していた数以上（[出典](https://developer.chrome.com/blog/cws-review-updates-2026)）。ダッシュボードで今の上限と公開数を確かめる。足りなければダッシュボードから増やす申請をする
- **トレーダーかどうかの申告**と **2 段階認証**：すべての開発者に必須。ほかのアイテムを公開しているので、済んでいるはず
- **Verified CRX uploads**（アップロードを自分の鍵の署名つきに限る設定）：有効にしない。鍵をなくすと、交換に最大 1 週間かかる

## ストアの掲載情報（Store listing）

| 欄 | 内容 |
|---|---|
| 名前・概要 | ZIP の manifest から自動で入る（名前「Live Audio Enhancer」、概要は manifest の `description`。132 文字まで） |
| 説明 | 下の「説明」 |
| カテゴリ | エンターテインメント（Entertainment）。次点はツール（Tools） |
| 言語 | 日本語 |
| ストアのアイコン（128×128） | `docs/cws/store-icon-128.png`（ストアの案内どおり、絵柄 96×96 と透明な余白 16px） |
| スクリーンショット（1280×800） | `docs/amo/screenshots/1-overview.png`、`2-auto.png`（Firefox のストアと同じ） |
| 小さいプロモーション タイル（440×280） | `docs/cws/promo-small.png`（任意だが、ないと検索結果で後ろに並ぶ） |
| マーキー プロモーション タイル（1400×560） | なし（任意） |
| 公式 URL・ホームページ・サポート URL | なし |

- カテゴリ：エンターテインメントは「スポーツ・音楽・テレビ・映画のファン向け」と定義されていて、配信や動画を見る人向けのこの拡張に合う
- 言語：拡張に `_locales` がないので、掲載文は 1 つの言語だけになる。英語の説明は、日本語の説明の下に並べて書く
- 対応サイトの名前は、説明の中で 1 回だけ書く。動作するサイトの長い一覧や、同じ言葉の繰り返しは、キーワードスパムとして却下の理由になる

### 説明（Description）

```
Live Audio Enhancer は、配信や動画の音を、その場で（リアルタイムに）聞きやすくする拡張機能です。

■ 主な機能
・AIノイズキャンセル
　エアコンやキーボードの音、環境音など、声以外の雑音を抑えます。「標準」（軽い）と「強め」（雑音をより強く抑える）から選べます。
　「オート」にすると、ふだんはかけ、音楽や歌が続くときは自動で外します（外れるまで15秒ほどかかります）。
・音量をそろえる
　大きすぎる声やBGMは抑え、小さい声は持ち上げて、聞きやすい音量にそろえます（標準・強め）。
・イコライザー
　10バンドのイコライザーと、12種類のプリセット（声を聞きやすく、ニュース、トーク、音楽、映画、ゲーム実況、小音量・夜間など）。
　「オート」にすると、番組の音を分析して、話し声が聞きやすいバランスに自動で整えます。音楽向けにしたいときは、手動でプリセットを選んでください。
・音割れ防止
　音を持ち上げても音割れしないよう、リミッターが働きます。

■ 対応サイト
ニコニコ生放送、YouTube、Twitch、Kick、TVer、ABEMA
※ 各サイトの運営元とは関係のない、非公式の拡張機能です。

■ 使い方
1. 対応サイトで動画を再生します。
2. ツールバーの拡張機能のボタン（パズルのアイコン）から Live Audio Enhancer を開き、使いたい機能を選びます。ピン留めしておくと、すぐに開けます。
設定は、開いているすべての対応サイトに反映されます。「有効」をオフにすると、元の音に戻ります。

■ ご注意
・ノイズキャンセルの「強め」は、パソコンへの負荷が高めで、音がわずかに遅れます。
・ミュート中の動画には効きません。ミュートを解除すると効きます。
・プレイヤーの音量は、今までどおりサイトの音量で調整できます。

■ プライバシー
音の処理は、すべてお使いのパソコンの中で行います。音声や閲覧履歴などのデータを集めたり、外部に送ったりすることはありません。

■ 使用しているライブラリ
・RNNoise（@sapphi-red/web-noise-suppressor：MIT、shiguredo/rnnoise-wasm：Apache-2.0、xiph/rnnoise：BSD-3-Clause）
・DeepFilterNet3（@workadventure/noise-suppression：MIT、DeepFilterNet：MIT）

―――――

[English]
Live Audio Enhancer makes the sound of live streams and videos easier to listen to, in real time.

- AI noise suppression: reduces background noise. Standard (light) or Strong. In Auto mode, it stays on and is turned off while music or singing continues.
- Volume leveling: tames loud parts and lifts quiet voices (Standard / Strong).
- Equalizer: 10 bands and 12 presets. In Auto mode, it balances the sound so that voices are easy to hear.
- A limiter prevents clipping.

Works on the six sites listed above. This is an unofficial extension, not affiliated with those sites.
The user interface is in Japanese. All audio processing happens on your computer; no data is collected or sent.
```

## プライバシーへの取り組み（Privacy practices）

審査担当者が読むので、英語で書いている（日本語の意味は各項目の下）。

### 単一用途（Single purpose）

```
Makes the audio of videos and live streams on supported sites easier to listen to, by applying noise suppression, volume leveling and equalization to the video's audio in real time.
```

意味：対応サイトの動画・配信の音に、ノイズキャンセル、音量をそろえる処理、イコライザーをリアルタイムでかけて、聞きやすくする。

### 権限が必要な理由（Permission justification）

**storage**

```
Saves the user's settings (on/off, noise suppression mode and strength, leveler, equalizer mode and gains) with chrome.storage.local, so that they are kept and applied to all open supported tabs. Nothing is sent outside the browser.
```

意味：設定（オン・オフ、ノイズキャンセルのモードと強さ、音量をそろえる、イコライザーのモードとゲイン）を保存し、開いているすべての対応サイトのタブに反映するため。ブラウザの外には送らない。

**ホスト権限（Host permission）**：content script を対応サイトで動かすため（欄が出たら入れる）

```
The content script runs only on the six supported video sites (live.nicovideo.jp, www.youtube.com, kick.com, www.twitch.tv, tver.jp, abema.tv). It connects the page's <video> element to the Web Audio API to process its audio. It does not read or collect page content, and sends nothing anywhere.
```

意味：content script は、6 つの対応サイトでだけ動く。ページの動画を Web Audio API につないで、音を処理する。ページの内容を読んだり集めたりせず、どこにも送らない。

### リモートコード（Remote code）

「いいえ、リモートコードを使用していません」（No, I am not using remote code）を選ぶ。

- 理由：コードと、ノイズキャンセルの WebAssembly・モデルは、すべて拡張のパッケージに入っている。ストアの定義では、リモートコードは「拡張のパッケージ以外から読み込んで実行するもの（JS や WASM）」で、同梱のものは当たらない

### データの使用（Data usage）

- 集めるデータの種類：**どれにもチェックを入れない**（個人を特定できる情報、健康情報、金融・支払い情報、認証情報、個人的な通信、位置情報、ウェブ履歴、ユーザーのアクティビティ、ウェブサイトのコンテンツ）
  - 音はパソコンの中で処理するだけで、保存も送信もしない。設定は `chrome.storage.local` に保存するだけ
  - 「ウェブサイトのコンテンツ」に動画の音の処理が当たるかは、公式の説明でははっきりしない。集めも送りもしないのでチェックしない。処理のしかたは、説明の「■ プライバシー」に書いてある
- 3 つの宣言：**すべてにチェックを入れる**
  - 承認されている用途以外で、ユーザーデータを第三者に販売・転送しない
  - 拡張の単一用途と関係のない目的で、ユーザーデータを使用・転送しない
  - 信用力の判断や融資のために、ユーザーデータを使用・転送しない

### プライバシーポリシーの URL

入れない（2026-11-11 に決めた）。

- ストアの決まりでは、ユーザーデータを扱わないなら必須ではない
- 審査で求められたときのために、文章は `docs/cws/privacy-policy.md` に用意してある。そのときは、この文章をウェブに置いて URL を入れる

## テストの手順（Test instructions）

審査担当者向け。ダッシュボードの「テストの手順」（Test instructions）の欄に入れる。

```
No account is needed. The UI is in Japanese.
1. Open a YouTube or Twitch video with people talking and play it with sound. Muted videos are processed after unmuting.
2. Open the Live Audio Enhancer popup from the toolbar.
3. ノイズキャンセル (Noise suppression): オン (On) reduces background noise. オート (Auto) keeps it on and turns it off after music or singing continues for about 15 seconds; the line starting with "今：" shows the current state. 標準 (Standard) = RNNoise, 強め (Strong) = DeepFilterNet3 (more CPU, about 70 ms latency).
4. 音量をそろえる (Leveler): the switch evens out loud and quiet parts.
5. イコライザー (Equalizer): オート (Auto) adjusts it automatically; 手動 (Manual) uses the presets and sliders.
6. 有効 (Enabled), at the top, turns all effects off.

The WebAssembly files and the model in vendor/ are unmodified files from open-source npm packages: @sapphi-red/web-noise-suppressor 0.4.1 (RNNoise, MIT) and @workadventure/noise-suppression 0.2.0 (DeepFilterNet3, MIT). Their license files are included in vendor/. All first-party code is plain JavaScript without minification.
```

## 配布（Distribution）

| 欄 | 内容 |
|---|---|
| 公開範囲 | 公開（Public） |
| 地域 | すべての地域 |
| 支払い | 無料 |

- 審査に通ったらすぐ公開される。公開の時期を自分で決めたいときは、提出の画面で「審査後に自動で公開する」のチェックを外す（審査から 30 日以内に公開しないと、下書きに戻る）
- 審査は多くの場合数日、長いと数週間。3 週間を超えたらサポートに問い合わせる

## 調べたときの出典

- 掲載情報の欄：https://developer.chrome.com/docs/webstore/cws-dashboard-listing
- 画像（アイコン・スクリーンショット・タイル）：https://developer.chrome.com/docs/webstore/images
- カテゴリ：https://developer.chrome.com/docs/webstore/best-practices
- プライバシーの欄：https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- ユーザーデータの FAQ：https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- 掲載文の決まり（キーワードスパム）：https://developer.chrome.com/docs/webstore/program-policies/listing-requirements
- 却下の理由の一覧：https://developer.chrome.com/docs/webstore/troubleshooting
- リモートコード：https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code
- 審査：https://developer.chrome.com/docs/webstore/review-process
- 公開の時期：https://developer.chrome.com/docs/webstore/publish
- テストの手順：https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions
- 公開できる数の上限（2026-08）：https://developer.chrome.com/blog/cws-review-updates-2026
- Verified CRX uploads：https://developer.chrome.com/blog/verified-uploads-cws
