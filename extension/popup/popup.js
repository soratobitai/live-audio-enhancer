'use strict';

const enabledInput = document.getElementById('enabled');
const denoiseInput = document.getElementById('denoise');
const denoiseSection = document.querySelector('.denoise');
const engineInputs = document.querySelectorAll('input[name="engine"]');
const levelerInputs = document.querySelectorAll('input[name="leveler"]');
const bandsSection = document.getElementById('bands');
const resetButton = document.getElementById('reset');

const SUFFIX = { lowshelf: ' 以下', highshelf: ' 以上' };
const freqText = (hz) => (hz >= 1000 ? `${hz / 1000}kHz` : `${hz}Hz`);
const gainText = (db) => `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;

let state;

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

    // ドラッグ中も音に反映させたいので、input イベントのたびに保存する
    input.addEventListener('input', () => {
      state.gains[i] = Number(input.value);
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

function render(controls) {
  enabledInput.checked = state.enabled;
  denoiseInput.checked = state.denoise;
  denoiseSection.classList.toggle('on', state.denoise);
  for (const input of engineInputs) input.checked = input.value === state.engine;
  for (const input of levelerInputs) input.checked = input.value === state.leveler;
  document.body.classList.toggle('off', !state.enabled);
  controls.forEach(({ input, value }, i) => {
    input.value = state.gains[i];
    value.textContent = gainText(state.gains[i]);
  });
}

(async () => {
  state = await Settings.load();
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
  // ラジオボタンの選択肢（ノイズキャンセルの方式、音量をそろえる強さ）
  for (const [inputs, key] of [[engineInputs, 'engine'], [levelerInputs, 'leveler']]) {
    for (const input of inputs) {
      input.addEventListener('change', () => {
        state[key] = input.value;
        Settings.save(state);
      });
    }
  }
  resetButton.addEventListener('click', () => {
    state.gains = Settings.defaults().gains;
    render(controls);
    Settings.save(state);
  });
})();
