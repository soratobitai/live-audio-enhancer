'use strict';

// 音声グラフの生成をここに集約する。
// createMediaElementSource() は同じ要素に1回しか呼べないので、接続済みの要素を WeakMap で管理する。
// ディレイ拡張と統合するときも、video 要素への接続は必ずこのモジュールを経由させる。
const AudioGraph = (() => {
  // 動作確認用の固定値（効果が聞き分けられる程度にかけている）
  const BANDS = [
    { type: 'lowshelf', freq: 100, gain: -6 },
    { type: 'peaking', freq: 1000, gain: 0, q: 1 },
    { type: 'peaking', freq: 3000, gain: 4, q: 1 },
    { type: 'highshelf', freq: 8000, gain: -3 },
  ];

  let ctx = null;
  let running = null;
  const graphs = new WeakMap(); // video -> Promise<graph | null>

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

  function buildChain(c, source) {
    let node = source;
    const filters = BANDS.map((b) => {
      const f = c.createBiquadFilter();
      f.type = b.type;
      f.frequency.value = b.freq;
      f.gain.value = b.gain;
      if (b.q) f.Q.value = b.q;
      node.connect(f);
      node = f;
      return f;
    });
    node.connect(c.destination);
    return filters;
  }

  async function connect(video) {
    const c = await whenRunning();
    try {
      const source = c.createMediaElementSource(video);
      const filters = buildChain(c, source);
      console.info('[audio-fx] 接続しました', video);
      return { source, filters };
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

  return { attach };
})();
