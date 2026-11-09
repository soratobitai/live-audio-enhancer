'use strict';

// 音声グラフの生成をここに集約する。
// createMediaElementSource() は同じ要素に1回しか呼べないので、接続済みの要素を WeakMap で管理する。
// ディレイ拡張と統合するときも、video 要素への接続は必ずこのモジュールを経由させる。
//
// 接続後はグラフを切らずに、ゲインのクロスフェードでエフェクトの有無を切り替える。
//   source ─┬─┬─ RNNoise ─ nrWet ─┬─ EQ（BiquadFilter × 帯域数）─ wet ─┬─ output ─ destination
//           │ └─────────── nrDry ─┘                                 │
//           └──────────────────────────────────────────────── dry ─┘
// RNNoise のノードは、ノイズキャンセルを初めて有効にしたときに作る。
// 読み込めなかったときは nrDry 側（素通し）のままにする。
const AudioGraph = (() => {
  // パラメータを変えるときの時定数（秒）。値を急に変えるとプツッというノイズが出る
  const RAMP = 0.02;
  // RNNoise は 48kHz 前提なので、AudioContext を 48kHz で作る（メディアの音声はブラウザが変換する）
  const SAMPLE_RATE = 48000;
  // RNNoise のワークレットは WASM を非同期に初期化し、それまでは無音を出す。
  // ノードを作った直後に切り替えると音が途切れるので、この秒数だけ待ってから nrWet に切り替える
  const DENOISER_WARMUP = 0.15;
  const RNNOISE_DIR = 'vendor/web-noise-suppressor/';
  const RNNOISE_PROCESSOR = '@sapphi-red/web-noise-suppressor/rnnoise';

  let ctx = null;
  let running = null;
  let rnnoise = null; // Promise<ArrayBuffer | null>: RNNoise の WASM。読み込めなかったら null
  let settings = Settings.defaults();
  const graphs = new WeakMap(); // video -> Promise<graph | null>
  const live = new Set(); // 接続済みのグラフ。設定の変更を反映するために持つ

  // AudioContext が running になるまで待つ。
  // 自動再生ポリシーで開始できないときは resume() が保留されるので、ユーザー操作のたびに再試行する。
  // running になる前に接続すると、その間は無音になるため、必ずこれを待ってから接続する。
  function whenRunning() {
    if (running) return running;
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    running = new Promise((resolve) => {
      const retry = () => ctx.resume();
      const check = () => {
        if (ctx.state !== 'running') return;
        ctx.removeEventListener('statechange', check);
        window.removeEventListener('pointerdown', retry, true);
        window.removeEventListener('keydown', retry, true);
        resolve(ctx);
      };
      ctx.addEventListener('statechange', check);
      window.addEventListener('pointerdown', retry, true);
      window.addEventListener('keydown', retry, true);
      retry();
      check();
      if (ctx.state !== 'running') {
        console.info('[audio-fx] ページを一度クリックすると、エフェクトが有効になります');
      }
    });
    return running;
  }

  // RNNoise のワークレットと WASM を読み込む（1回だけ）。
  // ワークレット内では fetch が使えないので、WASM は content script で取得して processorOptions で渡す。
  // 拡張内のファイルは web_accessible_resources に登録してあるので、ページの CSP に関係なく読み込める。
  // YouTube では、content script からの fetch で "Unsafe attempt to load URL" というログが出るが、取得はできている。
  function loadRnnoise(c) {
    const url = (file) => chrome.runtime.getURL(RNNOISE_DIR + file);
    rnnoise ??= Promise.all([
      c.audioWorklet.addModule(url('rnnoise/workletProcessor.js')),
      fetch(url('rnnoise_simd.wasm')).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
    ]).then(
      ([, wasm]) => wasm,
      (e) => {
        console.warn('[audio-fx] RNNoise を読み込めませんでした。ノイズキャンセルは使えません', e);
        return null;
      },
    );
    return rnnoise;
  }

  async function ensureDenoiser(g) {
    if (g.denoiserRequested) return;
    g.denoiserRequested = true;
    const c = g.source.context;
    const wasmBinary = await loadRnnoise(c);
    if (!wasmBinary) return;
    // RNNoise はチャンネルごとに処理し、maxChannels を超えたチャンネルは無音になるので、入力をステレオにそろえる
    const node = new AudioWorkletNode(c, RNNOISE_PROCESSOR, {
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { wasmBinary, maxChannels: 2 },
    });
    g.source.connect(node).connect(g.nrWet);
    g.denoiser = node;
    g.denoiseFrom = c.currentTime + DENOISER_WARMUP;
    apply(g, true);
    console.info('[audio-fx] ノイズキャンセルを準備しました');
  }

  function build(c, source) {
    const filters = Settings.BANDS.map((b) => {
      const f = c.createBiquadFilter();
      f.type = b.type;
      f.frequency.value = b.freq;
      if (b.q) f.Q.value = b.q;
      return f;
    });
    const nrWet = c.createGain();
    const nrDry = c.createGain();
    const wet = c.createGain();
    const dry = c.createGain();
    const output = c.createGain();
    source.connect(nrDry);
    nrWet.connect(filters[0]);
    nrDry.connect(filters[0]);
    // connect() は接続先を返すので、reduce で直列につなげる
    filters.reduce((from, to) => from.connect(to)).connect(wet);
    wet.connect(output);
    source.connect(dry);
    dry.connect(output);
    output.connect(c.destination);
    return {
      source, nrWet, nrDry, filters, wet, dry, output,
      denoiser: null, denoiserRequested: false, denoiseFrom: 0,
    };
  }

  // 設定をグラフに反映する。接続直後は ramp を false にして即座に反映する
  function apply(g, ramp) {
    const now = g.source.context.currentTime;
    const set = (param, v, from = now) => {
      if (ramp) param.setTargetAtTime(v, Math.max(now, from), RAMP);
      else param.value = v;
    };
    const denoise = settings.denoise && g.denoiser !== null;
    g.filters.forEach((f, i) => set(f.gain, settings.gains[i]));
    set(g.nrWet.gain, denoise ? 1 : 0, g.denoiseFrom);
    set(g.nrDry.gain, denoise ? 0 : 1, g.denoiseFrom);
    set(g.wet.gain, settings.enabled ? 1 : 0);
    set(g.dry.gain, settings.enabled ? 0 : 1);
    if (settings.denoise) ensureDenoiser(g);
  }

  async function connect(video) {
    const c = await whenRunning();
    try {
      const source = c.createMediaElementSource(video);
      const g = build(c, source);
      apply(g, false);
      live.add(g);
      console.info('[audio-fx] 接続しました', video);
      return g;
    } catch (e) {
      // 別のスクリプトが先に接続済みの場合など。接続し直すことはできないので、再試行はしない
      console.warn('[audio-fx] 接続に失敗しました', e);
      return null;
    }
  }

  function attach(video) {
    if (!graphs.has(video)) {
      // CORS で出力が無音になるのを避けるため、MSE（blob:）で再生している要素だけを接続する
      if (!video.currentSrc.startsWith('blob:')) {
        console.info('[audio-fx] blob: ではないので接続しません', video.currentSrc);
        return Promise.resolve(null);
      }
      graphs.set(video, connect(video));
    }
    return graphs.get(video);
  }

  function update(next) {
    settings = next;
    for (const g of live) apply(g, true);
  }

  return { attach, update };
})();
