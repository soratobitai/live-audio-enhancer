// ニコ生で拡張の動作を確認する。
// インストール済みの Chrome を一時プロファイル・ヘッドレス・ミュートで起動し、extension/ を読み込んで放送を再生する。
// ポップアップを操作して設定を変え、拡張が video に接続できたか、音が出ているか、
// EQ・バイパス・ノイズキャンセルが設定どおりに効いているかを数値で判定する。
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
const TOLERANCE_DB = 1.5;

// ポップアップで順に設定し、それぞれ測定する
const SCENARIOS = [
  { name: 'EQ 有効', enabled: true, denoise: false, gains: [-6, 0, 4, -3] },
  { name: 'EQ 無効（バイパス）', enabled: false, denoise: false, gains: [-6, 0, 4, -3] },
  { name: 'EQ 有効に戻す（ゲイン変更）', enabled: true, denoise: false, gains: [3, -4, 0, 2] },
  { name: 'ノイズキャンセル有効', enabled: true, denoise: true, gains: [0, 0, 0, 0] },
  { name: 'ノイズキャンセル無効に戻す', enabled: true, denoise: false, gains: [-6, 0, 4, -3] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 拡張の isolated world に測定用の関数を用意する。
// 接続済みのグラフ（attach はキャッシュ済みの Promise を返す）の入口と出口に AnalyserNode を付け、
// 呼ぶたびに、音量、周波数ごとの「出口 − 入口」の dB 差とその期待値、パラメータの現在値を返す。
const INSTALL_PROBE = `(async () => {
  const v = document.querySelector('video');
  const g = await AudioGraph.attach(v);
  if (!g) return false;
  const ctx = g.source.context;
  const mk = () => { const a = ctx.createAnalyser(); a.fftSize = 8192; a.smoothingTimeConstant = 0; return a; };
  const pre = mk(), post = mk();
  g.source.connect(pre);
  g.output.connect(post);

  const probes = [60, 1000, 3000, 14000];
  const freqs = new Float32Array(probes);
  const hz = ctx.sampleRate / pre.fftSize;
  const FRAMES = 40;

  globalThis.__audioFxProbe = async () => {
    // 期待値: wet 経路なら全フィルタの振幅特性の積、dry 経路なら素通し（0dB）。
    // ノイズキャンセルが効いているときは周波数特性が入力しだいで変わるので、期待値なし（null）
    const mag = new Float32Array(probes.length), phase = new Float32Array(probes.length);
    const wetDb = probes.map(() => 0);
    for (const f of g.filters) {
      f.getFrequencyResponse(freqs, mag, phase);
      mag.forEach((m, i) => { wetDb[i] += 20 * Math.log10(m); });
    }
    const expected = g.wet.gain.value < 0.5 ? probes.map(() => 0)
      : g.nrWet.gain.value > 0.5 ? probes.map(() => null)
      : wetDb;

    const a = new Float32Array(pre.frequencyBinCount), b = new Float32Array(post.frequencyBinCount);
    const tdIn = new Float32Array(pre.fftSize), tdOut = new Float32Array(post.fftSize);
    const diff = probes.map(() => ({ d: 0, lv: 0, c: 0 }));
    let peak = 0, sqIn = 0, sqOut = 0, n = 0, top = 0;
    for (let i = 0; i < FRAMES; i++) {
      await new Promise((r) => setTimeout(r, 100));
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
    return {
      ctxState: ctx.state, sampleRate: ctx.sampleRate,
      peak, inRmsDb: 10 * Math.log10(sqIn / n), outRmsDb: 10 * Math.log10(sqOut / n), topDb: top / FRAMES,
      params: {
        gains: g.filters.map((f) => f.gain.value),
        wet: g.wet.gain.value, dry: g.dry.gain.value, nrWet: g.nrWet.gain.value, nrDry: g.nrDry.gain.value,
        denoiser: g.denoiser ? g.denoiser.constructor.name : null,
      },
      bands: probes.map((p, k) => ({ hz: p, expectedDb: expected[k], measuredDb: avg(k, 'd'), inputDb: avg(k, 'lv') })),
    };
  };
  return true;
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

// ポップアップのスライダーとスイッチを、ユーザーが操作したときと同じイベントで動かす
async function setPopup(popup, { enabled, denoise, gains }) {
  await popup.evaluate((enabled, denoise, gains) => {
    document.querySelectorAll('.band input').forEach((input, i) => {
      input.value = gains[i];
      input.dispatchEvent(new Event('input'));
    });
    for (const [id, on] of [['denoise', denoise], ['enabled', enabled]]) {
      const sw = document.getElementById(id);
      if (sw.checked !== on) sw.click();
    }
  }, enabled, denoise, gains);
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
    if (!(await evaluate(contextId, INSTALL_PROBE))) return { url, title, logs, video, fail: '接続されていない' };

    popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    await popup.waitForSelector('.band input');

    const runs = [];
    for (const s of SCENARIOS) {
      await setPopup(popup, s);
      // 背面のタブはタイマーが間引かれるので、測定するページを前面に戻す。
      // ノイズキャンセルを初めて有効にしたときは、WASM の読み込みと切り替えの待ちがあるので長めに待つ
      await page.bringToFront();
      await sleep(1000);
      runs.push({ scenario: s, m: await evaluate(contextId, '__audioFxProbe()') });
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

function judgeRun({ scenario, m }) {
  if (m.ctxState !== 'running') return { ok: false, reason: `AudioContext が ${m.ctxState}` };
  if (m.peak === 0) return { ok: false, reason: '完全な無音（CORS や WASM の読み込み失敗の可能性）' };
  const near = (x, y, eps) => Math.abs(x - y) <= eps;
  const p = m.params;
  if (!scenario.gains.every((g, i) => near(p.gains[i], g, 0.05))) return { ok: false, reason: 'フィルタのゲインが設定と違う' };
  if (!near(p.wet, scenario.enabled ? 1 : 0, 0.01) || !near(p.dry, scenario.enabled ? 0 : 1, 0.01)) {
    return { ok: false, reason: 'wet / dry のゲインが設定と違う' };
  }
  if (scenario.denoise && !p.denoiser) return { ok: false, reason: 'RNNoise のノードがない' };
  if (!near(p.nrWet, scenario.denoise ? 1 : 0, 0.01) || !near(p.nrDry, scenario.denoise ? 0 : 1, 0.01)) {
    return { ok: false, reason: 'nrWet / nrDry のゲインが設定と違う' };
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
    console.log(`\n  [${scenario.name}] 設定: ${scenario.enabled ? 'ON' : 'OFF'} / ノイズキャンセル ${scenario.denoise ? 'ON' : 'OFF'} / ${scenario.gains.map(f).join(', ')} dB`);
    console.log(`    AudioContext: ${m.ctxState} / ${m.sampleRate}Hz　ピーク: ${m.peak.toFixed(4)}　RMS: 入口 ${m.inRmsDb.toFixed(1)} → 出口 ${m.outRmsDb.toFixed(1)} dBFS`);
    console.log(`    パラメータ: ゲイン ${p.gains.map(f).join(', ')} dB　wet ${p.wet.toFixed(2)} dry ${p.dry.toFixed(2)}　nrWet ${p.nrWet.toFixed(2)} nrDry ${p.nrDry.toFixed(2)}　RNNoise ${p.denoiser ?? 'なし'}`);
    console.log('    出口 − 入口（入口は最も強い成分との差。−50dB 未満の帯域は測定しない）:');
    for (const b of m.bands) {
      console.log(`      ${String(b.hz).padStart(5)}Hz  期待 ${f(b.expectedDb)}dB  実測 ${f(b.measuredDb)}dB  入口 ${f(b.inputDb === null ? null : b.inputDb - m.topDb)}dB`);
    }
    console.log(rj.ok ? '    OK' : `    ${rj.skip ? 'スキップ' : 'NG'}: ${rj.reason}`);
  });
  console.log(j.ok ? '\n  結果: OK' : `\n  結果: ${j.skip ? 'スキップ' : 'NG'}`);
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
