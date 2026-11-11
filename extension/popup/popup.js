'use strict';

const enabledInput = document.getElementById('enabled');
const denoiseSection = document.querySelector('.denoise');
const denoiseModeInputs = document.querySelectorAll('input[name="denoiseMode"]');
const engineInputs = document.querySelectorAll('input[name="engine"]');
const denoiseNote = document.querySelector('.denoise-note');
const denoiseExplain = document.querySelector('.denoise-explain');
const levelerSection = document.querySelector('.leveler');
const levelerInput = document.getElementById('leveler');
const levelerStrengthInputs = document.querySelectorAll('input[name="levelerStrength"]');
const presetSelect = document.getElementById('eqPreset');
const eqModeInputs = document.querySelectorAll('input[name="eqMode"]');
const autoNote = document.querySelector('.auto-note');
const bandsSection = document.getElementById('bands');
const resetButton = document.getElementById('reset');

const SUFFIX = { lowshelf: ' 以下', highshelf: ' 以上' };
const freqText = (hz) => (hz >= 1000 ? `${hz / 1000}kHz` : `${hz}Hz`);
const gainText = (db) => `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
// ノイズキャンセルの説明。選んでいるモードがどういう意味かを出す
const DENOISE_EXPLAIN = {
  off: 'かけません。オンにすると、声以外の音を抑えます',
  auto: '話し声のときだけかけ、音楽や歌のときは外します',
  on: 'いつもかけます。音楽では音が乱れることがあります',
};

let state;
let autoShown = null; // 今オートEQ の表示をしているか（オートと手動を切り替えたときだけ、スライダーの表示を切り替えるため）
// 状態の問い合わせ（オートEQ の補正量、ノイズキャンセルのオートの判定）
let statusTimer = null;
let polling = null; // 何を問い合わせているか。変わったときだけ問い合わせを始め直す
let statusGeneration = 0; // 問い合わせを始め直すたびに増やす。手動に切り替えたあとなどに届いた返事を捨てるため
let statusReplied = 0; // 表示に使った返事の番号。順番が入れ替わって届いた古い返事を捨てるため
let statusAsked = 0;

// ノイズキャンセルのオートが動いているか（全体が有効で、ノイズキャンセルがオート）
const denoiseAuto = () => state.enabled && state.denoise && state.denoiseAuto;

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

// オートEQ の補正量と、ノイズキャンセルのオートの判定を、表示しているタブの content script に問い合わせて表示する
async function showStatus(controls) {
  const generation = statusGeneration;
  const asked = ++statusAsked;
  let status = null;
  let usable = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    status = await chrome.tabs.sendMessage(tab.id, { type: 'audio-fx:status' });
  } catch {
    // 対応サイト以外のタブなど、content script がない
    usable = false;
  }
  // 問い合わせのあいだに設定が変わったり、あとの問い合わせの返事が先に届いていたりしたら、表示しない
  if (generation !== statusGeneration || asked < statusReplied) return;
  statusReplied = asked;
  const connected = usable && status?.connected;
  const notConnected = usable ? 'このタブでは、まだ動画につないでいません' : 'このタブでは使えません';
  if (state.autoEq) {
    const target = status?.autoEq?.target;
    autoNote.textContent = !connected ? notConnected
      : !status.autoEq?.ready ? '今：番組の音を分析しています…'
      : target === 'speech' ? '今：話し声に合わせて調整しています'
      : target === 'music' ? '今：音楽や歌に合わせて調整しています'
      : '今：番組の音に合わせて調整しています';
    if (status?.autoEq) showGains(controls, status.autoEq.gains);
  }
  if (denoiseAuto()) {
    const judged = status?.judge?.state;
    denoiseNote.textContent = !connected ? notConnected
      : judged === 'speech' ? '今：話し声なので、かけています'
      : judged === 'other' ? '今：音楽や歌などなので、外しています'
      : '今：音を調べています…';
  }
}

function render(controls) {
  enabledInput.checked = state.enabled;
  document.body.classList.toggle('off', !state.enabled);
  // 全体を無効にしているあいだは、「有効」のスイッチ以外は操作できない（無効のあいだは変えても音が変わらないため）
  const off = !state.enabled;

  // ノイズキャンセル：オフ / オート（話し声が主役のときだけかける）/ オン
  const denoiseMode = !state.denoise ? 'off' : state.denoiseAuto ? 'auto' : 'on';
  for (const input of denoiseModeInputs) input.checked = input.value === denoiseMode;
  denoiseExplain.textContent = DENOISE_EXPLAIN[denoiseMode];
  for (const input of engineInputs) input.checked = input.value === state.engine;
  denoiseSection.classList.toggle('on', state.denoise);
  denoiseNote.hidden = !denoiseAuto();

  // 音量をそろえる：オン・オフと強さ
  levelerInput.checked = state.leveler;
  for (const input of levelerStrengthInputs) input.checked = input.value === state.levelerStrength;
  levelerSection.classList.toggle('on', state.leveler);

  presetSelect.value = state.eqPreset;
  for (const input of eqModeInputs) input.checked = input.value === (state.autoEq ? 'auto' : 'manual');
  for (const input of [...denoiseModeInputs, ...engineInputs, levelerInput, ...levelerStrengthInputs, ...eqModeInputs]) {
    input.disabled = off;
  }

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
  // オートと手動を切り替えたときだけ、スライダーを 0 に戻す。
  // ほかの設定を変えるたびに 0 に戻すと、次の返事が届くまでスライダーがちらつく
  if (auto !== autoShown) {
    autoShown = auto;
    if (auto) showGains(controls, Settings.BANDS.map(() => 0));
  }
  if (!auto) showGains(controls, state.gains);

  // 問い合わせる内容（オートEQ、ノイズキャンセルのオート）が変わったときだけ、問い合わせを始め直す
  const want = [auto && 'auto-eq', denoiseAuto() && 'denoise'].filter(Boolean).join(',');
  if (want !== polling) {
    polling = want;
    statusGeneration += 1;
    clearInterval(statusTimer);
    statusTimer = null;
    if (denoiseAuto()) denoiseNote.textContent = '今：音を調べています…';
    if (want) {
      showStatus(controls);
      statusTimer = setInterval(() => showStatus(controls), 1000);
    }
  }
}

(async () => {
  state = await Settings.load();
  buildPresets();
  const controls = buildBands();
  render(controls);

  const change = (update) => {
    update();
    render(controls);
    Settings.save(state);
  };
  enabledInput.addEventListener('change', () => change(() => { state.enabled = enabledInput.checked; }));
  for (const input of denoiseModeInputs) {
    input.addEventListener('change', () => change(() => {
      state.denoise = input.value !== 'off';
      if (state.denoise) state.denoiseAuto = input.value === 'auto';
    }));
  }
  for (const input of engineInputs) input.addEventListener('change', () => change(() => { state.engine = input.value; }));
  levelerInput.addEventListener('change', () => change(() => { state.leveler = levelerInput.checked; }));
  for (const input of levelerStrengthInputs) {
    input.addEventListener('change', () => change(() => { state.levelerStrength = input.value; }));
  }
  for (const input of eqModeInputs) input.addEventListener('change', () => change(() => { state.autoEq = input.value === 'auto'; }));
  // プリセットを選んだら、その値をゲインに入れる。カスタムは、手動のゲインをそのまま残す
  presetSelect.addEventListener('change', () => change(() => {
    state.eqPreset = presetSelect.value;
    const preset = Settings.PRESETS.find((p) => p.id === state.eqPreset);
    if (preset) state.gains = [...preset.gains];
  }));
  resetButton.addEventListener('click', () => change(() => {
    state.gains = Settings.defaults().gains;
    state.eqPreset = 'flat';
  }));
})();
