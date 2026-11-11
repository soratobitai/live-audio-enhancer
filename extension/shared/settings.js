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

  // 音量をそろえる（コンプレッサー）の強さ（標準 / 強め）
  const STRENGTHS = Object.freeze(['standard', 'strong']);

  // EQ のプリセット。ゲインは帯域の順（31Hz〜16kHz）で、聞いて調整する前提の初期値。
  // プリセットを選ぶとその値が gains に入り、スライダーを動かすと 'custom' になる
  const PRESETS = Object.freeze([
    { id: 'flat', label: 'フラット', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { id: 'bass', label: '低音強調', gains: [8, 7, 5, 2, 0, 0, 0, 0, 0, 0] },
    { id: 'treble', label: '高音強調', gains: [0, 0, 0, 0, 0, 0, 2, 4, 6, 8] },
    { id: 'voice', label: '声を聞きやすく', gains: [-4, -3, -1, 0, 1, 2, 4, 4, 2, 0] },
    { id: 'music', label: '音楽', gains: [3, 3, 2, 0, -1, -1, 0, 1, 2, 3] },
    { id: 'movie', label: '映画', gains: [4, 3, 2, 0, -1, 1, 3, 2, 1, 1] },
    { id: 'news', label: 'ニュース', gains: [-6, -4, -2, 0, 1, 2, 3, 3, 1, -1] },
    { id: 'talk', label: 'トーク', gains: [-3, -2, 0, 1, 1, 1, 2, 2, 0, -2] },
    { id: 'game', label: 'ゲーム実況', gains: [2, 2, 0, -1, 0, 1, 3, 3, 2, 1] },
    { id: 'night', label: '小音量・夜間', gains: [7, 6, 3, 0, 0, 0, 0, 2, 4, 6] },
    { id: 'gentle', label: '耳にやさしい', gains: [0, 0, 0, 0, 0, 0, -1, -3, -4, -4] },
    { id: 'lowcut', label: '低音カット', gains: [-12, -8, -3, 0, 0, 0, 0, 0, 0, 0] },
  ]);
  // EQ の選択。custom（手動）またはプリセットの id。オートEQ はこれとは別に autoEq でオン・オフする
  const EQ_MODES = Object.freeze(['custom', ...PRESETS.map((p) => p.id)]);

  // ノイズキャンセルは声向けで、音楽の音質を落とすことがあるので既定ではオフにする。
  // オートEQ がオンのあいだは、eqPreset と gains（手動の EQ）は使わずに残しておき、オフに戻すとそれを使う
  function defaults() {
    return {
      enabled: true, denoise: false, engine: 'rnnoise', leveler: false, levelerStrength: 'standard',
      autoEq: false, eqPreset: 'flat', gains: BANDS.map(() => 0),
    };
  }

  // 保存値が欠けていたり古い形式だったりしても使えるように、既定値に重ねる。
  // 帯域の数が変わっていたら、ゲインの位置がずれるのでフラットに戻す
  function normalize(v) {
    const d = defaults();
    if (!v || typeof v !== 'object') return d;
    const clamp = (x) => Math.min(GAIN_RANGE, Math.max(-GAIN_RANGE, x));
    const gains = Array.isArray(v.gains) && v.gains.length === BANDS.length ? v.gains : d.gains;
    // 以前はオートEQ を eqPreset の 'auto' で表していた。オートEQ をオンにし、EQ はゲインと同じプリセットか、カスタムにする
    const legacyAuto = v.eqPreset === 'auto';
    const presetOf = (g) => PRESETS.find((p) => p.gains.every((x, i) => x === g[i]))?.id ?? 'custom';
    // v0.13.0 までは、leveler に強さ（'off' / 'light' / 'medium' / 'strong'）を入れていた。
    // オン・オフと強さに分け、弱と中は標準、強は強めにする。v0.15.0 までのオートEQ の強さ（autoStrength）は読み捨てる
    const legacyLeveler = ['light', 'medium', 'strong'].includes(v.leveler) ? v.leveler : null;
    return {
      enabled: typeof v.enabled === 'boolean' ? v.enabled : d.enabled,
      denoise: typeof v.denoise === 'boolean' ? v.denoise : d.denoise,
      engine: ENGINES.includes(v.engine) ? v.engine : d.engine,
      leveler: typeof v.leveler === 'boolean' ? v.leveler : legacyLeveler !== null,
      levelerStrength: STRENGTHS.includes(v.levelerStrength) ? v.levelerStrength
        : legacyLeveler === 'strong' ? 'strong' : d.levelerStrength,
      autoEq: typeof v.autoEq === 'boolean' ? v.autoEq : legacyAuto,
      // eqPreset がない以前の設定は、ゲインを使えたなら手動で調整したものとみなし、フラットに戻したならフラットにする
      eqPreset: EQ_MODES.includes(v.eqPreset) ? v.eqPreset
        : legacyAuto ? presetOf(gains)
        : gains === v.gains ? 'custom' : d.eqPreset,
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

  return { BANDS, GAIN_RANGE, ENGINES, STRENGTHS, PRESETS, EQ_MODES, defaults, load, save, onChange };
})();
