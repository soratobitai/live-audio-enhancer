# ライブ配信音声エフェクト Chrome拡張 引き継ぎメモ

最終更新：2026-11-09（拡張 v0.5.0、ステップ5まで完了）

## 目的

ライブ配信の音声に、リアルタイムでイコライザーとノイズキャンセルをかけるChrome拡張（Manifest V3）を作る。

- 対象サイトの優先度
  1. ニコニコ生放送（必須）：対応済み
  2. YouTube（ライブと通常動画の両方）：対応済み
  3. Kick：対応済み

## 現在の状態

| ステップ | 内容 | 状態 |
|---|---|---|
| 1 | 方式Aで固定EQをかける最小構成 | 完了 |
| 2 | ポップアップでON/OFFとEQのゲインを調整、`chrome.storage.local`に保存 | 完了 |
| 3 | content scriptからAudioWorkletを読み込めるかの検証 | 完了 |
| 4 | RNNoiseによるノイズキャンセル | 完了 |
| 5 | Kickの検証と対応（方式Bは不要だった） | 完了 |

ディレイ拡張との同時動作の確認（当初のステップ6）は、対象外になった。

### 使い方

- `chrome://extensions`でデベロッパーモードをオンにし、「パッケージ化されていない拡張機能を読み込む」で`extension/`フォルダを選ぶ
- 拡張アイコンのポップアップで、全体のON/OFF、ノイズキャンセルのON/OFF、EQ 4バンドのゲイン（±12dB）を変える
- 自動再生でページを一度もクリックしていないときは、クリックした時点でエフェクトがかかる

### ディレクトリ構成

```
audio-fx/
├─ extension/                  Chromeで読み込むフォルダ
│  ├─ manifest.json
│  ├─ shared/settings.js       設定の定義・保存・変更通知（content scriptとポップアップで共用）
│  ├─ audio/audio-graph.js     音声グラフの生成（video要素への接続はここだけで行う）
│  ├─ content/main.js          再生開始を拾って接続する
│  ├─ popup/                   ポップアップのUI
│  └─ vendor/web-noise-suppressor/   RNNoiseのワークレットとWASM、ライセンス文
├─ tools/
│  ├─ verify.js                実ブラウザでの自動検証
│  └─ vendor-rnnoise.js        npmパッケージからvendor/へファイルをコピー
└─ docs/handoff.md             このメモ
```

### 開発用コマンド

| コマンド | 内容 |
|---|---|
| `npm run verify:nico` / `verify:kick` / `verify:youtube` | サイトから配信を選んで自動検証する。`-- <URL>`で配信を指定できる |
| `npm run vendor` | `@sapphi-red/web-noise-suppressor`から`extension/vendor/`へファイルをコピーし直す |

- ビルドツールとフレームワークは使っていない。content scriptはmanifestに並べた順に読み込まれ、グローバルスコープを共有する
- 導入を検討するのは、npmパッケージをバンドルする必要が出たとき、共有コードが増えてグローバル共有がつらくなったとき、型チェックがほしくなったとき。そのときは`esbuild`を第一候補にする

## 関連プロジェクト

### 録画拡張（nico-nico-play-back-recorder）

- 場所：このリポジトリとは別の、非公開のリポジトリ
- ニコ生の番組を録画して見返すための拡張（WXT製）。この拡張と同時に使う
- 録画への影響は「録画拡張との関係」を参照

### ディレイ拡張

- 当初は、ニコ生の映像を遅延させる自作拡張との同時動作や統合を想定していた。2026-11-09に、考慮しないことになった
- それでも、音声グラフの生成を1か所（`extension/audio/audio-graph.js`）に集約する方針は続ける。同じ要素に`createMediaElementSource`を二重に呼ばないようにするため

## 実装方式

### 方式A（採用）：`<video>`要素をWeb Audio APIでフックする

content scriptで`AudioContext.createMediaElementSource(video)`を呼び、エフェクトを通してから`ctx.destination`に出力する。ニコ生・YouTube・Kickのすべてで動作を確認した。

