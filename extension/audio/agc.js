'use strict';

// 音量をそろえるの「自動音量調整」。数秒の平均の音の大きさを測り、目安の大きさに近づくように、音量をゆっくり上げ下げする。
// v0.27 まではコンプレッサーだけで、小さい音は一律の持ち上げ分（標準で約 +12dB）しか大きくならず、
// PC のラウドネス等化（Windows のサウンドの「拡張」）より効きが弱かった（2026-11-24、開発者の指摘）。
// - 無音や話の間（その番組のふだんの大きさよりずっと小さい音）は、平均に入れない。黙っているあいだに雑音を持ち上げないように
// - 1 回の測定で平均を動かす幅に上限を設ける。一瞬の大声で平均が上がり、そのあとの声が小さくなりすぎないように
//   （瞬間的な大声は、後ろのコンプレッサーとリミッターで抑える）
// - 上げ下げの幅にも上限を設ける
const Agc = (() => {
  const ANALYZE_MS = 100;
  const LEVEL_SECONDS = 3; // 音の大きさの平均の時定数（秒）
  // ふだんの大きさ（無音や話の間の判定に使う）の時定数（秒）。小さくなるほうへはゆっくり動かす。
  // 速いと、10 秒ほど黙っているあいだに雑音（-60dB）まで平均に入り、音量が約 7dB 上がって、話し始めの声が大きくなった（シミュレーション）
  const USUAL_SECONDS = 15;
  const USUAL_FALL_SECONDS = 60;
  const GATE_DB = 20; // ふだんの大きさよりこれだけ小さいときは、話の間などとみなす（オートEQ と同じ）
  const FLOOR_DB = -70; // これより小さいときは、無音とみなす
  const STEP_DB = 10; // 平均との差は、これより大きくても、この大きさとして平均に入れる
  const MIN_SECONDS = 1; // 音がこれだけたまるまでは、音量を変えない
  // 音量を変えるときの時定数（秒）。下げるときは速めにして、大きい音が続くときに早く抑える
  const UP_TAU = 1.5;
  const DOWN_TAU = 0.3;

  // 測った大きさ（dB）を ANALYZE_MS ごとに入れると、平均の大きさを返す（音がたまるまでは null）。
  // 音声のノードを使わない計算だけなので、検証のシミュレーションからも使う
  function tracker() {
    const dt = ANALYZE_MS / 1000;
    let frames = 0; // ふだんの大きさに入れた回数
    let usual = 0; // ふだんの大きさ（dB）
    let seconds = 0; // 平均に入れた音の長さ
    let level = 0; // 平均の大きさ（dB）
    return {
      push(db) {
        if (!(db > FLOOR_DB)) return;
        // どちらも、最初のうちは単純な平均、たまったら指数移動平均にする（オートEQ と同じ）
        frames += 1;
        usual += (db - usual) * Math.max(dt / (db < usual ? USUAL_FALL_SECONDS : USUAL_SECONDS), 1 / frames);
        if (db < usual - GATE_DB) return;
        // 最初の 1 回は、その大きさをそのまま平均にする
        const d = seconds === 0 ? db - level : Math.max(-STEP_DB, Math.min(STEP_DB, db - level));
        seconds += dt;
        level += d * Math.max(dt / LEVEL_SECONDS, dt / seconds);
      },
      level: () => (seconds >= MIN_SECONDS ? level : null),
    };
  }

  // 平均の大きさ level（dB）に対してかける音量（dB）
  function gainFor(level, { targetDb, maxBoostDb, maxCutDb }) {
    return Math.min(maxBoostDb, Math.max(-maxCutDb, targetDb - level));
  }

  // input の大きさを測り、gainParam（自動音量調整の GainNode の gain）を動かし始める。
  // getOptions() は { targetDb, maxBoostDb, maxCutDb } を返す（強さを変えたらすぐ反映するため、毎回聞く）
  function create(ctx, input, gainParam, getOptions) {
    // 耳に聞こえる大きさに近づけるため、ラウドネスの規格（ITU-R BS.1770）の K 特性に近い重みを付けてから測る。
    // 低い音は小さめに、2kHz より上は大きめに数える（低音の多い番組で、音量を下げすぎないように）
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 38;
    highpass.Q.value = 0.5;
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 1500;
    shelf.gain.value = 4;
    // 1 回に測る長さは約 0.34 秒（規格の 0.4 秒に近い）。約 0.085 秒（4096）では、言葉と言葉の間で大きさが大きくゆれ、
    // dB の平均が音の大きさ（RMS）より約 9dB 小さく出て、ふつうの大きさの配信（Twitch）でも約 +10dB 持ち上げていた
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 16384;
    input.connect(highpass).connect(shelf).connect(analyser);
    const td = new Float32Array(analyser.fftSize);
    const t = tracker();
    let gainDb = 0; // 今かけている音量（目標の値、dB）

    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(td);
      let sum = 0;
      for (const x of td) sum += x * x;
      t.push(10 * Math.log10(sum / td.length));
      const level = t.level();
      if (level === null) return;
      const next = gainFor(level, getOptions());
      if (Math.abs(next - gainDb) < 0.05) return;
      const now = ctx.currentTime;
      gainParam.cancelScheduledValues(now);
      gainParam.setTargetAtTime(10 ** (next / 20), now, next < gainDb ? DOWN_TAU : UP_TAU);
      gainDb = next;
    }, ANALYZE_MS);

    return {
      // 今かけている音量（dB）と、平均の大きさ（dB。音がたまるまでは null）。検証と表示用
      gainDb: () => gainDb,
      levelDb: () => t.level(),
      stop() {
        clearInterval(timer);
        input.disconnect(highpass);
        const now = ctx.currentTime;
        gainParam.cancelScheduledValues(now);
        gainParam.setTargetAtTime(1, now, DOWN_TAU);
      },
    };
  }

  return { tracker, gainFor, create };
})();
