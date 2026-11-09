'use strict';

// 設定の定義と保存。content script とポップアップの両方から読み込む。
const Settings = (() => {
  const KEY = 'settings';

  // EQ の帯域（1オクターブごとの10バンド）。両端はシェルビング、ほかはピーキング（Q 1.4 で約1オクターブ幅）。
  // 周波数と Q は固定で、ユーザーが調整するのはゲインだけ
  const BANDS = Object.freeze([
    { type: 'lowshelf', freq: 31 },
    { type: 'peaking', freq: 62, q: 1.4 },
    { type: 'peaking', freq: 125, q: 1.4 },
    { type: 'peaking', freq: 250, q: 1.4 },
    { type: 'peaking', freq: 500, q: 1.4 },
    { type: 'peaking', freq: 1000, q: 1.4 },
    { type: 'peaking', freq: 2000, q: 1.4 },
    { type: 'peaking', freq: 4000, q: 1.4 },
    { type: 'peaking', freq: 8000, q: 1.4 },
    { type: 'highshelf', freq: 16000 },
  ]);
  const GAIN_RANGE = 12; // ±dB

  // ノイズキャンセルの方式。RNNoise は軽くて遅延が小さく、DeepFilterNet3 は抑え方が強いが重くて遅延が大きい
  const ENGINES = Object.freeze(['rnnoise', 'deepfilternet']);

  // 音量をそろえる（コンプレッサー）の強さ
  const LEVELERS = Object.freeze(['off', 'light', 'medium', 'strong']);

  // ノイズキャンセルは声向けで、音楽の音質を落とすことがあるので既定ではオフにする
  function defaults() {
    return { enabled: true, denoise: false, engine: 'rnnoise', leveler: 'off', gains: BANDS.map(() => 0) };
  }

  // 保存値が欠けていたり古い形式だったりしても使えるように、既定値に重ねる。
  // 帯域の数が変わっていたら、ゲインの位置がずれるのでフラットに戻す
  function normalize(v) {
    const d = defaults();
    if (!v || typeof v !== 'object') return d;
    const clamp = (x) => Math.min(GAIN_RANGE, Math.max(-GAIN_RANGE, x));
    const gains = Array.isArray(v.gains) && v.gains.length === BANDS.length ? v.gains : d.gains;
    return {
      enabled: typeof v.enabled === 'boolean' ? v.enabled : d.enabled,
      denoise: typeof v.denoise === 'boolean' ? v.denoise : d.denoise,
      engine: ENGINES.includes(v.engine) ? v.engine : d.engine,
      leveler: LEVELERS.includes(v.leveler) ? v.leveler : d.leveler,
      gains: gains.map((g) => (Number.isFinite(g) ? clamp(g) : 0)),
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

  return { BANDS, GAIN_RANGE, ENGINES, LEVELERS, defaults, load, save, onChange };
})();
