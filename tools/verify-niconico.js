// ニコ生で拡張の動作を確認する。
// インストール済みの Chrome を一時プロファイル・ヘッドレス・ミュートで起動し、extension/ を読み込んで放送を再生する。
// 拡張が video に接続できたか、音が出ているか、EQ が設定どおりに効いているかを数値で判定する。
//
// 使い方:
//   npm run verify:nico                                  トップページから放送を選んで試す
//   npm run verify:nico -- https://live.nicovideo.jp/watch/lvXXXX
//   Chrome の場所が違うときは環境変数 CHROME_PATH で指定する
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = path.join(ROOT, 'extension');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MAX_TRIES = 5;
const MIN_PEAK = 0.01; // これ未満は音が小さすぎて判定できないとみなす
const TOLERANCE_DB = 1.5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 拡張の isolated world で実行する測定コード。
// 接続済みのグラフ（attach はキャッシュ済みの Promise を返す）の入口と出口に AnalyserNode を付け、
// 音量と、周波数ごとの「出口 − 入口」の dB 差を測る。期待値は各フィルタの getFrequencyResponse から求める。
const MEASURE = `(async () => {
  const v = document.querySelector('video');
  const g = await AudioGraph.attach(v);
  if (!g) return { attached: false };
  const ctx = g.source.context;
  const mk = () => { const a = ctx.createAnalyser(); a.fftSize = 8192; a.smoothingTimeConstant = 0; return a; };
  const pre = mk(), post = mk();
  g.source.connect(pre);
  g.filters.at(-1).connect(post);

  const probes = [60, 1000, 3000, 14000];
  const freqs = new Float32Array(probes);
  const mag = new Float32Array(probes.length), phase = new Float32Array(probes.length);
  const expected = probes.map(() => 0);
  for (const f of g.filters) {
    f.getFrequencyResponse(freqs, mag, phase);
    mag.forEach((m, i) => { expected[i] += 20 * Math.log10(m); });
  }

  const hz = ctx.sampleRate / pre.fftSize;
  const a = new Float32Array(pre.frequencyBinCount), b = new Float32Array(post.frequencyBinCount);
  const td = new Float32Array(post.fftSize);
  const diff = probes.map(() => ({ d: 0, lv: 0, c: 0 }));
  const FRAMES = 40;
  let peak = 0, sq = 0, n = 0, top = 0;
  for (let i = 0; i < FRAMES; i++) {
    await new Promise((r) => setTimeout(r, 100));
    pre.getFloatFrequencyData(a);
    post.getFloatFrequencyData(b);
    post.getFloatTimeDomainData(td);
    for (const x of td) { peak = Math.max(peak, Math.abs(x)); sq += x * x; n++; }
    // 最も強い成分より 50dB 以上弱いビンはノイズに埋もれていて差が当てにならないので、測定に使わない
    const mx = Math.max(...a);
    top += mx;
    probes.forEach((p, k) => {
      for (let j = Math.ceil(p * 0.95 / hz); j <= Math.floor(p * 1.05 / hz); j++) {
        if (a[j] > mx - 50) { diff[k].d += b[j] - a[j]; diff[k].lv += a[j]; diff[k].c++; }
      }
    });
  }
  g.source.disconnect(pre);
  g.filters.at(-1).disconnect(post);
  const avg = (k, key) => (diff[k].c ? diff[k][key] / diff[k].c : null);
  return {
    attached: true, ctxState: ctx.state, sampleRate: ctx.sampleRate,
    peak, rmsDb: 10 * Math.log10(sq / n), topDb: top / FRAMES,
    bands: probes.map((p, k) => ({ hz: p, expectedDb: expected[k], measuredDb: avg(k, 'd'), inputDb: avg(k, 'lv') })),
  };
})()`;

