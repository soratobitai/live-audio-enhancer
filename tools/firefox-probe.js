'use strict';

// Firefox の自動検証（tools/verify-firefox.js）で、拡張のコピーにだけ足すテスト用の content script。
// Chrome の検証は CDP で拡張の content script の実行環境に入れるが、Firefox ではできないので、
// ページから window.postMessage で頼まれた測定を、拡張と同じ実行環境で行って結果を返す。
// 結果は JSON 文字列で返す（Firefox では、content script のオブジェクトをそのまま渡すとページから読めないことがあるため）
document.documentElement.dataset.audioFxProbe = 'ready';

const probePick = () => [...document.querySelectorAll('video')]
  .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
const probeSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round1 = (x) => Math.round(x * 10) / 10;

const PROBE_COMMANDS = {
  async attach() {
    const v = probePick();
    // ここで AudioGraph.attach を呼ぶと、拡張の「再生が始まったら接続する」処理が壊れていても接続してしまうので、
    // その前に、拡張が自分で接続したかを記録する
    // （接続は AudioContext が動き出してから行うので、最長10秒待つ）
    let autoConnected = AudioGraph.status().connected;
    for (let i = 0; i < 20 && !autoConnected; i++) {
      await probeSleep(500);
      autoConnected = AudioGraph.status().connected;
    }
    const g = await AudioGraph.attach(v);
    return {
      autoConnected,
      attached: !!g, src: v.currentSrc.slice(0, 60), srcObject: v.srcObject ? String(v.srcObject) : null,
      ctxState: g?.source.context.state, sampleRate: g?.source.context.sampleRate,
    };
  },

  // settings を指定したら保存して wait ミリ秒待つ。そのあと入口と出口の音量・周波数ごとの差・パラメータを3秒間測る
  async measure({ settings, wait = 2000 }) {
    const v = probePick();
    const g = await AudioGraph.attach(v);
    if (!g) return { attached: false };
    if (settings) {
      await Settings.save({ ...Settings.defaults(), ...settings });
      await probeSleep(wait);
    }
    const ctx = g.source.context;
    const mk = () => { const a = ctx.createAnalyser(); a.fftSize = 8192; a.smoothingTimeConstant = 0; return a; };
    const pre = mk(), post = mk();
    g.source.connect(pre);
    g.output.connect(post);
    const probes = [62, 1000, 4000, 12000];
    const freqs = new Float32Array(probes), mag = new Float32Array(4), phase = new Float32Array(4);
    const expected = [0, 0, 0, 0];
    for (const f of g.filters) {
      f.getFrequencyResponse(freqs, mag, phase);
      mag.forEach((m, i) => { expected[i] += 20 * Math.log10(m); });
    }
    const hz = ctx.sampleRate / pre.fftSize;
    const a = new Float32Array(pre.frequencyBinCount), b = new Float32Array(post.frequencyBinCount);
    const ti = new Float32Array(pre.fftSize), to = new Float32Array(post.fftSize);
    const diff = probes.map(() => ({ d: 0, c: 0 }));
    let peakIn = 0, peakOut = 0, limiter = 0, interrupted = false, lastTime = v.currentTime;
    for (let i = 0; i < 30; i++) {
      await probeSleep(100);
      if (v.paused || v.currentTime < lastTime) interrupted = true;
      lastTime = v.currentTime;
      pre.getFloatFrequencyData(a);
      post.getFloatFrequencyData(b);
      pre.getFloatTimeDomainData(ti);
      post.getFloatTimeDomainData(to);
      for (let j = 0; j < ti.length; j++) { peakIn = Math.max(peakIn, Math.abs(ti[j])); peakOut = Math.max(peakOut, Math.abs(to[j])); }
      limiter = Math.min(limiter, g.limiter.reduction);
      // 最も強い成分より 50dB 以上弱いビンはノイズに埋もれていて差が当てにならないので、測定に使わない
      const mx = Math.max(...a);
      probes.forEach((p, k) => {
        for (let j = Math.ceil(p * 0.95 / hz); j <= Math.floor(p * 1.05 / hz); j++) {
          if (a[j] > mx - 50) { diff[k].d += b[j] - a[j]; diff[k].c++; }
        }
      });
    }
    g.source.disconnect(pre);
    g.output.disconnect(post);
    return {
      attached: true, ctxState: ctx.state, interrupted, peakIn, peakOut, limiter: round1(limiter),
      gains: g.filters.map((f) => round1(f.gain.value)),
      wet: round1(g.wet.gain.value), nrDry: round1(g.nrDry.gain.value),
      engines: Object.fromEntries(Object.entries(g.engines).map(([k, e]) => [k, { ready: !!e.node, wet: round1(e.wet.gain.value) }])),
      bands: probes.map((p, k) => ({ hz: p, expectedDb: round1(expected[k]), measuredDb: diff[k].c ? round1(diff[k].d / diff[k].c) : null })),
    };
  },

  // リミッターと同じ設定で、メイクアップゲインの量と、大きい入力に対する出力のピークを測る（OfflineAudioContext）
  async limiter() {
    const SR = 48000;
    const render = async (inDb, trimDb) => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: SR * 2, sampleRate: SR });
      const buf = ctx.createBuffer(1, SR * 2, SR);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = 10 ** (inDb / 20) * Math.sin(2 * Math.PI * 100 * i / SR);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const lim = ctx.createDynamicsCompressor();
      for (const [k, v] of Object.entries({ threshold: -3, knee: 0, ratio: 20, attack: 0, release: 0.1 })) lim[k].value = v;
      const trim = ctx.createGain();
      trim.gain.value = 10 ** (-trimDb / 20);
      src.connect(lim).connect(trim).connect(ctx.destination);
      src.start();
      const out = (await ctx.startRendering()).getChannelData(0);
      let p = 0;
      for (let i = SR / 2; i < out.length; i++) p = Math.max(p, Math.abs(out[i]));
      return Math.round(20 * Math.log10(p) * 100) / 100;
    };
    const makeupDb = (await render(-40, 0)) + 40;
    return { makeupDb, peakFor12dB: await render(12, makeupDb) };
  },
};

window.addEventListener('message', async (e) => {
  const req = e.data?.audioFxProbe;
  if (!req?.command) return;
  let result;
  try {
    result = await PROBE_COMMANDS[req.command](req.args ?? {});
  } catch (err) {
    result = { error: `${err.name}: ${err.message}` };
  }
  window.postMessage({ audioFxProbeResult: { id: req.id, json: JSON.stringify(result) } }, '*');
});
