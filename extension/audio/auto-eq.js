'use strict';

// オートEQ（試作）。EQ に入る前の音を分析し、帯域ごとの長い時間の平均レベルを目安の形に近づけるゲインを求める。
// EQ の後ろではなく前で測るので、自分の補正を測り直して補正が強まり続けることはない。
const AutoEq = (() => {
  // 目安の形（帯域ごとの相対レベル、dB）。中域を平らにし、高域に向かってなだらかに下げた仮の値で、聞いて調整する前提
  const TARGET = [-8, -3, 0, 0, 0, -1, -3, -6, -9, -15];
  const MID = [2, 3, 4, 5, 6, 7]; // 125Hz〜4kHz。この範囲の平均で目安の形の高さを合わせる
  const ANALYZE_MS = 250;
  const UPDATE_MS = 1000;
  const AVERAGE_SECONDS = 15; // 長い時間の平均の時定数
  const MIN_SECONDS = 5; // これだけ音がたまるまでは補正しない
  const SILENCE_DB = -60; // これより小さいときは平均に入れない（無音で形が崩れないように）
  const ABSENT_DB = 24; // 目安より 24dB 以上小さい帯域は、もともと音が入っていないとみなして持ち上げない
  // 強さ。amount は目安との差のうち補正する割合、limit は補正の上限（±dB）。
  // 割合と上限の両方を段階的に変える（割合を同じにすると、差が上限を超える帯域がない限り、強さを変えても結果が同じになる）
  const STRENGTHS = {
    standard: { amount: 0.75, limit: 9 },
    strong: { amount: 1, limit: 12 },
  };
  // 持ち上げる上限を、帯域ごとに limit の何倍にするか（下げる上限はどの帯域も limit）。
  // 声の配信で低い帯域や、圧縮で削られた高い帯域を持ち上げても、こもった響きや雑音が増えるだけなので、
  // 両端（31Hz・62Hz・16kHz）は下げるだけにし、125Hz・8kHz は半分にする
  const BOOST_SCALE = [0, 0, 0.5, 1, 1, 1, 1, 1, 0.5, 0];

  // 帯域ごとの分析範囲（中心から上下に半オクターブ）に入る FFT のビン
  function bandBins(sampleRate, fftSize) {
    const hz = sampleRate / fftSize;
    return Settings.BANDS.map((b) => [
      Math.max(1, Math.ceil(b.freq / Math.SQRT2 / hz)),
      Math.min(fftSize / 2 - 1, Math.floor(b.freq * Math.SQRT2 / hz)),
    ]);
  }

  function correction(levels, strength) {
    const { amount, limit } = STRENGTHS[strength];
    const offset = MID.reduce((s, i) => s + levels[i] - TARGET[i], 0) / MID.length;
    const raw = levels.map((level, i) => {
      const want = TARGET[i] + offset;
      const d = want - level;
      return level < want - ABSENT_DB ? Math.min(d, 0) : d;
    });
    // 隣の帯域と少しならして、補正の形がギザギザにならないようにする。
    // ならしすぎると補正の山が削られて効きが小さくなるので、隣の重みは小さめにする
    const smooth = raw.map((x, i) => (raw[i - 1] ?? x) * 0.2 + x * 0.6 + (raw[i + 1] ?? x) * 0.2);
    return smooth.map((x, i) => {
      const d = Math.min(limit * BOOST_SCALE[i], Math.max(-limit, x * amount));
      return Math.round(d * 10) / 10;
    });
  }

  // input の音を分析し始める。補正を計算し直すたびに onUpdate(gains) を呼ぶ
  function create(ctx, input, onUpdate) {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0;
    input.connect(analyser);
    const bins = bandBins(ctx.sampleRate, analyser.fftSize);
    const spectrum = new Float32Array(analyser.frequencyBinCount);
    const power = new Float64Array(bins.length);
    let seconds = 0; // 平均に入れた音の長さ
    let levels = null; // 帯域ごとの平均レベル（dB）
    let gains = Settings.BANDS.map(() => 0);
    let strength = 'standard';

    const analyze = setInterval(() => {
      analyser.getFloatFrequencyData(spectrum);
      const frame = bins.map(([lo, hi]) => {
        let p = 0;
        for (let j = lo; j <= hi; j++) p += 10 ** (spectrum[j] / 10);
        return p;
      });
      const total = frame.reduce((s, p) => s + p, 0);
      if (!(10 * Math.log10(total) > SILENCE_DB)) return;
      seconds += ANALYZE_MS / 1000;
      // 最初のうちは単純な平均、たまったら指数移動平均にする
      const a = Math.max(ANALYZE_MS / 1000 / AVERAGE_SECONDS, ANALYZE_MS / 1000 / seconds);
      frame.forEach((p, i) => { power[i] = power[i] * (1 - a) + p * a; });
    }, ANALYZE_MS);

    const update = setInterval(() => {
      if (seconds < MIN_SECONDS) return;
      levels = Array.from(power, (p) => 10 * Math.log10(p + 1e-30));
      gains = correction(levels, strength);
      onUpdate(gains);
    }, UPDATE_MS);

    return {
      ready: () => seconds >= MIN_SECONDS,
      gains: () => gains,
      // 強さを変える。分析が済んでいれば、すぐに補正し直す
      setStrength(next) {
        if (next === strength || !STRENGTHS[next]) return;
        strength = next;
        if (levels) {
          gains = correction(levels, strength);
          onUpdate(gains);
        }
      },
      // 目安の形の高さに合わせた、帯域ごとの平均レベル（検証と表示用）
      levels: () => levels,
      stop() {
        clearInterval(analyze);
        clearInterval(update);
        input.disconnect(analyser);
      },
    };
  }

  return { TARGET, STRENGTHS, create };
})();
