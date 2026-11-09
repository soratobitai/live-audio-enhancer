'use strict';

// 再生が始まった video 要素を音声グラフに接続する。
// メディアイベントはバブリングしないが、キャプチャフェーズなら document で受け取れる。
// YouTube の SPA 遷移や video 要素の差し替えも、再生開始の時点で拾える。
document.addEventListener('playing', (e) => {
  if (e.target instanceof HTMLVideoElement) AudioGraph.attach(e.target);
}, true);

// スクリプト注入の時点ですでに再生中の要素も拾う
for (const v of document.querySelectorAll('video')) {
  if (!v.paused) AudioGraph.attach(v);
}
