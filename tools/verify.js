// 対応サイトで拡張の動作を確認する。
// インストール済みの Chrome を一時プロファイル・ヘッドレス・ミュートで起動し、extension/ を読み込んで配信を再生する。
// ポップアップを操作して設定を変え、拡張が video に接続できたか、音が出ているか、
// EQ・バイパス・ノイズキャンセルが設定どおりに効いているかを数値で判定する。
//
// 使い方:
//   npm run verify:<nico / kick / youtube / twitch / tver / abema>   サイトのページから配信を選んで試す
//   npm run verify:kick -- https://kick.com/xxxx           URL を指定して試す
//   Chrome の場所が違うときは環境変数 CHROME_PATH で指定する
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { SITES, PICK_VIDEO, sleep, waitPlaying, findBroadcasts, siteOf } from './sites.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = path.join(ROOT, 'extension');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MAX_TRIES = 5;
const TOLERANCE_DB = 1.5;

// EQ のテスト用のゲイン（帯域は 31 / 62 / 125 / 250 / 500 / 1k / 2k / 4k / 8k / 16k Hz の順）
const GAINS_A = [0, -6, 0, 0, 0, 0, 0, 4, 0, -3];
const GAINS_B = [0, 3, 0, 0, 0, -4, 0, 0, 2, 0];
const FLAT = GAINS_A.map(() => 0);

// ポップアップで順に設定し、それぞれ測定する。
// eqPreset を指定したものはプリセットの選択で設定し、それ以外はスライダーで gains を設定する。keepEq なら手動の EQ は触らない。
// オートEQ は分析がたまるまで時間がかかり、YouTube は再生開始から約40秒で止まることがあるので、最初に測る
const BASE = {
  enabled: true, denoise: false, engine: 'rnnoise', leveler: false, levelerStrength: 'standard', autoEq: false, autoStrength: 'standard',
};
// オートEQ の強さごとの補正の上限（±dB、extension/audio/auto-eq.js の STRENGTHS と同じ値）
const AUTO_LIMITS = { standard: 9, strong: 12 };
// 音量をそろえるの強さごとのしきい値（dB、extension/audio/audio-graph.js の LEVELERS と同じ値）
const LEVELER_THRESHOLDS = { standard: -32, strong: -40 };
const SCENARIOS = [
  // 手動の EQ をニュースにしてからオートEQ をオンにし、オフに戻したときにニュースに戻るかを確かめる
  { ...BASE, name: 'オートEQ（標準）', autoEq: true, eqPreset: 'news', wait: 20000 },
  // 強さを変えると、分析済みの結果からすぐに補正し直す。ゲインが追いつくまで少し待つ
  { ...BASE, name: 'オートEQ（強め）', autoEq: true, autoStrength: 'strong', eqPreset: 'news', keepEq: true, wait: 4000 },
  { ...BASE, name: 'オートEQ をオフに戻す（手動のニュースに戻る）', eqPreset: 'news', keepEq: true },
  { ...BASE, name: 'EQ 有効', gains: GAINS_A },
  { ...BASE, name: 'EQ 無効（バイパス）', enabled: false, gains: GAINS_A },
  { ...BASE, name: 'EQ 有効に戻す（ゲイン変更）', gains: GAINS_B },
  { ...BASE, name: 'プリセット（ニュース）', eqPreset: 'news' },
  // 低音を大きく持ち上げても、リミッターで 0dBFS を超えないこと
  { ...BASE, name: 'プリセット（低音強調）', eqPreset: 'bass' },
  { ...BASE, name: '音量をそろえる（標準）', leveler: true, gains: FLAT },
  { ...BASE, name: '音量をそろえる（強め）', leveler: true, levelerStrength: 'strong', gains: FLAT },
  { ...BASE, name: 'ノイズキャンセル有効（RNNoise）', denoise: true, gains: FLAT },
  { ...BASE, name: 'ノイズキャンセル有効（DeepFilterNet3）', denoise: true, engine: 'deepfilternet', gains: FLAT },
  { ...BASE, name: 'ノイズキャンセルを RNNoise に戻す（作り直し）', denoise: true, gains: FLAT },
  { ...BASE, name: 'すべて無効に戻す（EQ だけ有効）', engine: 'deepfilternet', gains: GAINS_A },
];