実装上の決まりごと：
- **接続する要素を限定する**：別オリジンのメディアをCORSなしで再生している要素に接続すると、出力が無音になる。そのため、ページ自身がデータを用意している要素だけに接続する（`canAttach`）
  - `currentSrc`が`blob:`のもの（MSE）
  - `srcObject`が`MediaSourceHandle`のもの（Worker内のMSE。Kick）
- **二重接続を防ぐ**：`createMediaElementSource()`は同じ要素に1回しか呼べない。接続済みの要素は`WeakMap`で管理する
- **無効のあいだは接続しない**：接続すると、リロードするまで元に戻せないため
- **バイパスはつなぎ替えで行う**：接続後はグラフを切らず、wet/dryのゲインのクロスフェードで切り替える。値は`setTargetAtTime`（時定数20ms）で変え、プツッというノイズを防ぐ
- **AudioContextがrunningになってから接続する**：自動再生ポリシーでsuspendedのまま接続すると無音になる。`pointerdown`と`keydown`のたびに`resume()`を再試行する
- **AudioContextは48kHzで作る**：RNNoiseが48kHz前提のため
- **再生開始を`playing`イベントで拾う**：`document`でキャプチャフェーズのリスナーを使う（メディアイベントはバブリングしない）。MutationObserverや`yt-navigate-finish`は使っていない
- DRM（EME）付きのコンテンツは対象外（未検証）

### 方式B（未実装）：`chrome.tabCapture`でタブ音声をキャプチャする

3サイトとも方式Aで対応できたため、実装していない。方式Aが使えないサイトに対応するときの代替案として残す。

- service workerで`chrome.tabCapture.getMediaStreamId()`を取得する
- offscreen documentで`getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId } } })`を使ってストリームを受け取る
- キャプチャ中はタブ本来の音が止まるので、加工後の音をoffscreen側のAudioContextで再生する
- 拡張アイコンのクリックなど、ユーザー操作を起点にする必要がある

## サイト別の状況

| サイト | 再生の仕組みと注意点 | 状態 |
|---|---|---|
| ニコ生 | `blob:`（MSE）。video要素はトップフレームにある。自動再生は止められ、再生ボタンのクリックで再生が始まる | 対応済み・自動検証OK |
| YouTube | `blob:`（MSE）。SPAでvideo要素が使い回されるが、`WeakMap`で二重接続を防いでいる | 対応済み・自動検証OK（SPA遷移後の動作は未確認） |
| Kick | Amazon IVSがWorker内のMSEを`srcObject`（`MediaSourceHandle`）で渡す。`currentSrc`は空。ミュートで自動再生される。広告用の`static.kick.com/ads/*.mp4`は別オリジンなので接続しない | 対応済み・自動検証OK |

## 音声グラフの構成

```
source ─┬─┬─ RNNoise ─ nrWet ─┬─ EQ（BiquadFilter × 4）─ wet ─┬─ output ─ destination
        │ └─────────── nrDry ─┘                              │
        └───────────────────────────────────────────── dry ─┘
```

- **全体のON/OFF**：`wet`/`dry`で切り替える
- **ノイズキャンセルのON/OFF**：`nrWet`/`nrDry`で切り替える
- **イコライザー**：lowshelf 100Hz、peaking 1kHz（Q=1）、peaking 3kHz（Q=1）、highshelf 8kHz。ユーザーが変えるのはゲインだけ（±12dB）
- **ノイズキャンセル**：`@sapphi-red/web-noise-suppressor` 0.4.1 のRNNoiseワークレットを使う
  - **WASMの渡し方**：ワークレット内では`fetch`が使えないので、content scriptで取得して`processorOptions.wasmBinary`で渡す
  - **フレームサイズの吸収**：128サンプル単位の入力を、1920サンプルのリングバッファで480サンプルのフレームに組み替えている。遅延は640サンプル（約13ms）
  - **チャンネル**：チャンネルごとに処理する。入力は2ch（ステレオ）にそろえる
  - **ノードを作るタイミング**：ノイズキャンセルを初めて有効にしたときに作る。WASMの初期化中は無音になるので、0.15秒待ってから切り替える。読み込めなかったときは素通しのままにする
  - **既定値**：オフ。RNNoiseは声向けで、音楽の音質を落とすことがあるため
