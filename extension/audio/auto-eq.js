'use strict';

// オートEQ。EQ に入る前の音を分析し、帯域ごとの長い時間の平均レベルを目安の形に近づけるゲインを求める。
// EQ の後ろではなく前で測るので、自分の補正を測り直して補正が強まり続けることはない。
const AutoEq = (() => {
  // 目安の形（帯域ごとの相対レベル、dB）。中域を平らにし、高域に向かってなだらかに下げた仮の値で、聞いて調整する前提
  const TARGET = [-8, -3, 0, 0, 0, -1, -3, -6, -9, -15];
  const MID = [2, 3, 4, 5, 6, 7]; // 125Hz〜4kHz。この範囲の平均で目安の形の高さを合わせる
  const ANALYZE_MS = 250;
  const UPDATE_MS = 1000;
  const AVERAGE_SECONDS = 15; // 長い時間の平均の時定数
  const MIN_SECONDS = 5; // これだけ音がたまるまでは補正しない
  // 無音や話の間を平均に入れない（形が崩れないように）。EQ の形は音の大きさに関係なく決められるので、
  // 決まった大きさではなく、その番組のふだんの大きさ（全体の平均）と比べて判定する。
  // 決まった大きさ（以前は -60dB）で判定すると、番組の音が小さいときにほとんど捨ててしまい、分析が終わらなかった
  const FLOOR_DB = -100; // これより小さいときは完全な無音とみなす
  const GATE_DB = 20; // ふだんの大きさよりこれだけ小さいときは、話の間などとみなす
  const ABSENT_DB = 24; // 目安より 24dB 以上小さい帯域は、もともと音が入っていないとみなして持ち上げない
  // 補正の上限（±dB）。目安との差はそのまま（100%）補正する。
  // 以前は強さを選べた（控えめ 50%・±6dB、標準 75%・±9dB）が、差が聞き分けにくく、強めで聞きやすくなったので強めに固定した
  const LIMIT = 12;
  // 持ち上げる上限を、帯域ごとに LIMIT の何倍にするか（下げる上限はどの帯域も LIMIT）。
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

  function correction(levels) {
    // 目安の形の高さを、125Hz〜4kHz の平均で合わせる。もともと音が入っていない帯域を平均に入れると、
    // 高さが下がって中域全体を下げてしまう（125Hz がほとんどない番組で、250Hz〜4kHz を約 7dB 下げていた）。
    // いったん全体で合わせてから、音が入っていない帯域を除いて合わせ直す
    const offsetOf = (bands) => bands.reduce((s, i) => s + levels[i] - TARGET[i], 0) / bands.length;
    let offset = offsetOf(MID);
    const present = MID.filter((i) => levels[i] >= TARGET[i] + offset - ABSENT_DB);
    if (present.length > 0 && present.length < MID.length) offset = offsetOf(present);
    const absent = levels.map((level, i) => level < TARGET[i] + offset - ABSENT_DB);
    const raw = levels.map((level, i) => {
      const d = TARGET[i] + offset - level;
      return absent[i] ? Math.min(d, 0) : d;
    });
    // 隣の帯域と少しならして、補正の形がギザギザにならないようにする。
    // ならしすぎると補正の山が削られて効きが小さくなるので、隣の重みは小さめにする
    const smooth = raw.map((x, i) => (raw[i - 1] ?? x) * 0.2 + x * 0.6 + (raw[i + 1] ?? x) * 0.2);
    return smooth.map((x, i) => {
      // 音が入っていない帯域は、ならしで隣から持ち上がった分も含めて、持ち上げない
      const boost = absent[i] ? 0 : LIMIT * BOOST_SCALE[i];
      const d = Math.min(boost, Math.max(-LIMIT, x));
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
    let usualDb = 0; // ふだんの大きさ（完全な無音以外の全体の、dB での平均）
    let frames = 0; // ふだんの大きさに入れた回数
    let levels = null; // 帯域ごとの平均レベル（dB）
    let gains = Settings.BANDS.map(() => 0);

    const analyze = setInterval(() => {
      analyser.getFloatFrequencyData(spectrum);
      const frame = bins.map(([lo, hi]) => {
        let p = 0;
        for (let j = lo; j <= hi; j++) p += 10 ** (spectrum[j] / 10);
        return p;
      });
      const total = frame.reduce((s, p) => s + p, 0);
      const db = 10 * Math.log10(total);
      if (!(db > FLOOR_DB)) return;
      // ふだんの大きさは、帯域の平均と同じく、最初のうちは単純な平均、たまったら指数移動平均にする。
      // 番組の音量が大きく下がっても、しばらくすると追いつく。
      // パワーではなく dB で平均する。パワーの平均は、ときどき入る大きな音に引っ張られて高くなり、
      // 小さい環境音がほとんどの番組（ニコ生の馬房の定点カメラ）で、その環境音をほとんど捨てて分析が終わらなかった
      frames += 1;
      usualDb += (db - usualDb) * Math.max(ANALYZE_MS / 1000 / AVERAGE_SECONDS, 1 / frames);
      if (db < usualDb - GATE_DB) return;
      seconds += ANALYZE_MS / 1000;
      // 最初のうちは単純な平均、たまったら指数移動平均にする
      const a = Math.max(ANALYZE_MS / 1000 / AVERAGE_SECONDS, ANALYZE_MS / 1000 / seconds);
      frame.forEach((p, i) => { power[i] = power[i] * (1 - a) + p * a; });
    }, ANALYZE_MS);

    const update = setInterval(() => {
      if (seconds < MIN_SECONDS) return;
      levels = Array.from(power, (p) => 10 * Math.log10(p + 1e-30));
      gains = correction(levels);
      onUpdate(gains);
    }, UPDATE_MS);

    return {
      ready: () => seconds >= MIN_SECONDS,
      gains: () => gains,
      // 目安の形の高さに合わせた、帯域ごとの平均レベル（検証と表示用）
      levels: () => levels,
      stop() {
        clearInterval(analyze);
        clearInterval(update);
        input.disconnect(analyser);
      },
    };
  }

  return { TARGET, LIMIT, create };
})();