// 拡張の isolated world に測定用の関数を用意する。
// 接続済みのグラフ（attach はキャッシュ済みの Promise を返す）の入口と出口に AnalyserNode を付け、
// 呼ぶたびに、音量、周波数ごとの「出口 − 入口」の dB 差とその期待値、パラメータの現在値を返す。
const INSTALL_PROBE = `(async () => {
  const v = ${PICK_VIDEO};
  const g = await AudioGraph.attach(v);
  if (!g) return false;
  const ctx = g.source.context;
  const mk = () => { const a = ctx.createAnalyser(); a.fftSize = 8192; a.smoothingTimeConstant = 0; return a; };
  const pre = mk(), post = mk();
  g.source.connect(pre);
  g.output.connect(post);

  const probes = [62, 1000, 4000, 12000];
  const freqs = new Float32Array(probes);
  const hz = ctx.sampleRate / pre.fftSize;
  const FRAMES = 40;

  globalThis.__audioFxProbe = async () => {
    // 期待値: wet 経路なら全フィルタの振幅特性の積、dry 経路なら素通し（0dB）。
    // ノイズキャンセルやコンプレッサーが効いているときは、入力しだいで変わるので期待値なし（null）
    const mag = new Float32Array(probes.length), phase = new Float32Array(probes.length);
    const wetDb = probes.map(() => 0);
    for (const f of g.filters) {
      f.getFrequencyResponse(freqs, mag, phase);
      mag.forEach((m, i) => { wetDb[i] += 20 * Math.log10(m); });
    }
    const denoising = Object.values(g.engines).some((e) => e.wet.gain.value > 0.5);
    const compressing = g.compWet.gain.value > 0.5;
    // オートEQ のあいだは、測っている途中でもゲインが少しずつ変わるので、周波数特性では判定しない
    let expected = g.wet.gain.value < 0.5 ? probes.map(() => 0)
      : denoising || compressing || g.auto ? probes.map(() => null)
      : wetDb;

    const a = new Float32Array(pre.frequencyBinCount), b = new Float32Array(post.frequencyBinCount);
    const tdIn = new Float32Array(pre.fftSize), tdOut = new Float32Array(post.fftSize);
    const diff = probes.map(() => ({ d: 0, lv: 0, c: 0 }));
    let peak = 0, sqIn = 0, sqOut = 0, n = 0, top = 0, reduction = 0;
    // 測っている途中で動画が止まったり、最初に戻ったり（広告や読み込み直し）したら、結果を使わない
    let interrupted = false, lastTime = v.currentTime, limiterReduction = 0;
    for (let i = 0; i < FRAMES; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (v.paused || v.currentTime < lastTime) interrupted = true;
      lastTime = v.currentTime;
      reduction = Math.min(reduction, g.compressor.reduction);
      limiterReduction = Math.min(limiterReduction, g.limiter.reduction);
      pre.getFloatFrequencyData(a);
      post.getFloatFrequencyData(b);
      pre.getFloatTimeDomainData(tdIn);
      post.getFloatTimeDomainData(tdOut);
      for (let j = 0; j < tdOut.length; j++) {
        peak = Math.max(peak, Math.abs(tdOut[j]));
        sqIn += tdIn[j] * tdIn[j];
        sqOut += tdOut[j] * tdOut[j];
        n++;
      }
      // 最も強い成分より 50dB 以上弱いビンはノイズに埋もれていて差が当てにならないので、測定に使わない
      const mx = Math.max(...a);
      top += mx;
      probes.forEach((p, k) => {
        for (let j = Math.ceil(p * 0.95 / hz); j <= Math.floor(p * 1.05 / hz); j++) {
          if (a[j] > mx - 50) { diff[k].d += b[j] - a[j]; diff[k].lv += a[j]; diff[k].c++; }
        }
      });
    }
    const avg = (k, key) => (diff[k].c ? diff[k][key] / diff[k].c : null);
    // リミッターが効いた区間は、EQ の特性どおりにならないので周波数特性では判定しない
    if (limiterReduction < -1) expected = probes.map(() => null);
    return {
      ctxState: ctx.state, sampleRate: ctx.sampleRate,
      video: { paused: v.paused, time: v.currentTime, interrupted },
      peak, inRmsDb: 10 * Math.log10(sqIn / n), outRmsDb: 10 * Math.log10(sqOut / n), topDb: top / FRAMES,
      params: {
        gains: g.filters.map((f) => f.gain.value),
        wet: g.wet.gain.value, dry: g.dry.gain.value, nrDry: g.nrDry.gain.value,
        engines: Object.fromEntries(Object.entries(g.engines).map(([k, e]) => [k, { ready: !!e.node, wet: e.wet.gain.value }])),
        comp: {
          wet: g.compWet.gain.value, dry: g.compDry.gain.value,
          threshold: g.compressor.threshold.value, ratio: g.compressor.ratio.value,
          maxReduction: reduction, // 測定中に最も強く圧縮したときの量（dB、0 以下）
        },
        limiter: { maxReduction: limiterReduction },
        // オートEQ の分析結果。levels は EQ に入る前の帯域ごとの平均レベル、target は目安の形
        auto: g.auto ? { ready: g.auto.ready(), gains: g.auto.gains(), levels: g.auto.levels(), target: AutoEq.TARGET } : null,
      },
      bands: probes.map((p, k) => ({ hz: p, expectedDb: expected[k], measuredDb: avg(k, 'd'), inputDb: avg(k, 'lv') })),
    };
  };
  return true;
})()`;