- **コンプレッサー**：未実装（任意）
- **設定**：`chrome.storage.local`の`settings`キーに`{ enabled, denoise, gains }`を保存する。既定値は「有効、ノイズキャンセルはオフ、全バンド0dB」

### ノイズキャンセルのライセンス

`extension/vendor/web-noise-suppressor/`にライセンス文を置いている。

| 対象 | ライセンス |
|---|---|
| sapphi-red/web-noise-suppressor | MIT |
| shiguredo/rnnoise-wasm（WASMのビルドとJSラッパー） | Apache-2.0 |
| xiph/rnnoise | BSD-3-Clause |

## 検証

### 自動検証（`tools/verify.js`）

インストール済みのChromeを、一時プロファイル・ヘッドレス・ミュートで起動する。`extension/`を読み込んで配信を再生し、ポップアップを実際に操作して、次の5つの設定を順に測る。

1. EQ有効
2. 全体を無効にする（素通し）
3. ゲインを変えて有効に戻す
4. ノイズキャンセル有効
5. ノイズキャンセル無効に戻す

拡張のcontent scriptと同じ実行環境（isolated world）で、音声グラフの入口と出口にAnalyserNodeを付けて判定する。

- **パラメータ**：各フィルタのゲイン、wet/dry、nrWet/nrDryが設定どおりか
- **周波数特性**：EQの「出口 − 入口」が、`getFrequencyResponse`から計算した期待値と1.5dB以内か。入力の最も強い成分より50dB以上弱い帯域は判定しない
- **無音でないか**：出力が完全な無音（CORSやWASMの読み込み失敗）になっていないか

2026-11-09の時点で、3サイトとも5パターンすべてOK（期待値との差は0.2dB以内）。

### 実際に聞いての確認

2026-11-09に、開発者が実際に耳で聞いて、正しく動作することを確認した。

### 手動確認（DevTools Console）

新しいサイトを調べるときに使う。

```js
// 再生方式の確認。blob: か MediaSourceHandle なら接続できる
[...document.querySelectorAll('video')].map(v => ({
  currentSrc: v.currentSrc,
  srcObject: v.srcObject && Object.prototype.toString.call(v.srcObject),
  size: `${v.clientWidth}x${v.clientHeight}`,
}))
```

```js
// フックの確認。音がこもれば成功、無音になれば方式Aは使えない。実行後はリロードして元に戻す
const v = document.querySelector('video');
const ctx = new AudioContext();
const lp = ctx.createBiquadFilter();
lp.type = 'lowpass';
lp.frequency.value = 500;
ctx.createMediaElementSource(v).connect(lp).connect(ctx.destination);
ctx.resume();
```

## 検証で分かったこと

### AudioWorkletの読み込み（content scriptから）

| 読み込み方 | ニコ生（CSPヘッダーなし） | YouTube（厳しいCSP） |
|---|---|---|
| 拡張内のURLを直接指定（`web_accessible_resources`に登録） | OK | OK |
| 同上（登録なし） | NG | NG |
| Blob URL / data: URL | OK | NG（CSPで止められる） |

- **採用した方法**：`web_accessible_resources`に登録し、`chrome.runtime.getURL`で直接読み込む
- **`use_dynamic_url: true`も設定している**：`getURL`がセッションごとに変わるURLを返すようになり、ページ側から拡張の固定URLにアクセスできなくなることを確認した
- **WASMの実行**：ワークレット内でのWASMの実行は、ニコ生・YouTube・Kickのどれでもページのcontent security policyに止められなかった
- **YouTubeでのみ出るログ**：content scriptからWARのファイルを`fetch`すると、`Unsafe attempt to load URL ...`というsecurityログが出る。取得自体は成功している
  - 固定URLでも出る
  - ニコ生では出ない。Kickは未確認

