// Firefox で、対応サイトの拡張の動作を確認する。
// インストール済みの Firefox をヘッドレスで起動し、テスト用 content script（tools/firefox-probe.js）を足した
// 拡張のコピーを一時的なアドオンとして読み込んで、配信を再生する。
//
// Firefox では、タブのミュートや動画の音量が Web Audio に入る手前でかかるので、ミュートせず動画の音量を 0.01 にして測る
// （スピーカーからはほぼ聞こえない）。拡張の中ではプレイヤーの音量を打ち消すので、処理は音量 100% と同じ大きさで行われる。
// オートEQ・音量をそろえる・全体の無効は、Chrome の検証（tools/verify.js）で確かめていて、ここではまだ確かめていない。
//
// 使い方:
//   npm run verify:firefox -- <nico / kick / youtube / twitch / tver / abema>   サイトのページから配信を選んで試す
//   npm run verify:firefox -- https://kick.com/xxxx        URL を指定して試す
//   Firefox の場所が違うときは環境変数 FIREFOX_PATH で指定する
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { SITES, PICK_VIDEO, sleep, waitPlaying, findBroadcasts, siteOf } from './sites.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIREFOX = process.env.FIREFOX_PATH || 'C:/Program Files/Mozilla Firefox/firefox.exe';
const MAX_TRIES = 5;
const TOLERANCE_DB = 1.5;
const VIDEO_VOLUME = 0.01;
const GAINS = [0, -6, 0, 0, 0, 0, 0, 4, 0, -3];