async function findBroadcasts(browser) {
  const page = await browser.newPage();
  try {
    await page.goto('https://live.nicovideo.jp/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(8000);
    return await page.$$eval('a[href*="/watch/lv"]', (as) => [...new Set(as.map((a) => a.href.split('?')[0]))]);
  } finally {
    await page.close();
  }
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

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(12000);
    const title = (await page.title()).split(' - ')[0];

    // 自動再生は止められるので、プレイヤー中央（再生ボタン）をクリックする
    const center = await page.$eval('video', (v) => {
      const r = v.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }).catch(() => null);
    if (!center) return { url, title, skip: 'video 要素がない' };
    await page.mouse.click(center.x, center.y);
    await sleep(6000);

    const video = await page.evaluate(() => {
      const v = document.querySelector('video');
      return { src: v.currentSrc, paused: v.paused };
    });
    if (video.paused) return { url, title, skip: '再生されない（放送前など）' };

    const { frameTree } = await cdp.send('Page.getFrameTree');
    const contextId = contexts.get(frameTree.frame.id);
    if (contextId === undefined) return { url, title, logs, fail: 'content script が注入されていない' };

    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      contextId, expression: MEASURE, awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) return { url, title, logs, fail: exceptionDetails.exception?.description ?? exceptionDetails.text };
    return { url, title, logs, video, m: result.value };
  } finally {
    await page.close();
  }
}

function judge(r) {
  const { m } = r;
  if (!m.attached) return { ok: false, reason: '接続されていない' };
  if (m.ctxState !== 'running') return { ok: false, reason: `AudioContext が ${m.ctxState}` };
  if (m.peak === 0) return { ok: false, reason: '完全な無音（CORS で出力が止められている可能性）' };
  if (m.peak < MIN_PEAK) return { ok: false, skip: true, reason: '音が小さすぎて判定できない' };
  const bad = m.bands.filter((b) => b.measuredDb !== null && Math.abs(b.measuredDb - b.expectedDb) > TOLERANCE_DB);
  if (bad.length) return { ok: false, reason: `EQ の特性が期待値と ${TOLERANCE_DB}dB 以上ずれている` };
  if (m.bands.filter((b) => b.measuredDb !== null).length < 2) return { ok: false, skip: true, reason: 'EQ を測れる帯域が少ない' };
  return { ok: true };
}

function report(r, j) {
  const f = (x) => (x === null ? '  -  ' : (x >= 0 ? '+' : '') + x.toFixed(1));
  console.log(`\n■ ${r.title}\n  ${r.url}`);
  if (r.skip) return console.log(`  スキップ: ${r.skip}`);
  for (const l of r.logs ?? []) console.log(`  ログ: ${l}`);
  if (r.fail) return console.log(`  NG: ${r.fail}`);
  const { m } = r;
  console.log(`  src: ${r.video.src}`);
  if (!m.attached) return console.log(`  NG: ${j.reason}`);
  console.log(`  AudioContext: ${m.ctxState} / ${m.sampleRate}Hz　ピーク: ${m.peak.toFixed(4)}　RMS: ${m.rmsDb.toFixed(1)}dBFS`);
  console.log('  EQ（出口 − 入口）　※入口は最も強い成分との差。−50dB 未満の帯域は測定しない:');
  for (const b of m.bands) {
    console.log(`    ${String(b.hz).padStart(5)}Hz  期待 ${f(b.expectedDb)}dB  実測 ${f(b.measuredDb)}dB  入口 ${f(b.inputDb === null ? null : b.inputDb - m.topDb)}dB`);
  }
  console.log(j.ok ? '  OK' : `  ${j.skip ? 'スキップ' : 'NG'}: ${j.reason}`);
}

async function main() {
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
    const urls = process.argv.length > 2 ? process.argv.slice(2) : await findBroadcasts(browser);
    for (const url of urls.slice(0, MAX_TRIES)) {
      const r = await check(browser, extId, url);
      const j = r.m ? judge(r) : { ok: false };
      report(r, j);
      if (j.ok) return 0;
      // 判定できなかったものだけ次の放送で試す。NG は打ち切る
      if (r.fail || (r.m && !j.skip)) return 1;
    }
    console.log('\n判定できる放送が見つからなかった');
    return 2;
  } finally {
    await browser.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

process.exitCode = await main().catch((e) => { console.error(e); return 1; });
