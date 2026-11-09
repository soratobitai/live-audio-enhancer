# ライブ配信音声エフェクト Chrome拡張 引き継ぎメモ

## 目的

ライブ配信の音声に、リアルタイムでイコライザーとノイズキャンセルをかけるChrome拡張（Manifest V3）を作る。

- 対象サイトの優先度
  1. ニコニコ生放送（必須）
  2. YouTube（ライブと通常動画の両方。対応できればなお良い）
  3. Kick（対応可否を検証中）

## 前提と関連プロジェクト

- 開発者は、ニコ生の映像を指定秒数遅延させるChrome拡張（MV3）を自作済み
  - HLS/MSEとDOM操作で遅延を実現している
  - 映像要素の検出にはMutationObserverを使用
  - したがって、ニコ生の`<video>`要素にはcontent scriptからアクセスでき、MSE再生であることはほぼ確定
- 将来的にディレイ拡張と統合する可能性がある。その場合、`createMediaElementSource`を同じ要素に二重に呼ばないよう、音声グラフの生成は1か所に集約すること

## 実装方式

### 方式A（第一候補）：`<video>`要素をWeb Audio APIでフックする

content scriptで`AudioContext.createMediaElementSource(video)`を呼び、フィルタを通してから`ctx.destination`に出力する。

制約:
- メディアが別オリジンでCORSヘッダーが無いと、出力が無音になる。MSE（`src`が`blob:`）なら問題ない
- `createMediaElementSource()`は同じ要素に1回しか呼べない（2回目は例外になる）。接続済みの要素は`WeakMap`で管理する
- 接続後は、音声がAudioContext経由でしか鳴らない。解除して元に戻すことはできない（リロードが必要）
- エフェクトをバイパスしたいときは、グラフを切らずにつなぎ替えるか、フィルタのゲインを0にする
- `AudioContext`はユーザー操作か再生開始後に`resume()`する
- DRM（EME）付きのコンテンツは対象外

### 方式B（フォールバック）：`chrome.tabCapture`でタブ音声をキャプチャする

- service workerで`chrome.tabCapture.getMediaStreamId()`を取得する
- offscreen documentで`getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId } } })`を使ってストリームを受け取る
- キャプチャ中はタブ本来の音が止まるので、加工後の音をoffscreen側のAudioContextで再生する
- 拡張アイコンのクリックなど、ユーザー操作を起点にする必要がある
- サイトの実装やCORSに依存しない

## サイト別の状況

| サイト | 見立て | 状態 |
|---|---|---|
| ニコ生 | 方式Aで可能な可能性が高い | 実機確認推奨 |
| YouTube | 方式Aで可能（MSE再生）。SPAで同じvideo要素を使い回すため、二重接続の防止が必須。`yt-navigate-finish`などで再検出する | 実機確認推奨 |
| Kick | Amazon IVSプレイヤーがvideo要素に接続して再生する作り。`src`が`blob:`かどうか、フック後に音が出るかは未確認 | 要検証。だめなら方式B |

## 検証手順（各サイトのDevTools Consoleで実行）

### 1. srcの確認

`blob:`で始まっていれば、CORSの問題は起きない。

```js
[...document.querySelectorAll('video')].map(v => ({ src: v.src, currentSrc: v.currentSrc }))
```

### 2. フックの確認

音がこもれば成功、無音になれば方式Bが必要。実行後はリロードして元に戻す。

```js
const v = document.querySelector('video');
const ctx = new AudioContext();
const src = ctx.createMediaElementSource(v);
const lp = ctx.createBiquadFilter();
lp.type = 'lowpass';
lp.frequency.value = 500;
src.connect(lp).connect(ctx.destination);
ctx.resume();
```

## 音声処理の構成

- イコライザー：`BiquadFilterNode`（lowshelf / peaking / highshelf）を直列につなぐ
- コンプレッサー（任意）：`DynamicsCompressorNode`
- ノイズキャンセル：`AudioWorklet`内でRNNoiseのWASM版を動かす
  - RNNoiseは48kHz・480サンプル（10ms）のフレーム単位で処理する
  - AudioWorkletは128サンプル単位で呼ばれるので、リングバッファでフレームサイズの差を吸収する
  - 使用するWASMパッケージは未選定。候補の実在、ライセンス、MV3での動作は要確認
- 想定遅延は数十ms程度で、映像とのズレは許容範囲

### EQの最小例（方式A）

```js
const video = document.querySelector('video');
const ctx = new AudioContext();
const src = ctx.createMediaElementSource(video);

const bands = [
  { type: 'lowshelf', freq: 100, gain: -6 },
  { type: 'peaking', freq: 1000, gain: 0, q: 1 },
  { type: 'peaking', freq: 3000, gain: 4, q: 1 },
  { type: 'highshelf', freq: 8000, gain: -3 },
];

let node = src;
for (const b of bands) {
  const f = ctx.createBiquadFilter();
  f.type = b.type;
  f.frequency.value = b.freq;
  f.gain.value = b.gain;
  if (b.q) f.Q.value = b.q;
  node.connect(f);
  node = f;
}
node.connect(ctx.destination);

video.addEventListener('play', () => ctx.resume());
```

## 未確認事項（実装前に検証すること）

1. Kickの`src`が`blob:`か、方式Aでフックしたときに音が出るか
2. content scriptから、拡張内のAudioWorkletモジュールを`ctx.audioWorklet.addModule(chrome.runtime.getURL(...))`で読み込めるか
   - `web_accessible_resources`への登録が必要。ページのCSPの影響を受けるかどうかも確認する
   - 読み込めない場合は、Blob URL経由での読み込みか、方式Bのoffscreen documentでの処理に切り替える
3. RNNoiseのWASMとして何を使うか（実在、ライセンス、サイズ、MV3のCSP下でWASMを実行できるか）
4. ニコ生でディレイ拡張と同時に動かしたときの挙動

## 開発者の作業スタイル

- 段階的に1ステップずつ進めることを好む
- 実在が未確認のAPI名、パッケージ名、ファイル名は断定せず、確認してから記述すること
- 回答・説明は日本語で行う