// テスト用 content script を足した拡張のコピーを作る。
// WebDriver BiDi では拡張の内部 URL（moz-extension://）を開けないので、
// 拡張自身にポップアップの画面をタブで開かせるバックグラウンドスクリプトも足す
function makeTestExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-fx-firefox-'));
  fs.cpSync(path.join(ROOT, 'extension'), dir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools/firefox-probe.js'), path.join(dir, 'firefox-probe.js'));
  fs.writeFileSync(path.join(dir, 'firefox-open-popup.js'), "browser.tabs.create({ url: browser.runtime.getURL('popup/popup.html') });\n");
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.content_scripts[0].js.push('firefox-probe.js');
  manifest.background = { scripts: ['firefox-open-popup.js'] };
  manifest.browser_specific_settings = { gecko: { id: 'audio-fx-verify@example.invalid' } };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

// ページから、テスト用 content script に測定を頼む
const probe = (page, command, args) => page.evaluate((command, args) => new Promise((resolve) => {
  const id = Math.random().toString(36).slice(2);
  const onMessage = (e) => {
    const r = e.data?.audioFxProbeResult;
    if (r?.id !== id) return;
    window.removeEventListener('message', onMessage);
    resolve(JSON.parse(r.json));
  };
  window.addEventListener('message', onMessage);
  window.postMessage({ audioFxProbe: { id, command, args } }, '*');
  setTimeout(() => resolve({ error: 'テスト用 content script から返事がない' }), 60000);
}), command, args ?? null);

const near = (x, y, eps) => Math.abs(x - y) <= eps;

// 測定の途中で動画が止まった・戻った、または入口が無音なら、判定できない
function unmeasurable(m) {
  if (m.error || m.attached === false) return null; // 測定自体の失敗は、判定できないのではなく NG にする（judge で扱う）
  if (m.interrupted) return '測っている途中で動画が止まった、または最初に戻った';
  if (!(m.peakIn > 0)) return '入口が無音';
  return null;
}

function judgeEq(m) {
  if (m.error || m.attached === false) return { ng: m.error ?? '接続されていない' };
  const skip = unmeasurable(m);
  if (skip) return { skip };
  if (!GAINS.every((g, i) => near(m.gains[i], g, 0.05))) return { ng: 'フィルタのゲインが設定と違う' };
  const judged = m.bands.filter((b) => b.measuredDb !== null);
  if (judged.some((b) => Math.abs(b.measuredDb - b.expectedDb) > TOLERANCE_DB)) return { ng: `周波数特性が期待値と ${TOLERANCE_DB}dB 以上ずれている` };
  if (judged.length < 2) return { skip: '測れる帯域が少ない' };
  return { ok: true };
}

function judgeEngine(m, name) {
  if (m.error || m.attached === false) return { ng: m.error ?? '接続されていない' };
  const engine = m.engines[name];
  if (!engine?.ready) return { ng: `${name} のノードを作れなかった` };
  if (!near(engine.wet, 1, 0.01) || !near(m.nrDry, 0, 0.01)) return { ng: `${name} に切り替わっていない` };
  const others = Object.keys(m.engines).filter((k) => k !== name);
  if (others.length) return { ng: `使っていない方式が止まっていない: ${others.join(', ')}` };
  const skip = unmeasurable(m);
  if (skip) return { skip };
  if (!(m.peakOut > 0)) return { ng: '出力が完全な無音' };
  return { ok: true };
}

async function check(browser, url) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(10000);
    const title = (await page.title()).split(' - ')[0];
    if (await page.evaluate(() => document.documentElement.dataset.audioFxProbe) !== 'ready') {
      return { url, title, fail: '拡張の content script が動いていない' };
    }
    const center = await page.evaluate(`(() => {
      const v = ${PICK_VIDEO};
      if (!v) return null;
      const r = v.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!center) return { url, title, skip: 'video 要素がない' };
    // クリックでユーザー操作の扱いにしてから、ミュートを解除して再生する（音量は小さくする）
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
      v.volume = ${VIDEO_VOLUME};
      if (v.paused) v.play().catch(() => {});
    })()`);
    await sleep(5000);
    if (!(await waitPlaying(page, 10000))) return { url, title, skip: '再生されない（放送前など）' };

    const results = [];
    const attach = await probe(page, 'attach');
    results.push(['接続', attach, !attach.autoConnected ? { ng: '再生が始まっても、拡張が自動で接続しなかった' }
      : attach.attached && attach.ctxState === 'running' ? { ok: true } : { ng: '接続されていない' }]);
    if (!attach.attached) return { url, title, results };

    const eq = await probe(page, 'measure', { settings: { eqPreset: 'custom', gains: GAINS } });
    results.push(['EQ', eq, judgeEq(eq)]);
    const rnnoise = await probe(page, 'measure', { settings: { denoise: true, engine: 'rnnoise' }, wait: 3000 });
    results.push(['ノイズキャンセル（RNNoise）', rnnoise, judgeEngine(rnnoise, 'rnnoise')]);
    const dfn = await probe(page, 'measure', { settings: { denoise: true, engine: 'deepfilternet' }, wait: 5000 });
    results.push(['ノイズキャンセル（DeepFilterNet3）', dfn, judgeEngine(dfn, 'deepfilternet')]);

    // ポップアップ：プリセットを選ぶと EQ に入るか、配信のタブに状態を問い合わせられるか。
    // ポップアップの画面は、テスト用のバックグラウンドスクリプトが拡張の起動時にタブで開いている。
    // Puppeteer からは URL が about:blank に見えるので、タブの中で実際の URL を読んで探す
    let popup = null;
    for (const p of await browser.pages()) {
      const href = await p.evaluate(() => location.href).catch(() => '');
      if (href.endsWith('/popup/popup.html')) popup = p;
    }
    if (!popup) return { url, title, fail: 'ポップアップの画面が開かれていない' };
    // 内部扱いのタブは、前面に出すことも読み込み直すこともできないので、開いたままの画面を操作する
    const popupResult = await popup.evaluate(async () => {
      const select = document.getElementById('eqPreset');
      const options = select.options.length;
      select.value = 'news';
      select.dispatchEvent(new Event('change'));
      const news = Settings.PRESETS.find((p) => p.id === 'news').gains;
      // ヘッドレスでは「表示中のタブ」がポップアップ自身になるので、開いているタブすべてに問い合わせる
      const tabs = await chrome.tabs.query({});
      const statuses = [];
      for (const tab of tabs) {
        try { statuses.push(await chrome.tabs.sendMessage(tab.id, { type: 'audio-fx:status' })); } catch { /* content script がないタブ */ }
      }
      return { options, news, connected: statuses.some((s) => s?.connected) };
    });
    await page.bringToFront();
    await sleep(1000);
    const afterPreset = await probe(page, 'measure', {});
    const popupJudge = popupResult.options < 13 ? { ng: 'プリセットの選択肢が足りない' }
      : !popupResult.connected ? { ng: '配信のタブに状態を問い合わせられない' }
      : !popupResult.news.every((g, i) => near(afterPreset.gains[i], g, 0.1)) ? { ng: 'プリセットのゲインが EQ に入っていない' }
      : { ok: true };
    results.push(['ポップアップ', { ...popupResult, gains: afterPreset.gains }, popupJudge]);

    const limiter = await probe(page, 'limiter');
    results.push(['リミッター', limiter, near(limiter.makeupDb, 1.71, 0.05) && limiter.peakFor12dB < -1
      ? { ok: true } : { ng: 'メイクアップゲインか、大きい入力に対するピークが Chrome と違う' }]);
    return { url, title, src: attach.src, results };
  } catch (e) {
    return { url, fail: e.message };
  } finally {
    await page.close();
  }
}

