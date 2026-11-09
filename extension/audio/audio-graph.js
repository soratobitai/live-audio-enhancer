'use strict';

// 音声グラフの生成をここに集約する。
// createMediaElementSource() は同じ要素に1回しか呼べないので、接続済みの要素を WeakMap で管理する。
// video 要素への接続は必ずこのモジュールを経由させる。
//
// 接続後はグラフを切らずに、ゲインのクロスフェードでエフェクトの有無を切り替える。
//   source ─┬─┬─ RNNoise ──────── 方式ごとの wet ─┬─ eqIn ─ EQ ─┬─ コンプレッサー ─ compWet ─┬─ wet ─┬─ output ─ destination
//           │ ├─ DeepFilterNet3 ─ 方式ごとの wet ─┤             └─────────────── compDry ─┘       │
//           │ └──────────────────────── nrDry ───┘                                               │
//           └────────────────────────────────────────────────────────────────────────── dry ───┘
// EQ は BiquadFilter を帯域の数だけ直列につないだもの。
// オートEQ のときは、eqIn（EQ に入る前の音）を分析して EQ のゲインを決める。
// ノイズキャンセルのノードは、その方式を選んだときに作り、使わなくなったら止める。
// 準備中や作れなかったときは nrDry 側（素通し）にする。
const AudioGraph = (() => {
  // パラメータを変えるときの時定数（秒）。値を急に変えるとプツッというノイズが出る
  const RAMP = 0.02;
  // 使わなくなったノイズキャンセルを止めるまでの時間（ミリ秒）。出力のフェードアウトが終わるのを待つ
  const STOP_DELAY_MS = 200;
  // オートEQ がゲインを変えるときの時定数（秒）。音色が急に変わらないよう、ゆっくり変える
  const AUTO_RAMP = 1;
  // RNNoise も DeepFilterNet3 も 48kHz 前提なので、AudioContext を 48kHz で作る（メディアの音声はブラウザが変換する）
  const SAMPLE_RATE = 48000;
  const RNNOISE_DIR = 'vendor/web-noise-suppressor/';
  const RNNOISE_PROCESSOR = '@sapphi-red/web-noise-suppressor/rnnoise';
  const DEEPFILTERNET_DIR = 'vendor/deepfilternet/';
  // 音量をそろえる（コンプレッサー）の強さごとの設定。
  // DynamicsCompressorNode は圧縮した分に応じて自動で持ち上げる（メイクアップゲイン）ので、大きい音は抑えられ、
  // 小さい音は大きくなる。1kHz の正弦波で測ると、入力 -50dB / -3dB に対して出力は
  // 弱 -44.7 / -6.3、中 -38.2 / -10.5、強 -31.2 / -15.3 dB で、どの強さでも 0dBFS は超えなかった
  const LEVELERS = {
    light: { threshold: -24, knee: 12, ratio: 2, attack: 0.01, release: 0.25 },
    medium: { threshold: -32, knee: 12, ratio: 4, attack: 0.005, release: 0.25 },
    strong: { threshold: -40, knee: 10, ratio: 8, attack: 0.003, release: 0.25 },
  };

  let ctx = null;
  let running = null;
  let rnnoise = null; // Promise<ArrayBuffer | null>: RNNoise の WASM。読み込めなかったら null
  let deepfilternet = null; // Promise<module | null>: DeepFilterNet3 のモジュール。読み込めなかったら null
  let settings = Settings.defaults();
  const graphs = new WeakMap(); // video -> Promise<graph | null>
  const live = new Set(); // 接続済みのグラフ。設定の変更を反映するために持つ
  let latest = null; // 最後に接続したグラフ。ポップアップにオートEQの状態を見せるために使う

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

  async function createRnnoise(c, source) {
    const wasmBinary = await loadRnnoise(c);
    if (!wasmBinary) return null;
    // RNNoise はチャンネルごとに処理し、maxChannels を超えたチャンネルは無音になるので、入力をステレオにそろえる
    const node = new AudioWorkletNode(c, RNNOISE_PROCESSOR, {
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { wasmBinary, maxChannels: 2 },
    });
    source.connect(node);
    // ワークレット内の RNNoise の状態を解放してから切り離す
    return { node, stop: () => { node.port.postMessage('destroy'); node.disconnect(); } };
  }

  // DeepFilterNet3 は、パッケージの createDeepFilterNetAudioWorklet() で作る。
  // ES モジュールなので動的 import で読み込む（content script は静的 import を使えない）。
  // 入力はモノラルにまとめて処理され、出力もモノラルになる（EQ に入るところで左右に広がる）
  async function createDeepFilterNet(c, source) {
    deepfilternet ??= import(chrome.runtime.getURL(DEEPFILTERNET_DIR + 'deepfilternet.js')).catch((e) => {
      console.warn('[audio-fx] DeepFilterNet3 を読み込めませんでした', e);
      return null;
    });
    const module = await deepfilternet;
    if (!module) return null;
    let worklet = null;
    try {
      // モジュールは既定ではワークレット・WASM・モデルの URL を import.meta.url から作るが、それは拡張の固定 URL になり、
      // use_dynamic_url を有効にしているとページから取得できない。getURL の動的 URL を明示的に渡す
      const url = (file) => chrome.runtime.getURL(DEEPFILTERNET_DIR + file);
      worklet = await module.createDeepFilterNetAudioWorklet(c, {
        moduleUrl: url('assets/deepfilternet-worklet-processor.js'),
        wasmUrl: url('assets/deepfilternet/df_bg.wasm'),
        modelUrl: url('assets/deepfilternet/DeepFilterNet3_onnx.tar.gz'),
        onOverload: (load) => console.warn('[audio-fx] DeepFilterNet3 の処理が間に合っていません', load),
      });
      // 準備ができるまでは入力をそのまま出す（bypassUntilReady）。準備ができてから出力に切り替える
      source.connect(worklet.node);
      await worklet.ready;
      return { node: worklet.node, stop: () => worklet.dispose() };
    } catch (e) {
      worklet?.dispose();
      console.warn('[audio-fx] DeepFilterNet3 を使えませんでした', e);
      return null;
    }
  }

  // ノイズキャンセルの方式ごとの作り方。create(c, source) は、source につないで使える状態にしたノードと、
  // それを止める関数 { node, stop } を返す（失敗なら null）。
  // warmup は、ノードができてから出力に切り替えるまでに待つ秒数。
  // RNNoise のワークレットは WASM を非同期に初期化し、それまでは無音を出すので少し待つ
  const ENGINES = {
    rnnoise: { create: createRnnoise, warmup: 0.15 },
    deepfilternet: { create: createDeepFilterNet, warmup: 0 },
  };

  async function ensureEngine(g, name) {
    if (g.engines[name]) return;
    const c = g.source.context;
    const engine = { node: null, wet: c.createGain(), from: 0, stop: null };
    engine.wet.gain.value = 0;
    engine.wet.connect(g.eqIn);
    g.engines[name] = engine;
    const created = await ENGINES[name].create(c, g.source);
    if (!created) return;
    engine.stop = () => {
      g.source.disconnect(created.node);
      created.stop();
    };
    // 準備しているあいだに別の方式に切り替えられていたら、使わずに止める
    if (g.engines[name] !== engine) {
      engine.stop();
      return;
    }
    created.node.connect(engine.wet);
    engine.node = created.node;
    engine.from = c.currentTime + ENGINES[name].warmup;
    apply(g, true);
    console.info(`[audio-fx] ノイズキャンセル（${name}）を準備しました`);
  }

  // 使わなくなった方式は、出力をフェードアウトしてから止める（裏で処理し続けて CPU を使わないように）。
  // もう一度選ばれたときは作り直す（WASM やモデルは読み込み済みなので速い）
  function stopEngine(g, name) {
    const engine = g.engines[name];
    delete g.engines[name];
    engine.wet.gain.setTargetAtTime(0, g.source.context.currentTime, RAMP);
    setTimeout(() => {
      engine.wet.disconnect();
      engine.stop?.();
    }, STOP_DELAY_MS);
  }

  function build(c, source) {
    const filters = Settings.BANDS.map((b) => {
      const f = c.createBiquadFilter();
      f.type = b.type;
      f.frequency.value = b.freq;
      if (b.q) f.Q.value = b.q;
      return f;
    });
    const nrDry = c.createGain();
    const eqIn = c.createGain();
    const compressor = c.createDynamicsCompressor();
    const compWet = c.createGain();
    const compDry = c.createGain();
    const wet = c.createGain();
    const dry = c.createGain();
    const output = c.createGain();
    source.connect(nrDry);
    nrDry.connect(eqIn);
    eqIn.connect(filters[0]);
    // connect() は接続先を返すので、reduce で直列につなげる
    const eqOut = filters.reduce((from, to) => from.connect(to));
    eqOut.connect(compressor).connect(compWet).connect(wet);
    eqOut.connect(compDry).connect(wet);
    wet.connect(output);
    source.connect(dry);
    dry.connect(output);
    output.connect(c.destination);
    // engines: 方式名 -> { node, wet, from }。ノードは準備ができるまで null。
    // auto: オートEQ の分析（オートEQ を選んでいるあいだだけ動かす）
    return { source, nrDry, eqIn, filters, compressor, compWet, compDry, wet, dry, output, engines: {}, auto: null };
  }

  // EQ のゲインを決める。オートEQ のときは分析した結果を、それ以外は設定のゲイン（手動かプリセット）を使う
  function applyEq(g, ramp) {
    const c = g.source.context;
    if (settings.eqPreset === 'auto') {
      g.auto ??= AutoEq.create(c, g.eqIn, (gains) => {
        if (settings.eqPreset !== 'auto') return;
        gains.forEach((v, i) => g.filters[i].gain.setTargetAtTime(v, c.currentTime, AUTO_RAMP));
      });
      // 分析がたまるまでは 0dB（素通し）から始める
      g.auto.gains().forEach((v, i) => g.filters[i].gain.setTargetAtTime(v, c.currentTime, AUTO_RAMP));
      return;
    }
    if (g.auto) {
      g.auto.stop();
      g.auto = null;
    }
    g.filters.forEach((f, i) => {
      if (ramp) f.gain.setTargetAtTime(settings.gains[i], c.currentTime, RAMP);
      else f.gain.value = settings.gains[i];
    });
  }

  // 設定をグラフに反映する。接続直後は ramp を false にして即座に反映する
  function apply(g, ramp) {
    const now = g.source.context.currentTime;
    const set = (param, v, from = now) => {
      if (ramp) param.setTargetAtTime(v, Math.max(now, from), RAMP);
      else param.value = v;
    };
    // 使うノイズキャンセル。準備中や作れなかったときは null で、nrDry 側（素通し）にする
    const active = settings.denoise ? g.engines[settings.engine] : undefined;
    const using = active?.node ? active : null;
    applyEq(g, ramp);
    for (const engine of Object.values(g.engines)) set(engine.wet.gain, engine === using ? 1 : 0, using?.from);
    set(g.nrDry.gain, using ? 0 : 1, using?.from);
    const leveler = LEVELERS[settings.leveler];
    if (leveler) {
      for (const [key, value] of Object.entries(leveler)) set(g.compressor[key], value);
    }
    set(g.compWet.gain, leveler ? 1 : 0);
    set(g.compDry.gain, leveler ? 0 : 1);
    set(g.wet.gain, settings.enabled ? 1 : 0);
    set(g.dry.gain, settings.enabled ? 0 : 1);
    for (const name of Object.keys(g.engines)) {
      if (!(settings.denoise && name === settings.engine)) stopEngine(g, name);
    }
    if (settings.denoise) ensureEngine(g, settings.engine);
  }

  async function connect(video) {
    const c = await whenRunning();
    try {
      const source = c.createMediaElementSource(video);
      const g = build(c, source);
      apply(g, false);
      live.add(g);
      latest = g;
      console.info('[audio-fx] 接続しました', video);
      return g;
    } catch (e) {
      // 別のスクリプトが先に接続済みの場合など。接続し直すことはできないので、再試行はしない
      console.warn('[audio-fx] 接続に失敗しました', e);
      return null;
    }
  }

  // 接続してよい要素か。別オリジンのメディアを CORS なしで再生している要素に接続すると出力が無音になるので、
  // ページ自身がデータを用意している MSE（または Blob）の要素だけを対象にする。
  // Kick（Amazon IVS）は Worker 内で MSE を使い、srcObject に MediaSourceHandle を渡している（currentSrc は空）
  function canAttach(video) {
    if (video.currentSrc.startsWith('blob:')) return true;
    return typeof MediaSourceHandle !== 'undefined' && video.srcObject instanceof MediaSourceHandle;
  }

  function attach(video) {
    if (!graphs.has(video)) {
      if (!canAttach(video)) {
        console.info('[audio-fx] MSE で再生していないので接続しません', video.currentSrc);
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

  // ポップアップに見せる状態。オートEQ の分析が済んでいるかと、今の補正量
  function status() {
    const auto = latest?.auto;
    return {
      connected: !!latest,
      autoEq: auto ? { ready: auto.ready(), gains: auto.gains() } : null,
    };
  }

  return { attach, update, status };
})();