// ポップアップのスライダー・選択肢・スイッチを、ユーザーが操作したときと同じイベントで動かす。
// スライダーは画面上では高音が上に並ぶので、帯域の番号（data-band）で選ぶ
async function setPopup(popup, { enabled, denoise, engine, leveler, levelerStrength, autoEq, autoStrength, gains, eqPreset, keepEq }) {
  await popup.evaluate((enabled, denoise, engine, leveler, levelerStrength, autoEq, autoStrength, gains, eqPreset, keepEq) => {
    // 全体が無効のあいだは「有効」のスイッチ以外を操作できないので、先に有効にし、無効にするのは最後にする
    const enabledSwitch = document.getElementById('enabled');
    if (!enabledSwitch.checked) enabledSwitch.click();
    // オートEQ のあいだは手動の EQ を操作できないので、手動の EQ を変えるときは先にオートEQ をオフにする
    const autoSwitch = document.getElementById('autoEq');
    if (!keepEq) {
      if (autoSwitch.checked) autoSwitch.click();
      if (eqPreset) {
        const select = document.getElementById('eqPreset');
        select.value = eqPreset;
        select.dispatchEvent(new Event('change'));
      } else {
        gains.forEach((gain, i) => {
          const input = document.querySelector(`.band input[data-band="${i}"]`);
          input.value = gain;
          input.dispatchEvent(new Event('input'));
        });
      }
    }
    if (autoSwitch.checked !== autoEq) autoSwitch.click();
    for (const [name, value] of [['engine', engine], ['levelerStrength', levelerStrength], ['autoStrength', autoStrength]]) {
      const radio = document.querySelector(`input[name="${name}"][value="${value}"]`);
      if (!radio.checked) radio.click();
    }
    for (const [id, on] of [['denoise', denoise], ['leveler', leveler]]) {
      const sw = document.getElementById(id);
      if (sw.checked !== on) sw.click();
    }
    if (!enabled) enabledSwitch.click();
  }, enabled, denoise, engine, leveler, levelerStrength, autoEq, autoStrength, gains ?? null, eqPreset ?? null, !!keepEq);
}

