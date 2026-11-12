'use strict';

// 話し声の判定。番組の音が、話し声が主役か、音楽や歌・街の音など（話し声が主役でない）かを判定する。
// ノイズキャンセルのオート（話し声のときだけかける）と、イコライザーのオート（話し声用と音楽用で目安の形を変える）で使う。
// ノイズキャンセルは話し声だけを残すように作られているので、音楽や歌にかけると、楽器が消えて歌声が乱れる。
//
// 判定には、ノイズキャンセル自身の消し方を使う。大きい音の瞬間に、ノイズキャンセルがどれだけ消しているかを測ると、
// 話し声の配信では 0〜0.6dB（声はほぼそのまま残す）、歌や音楽の配信では 2.5〜58dB だった（2026-11-11、実際の配信で測定）。
// ノイズキャンセルのオートで外しているあいだも、ノイズキャンセルは動かしたまま測り続ける。
// ノイズキャンセルをオフにしているときは、判定のためだけに RNNoise を動かす（音には使わない）。
//
// 話していないあいだは、雑音だけが「大きい瞬間」になる。ノイズキャンセルは雑音をほとんど消すので、そのまま判定すると
// 音楽と取り違える（2026-11-12、強めで雑音の多い配信）。そこで、番組のふだんの大きさ（話しているときの声の大きさ）を覚えておき、
// それより十分小さい音しかないときは、判定を変えない。ふだんの大きさはゆっくり下げるので、声より小さい音楽が続くときや、
// 長く話さないとき（声より 20dB 小さい音なら約 20 秒）は、そのときの音で判定し直す。
const SpeechJudge = (() => {
  const ANALYZE_MS = 250;
  const WINDOW = 16; // 直近 4 秒で判定する
  const LOUD_DB = 10; // 窓の中で最も大きい瞬間から 10dB 以内を「大きい瞬間」とする
  const MIN_LOUD = 6; // 大きい瞬間がこれより少ないとき（ほぼ無音など）は判定を変えない
  const SILENCE_DBFS = -70; // これより小さい瞬間は使わない
  const MUSIC_DB = 3; // 大きい瞬間に消した量の中央値がこれ以上なら、話し声が主役でない（外す）
  const SPEECH_DB = 1.5; // これ以下なら話し声（かける）。あいだのときは今の判定のまま（切り替わりのばたつきを防ぐ）
  const REMOVED_ALL_DB = 60; // 出口が完全な無音のとき（すべて消した）は、この量を消したとみなす
  const QUIET_DB = 12; // 大きい瞬間の大きさが、ふだんの大きさよりこれ以上小さいときは、判定を変えない
  const USUAL_FALL_DB = 0.5; // ふだんの大きさは、大きい音にはすぐ合わせ、小さい音のときは 1 秒にこれだけ下げる

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
    let usual = null; // 番組のふだんの大きさ（dBFS）
    let quiet = false; // 大きい瞬間でも、ふだんより十分小さいか（そのあいだは判定を変えない）
    const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

    const timer = setInterval(() => {
      frames.push([rms(ain), rms(aout)]);
      if (frames.length > WINDOW) frames.shift();
      const heard = frames.filter(([level]) => level > SILENCE_DBFS);
      if (heard.length === 0) return;
      const top = Math.max(...heard.map(([level]) => level));
      const loud = heard.filter(([level]) => level >= top - LOUD_DB);
      if (loud.length < MIN_LOUD) return;
      removal = median(loud.map(([level, out]) => (Number.isFinite(out) ? level - out : REMOVED_ALL_DB)));
      const level = median(loud.map(([l]) => l));
      usual = usual === null ? level : Math.max(level, usual - USUAL_FALL_DB * (ANALYZE_MS / 1000));
      quiet = level < usual - QUIET_DB;
      if (quiet) return;
      const next = removal >= MUSIC_DB ? 'other' : removal <= SPEECH_DB ? 'speech' : state;
      if (next !== state) {
        state = next;
        onChange(state);
      }
    }, ANALYZE_MS);

    return {
      state: () => state,
      removal: () => removal,
      quiet: () => quiet,
      stop() {
        clearInterval(timer);
        // ノイズキャンセルのノードが先に切り離されていることもあるので、切り離しの失敗は無視する
        for (const [from, to] of [[input, ain], [output, aout]]) {
          try { from.disconnect(to); } catch { /* すでに切り離されている */ }
        }
      },
    };
  }

  return { create };
})();
