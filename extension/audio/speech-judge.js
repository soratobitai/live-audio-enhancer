'use strict';

// ノイズキャンセルのオートの判定。ふだんはかけ（'speech'）、音楽や歌が続いているとはっきり分かったときだけ外す（'other'）。
// ノイズキャンセルは話し声だけを残すように作られているので、音楽や歌にかけると、楽器が消えて歌声が乱れる。
//
// 判定には、ノイズキャンセル自身の消し方を使う。大きい音の瞬間に、ノイズキャンセルがどれだけ消しているかを測ると、
// 話し声の配信では 0〜0.6dB（声はほぼそのまま残す）、歌や音楽の配信では 2.5〜58dB だった（2026-11-11、実際の配信で測定）。
// 外しているあいだも、ノイズキャンセルは動かしたまま測り続ける。
//
// ただし、ノイズキャンセルは雑音も消すので、この方法では雑音と音楽を見分けられない。話していないあいだの雑音を音楽と取り違えて
// 外し、雑音が聞こえていた（2026-11-12、強めで雑音の多い配信）。そこで、迷ったらかける側に倒す（v0.23.0 から）。
//   - 音楽らしい消し方が 15 秒続いたときだけ外す。話の合間の雑音は、たいていそれより短い
//   - 話し声らしい消し方になったら、すぐかけ直す
//   - 番組のふだんの大きさ（話しているときの声の大きさ）より十分小さい音しかないときは、数えない（v0.22.1 から）
// 以前は、話し声と分かるまでは外し、音楽らしい消し方になると約 4 秒で外していた。
const SpeechJudge = (() => {
  const ANALYZE_MS = 250;
  const WINDOW = 16; // 直近 4 秒の消し方を見る
  const LOUD_DB = 10; // 窓の中で最も大きい瞬間から 10dB 以内を「大きい瞬間」とする
  const MIN_LOUD = 6; // 大きい瞬間がこれより少ないとき（ほぼ無音など）は数えない
  const SILENCE_DBFS = -70; // これより小さい瞬間は使わない
  const MUSIC_DB = 3; // 大きい瞬間に消した量の中央値がこれ以上なら、音楽らしい
  const SPEECH_DB = 1.5; // これ以下なら話し声らしい（すぐかけ直す）。あいだのときは、続いている長さを少しずつ減らす
  const MUSIC_HOLD_MS = 15000; // 音楽らしい消し方がこれだけ続いたら外す
  const REMOVED_ALL_DB = 60; // 出口が完全な無音のとき（すべて消した）は、この量を消したとみなす
  const QUIET_DB = 12; // 大きい瞬間の大きさが、ふだんの大きさよりこれ以上小さいときは、数えない
  const USUAL_FALL_DB = 0.5; // ふだんの大きさは、大きい音にはすぐ合わせ、小さい音のときは 1 秒にこれだけ下げる

  // input（ノイズキャンセルの入口）と output（ノイズキャンセルのノードの出口）の大きさを比べ始める。
  // 判定が変わるたびに onChange(state) を呼ぶ。state は 'speech'（かける。最初はこれ）/ 'other'（音楽や歌が続いているので外す）
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
    let state = 'speech';
    let removal = null; // 直近の、大きい瞬間に消した量の中央値（dB）
    let usual = null; // 番組のふだんの大きさ（dBFS）
    let quiet = false; // 大きい瞬間でも、ふだんより十分小さいか（そのあいだは数えない）
    let musicMs = 0; // 音楽らしい消し方が続いている長さ
    const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const change = (next) => {
      if (next === state) return;
      state = next;
      onChange(state);
    };

    const timer = setInterval(() => {
      frames.push([rms(ain), rms(aout)]);
      if (frames.length > WINDOW) frames.shift();
      const heard = frames.filter(([level]) => level > SILENCE_DBFS);
      if (heard.length === 0) return;
      const top = Math.max(...heard.map(([level]) => level));
      const loud = heard.filter(([level]) => level >= top - LOUD_DB);
      if (loud.length < MIN_LOUD) return;
      const removed = loud.map(([level, out]) => (Number.isFinite(out) ? level - out : REMOVED_ALL_DB)).sort((a, b) => a - b);
      removal = removed[Math.floor(removed.length / 2)];
      // 話し声らしいかは、中央値ではなく下から 4 分の 1 の値で見る。大きい雑音の中で短く話したとき（4 秒のうち 2 秒など）、
      // 中央値は雑音の側になり、話していても話し声と分からなかった。4 秒のうち 1 秒ほど声があれば、かけ直す
      const speechLike = removed[Math.floor(removed.length / 4)] <= SPEECH_DB;
      const level = median(loud.map(([l]) => l));
      usual = usual === null ? level : Math.max(level, usual - USUAL_FALL_DB * (ANALYZE_MS / 1000));
      quiet = level < usual - QUIET_DB;
      if (quiet) return;
      if (speechLike) {
        musicMs = 0;
        change('speech');
      } else if (removal >= MUSIC_DB) {
        musicMs += ANALYZE_MS;
        if (musicMs >= MUSIC_HOLD_MS) change('other');
      } else {
        // あいだのとき（BGM のある雑談など）は減らす。話の合間の雑音が、合間をまたいで積み上がらないように。
        // 音楽の途中で一時的に下がっても（lo-fi で 2dB 前後）、すぐには 0 に戻さない
        musicMs = Math.max(0, musicMs - ANALYZE_MS);
      }
    }, ANALYZE_MS);

    return {
      state: () => state,
      removal: () => removal,
      quiet: () => quiet,
      // 音楽らしい消し方が続いている長さ（秒。検証と表示用）
      musicSeconds: () => musicMs / 1000,
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
