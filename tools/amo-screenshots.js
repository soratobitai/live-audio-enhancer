// ストア（AMO）に載せるスクリーンショット（1280×800）を作る。docs/amo/screenshots/ に保存する。
// 実際のポップアップの画面（extension/popup/popup.html）を開き、左にポップアップ、右に説明を並べて撮る。
// オートEQ の画面は、配信につないだときの補正量（Twitch の雑談で実際に出た値）を再現して撮る。
// ポップアップの画面はタブで開くので、オートEQ の状態は「このタブでは使えません」になる。配信につないだときの表示に書き換えて撮る。
//
// 使い方:
//   npm run amo:screenshots
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/amo/screenshots');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const POPUP_WIDTH = 340; // extension/popup/popup.css の body の幅

const SHOTS = [
  {
    file: '1-overview.png',
    title: '配信の音を、聞きやすく',
    points: ['AIノイズキャンセル', '音量をそろえる', '10バンドのイコライザー（オートと12のプリセット）', 'ニコ生・YouTube・Twitch・Kick・TVer・ABEMA'],
    site: 'youtube',
    settings: { enabled: true, denoise: true, engine: 'rnnoise', leveler: true, levelerStrength: 'standard', autoEq: false, eqPreset: 'voice', gains: [-4, -3, -1, 0, 1, 2, 4, 4, 2, 0] },
  },
  {
    // サイトのタブ（サイトごとのオン・オフの一覧）を撮る
    file: '2-sites.png',
    title: 'サイトごとに使い分け',
    points: ['設定はサイトごとに保存', 'ライブ配信はノイズキャンセルをオン、テレビ番組はオフ、など', 'サイトごとにオン・オフも'],
    site: 'twitch',
    view: 'sites',
    settings: { enabled: true, denoise: true, engine: 'rnnoise', leveler: true, levelerStrength: 'standard', autoEq: true, eqPreset: 'flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    // サイトごとに変える設定（一覧で、オフのサイトがあることを見せる）
    siteOverrides: { kick: { enabled: false } },
  },
  {
    file: '3-auto-eq.png',
    title: 'イコライザーはオートでも',
    points: ['話し声が聞きやすいように、番組に合わせて自動で調整', '音楽向けにしたいときは、手動のプリセットで'],
    site: 'tver',
    settings: { enabled: true, denoise: false, engine: 'rnnoise', leveler: true, levelerStrength: 'standard', autoEq: true, eqPreset: 'flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    // 配信につないだときの、オートEQ の補正量（Twitch の雑談で実際に出た値）
    autoGains: [0, 0, 3.0, -4.1, -4.5, 0.3, 3.1, 5.7, 6.0, 0],
  },
];

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'live-audio-enhancer-shots-'));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, pipe: true, enableExtensions: true, userDataDir: profile, args: ['--lang=ja'] });
try {
  const extId = await browser.installExtension(path.join(ROOT, 'extension'));
  fs.mkdirSync(OUT, { recursive: true });
  const icon = `data:image/png;base64,${fs.readFileSync(path.join(ROOT, 'extension/icons/icon-128.png')).toString('base64')}`;
  for (const shot of SHOTS) {
    // ポップアップを、設定を入れた状態で開いて撮る（2 倍の解像度）
    const popup = await browser.newPage();
    await popup.setViewport({ width: POPUP_WIDTH, height: 620, deviceScaleFactor: 2 });
    // 設定はサイトごと。すべてのサイトに同じ設定を入れ、shot.site のサイトの設定として開く
    await popup.goto(`chrome-extension://${extId}/popup/popup.html?site=${shot.site}`);
    await popup.evaluate((s, overrides) => Settings.saveAll(Object.fromEntries(Settings.SITES.map(({ id }) => [id, { ...s, ...overrides?.[id] }]))), shot.settings, shot.siteOverrides ?? null);
    await popup.reload();
    await popup.waitForSelector('.band input');
    await new Promise((r) => setTimeout(r, 1500));
    if (shot.view === 'sites') await popup.click('#tabSites');
    if (shot.autoGains) {
      await popup.evaluate((gains) => {
        const note = document.querySelector('.auto-note');
        note.textContent = '今：番組に合わせて調整しています';
        note.dataset.state = 'ready';
        const inputs = [...document.querySelectorAll('.band input')];
        gains.forEach((g, i) => {
          const input = inputs.find((el) => Number(el.dataset.band) === i);
          input.value = g;
          input.parentElement.querySelector('output').textContent = `${g > 0 ? '+' : ''}${g.toFixed(1)} dB`;
          // スライダーの色を 0dB から今の値まで伸ばす（popup.js の paintFill と同じ）
          const pos = ((g + 12) / 24) * 100;
          input.style.setProperty('--a', `${Math.min(pos, 50)}%`);
          input.style.setProperty('--b', `${Math.max(pos, 50)}%`);
        });
      }, shot.autoGains);
    }
    const height = await popup.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
    const png = await popup.screenshot({ clip: { x: 0, y: 0, width: POPUP_WIDTH, height }, encoding: 'base64' });
    await popup.close();

    // 1280×800 の画面に、ポップアップと説明を並べる
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><body style="margin:0;width:1280px;height:800px;overflow:hidden;
        background:linear-gradient(135deg,#2f80ed,#7b3fe4);font-family:'Yu Gothic UI','Segoe UI',sans-serif;color:#fff">
      <div style="position:absolute;left:96px;top:50%;transform:translateY(-50%);width:${Math.round(POPUP_WIDTH * 2 * 0.53)}px;
          border-radius:14px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.35);background:#fff">
        <img src="data:image/png;base64,${png}" style="display:block;width:100%">
      </div>
      <div style="position:absolute;left:600px;top:50%;transform:translateY(-50%);width:600px">
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:28px">
          <img src="${icon}" width="56" height="56" style="border-radius:14px;box-shadow:0 0 0 3px rgba(255,255,255,.9)"><span style="font-size:30px;font-weight:600">Live Audio Enhancer</span>
        </div>
        <div style="font-size:46px;font-weight:700;line-height:1.3;margin-bottom:28px">${shot.title}</div>
        ${shot.points.map((p) => `<div style="font-size:26px;line-height:1.5;margin:10px 0">・${p}</div>`).join('')}
      </div></body></html>`);
    await page.screenshot({ path: path.join(OUT, shot.file) });
    await page.close();
    console.log(path.relative(ROOT, path.join(OUT, shot.file)));
  }
} finally {
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
