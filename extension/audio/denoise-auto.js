'use strict';

// ノイズキャンセルのオート。話し声が主役のときだけノイズキャンセルをかけ、音楽や歌、街の音などのときは外す。
// ノイズキャンセルは話し声だけを残すように作られているので、音楽や歌にかけると、楽器が消えて歌声が乱れる。
//
// 判定には、ノイズキャンセル自身の消し方を使う。大きい音の瞬間に、ノイズキャンセルがどれだけ消しているかを測ると、
// 話し声の配信では 0〜0.6dB（声はほぼそのまま残す）、歌や音楽の配信では 2.5〜58dB だった（2026-11-11、実際の配信で測定）。
// 外しているあいだもノイズキャンセルは動かしたまま測り続け、話し声に戻ったらかけ直す。
const DenoiseAuto = (() => {
  const ANALYZE_MS = 250;
  const WINDOW = 16; // 直近 4 秒で判定する
  const LOUD_DB = 10; // 窓の中で最も大きい瞬間から 10dB 以内を「大きい瞬間」とする
  const MIN_LOUD = 6; // 大きい瞬間がこれより少ないとき（ほぼ無音など）は判定を変えない
  const SILENCE_DBFS = -70; // これより小さい瞬間は使わない
  const MUSIC_DB = 3; // 大きい瞬間に消した量の中央値がこれ以上なら、話し声が主役でない（外す）
  const SPEECH_DB = 1.5; // これ以下なら話し声（かける）。あいだのときは今の判定のまま（切り替わりのばたつきを防ぐ）
  const REMOVED_ALL_DB = 60; // 出口が完全な無音のとき（すべて消した）は、この量を消したとみなす

  // input（ノイズキャンセルの入口）と output（ノイズキャンセルのノードの出口）の大きさを比べ始める。
  // 判定が変わるたびに onChange(state) を呼ぶ。state は 'undecided'（まだ分からない）/ 'speech' / 'other'
  function create(ctx, input, output, onChange) {
    const mk = () => {
      const a = ctx.createAnalyser();
      a.fftSize = 16384;
      return a;
    };
    const ain = mk(), aout = mk();
    input.connect(ain);
    output.connect(aout);
    const td = new Float32Array(ain.fftSize);
    const rms = (a) => {
      a.getFloatTimeDomainData(td);
      let sum = 0;
      for (const x of td) sum += x * x;
      return 10 * Math.log10(sum / td.length);
    };
    const frames = [];
    let state = 'undecided';
    let removal = null; // 直近の判定に使った、大きい瞬間に消した量の中央値（dB）

    const timer = setInterval(() => {
      frames.push([rms(ain), rms(aout)]);
      if (frames.length > WINDOW) frames.shift();
      const heard = frames.filter(([level]) => level > SILENCE_DBFS);
      if (heard.length === 0) return;
      const top = Math.max(...heard.map(([level]) => level));
      const removed = heard.filter(([level]) => level >= top - LOUD_DB)
        .map(([level, out]) => (Number.isFinite(out) ? level - out : REMOVED_ALL_DB))
        .sort((a, b) => a - b);
      if (removed.length < MIN_LOUD) return;
      removal = removed[Math.floor(removed.length / 2)];
      const next = removal >= MUSIC_DB ? 'other' : removal <= SPEECH_DB ? 'speech' : state;
      if (next !== state) {
        state = next;
        onChange(state);
      }
    }, ANALYZE_MS);

    return {
      state: () => state,
      removal: () => removal,
      stop() {
        clearInterval(timer);
        input.disconnect(ain);
        output.disconnect(aout);
      },
    };
  }

  return { create };
})();
