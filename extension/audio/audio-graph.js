'use strict';

// 音声グラフの生成をここに集約する。
// createMediaElementSource() は同じ要素に1回しか呼べないので、接続済みの要素を WeakMap で管理する。
// ディレイ拡張と統合するときも、video 要素への接続は必ずこのモジュールを経由させる。
//
// 接続後はグラフを切らずに、wet / dry のゲインでエフェクトの有無を切り替える。
// worklet はノイズキャンセルを入れる位置（今は素通し）。読み込めなかったときは省いて接続する。
//   source ─┬─ worklet ─ EQ（BiquadFilter × 帯域数）─ wet ─┬─ output ─ destination
//           └────────────────────────────────────── dry ─┘
const AudioGraph = (() => {
  // パラメータを変えるときの時定数（秒）。値を急に変えるとプツッというノイズが出る
  const RAMP = 0.02;

  let ctx = null;
  let running = null;
  let worklets = null; // Promise<boolean>: AudioWorklet のモジュールを読み込めたか
  let settings = Settings.defaults();
  const graphs = new WeakMap(); // video -> Promise<graph | null>
  const live = new Set(); // 接続済みのグラフ。設定の変更を反映するために持つ

  // AudioContext が running になるまで待つ。
  // 自動再生ポリシーで開始できないときは resume() が保留されるので、ユーザー操作のたびに再試行する。
  // running になる前に接続すると、その間は無音になるため、必ずこれを待ってから接続する。
  function whenRunning() {
    if (running) return running;
    ctx = new AudioContext();
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

  // AudioWorklet のモジュールを読み込む。
  // 拡張内のファイルを web_accessible_resources に登録しておけば、ページの CSP に関係なく読み込める。
  // Blob URL や data: URL は YouTube の CSP で止められることを確認したので使わない。
  function loadWorklets(c) {
    worklets ??= c.audioWorklet.addModule(chrome.runtime.getURL('worklets/passthrough.js')).then(
      () => true,
      (e) => {
        console.warn('[audio-fx] AudioWorklet を読み込めませんでした。ワークレットなしで接続します', e);
        return false;
      },
    );
    return worklets;
  }

  function build(c, source, useWorklet) {
    const worklet = useWorklet ? new AudioWorkletNode(c, 'passthrough') : null;
    const filters = Settings.BANDS.map((b) => {
      const f = c.createBiquadFilter();
      f.type = b.type;
      f.frequency.value = b.freq;
      if (b.q) f.Q.value = b.q;
      return f;
    });
    const wet = c.createGain();
    const dry = c.createGain();
    const output = c.createGain();
    // connect() は接続先を返すので、reduce で直列につなげる
    [source, ...(worklet ? [worklet] : []), ...filters, wet].reduce((from, to) => from.connect(to));
    source.connect(dry);
    wet.connect(output);
    dry.connect(output);
    output.connect(c.destination);
    return { source, worklet, filters, wet, dry, output };
  }

  // 設定をグラフに反映する。接続直後は ramp を false にして即座に反映する
  function apply(g, ramp) {
    const t = g.source.context.currentTime;
    const set = (param, v) => {
      if (ramp) param.setTargetAtTime(v, t, RAMP);
      else param.value = v;
    };
    g.filters.forEach((f, i) => set(f.gain, settings.gains[i]));
    set(g.wet.gain, settings.enabled ? 1 : 0);
    set(g.dry.gain, settings.enabled ? 0 : 1);
  }

  async function connect(video) {
    const c = await whenRunning();
    const useWorklet = await loadWorklets(c);
    try {
      const source = c.createMediaElementSource(video);
      const g = build(c, source, useWorklet);
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
