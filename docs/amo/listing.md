# ストア（AMO）に載せる内容

Developer Hub の各欄に、そのまま貼り付けて使う。日本語を既定の言語にし、英語を追加する（手順は `docs/publish-firefox.md`）。

## 基本

| 欄 | 内容 |
|---|---|
| 名前（Name） | Live Audio Enhancer |
| URL（Add-on URL / slug） | `live-audio-enhancer`（`https://addons.mozilla.org/ja/firefox/addon/live-audio-enhancer/` になる） |
| カテゴリ（Categories） | Photos, Music & Videos（写真・音楽・動画） |
| サポートのメール（Support email） | info_bobo@yahoo.co.jp |
| サポートのサイト（Support website） | なし（空欄） |
| ライセンス（License） | MIT License |
| プライバシーポリシー | なし（データを集めず、外部にも送らないため不要） |
| 対応（Compatibility） | Firefox（パソコン版）のみ。Android は外す |
| ソースコードの提出 | いいえ（自作のコードは手書きで、圧縮もまとめもしていない。ライブラリは審査担当者へのメモに出どころを書く） |
| 審査担当者へのメモ（Notes for Reviewers） | `docs/amo/reviewer-notes.md` の本文 |

## 要約（Summary、250 文字まで）

### 日本語

```
ニコ生・YouTube・Twitch・TVer・ABEMAなどの配信の音を聞きやすくします。AIノイズキャンセル（話し声のときだけかけるオートつき）、音量をそろえる、話し声と音楽に合わせて自動で整えるイコライザー。
```

### English

```
Make live streams easier to listen to: AI noise suppression (Auto applies it only while people are talking), loudness leveling, and an equalizer that adapts automatically to speech or music. Works on YouTube, Twitch, Kick, niconico, TVer and ABEMA.
```

## 説明（Description、15,000 文字まで）

### 日本語

```
Live Audio Enhancer は、配信や動画の音を、その場で（リアルタイムに）聞きやすくする拡張機能です。

■ 主な機能
・AIノイズキャンセル
　エアコンやキーボードの音、環境音など、声以外の雑音を抑えます。「標準」（軽い）と「強め」（雑音をより強く抑える）から選べます。
　「オート」にすると、話し声が中心のときだけかけ、音楽や歌のときは自動で外します。歌枠やカラオケでも、歌声が乱れません。
・音量をそろえる
　大きすぎる声やBGMは抑え、小さい声は持ち上げて、聞きやすい音量にそろえます（標準・強め）。
・イコライザー
　10バンドのイコライザーと、12種類のプリセット（声を聞きやすく、ニュース、トーク、音楽、映画、ゲーム実況、小音量・夜間など）。
　「オート」にすると、番組の音を分析して、話し声なら話し声向け、音楽なら音楽向けのバランスに自動で整えます。
・音割れ防止
　音を持ち上げても音割れしないよう、リミッターが働きます。

■ 対応サイト
ニコニコ生放送、YouTube、Twitch、Kick、TVer、ABEMA

■ 使い方
1. 対応サイトで動画を再生します。
2. ツールバーの Live Audio Enhancer のボタンを押して、使いたい機能を選びます。
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
```

### English

```
Live Audio Enhancer makes the sound of live streams and videos easier to listen to, in real time.

Features
- AI noise suppression: reduces background noise such as air conditioners, keyboards and room noise. Choose Standard (light) or Strong (stronger suppression).
  In Auto mode, it is applied only while people are talking and is turned off automatically for music and singing, so songs are not distorted.
- Loudness leveling: tames loud voices and music and lifts quiet voices (Standard / Strong).
- Equalizer: 10 bands and 12 presets (voice clarity, news, talk, music, movie, game commentary, quiet listening at night, and more).
  In Auto mode, it analyzes the program and balances the sound for speech or music automatically.
- A limiter prevents clipping when the sound is boosted.

Supported sites
niconico Live, YouTube, Twitch, Kick, TVer, ABEMA

How to use
1. Play a video on a supported site.
2. Click the Live Audio Enhancer button in the toolbar and choose the features you want.
Settings apply to all open supported sites. Turn off "有効" (Enabled) to hear the original sound.

Notes
- The Strong noise suppression uses more CPU and adds a short delay.
- Effects do not apply while a video is muted. They start when you unmute it.
- The user interface is in Japanese.

Privacy
All audio processing happens on your computer. The extension does not collect or send any data, including audio and browsing history.

Libraries
- RNNoise (@sapphi-red/web-noise-suppressor: MIT, shiguredo/rnnoise-wasm: Apache-2.0, xiph/rnnoise: BSD-3-Clause)
- DeepFilterNet3 (@workadventure/noise-suppression: MIT, DeepFilterNet: MIT)
```

## スクリーンショット（`docs/amo/screenshots/`、1280×800）

| ファイル | 説明（Caption） |
|---|---|
| `1-overview.png` | ノイズキャンセル、音量をそろえる、イコライザーを1つの画面で設定できます |
| `2-auto.png` | オートなら、話し声のときだけノイズキャンセルをかけ、イコライザーも自動で整えます |

UI を変えたら `npm run amo:screenshots` で作り直す。
