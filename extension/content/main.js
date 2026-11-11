'use strict';

// 再生中で音の出ている video 要素を音声グラフに接続する。
// 接続すると元に戻せないので、無効のあいだは接続しない。有効になった時点で再生中の要素を接続する。
let enabled = false;

// ミュート（または音量 0）の動画にはつながない。YouTube のサムネイルにマウスを乗せたときのプレビューなど、
// 音を出さない動画にノイズキャンセルなどを動かさないため。ミュートを解除したときにつなぐ（Kick はミュートで自動再生される）
function attachIfAudible(v) {
  if (enabled && !v.paused && !v.muted && v.volume > 0) AudioGraph.attach(v);
}

function attachPlaying() {
  for (const v of document.querySelectorAll('video')) attachIfAudible(v);
}

// メディアイベントはバブリングしないが、キャプチャフェーズなら document で受け取れる。
// YouTube の SPA 遷移や video 要素の差し替えも、再生開始の時点で拾える。ミュートの解除は volumechange で拾う
for (const type of ['playing', 'volumechange']) {
  document.addEventListener(type, (e) => {
    if (e.target instanceof HTMLVideoElement) attachIfAudible(e.target);
  }, true);
}

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
