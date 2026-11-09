'use strict';

// 設定の定義と保存。content script とポップアップの両方から読み込む。
const Settings = (() => {
  const KEY = 'settings';

  // EQ の帯域。周波数と Q は固定で、ユーザーが調整するのはゲインだけ
  const BANDS = Object.freeze([
    { type: 'lowshelf', freq: 100 },
    { type: 'peaking', freq: 1000, q: 1 },
    { type: 'peaking', freq: 3000, q: 1 },
    { type: 'highshelf', freq: 8000 },
  ]);
  const GAIN_RANGE = 12; // ±dB

  // ノイズキャンセルの方式。RNNoise は軽くて遅延が小さく、DeepFilterNet3 は抑え方が強いが重くて遅延が大きい
  const ENGINES = Object.freeze(['rnnoise', 'deepfilternet']);

  // ノイズキャンセルは声向けで、音楽の音質を落とすことがあるので既定ではオフにする
  function defaults() {
    return { enabled: true, denoise: false, engine: 'rnnoise', gains: BANDS.map(() => 0) };
  }

  // 保存値が欠けていたり帯域数が変わっていたりしても使えるように、既定値に重ねる
  function normalize(v) {
    const d = defaults();
    if (!v || typeof v !== 'object') return d;
    const clamp = (x) => Math.min(GAIN_RANGE, Math.max(-GAIN_RANGE, x));
    return {
      enabled: typeof v.enabled === 'boolean' ? v.enabled : d.enabled,
      denoise: typeof v.denoise === 'boolean' ? v.denoise : d.denoise,
      engine: ENGINES.includes(v.engine) ? v.engine : d.engine,
      gains: d.gains.map((g, i) => (Number.isFinite(v.gains?.[i]) ? clamp(v.gains[i]) : g)),
    };
  }

  async function load() {
    const { [KEY]: v } = await chrome.storage.local.get(KEY);
    return normalize(v);
  }

  function save(s) {
    return chrome.storage.local.set({ [KEY]: s });
  }

  function onChange(callback) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) callback(normalize(changes[KEY].newValue));
    });
  }

  return { BANDS, GAIN_RANGE, ENGINES, defaults, load, save, onChange };
})();
