'use strict';

// 再生が始まった video 要素を音声グラフに接続する。
// 接続すると元に戻せないので、無効のあいだは接続しない。有効になった時点で再生中の要素を接続する。
let enabled = false;

function attachPlaying() {
  for (const v of document.querySelectorAll('video')) {
    if (!v.paused) AudioGraph.attach(v);
  }
}

// メディアイベントはバブリングしないが、キャプチャフェーズなら document で受け取れる。
// YouTube の SPA 遷移や video 要素の差し替えも、再生開始の時点で拾える。
document.addEventListener('playing', (e) => {
  if (enabled && e.target instanceof HTMLVideoElement) AudioGraph.attach(e.target);
}, true);

function applySettings(s) {
  AudioGraph.update(s);
  enabled = s.enabled;
  if (enabled) attachPlaying();
}

Settings.onChange(applySettings);
Settings.load().then(applySettings);

// ポップアップから、オートEQ の補正量などの状態を問い合わせられる
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'audio-fx:status') sendResponse(AudioGraph.status());
});