function report(r) {
  console.log(`\n■ ${r.title ?? ''}\n  ${r.url}`);
  if (r.skip) return console.log(`  スキップ: ${r.skip}`);
  if (r.fail) return console.log(`  NG: ${r.fail}`);
  if (r.src) console.log(`  src: ${r.src}`);
  const db = (x) => (x > 0 ? `${(20 * Math.log10(x)).toFixed(1)}dB` : '-∞');
  for (const [name, m, j] of r.results) {
    console.log(`\n  [${name}] ${j.ok ? 'OK' : j.ng ? `NG: ${j.ng}` : `スキップ: ${j.skip}`}`);
    if (m.peakIn !== undefined) console.log(`    ピーク: 入口 ${db(m.peakIn)} → 出口 ${db(m.peakOut)}　ゲイン ${m.gains.join(', ')}　ノイズキャンセル ${JSON.stringify(m.engines)}`);
    if (m.bands) console.log(`    出口 − 入口: ${m.bands.map((b) => `${b.hz}Hz 期待 ${b.expectedDb} 実測 ${b.measuredDb ?? '-'}`).join(' / ')}`);
    if (name === 'ポップアップ') console.log(`    選択肢 ${m.options} 個　問い合わせ ${m.connected ? 'OK' : 'NG'}　ニュースを選んだ後のゲイン ${m.gains.join(', ')}`);
    if (name === 'リミッター') console.log(`    メイクアップゲイン ${m.makeupDb}dB　+12dB の入力に対する出力 ${m.peakFor12dB}dBFS`);
    if (m.error) console.log(`    エラー: ${m.error}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const site = SITES[args[0]];
  if (!site && !args.length) {
    console.error(`サイトか URL を指定してください: ${Object.keys(SITES).join(' / ')}`);
    return 1;
  }
  const extension = makeTestExtension();
  const browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: FIREFOX,
    headless: true,
    extraPrefsFirefox: {
      'media.autoplay.default': 0,
      // Puppeteer は既定で Widevine（DRM の再生モジュール）のダウンロードを止めている。
      // DRM を使うサイト（ABEMA）は、これがないと再生できない
      'media.gmp-manager.updateEnabled': true,
    },
    // 拡張のページ（ポップアップの画面）は Firefox の内部扱いなので、操作するにはこの指定が要る
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  });
  try {
    await browser.installExtension(extension);
    const targets = site ? await findBroadcasts(browser, site) : args;
    for (const url of targets.slice(0, MAX_TRIES)) {
      const r = await check(browser, url);
      report(r);
      if (r.skip) continue;
      if (r.fail) return 1;
      const judges = r.results.map(([, , j]) => j);
      if (judges.some((j) => j.ng)) {
        console.log('\n  結果: NG');
        return 1;
      }
      if (judges.every((j) => j.ok)) {
        console.log('\n  結果: OK');
        return 0;
      }
      console.log('\n  結果: スキップ（判定できない項目があった）');
    }
    console.log('\n判定できる配信が見つからなかった');
    return 2;
  } finally {
    await browser.close();
    fs.rmSync(extension, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

process.exitCode = await main().catch((e) => { console.error(e); return 1; });