### 自動再生

- ニコ生：自動再生が止められる。再生ボタンのクリックで始まる
- Kick：ミュートで自動再生される。ミュート中は音がないので、クリック待ちのあいだに無音の時間ができることはない
- YouTube：ヘッドレスでは、画面中央のクリックでは再生されないことがあった。再生ボタンでは再生された

## 録画拡張との関係

2026-11-09に録画拡張のコードを確認し、録画の取り方を再現して測った。

- **接続の取り合いがない**：録画拡張は`createMediaElementSource`を使っていない
- **干渉する処理がない**：ページ側で動くスクリプト、メディア関連の仕組みの書き換え、AudioContextの使用はどれもない
- **結論**：録画が失敗する、無音になる、エラーになる、といった悪影響はない

| 録画の種類 | 音の取り方 | 録画に入る音 | 確認 |
|---|---|---|---|
| コメントなし / コメントあり | `video.captureStream()`（`utils/recording-source.ts`） | 元の音（EQもノイズキャンセルもかからない） | 実測（ニコ生・YouTube） |
| 画面録画 | `getDisplayMedia`のタブ音声（`utils/screen-capture.ts`） | エフェクト後の音のはず | 未確認 |

- **captureStreamの測定**：先に`captureStream()`を取得してからこの拡張が接続した場合（録画拡張と同じ順番）も、元の音だった
- **captureStreamの音量**：プレイヤーの音量をかける前の音になる。音量0.5のとき、拡張の入口より約6dB大きい
- **画面録画が未確認の理由**：ヘッドレスのChromeでは、拡張がなくてもタブ音声が無音になり、測れなかった。タブ音声はタブが出す音をすべて取る仕組みなので、エフェクト後の音が入ると考えている
- **録画にエフェクトを入れたい場合**：コメントなし・コメントありの録画に入れるには、録画拡張側の変更が必要になる。具体的には、拡張どうしが連携して、録画拡張がこの拡張の出力から音を受け取るようにする

## 残課題

### 解決済みの未確認事項

1. **Kickの`src`が`blob:`か、方式Aで音が出るか**：`src`は空で、`srcObject`が`MediaSourceHandle`だった。接続の対象に加えれば、方式Aで音が出てEQも効く
2. **content scriptからAudioWorkletを読み込めるか**：`web_accessible_resources`に登録すれば読み込める。ページのCSPの影響は受けない
3. **RNNoiseのWASMに何を使うか**：`@sapphi-red/web-noise-suppressor` 0.4.1
   - ライセンスはMIT（上流はApache-2.0とBSD-3-Clause）
   - WASMは約154KB
   - 3サイトのCSPの下で動作する
4. **ニコ生でディレイ拡張と同時に動かしたときの挙動**：対象外（ディレイ拡張は考慮しないことになった）

### 未解決

- 録画拡張の「画面録画」に、エフェクト後の音が入るかの実機確認
  - 確認方法：EQの「100Hz 以下」を−12dBにして10秒ほど録り、低音が削れているかを聞く
- ログイン状態やプレミアム会員での動作
- YouTubeでSPA遷移したあとの動作
- Kickの埋め込みプレイヤーでの動作
- ノイズキャンセルを一度有効にすると、無効にしてもリロードするまでRNNoiseの処理が続く。負荷が気になるなら、無効のときに切り離す
- YouTubeで出る`Unsafe attempt to load URL`のログ。消すなら、service worker経由でWASMを取得する
- TypeScript 7系でJSDocによる型チェックがどこまでできるかは未確認（型チェックを導入するときに確認する）

## 開発者の作業スタイル

- 段階的に1ステップずつ進めることを好む
- 実在が未確認のAPI名、パッケージ名、ファイル名は断定せず、確認してから記述すること
- 回答・説明は日本語で行う
