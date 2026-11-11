'use strict';

// 音声グラフの生成をここに集約する。
// createMediaElementSource() は同じ要素に1回しか呼べないので、接続済みの要素を WeakMap で管理する。
// video 要素への接続は必ずこのモジュールを経由させる。
//
// 接続後はグラフを切らずに、ゲインのクロスフェードでエフェクトの有無を切り替える。
//   video ─ source ─┬─┬─ RNNoise ──────── 方式ごとの wet ─┬─ eqIn ─ EQ ─┬─ コンプレッサー ─ compWet ─┬─ リミッター ─ wet ─┬─ output ─ volume ─ destination
//                   │ ├─ DeepFilterNet3 ─ 方式ごとの wet ─┤             └─────────────── compDry ─┘                   │
//                   │ └──────────────────────── nrDry ───┘                                                           │
//                   └────────────────────────────────────────────────────────────────────────────────────── dry ───┘
// プレイヤーの音量は、この拡張に音が届く前にかかっている。音量によってオートEQ や音量をそろえるの効き方が
// 変わらないよう、source で音量を打ち消してから処理し、volume でかけ直す（耳に届く大きさはプレイヤーの音量どおり）。
// リミッターは、EQ で持ち上げても 0dBFS を超えて音割れしないように、エフェクト側の経路の最後に常に入れる。
// EQ は BiquadFilter を帯域の数だけ直列につないだもの。
// オートEQ のときは、eqIn（EQ に入る前の音）を分析して EQ のゲインを決める。
// ノイズキャンセルのノードは、その方式を選んだときに作り、使わなくなったら止める。
// 準備中や作れなかったときは nrDry 側（素通し）にする。
const AudioGraph = (() => {
  // パラメータを変えるときの時定数（秒）。値を急に変えるとプツッというノイズが出る
  const RAMP = 0.02;
  // プレイヤーの音量を打ち消すときの下限（-40dB）。音量 0 は打ち消せないので、これより小さい音量はこの値とみなす
  const MIN_VOLUME = 0.01;
  // 使わなくなったノイズキャンセルを止めるまでの時間（ミリ秒）。出力のフェードアウトが終わるのを待つ
  const STOP_DELAY_MS = 200;
  // オートEQ がゲインを変えるときの時定数（秒）。音色が急に変わらないよう、ゆっくり変える
  const AUTO_RAMP = 1;
  // RNNoise も DeepFilterNet3 も 48kHz 前提なので、AudioContext を 48kHz で作る（メディアの音声はブラウザが変換する）
  const SAMPLE_RATE = 48000;
  const RNNOISE_DIR = 'vendor/web-noise-suppressor/';
  const RNNOISE_PROCESSOR = '@sapphi-red/web-noise-suppressor/rnnoise';
  const DEEPFILTERNET_DIR = 'vendor/deepfilternet/';
  const DEEPFILTERNET_PROCESSOR = 'workadventure-deepfilternet';
  // DeepFilterNet3 のワークレットに渡す設定。パッケージの createDeepFilterNetAudioWorklet()（0.2.0）が既定で渡すものと同じ。
  // パッケージの関数は使わず、ノードを自分で作る（Firefox ではパッケージの関数が渡す WebAssembly.Module をワークレットにコピーできないため）。
  // パッケージを更新したら、この設定が変わっていないかを dist/deepfilternet.js で確かめる
  const DEEPFILTERNET_OPTIONS = {
    speechAttenuationDb: 25,
    pauseGate: {
      extraAttenuationDb: 20, lookaheadFrames: 3, hangoverFrames: 10,
      releaseDbPerFrame: 0.6, speechAboveFloorDb: 10, maxSpeechAttenuationDb: 15,
    },
    bypassUntilReady: true,
    maxLoad: 0.7,
    loadReportAfterMs: 0,
  };
  const DEEPFILTERNET_READY_TIMEOUT_MS = 30000;
  // Firefox の content script で作ったオブジェクトは、そのままではワークレットにコピーできない（DataCloneError）。
  // cloneInto（Firefox の content script にだけある関数）でページ側にコピーしてから渡す。Chrome ではそのまま渡す
  const CLONE_INTO = typeof cloneInto === 'function' ? cloneInto : null;
  const toPage = (value) => (CLONE_INTO ? CLONE_INTO(value, window) : value);
  // 音量をそろえる（コンプレッサー）の強さごとの設定。
  // DynamicsCompressorNode は圧縮した分に応じて自動で持ち上げる（メイクアップゲイン）ので、大きい音は抑えられ、
  // 小さい音は大きくなる。1kHz の正弦波で測ると、入力 -50dB / -3dB に対して出力は
  // 標準 -38.2 / -10.5、強め -31.2 / -15.3 dB で、どちらも 0dBFS は超えなかった
  const LEVELERS = {
    standard: { threshold: -32, knee: 12, ratio: 4, attack: 0.005, release: 0.25 },
    strong: { threshold: -40, knee: 10, ratio: 8, attack: 0.003, release: 0.25 },
  };
  // 音割れ防止のリミッター。DynamicsCompressorNode をリミッターとして使う。
  // この Node は、0dB の入力に対するゲインの逆数の 0.6 乗を自動のメイクアップゲインとしてかけるので、
  // 直後の GainNode で打ち消し、しきい値より小さい音は変えないようにする（この設定では 1.71dB）。
  // 100Hz の正弦波で測ると、+12dB の入力でも -1.95dBFS、-30dB から +12dB に跳ね上がる音でも -1.35dBFS に収まった
  // （しきい値を -1dB にすると、跳ね上がる音で +0.4dBFS になった）
  const LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0, release: 0.1 };
  const LIMITER_MAKEUP_DB = -0.6 * (LIMITER.threshold - LIMITER.threshold / LIMITER.ratio);

  let ctx = null;
  let running = null;
  let rnnoise = null; // Promise<ArrayBuffer | null>: RNNoise の WASM。読み込めなかったら null
  let deepfilternet = null; // Promise<{ wasmModule, modelBytes } | null>: DeepFilterNet3 の WASM とモデル。読み込めなかったら null
  let settings = Settings.defaults();
  const graphs = new WeakMap(); // video -> Promise<graph | null>
  const live = new Set(); // 接続済みのグラフ。設定の変更を反映するために持つ
  let latest = null; // 最後に再生が始まった（つないだ）動画のグラフ。ポップアップにオートEQの状態を見せるために使う
  const skipped = new WeakSet(); // 接続しない理由をログに出した要素（音量を動かすたびに出さないように、1回だけ出す）

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

  // 拡張内のファイルをバイト列で取得する。
  // ワークレット内では fetch が使えないので、WASM などは content script で取得して processorOptions で渡す。
  // 拡張内のファイルは web_accessible_resources に登録してあるので、ページの CSP に関係なく読み込める。
  // YouTube では、content script からの fetch で "Unsafe attempt to load URL" というログが出るが、取得はできている。
  async function fetchBytes(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.arrayBuffer();
  }

  // RNNoise のワークレットと WASM を読み込む（1回だけ）
  function loadRnnoise(c) {
    const url = (file) => chrome.runtime.getURL(RNNOISE_DIR + file);
    rnnoise ??= Promise.all([
      c.audioWorklet.addModule(url('rnnoise/workletProcessor.js')),
      fetchBytes(url('rnnoise_simd.wasm')),
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
    const node = new AudioWorkletNode(c, RNNOISE_PROCESSOR, toPage({
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { wasmBinary, maxChannels: 2 },
    }));
    source.connect(node);
    // ワークレット内の RNNoise の状態を解放してから切り離す
    return { node, stop: () => { node.port.postMessage('destroy'); node.disconnect(); } };
  }

  // DeepFilterNet3 のワークレット・WASM・モデルを読み込む（1回だけ）。
  // WASM は、Chrome ではコンパイル済みの WebAssembly.Module を渡す
  // （14.6MB の WASM をワークレットの音声処理のスレッドでコンパイルさせると、音が途切れるおそれがあるため）。
  // Firefox では WebAssembly.Module をページ側にコピーできないので、バイト列のまま渡し、ワークレットでコンパイルさせる
  // （実測で、準備ができるまで約0.3秒）
  function loadDeepFilterNet(c) {
    const url = (file) => chrome.runtime.getURL(DEEPFILTERNET_DIR + file);
    deepfilternet ??= Promise.all([
      c.audioWorklet.addModule(url('assets/deepfilternet-worklet-processor.js')),
      fetchBytes(url('assets/deepfilternet/df_bg.wasm')).then((bytes) => (CLONE_INTO ? bytes : WebAssembly.compile(bytes))),
      fetchBytes(url('assets/deepfilternet/DeepFilterNet3_onnx.tar.gz')),
    ]).then(
      ([, wasmModule, modelBytes]) => ({ wasmModule, modelBytes }),
      (e) => {
        console.warn('[audio-fx] DeepFilterNet3 を読み込めませんでした', e);
        return null;
      },
    );
    return deepfilternet;
  }

  // DeepFilterNet3 は、入力をモノラルにまとめて処理し、モノラルで出す（EQ に入るところで左右に広がる）。
  // 準備ができるまでは入力をそのまま出す（bypassUntilReady）ので、準備ができてから出力に切り替える
  async function createDeepFilterNet(c, source) {
    const assets = await loadDeepFilterNet(c);
    if (!assets) return null;
    const node = new AudioWorkletNode(c, DEEPFILTERNET_PROCESSOR, toPage({
      channelCount: 1,
      channelCountMode: 'explicit',
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { ...assets, ...DEEPFILTERNET_OPTIONS },
    }));
    const stop = () => {
      node.port.postMessage(toPage({ type: 'dispose' }));
      node.disconnect();
    };
    source.connect(node);
    const failure = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('準備が時間内に終わりませんでした'), DEEPFILTERNET_READY_TIMEOUT_MS);
      const finish = (reason) => {
        clearTimeout(timer);
        resolve(reason);
      };
      node.port.onmessage = ({ data }) => {
        if (data?.type === 'ready') finish(null);
        else if (data?.type === 'error') finish(data.message);
        else if (data?.type === 'overload') console.warn('[audio-fx] DeepFilterNet3 の処理が間に合っていません', data.load);
      };
      node.onprocessorerror = () => finish('ワークレットでエラーが起きました');
    });
    if (failure) {
      source.disconnect(node);
      stop();
      console.warn('[audio-fx] DeepFilterNet3 を使えませんでした', failure);
      return null;
    }
    return { node, stop };
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
    // 準備中に止められた場合と、止める予約のタイマーの両方から呼ばれることがあるので、2回目は何もしない
    let stopped = false;
    engine.stop = () => {
      if (stopped) return;
      stopped = true;
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
  // ノイズキャンセルのオートの判定を、使っているノイズキャンセルのノード（node）に合わせて始める・止める。
  // 方式を切り替えたときは、新しいノードで判定し直す。判定が変わったら設定を反映し直す
  // 話し声の判定（SpeechJudge）を、ノイズキャンセルのオートかイコライザーのオートのときだけ動かす。
  // 判定には、ノイズキャンセルのノードの出口を使う（engineNode。準備中は null）。
  // ノイズキャンセルをオフにしているときは、判定のためだけに RNNoise を動かす（音には使わない。1コアの約 4%）。
  // 判定が変わったら設定を反映し直す（ノイズキャンセルのかけ外しと、オートEQ の目安の形）
  function applyJudge(g, engineNode) {
    const needed = settings.enabled && ((settings.denoise && settings.denoiseAuto) || settings.autoEq);
    const node = !needed ? null : settings.denoise ? engineNode : judgeEngineNode(g);
    if (g.judge && g.judge.node !== node) {
      g.judge.stop();
      g.judge = null;
    }
    // 判定だけのための RNNoise は、ノイズキャンセルをオフにしていて判定が要るときだけ残す
    if (!needed || settings.denoise) stopJudgeEngine(g);
    if (node && !g.judge) {
      g.judge = SpeechJudge.create(g.source.context, g.source, node, () => apply(g, true));
      g.judge.node = node;
    }
  }

  // 判定だけのための RNNoise のノード。作っている途中は null を返し、できたら設定を反映し直す
  function judgeEngineNode(g) {
    if (!g.judgeEngine) {
      const holder = { node: null, stop: null };
      g.judgeEngine = holder;
      createRnnoise(g.source.context, g.source).then((created) => {
        if (!created) return;
        const stop = () => {
          g.source.disconnect(created.node);
          created.stop();
        };
        // 作っているあいだに要らなくなっていたら、使わずに止める
        if (g.judgeEngine !== holder) return stop();
        holder.node = created.node;
        holder.stop = stop;
        apply(g, true);
      });
    }
    return g.judgeEngine.node;
  }

  function stopJudgeEngine(g) {
    const holder = g.judgeEngine;
    g.judgeEngine = null;
    holder?.stop?.();
  }

  // オートEQ の目安の形。話し声の判定に合わせて、話し声用・音楽用・判定前（neutral）を使い分ける
  function autoTarget(g) {
    const judged = g.judge?.state();
    return judged === 'speech' ? 'speech' : judged === 'other' ? 'music' : 'neutral';
  }

  function stopEngine(g, name) {
    const engine = g.engines[name];
    delete g.engines[name];
    const now = g.source.context.currentTime;
    engine.wet.gain.cancelScheduledValues(now);
    engine.wet.gain.setTargetAtTime(0, now, RAMP);
    setTimeout(() => {
      engine.wet.disconnect();
      engine.stop?.();
    }, STOP_DELAY_MS);
  }

  function build(c, element) {
    const source = c.createGain();
    element.connect(source);
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
    const limiter = c.createDynamicsCompressor();
    for (const [key, value] of Object.entries(LIMITER)) limiter[key].value = value;
    const limiterTrim = c.createGain();
    limiterTrim.gain.value = 10 ** (-LIMITER_MAKEUP_DB / 20);
    const wet = c.createGain();
    const dry = c.createGain();
    const output = c.createGain();
    const volume = c.createGain();
    source.connect(nrDry);
    nrDry.connect(eqIn);
    eqIn.connect(filters[0]);
    // connect() は接続先を返すので、reduce で直列につなげる
    const eqOut = filters.reduce((from, to) => from.connect(to));
    eqOut.connect(compressor).connect(compWet).connect(limiter);
    eqOut.connect(compDry).connect(limiter);
    limiter.connect(limiterTrim).connect(wet);
    wet.connect(output);
    source.connect(dry);
    dry.connect(output);
    output.connect(volume).connect(c.destination);
    // engines: 方式名 -> { node, wet, from }。ノードは準備ができるまで null。
    // auto: オートEQ の分析（オートEQ がオンのあいだだけ動かす）
    return {
      element, source, nrDry, eqIn, filters, compressor, compWet, compDry, limiter, wet, dry, output, volume, engines: {}, auto: null,
      judge: null, judgeEngine: null,
    };
  }

  // プレイヤーの音量を、source で打ち消し、volume でかけ直す。
  // プレイヤーの音量 v がかかった音に 1/v をかけて処理し、最後に v をかけるので、耳に届く大きさは変わらない。
  // プレイヤーの音量は瞬時に変わるので、こちらも瞬時に変える。2つをゆっくり逆向きに変えると、途中で積が 1 を超え、
  // 音量を 0.1 から 1 にした瞬間に約 +9dB 大きくなっていた
  function followVolume(g, video) {
    const v = Math.max(video.volume, MIN_VOLUME);
    const now = g.source.context.currentTime;
    for (const [param, value] of [[g.source.gain, 1 / v], [g.volume.gain, v]]) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(value, now);
    }
  }

  // EQ のゲインを決める。オートEQ のときは分析した結果を、それ以外は設定のゲイン（手動かプリセット）を使う
  function applyEq(g, ramp) {
    const c = g.source.context;
    if (settings.autoEq) {
      g.auto ??= AutoEq.create(c, g.eqIn, (gains) => {
        if (!settings.autoEq) return;
        gains.forEach((v, i) => g.filters[i].gain.setTargetAtTime(v, c.currentTime, AUTO_RAMP));
      });
      g.auto.setTarget(autoTarget(g));
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
    // 先に予約した変化が残っていると、あとから上書きされてしまうので取り消してから設定する。
    // 例：ノイズキャンセルの準備ができると、0.15 秒後に nrDry を 0 にする予約を入れる。その前にオフにされたとき、
    // 予約を取り消さないと nrDry が 0 のまま残り、次に設定を変えるまで無音になっていた
    const set = (param, v, from = now) => {
      if (ramp) {
        param.cancelScheduledValues(now);
        param.setTargetAtTime(v, Math.max(now, from), RAMP);
      } else {
        param.value = v;
      }
    };
    // 使うノイズキャンセル。準備中や作れなかったときは null で、nrDry 側（素通し）にする。
    // 全体を無効にしているあいだは音に使わないので、CPU を使わないように止める（有効に戻すと作り直す。0.2〜0.4 秒）
    const denoise = settings.enabled && settings.denoise;
    const active = denoise ? g.engines[settings.engine] : undefined;
    // ノイズキャンセルのオートのときは、話し声が主役と判定したあいだだけかける。ノードは動かしたまま判定を続ける
    applyJudge(g, active?.node ?? null);
    const paused = settings.denoiseAuto && g.judge?.state() !== 'speech';
    const using = active?.node && !paused ? active : null;
    applyEq(g, ramp);
    for (const engine of Object.values(g.engines)) set(engine.wet.gain, engine === using ? 1 : 0, using?.from);
    set(g.nrDry.gain, using ? 0 : 1, using?.from);
    const leveler = settings.leveler ? LEVELERS[settings.levelerStrength] : null;
    if (leveler) {
      for (const [key, value] of Object.entries(leveler)) set(g.compressor[key], value);
    }
    set(g.compWet.gain, leveler ? 1 : 0);
    set(g.compDry.gain, leveler ? 0 : 1);
    set(g.wet.gain, settings.enabled ? 1 : 0);
    set(g.dry.gain, settings.enabled ? 0 : 1);
    for (const name of Object.keys(g.engines)) {
      if (!(denoise && name === settings.engine)) stopEngine(g, name);
    }
    if (denoise) ensureEngine(g, settings.engine);
  }

  async function connect(video) {
    const c = await whenRunning();
    try {
      const g = build(c, c.createMediaElementSource(video));
      followVolume(g, video);
      video.addEventListener('volumechange', () => followVolume(g, video));
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
        if (!skipped.has(video)) console.info('[audio-fx] MSE で再生していないので接続しません', video.currentSrc);
        skipped.add(video);
        return Promise.resolve(null);
      }
      graphs.set(video, connect(video));
    }
    // すでにつないだ動画の再生が始まったときも、ポップアップに状態を見せる対象をその動画にする
    const pending = graphs.get(video);
    pending.then((g) => { if (g) latest = g; });
    return pending;
  }

  function update(next) {
    settings = next;
    for (const g of live) apply(g, true);
  }

  // ポップアップに見せる状態。オートEQ の分析が済んでいるかと、今の補正量
  function status() {
    const auto = latest?.auto;
    const judge = latest?.judge;
    return {
      connected: !!latest,
      autoEq: auto ? { ready: auto.ready(), gains: auto.gains(), target: auto.target() } : null,
      judge: judge ? { state: judge.state(), removal: judge.removal() } : null,
    };
  }

  return { attach, update, status };
})();
