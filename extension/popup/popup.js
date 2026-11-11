'use strict';

const enabledInput = document.getElementById('enabled');
const presetSelect = document.getElementById('eqPreset');
const eqModeInputs = document.querySelectorAll('input[name="eqMode"]');
const autoNote = document.querySelector('.auto-note');
const bandsSection = document.getElementById('bands');
const resetButton = document.getElementById('reset');

const SUFFIX = { lowshelf: ' 以下', highshelf: ' 以上' };
const freqText = (hz) => (hz >= 1000 ? `${hz / 1000}kHz` : `${hz}Hz`);
const gainText = (db) => `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
// オン・オフのスイッチと、強さ（標準 / 強め）の選択肢を持つ機能。key はスイッチの設定、choice は選択肢の設定
const FEATURES = [
  { key: 'denoise', choice: 'engine', section: '.denoise' },
  { key: 'leveler', choice: 'levelerStrength', section: '.leveler' },
].map((f) => ({
  ...f,
  input: document.getElementById(f.key),
  choices: document.querySelectorAll(`input[name="${f.choice}"]`),
  section: document.querySelector(f.section),
}));

let state;
let autoTimer = null;
let autoShown = null; // 今オートの表示をしているか（オートと手動を切り替えたときだけ、表示を切り替えるため）
let autoGeneration = 0; // オートの表示を始めるたびに増やす。手動に切り替えたあとに届いた返事を捨てるため
let autoReplied = 0; // 表示に使った返事の番号。順番が入れ替わって届いた古い返事を捨てるため
let autoAsked = 0;

// 帯域ごとの行を作る。返す配列は帯域の順（低音から）で、画面には高音を上にして並べる
function buildBands() {
  const controls = Settings.BANDS.map((b, i) => {
    const row = document.createElement('label');
    row.className = 'band';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = freqText(b.freq) + (SUFFIX[b.type] ?? '');

    const input = document.createElement('input');
    input.type = 'range';
    input.min = -Settings.GAIN_RANGE;
    input.max = Settings.GAIN_RANGE;
    input.step = 0.5;
    input.dataset.band = i;

    const value = document.createElement('output');

    // ドラッグ中も音に反映させたいので、input イベントのたびに保存する。手で動かしたらカスタムになる
    input.addEventListener('input', () => {
      state.gains[i] = Number(input.value);
      state.eqPreset = 'custom';
      presetSelect.value = 'custom';
      value.textContent = gainText(state.gains[i]);
      Settings.save(state);
    });
    input.addEventListener('dblclick', () => {
      input.value = 0;
      input.dispatchEvent(new Event('input'));
    });

    row.append(name, input, value);
    return { row, input, value };
  });
  bandsSection.append(...controls.map((c) => c.row).reverse());
  return controls;
}

function buildPresets() {
  const add = (parent, value, label) => parent.append(new Option(label, value));
  add(presetSelect, 'custom', 'カスタム');
  const group = document.createElement('optgroup');
  group.label = 'プリセット';
  for (const p of Settings.PRESETS) add(group, p.id, p.label);
  presetSelect.append(group);
}

function showGains(controls, gains) {
  controls.forEach(({ input, value }, i) => {
    input.value = gains[i];
    value.textContent = gainText(gains[i]);
  });
}

// オートEQ の補正量を、表示しているタブの content script に問い合わせて表示する
async function showAutoEq(controls) {
  const generation = autoGeneration;
  const asked = ++autoAsked;
  // 問い合わせのあいだに手動に切り替えられたり、あとの問い合わせの返事が先に届いていたりしたら、表示しない
  const stale = () => generation !== autoGeneration || asked < autoReplied;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const status = await chrome.tabs.sendMessage(tab.id, { type: 'audio-fx:status' });
    if (stale()) return;
    autoReplied = asked;
    if (!status?.connected) {
      autoNote.textContent = 'このタブでは、まだ動画につないでいません';
    } else if (!status.autoEq?.ready) {
      autoNote.textContent = '番組の音を分析しています…';
    } else {
      autoNote.textContent = '番組の音に合わせて自動で調整しています（試作）';
    }
    if (status?.autoEq) showGains(controls, status.autoEq.gains);
  } catch {
    // 対応サイト以外のタブなど、content script がない
    if (stale()) return;
    autoNote.textContent = 'このタブでは使えません';
  }
}

function render(controls) {
  enabledInput.checked = state.enabled;
  document.body.classList.toggle('off', !state.enabled);
  presetSelect.value = state.eqPreset;
  // 全体を無効にしているあいだは、「有効」のスイッチ以外は操作できない（無効のあいだは変えても音が変わらないため）
  const off = !state.enabled;
  for (const f of FEATURES) {
    f.input.checked = state[f.key];
    f.section.classList.toggle('on', state[f.key]);
    for (const input of f.choices) input.checked = input.value === state[f.choice];
    for (const input of [f.input, ...f.choices]) input.disabled = off;
  }
  for (const input of eqModeInputs) input.checked = input.value === (state.autoEq ? 'auto' : 'manual');
  for (const input of eqModeInputs) input.disabled = off;

  // EQ はオートか手動のどちらか。オートのあいだは、手動の EQ（プリセット・フラットに戻す）は隠し、
  // スライダーは動かせないようにして、自動で決めた補正量を表示する。手動に戻すと、手動の EQ の値に戻る
  const auto = state.autoEq;
  document.body.classList.toggle('auto', auto);
  presetSelect.disabled = off || auto;
  resetButton.disabled = off || auto;
  for (const { input } of controls) {
    input.disabled = off || auto;
    // オートの補正量は 0.1dB 刻みなので、スライダーのつまみも同じ刻みで表示する（手動では 0.5dB 刻みで動かす）
    input.step = auto ? 0.1 : 0.5;
  }
  // オートと手動を切り替えたときだけ、表示と問い合わせを切り替える。
  // ほかの設定を変えるたびに 0 に戻すと、次の返事が届くまでスライダーがちらつく
  if (auto !== autoShown) {
    autoShown = auto;
    autoGeneration += 1;
    clearInterval(autoTimer);
    autoTimer = null;
    if (auto) {
      showGains(controls, Settings.BANDS.map(() => 0));
      showAutoEq(controls);
      autoTimer = setInterval(() => showAutoEq(controls), 1000);
    }
  }
  if (!auto) showGains(controls, state.gains);
}

(async () => {
  state = await Settings.load();
  buildPresets();
  const controls = buildBands();
  render(controls);

  enabledInput.addEventListener('change', () => {
    state.enabled = enabledInput.checked;
    render(controls);
    Settings.save(state);
  });
  for (const f of FEATURES) {
    f.input.addEventListener('change', () => {
      state[f.key] = f.input.checked;
      render(controls);
      Settings.save(state);
    });
    for (const input of f.choices) {
      input.addEventListener('change', () => {
        state[f.choice] = input.value;
        Settings.save(state);
      });
    }
  }
  for (const input of eqModeInputs) {
    input.addEventListener('change', () => {
      state.autoEq = input.value === 'auto';
      render(controls);
      Settings.save(state);
    });
  }
  // プリセットを選んだら、その値をゲインに入れる。カスタムは、手動のゲインをそのまま残す
  presetSelect.addEventListener('change', () => {
    state.eqPreset = presetSelect.value;
    const preset = Settings.PRESETS.find((p) => p.id === state.eqPreset);
    if (preset) state.gains = [...preset.gains];
    render(controls);
    Settings.save(state);
  });
  resetButton.addEventListener('click', () => {
    state.gains = Settings.defaults().gains;
    state.eqPreset = 'flat';
    render(controls);
    Settings.save(state);
  });
})();
