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

  // EQ のプリセット。ゲインは帯域の順（31Hz〜16kHz）で、聞いて調整する前提の初期値。
  // プリセットを選ぶとその値が gains に入り、スライダーを動かすと 'custom' になる
  const PRESETS = Object.freeze([
    { id: 'flat', label: 'フラット', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { id: 'bass', label: '低音強調', gains: [5, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
    { id: 'treble', label: '高音強調', gains: [0, 0, 0, 0, 0, 0, 1, 3, 4, 5] },
    { id: 'voice', label: '声を聞きやすく', gains: [-4, -3, -1, 0, 1, 2, 4, 4, 2, 0] },
    { id: 'music', label: '音楽', gains: [3, 3, 2, 0, -1, -1, 0, 1, 2, 3] },
    { id: 'movie', label: '映画', gains: [4, 3, 2, 0, -1, 1, 3, 2, 1, 1] },
    { id: 'news', label: 'ニュース', gains: [-6, -4, -2, 0, 1, 2, 3, 3, 1, -1] },
    { id: 'talk', label: 'トーク', gains: [-3, -2, 0, 1, 1, 1, 2, 2, 0, -2] },
    { id: 'game', label: 'ゲーム実況', gains: [2, 2, 0, -1, 0, 1, 3, 3, 2, 1] },
    { id: 'night', label: '小音量・夜間', gains: [5, 4, 2, 0, 0, 0, 0, 1, 3, 4] },
    { id: 'gentle', label: '耳にやさしい', gains: [0, 0, 0, 0, 0, 0, -1, -3, -4, -4] },
    { id: 'lowcut', label: '低音カット', gains: [-12, -8, -3, 0, 0, 0, 0, 0, 0, 0] },
  ]);
  // EQ の選択。custom（手動）、auto（オートEQ）、またはプリセットの id
  const EQ_MODES = Object.freeze(['custom', 'auto', ...PRESETS.map((p) => p.id)]);

  // ノイズキャンセルは声向けで、音楽の音質を落とすことがあるので既定ではオフにする
  function defaults() {
    return {
      enabled: true, denoise: false, engine: 'rnnoise', leveler: 'off', eqPreset: 'flat', gains: BANDS.map(() => 0),
    };
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
      // eqPreset がない以前の設定は、ゲインを使えたなら手動で調整したものとみなし、フラットに戻したならフラットにする
      eqPreset: EQ_MODES.includes(v.eqPreset) ? v.eqPreset : gains === v.gains ? 'custom' : d.eqPreset,
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

  return { BANDS, GAIN_RANGE, ENGINES, LEVELERS, PRESETS, EQ_MODES, defaults, load, save, onChange };
})();
