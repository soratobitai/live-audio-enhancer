'use strict';

const enabledInput = document.getElementById('enabled');
const denoiseInput = document.getElementById('denoise');
const denoiseSection = document.querySelector('.denoise');
const engineInputs = document.querySelectorAll('input[name="engine"]');
const levelerInputs = document.querySelectorAll('input[name="leveler"]');
const eqSection = document.querySelector('.eq');
const presetSelect = document.getElementById('eqPreset');
const autoOptions = document.querySelector('.auto-options');
const autoStrengthInputs = document.querySelectorAll('input[name="autoStrength"]');
const autoNote = document.querySelector('.auto-note');
const bandsSection = document.getElementById('bands');
const resetButton = document.getElementById('reset');

const SUFFIX = { lowshelf: ' 以下', highshelf: ' 以上' };
const freqText = (hz) => (hz >= 1000 ? `${hz / 1000}kHz` : `${hz}Hz`);
const gainText = (db) => `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;

let state;
let autoTimer = null;

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
  add(presetSelect, 'auto', 'オート（試作）');
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
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const status = await chrome.tabs.sendMessage(tab.id, { type: 'audio-fx:status' });
    if (!status?.connected) {
      autoNote.textContent = 'このタブでは、まだ動画につないでいません';
    } else if (!status.autoEq?.ready) {
      autoNote.textContent = '番組の音を分析しています…';
    } else {
      autoNote.textContent = '番組の音に合わせて自動で調整しています';
    }
    if (status?.autoEq) showGains(controls, status.autoEq.gains);
  } catch {
    // 対応サイト以外のタブなど、content script がない
    autoNote.textContent = 'このタブでは使えません';
  }
}

function render(controls) {
  enabledInput.checked = state.enabled;
  denoiseInput.checked = state.denoise;
  denoiseSection.classList.toggle('on', state.denoise);
  for (const input of engineInputs) input.checked = input.value === state.engine;
  for (const input of levelerInputs) input.checked = input.value === state.leveler;
  for (const input of autoStrengthInputs) input.checked = input.value === state.autoStrength;
  document.body.classList.toggle('off', !state.enabled);
  presetSelect.value = state.eqPreset;

  const auto = state.eqPreset === 'auto';
  eqSection.classList.toggle('auto', auto);
  autoOptions.hidden = !auto;
  clearInterval(autoTimer);
  autoTimer = null;
  if (auto) {
    showGains(controls, Settings.BANDS.map(() => 0));
    showAutoEq(controls);
    autoTimer = setInterval(() => showAutoEq(controls), 1000);
  } else {
    showGains(controls, state.gains);
  }
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
  denoiseInput.addEventListener('change', () => {
    state.denoise = denoiseInput.checked;
    render(controls);
    Settings.save(state);
  });
  // ラジオボタンの選択肢（ノイズキャンセルの方式、音量をそろえる強さ、オートEQ の強さ）
  for (const [inputs, key] of [[engineInputs, 'engine'], [levelerInputs, 'leveler'], [autoStrengthInputs, 'autoStrength']]) {
    for (const input of inputs) {
      input.addEventListener('change', () => {
        state[key] = input.value;
        Settings.save(state);
      });
    }
  }
  // プリセットを選んだら、その値をゲインに入れる。カスタムとオートは、手動のゲインをそのまま残す
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