async function check(browser, extId, url) {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => { if (m.text().includes('[audio-fx]')) logs.push(m.text()); });

  // 拡張の content script が動く isolated world を、フレームごとに記録する
  const cdp = await page.createCDPSession();
  const contexts = new Map();
  cdp.on('Runtime.executionContextCreated', ({ context }) => {
    if (context.origin === `chrome-extension://${extId}`) contexts.set(context.auxData.frameId, context.id);
  });
  cdp.on('Runtime.executionContextsCleared', () => contexts.clear());
  await cdp.send('Runtime.enable');
  const evaluate = async (contextId, expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      contextId, expression, awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };

  let popup;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(12000);
    const title = (await page.title()).split(' - ')[0];

    // プレイヤー中央をクリックしてユーザー操作の扱いにしてから、ユーザーがするのと同じようにミュート解除と再生をする。
    // 自動再生が止められるサイト（ニコ生など）も、ミュートで自動再生するサイト（Kick など）もこれで再生できる
    const center = await page.evaluate(`(() => {
      const v = ${PICK_VIDEO};
      if (!v) return null;
      const r = v.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!center) return { url, title, skip: 'video 要素がない' };
    await page.mouse.click(center.x, center.y);
    await sleep(1000);
    // 再生の前に出るダイアログを閉じる（TVer のアンケート）
    const dismiss = siteOf(url)?.dismiss;
    if (dismiss) {
      await sleep(3000);
      await page.evaluate(dismiss);
      await sleep(1000);
    }
    await page.evaluate(`(() => {
      const v = ${PICK_VIDEO};
      v.muted = false;
      if (v.volume === 0) v.volume = 0.5;
      if (v.paused) v.play().catch(() => {});
    })()`);
    await sleep(5000);
    await waitPlaying(page, 10000);

    const video = await page.evaluate(`(() => {
      const v = ${PICK_VIDEO};
      return { src: v.currentSrc || (v.srcObject ? Object.prototype.toString.call(v.srcObject) : ''), paused: v.paused };
    })()`);
    if (video.paused) return { url, title, skip: '再生されない（放送前など）' };

    const { frameTree } = await cdp.send('Page.getFrameTree');
    const contextId = contexts.get(frameTree.frame.id);
    if (contextId === undefined) return { url, title, logs, fail: 'content script が注入されていない' };
    if (!(await evaluate(contextId, INSTALL_PROBE))) return { url, title, logs, video, fail: '接続されていない' };

    popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    await popup.waitForSelector('.band input');
    // プリセットのゲインは拡張の設定から取る（期待値に使う）
    const presets = await popup.evaluate(() => Object.fromEntries(Settings.PRESETS.map((p) => [p.id, p.gains])));

    const runs = [];
    for (const scenario of SCENARIOS) {
      const s = presets[scenario.eqPreset] ? { ...scenario, gains: presets[scenario.eqPreset] } : scenario;
      await setPopup(popup, s);
      // 全体を無効にしたとき、「有効」のスイッチ以外を操作できなくなっているか
      const locked = await popup.evaluate(() => !document.querySelector(':is(.denoise, .leveler, .eq) :is(input, select):enabled, #reset:enabled'));
      // 背面のタブはタイマーが間引かれるので、測定するページを前面に戻す。
      // ノイズキャンセルを初めて有効にしたときは、WASM・モデルの読み込みと切り替えの待ちがあるので長めに待つ。
      // オートEQ は分析がたまって補正が落ち着くまで待つ
      await page.bringToFront();
      await sleep(s.wait ?? 2000);
      runs.push({ scenario: s, locked, m: await evaluate(contextId, '__audioFxProbe()') });
      await popup.bringToFront();
    }
    return { url, title, logs, video, runs };
  } catch (e) {
    return { url, fail: e.message };
  } finally {
    await popup?.close();
    await page.close();
  }
}

function judgeRun({ scenario, m, locked }) {
  if (locked !== !scenario.enabled) return { ok: false, reason: scenario.enabled ? 'ポップアップの欄を操作できない' : '全体を無効にしても、ほかの欄を操作できる' };
  if (m.ctxState !== 'running') return { ok: false, reason: `AudioContext が ${m.ctxState}` };
  // 入口から無音なら、拡張の処理とは関係なく判定できない（YouTube の広告や読み込み直しで動画が止まることがある）
  if (m.video.paused || m.inRmsDb === null) return { ok: false, skip: true, reason: '入口が無音で判定できない（動画が止まっている、広告など）' };
  if (m.video.interrupted) return { ok: false, skip: true, reason: '測っている途中で動画が止まった、または最初に戻った（広告など）' };
  if (m.peak === 0) return { ok: false, reason: '完全な無音（CORS や WASM の読み込み失敗の可能性）' };
  if (m.peak > 1) return { ok: false, reason: `出力が 0dBFS を超えた（ピーク ${m.peak.toFixed(3)}、音割れ）` };
  const near = (x, y, eps) => Math.abs(x - y) <= eps;
  const p = m.params;
  if (scenario.autoEq) {
    if (!p.auto?.ready) return { ok: false, reason: 'オートEQ の分析が終わっていない' };
    const limit = AUTO_LIMITS[scenario.autoStrength];
    if (p.auto.gains.some((g) => Math.abs(g) > limit + 0.01)) return { ok: false, reason: `オートEQ の補正量が ±${limit}dB を超えている` };
    // 補正量は毎秒計算し直され、フィルタのゲインはそれを時定数1秒で追いかける。
    // 内容がよく変わる番組では補正量が1秒に0.5dB以上動くこともあるので、1.5dB までの差は許す
    if (!p.auto.gains.every((g, i) => near(p.gains[i], g, 1.5))) return { ok: false, reason: 'フィルタのゲインがオートEQ の補正量と違う' };
  } else {
    if (p.auto) return { ok: false, reason: 'オートEQ の分析が止まっていない' };
    if (!scenario.gains.every((g, i) => near(p.gains[i], g, 0.05))) return { ok: false, reason: 'フィルタのゲインが設定と違う' };
  }
  if (!near(p.wet, scenario.enabled ? 1 : 0, 0.01) || !near(p.dry, scenario.enabled ? 0 : 1, 0.01)) {
    return { ok: false, reason: 'wet / dry のゲインが設定と違う' };
  }
  if (scenario.denoise && !p.engines[scenario.engine]?.ready) return { ok: false, reason: `${scenario.engine} のノードがない` };
  const leftover = Object.keys(p.engines).filter((k) => !(scenario.denoise && k === scenario.engine));
  if (leftover.length) return { ok: false, reason: `使っていない方式が止まっていない: ${leftover.join(', ')}` };
  for (const [name, e] of Object.entries(p.engines)) {
    if (!near(e.wet, scenario.denoise && name === scenario.engine ? 1 : 0, 0.01)) return { ok: false, reason: `${name} の wet が設定と違う` };
  }
  if (!near(p.nrDry, scenario.denoise ? 0 : 1, 0.01)) return { ok: false, reason: 'nrDry のゲインが設定と違う' };
  if (!near(p.comp.wet, scenario.leveler ? 1 : 0, 0.01) || !near(p.comp.dry, scenario.leveler ? 0 : 1, 0.01)) {
    return { ok: false, reason: 'compWet / compDry のゲインが設定と違う' };
  }
  if (scenario.leveler && !near(p.comp.threshold, LEVELER_THRESHOLDS[scenario.levelerStrength], 0.01)) {
    return { ok: false, reason: '音量をそろえるの強さが設定と違う' };
  }
  const judged = m.bands.filter((b) => b.expectedDb !== null && b.measuredDb !== null);
  if (judged.some((b) => Math.abs(b.measuredDb - b.expectedDb) > TOLERANCE_DB)) {
    return { ok: false, reason: `周波数特性が期待値と ${TOLERANCE_DB}dB 以上ずれている` };
  }
  const expectsBands = m.bands.some((b) => b.expectedDb !== null);
  if (expectsBands && judged.length < 2) return { ok: false, skip: true, reason: '測れる帯域が少ない' };
  return { ok: true };
}

function judge(r) {
  const results = r.runs.map(judgeRun);
  return {
    ok: results.every((j) => j.ok),
    skip: results.some((j) => j.skip) && !results.some((j) => !j.ok && !j.skip),
    results,
  };
}

function report(r, j) {
  const f = (x) => (x === null ? '  -  ' : (x >= 0 ? '+' : '') + x.toFixed(1));
  console.log(`\n■ ${r.title ?? ''}\n  ${r.url}`);
  if (r.skip) return console.log(`  スキップ: ${r.skip}`);
  for (const l of r.logs ?? []) console.log(`  ログ: ${l}`);
  if (r.fail) return console.log(`  NG: ${r.fail}`);
  console.log(`  src: ${r.video.src}`);
  r.runs.forEach(({ scenario, m }, i) => {
    const rj = j.results[i];
    const p = m.params;
    const eq = scenario.autoEq ? `オート（${scenario.autoStrength}）` : `${scenario.eqPreset ? `${scenario.eqPreset} ` : ''}${scenario.gains.map(f).join(', ')} dB`;
    console.log(`\n  [${scenario.name}] 設定: ${scenario.enabled ? 'ON' : 'OFF'} / ノイズキャンセル ${scenario.denoise ? `ON（${scenario.engine}）` : 'OFF'} / 音量をそろえる ${scenario.leveler ? scenario.levelerStrength : 'off'} / EQ ${eq}`);
    // 完全な無音の RMS（-Infinity）は、CDP で受け取ると null になる
    const db = (x) => (x === null ? '-∞' : x.toFixed(1));
    console.log(`    AudioContext: ${m.ctxState} / ${m.sampleRate}Hz　ピーク: ${m.peak.toFixed(4)}　RMS: 入口 ${db(m.inRmsDb)} → 出口 ${db(m.outRmsDb)} dBFS　動画: ${m.video.paused ? '一時停止' : '再生中'} ${m.video.time.toFixed(1)}秒`);
    const engines = Object.entries(p.engines).map(([k, e]) => `${k} ${e.ready ? e.wet.toFixed(2) : '準備中'}`).join(' ') || 'なし';
    console.log(`    パラメータ: ゲイン ${p.gains.map(f).join(', ')} dB　wet ${p.wet.toFixed(2)} dry ${p.dry.toFixed(2)}　nrDry ${p.nrDry.toFixed(2)}　ノイズキャンセル ${engines}`);
    console.log(`    コンプレッサー: compWet ${p.comp.wet.toFixed(2)} compDry ${p.comp.dry.toFixed(2)}　threshold ${p.comp.threshold.toFixed(0)}dB ratio ${p.comp.ratio.toFixed(0)}　最大圧縮量 ${p.comp.maxReduction.toFixed(1)}dB　リミッターの最大圧縮量 ${p.limiter.maxReduction.toFixed(1)}dB`);
    if (p.auto?.levels) {
      // 目安の形（中域の平均で高さを合わせたもの）からの、帯域ごとのずれ。もともと音がない帯域（-24dB 未満）は大きさの計算から除く
      const { levels, target, gains } = p.auto;
      const mid = [2, 3, 4, 5, 6, 7];
      const offset = mid.reduce((s, i) => s + levels[i] - target[i], 0) / mid.length;
      const before = levels.map((l, i) => l - (target[i] + offset));
      const after = before.map((d, i) => d + gains[i]);
      const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length).toFixed(1);
      const present = (a) => a.filter((_, i) => before[i] >= -24);
      console.log(`    オートEQ 目安からのずれ: ${before.map(f).join(', ')} dB`);
      console.log(`    オートEQ 補正量        : ${gains.map(f).join(', ')} dB`);
      console.log(`    ずれの大きさ（RMS）: 補正前 ${rms(present(before))}dB → 補正後（概算） ${rms(present(after))}dB`);
    }
    console.log('    出口 − 入口（入口は最も強い成分との差。−50dB 未満の帯域は測定しない）:');
    for (const b of m.bands) {
      console.log(`      ${String(b.hz).padStart(5)}Hz  期待 ${f(b.expectedDb)}dB  実測 ${f(b.measuredDb)}dB  入口 ${f(b.inputDb === null ? null : b.inputDb - m.topDb)}dB`);
    }
    console.log(rj.ok ? '    OK' : `    ${rj.skip ? 'スキップ' : 'NG'}: ${rj.reason}`);
  });
  console.log(j.ok ? '\n  結果: OK' : `\n  結果: ${j.skip ? 'スキップ' : 'NG'}`);
}

async function main() {
  const [siteName, ...urls] = process.argv.slice(2);
  const site = SITES[siteName];
  if (!site) {
    console.error(`サイトを指定してください: ${Object.keys(SITES).join(' / ')}`);
    return 1;
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-fx-verify-'));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    pipe: true,
    enableExtensions: true,
    userDataDir: profile,
    args: ['--mute-audio', '--lang=ja', '--window-size=1400,900'],
    defaultViewport: { width: 1400, height: 900 },
  });
  try {
    const extId = await browser.installExtension(EXTENSION);
    const targets = urls.length ? urls : await findBroadcasts(browser, site);
    for (const url of targets.slice(0, MAX_TRIES)) {
      const r = await check(browser, extId, url);
      const j = r.runs ? judge(r) : { ok: false, skip: !!r.skip };
      report(r, j);
      if (j.ok) return 0;
      // 判定できなかったものだけ次の放送で試す。NG は打ち切る
      if (!j.skip) return 1;
    }
    console.log('\n判定できる放送が見つからなかった');
    return 2;
  } finally {
    await browser.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

process.exitCode = await main().catch((e) => { console.error(e); return 1; });
