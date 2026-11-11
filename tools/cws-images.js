// Chrome ウェブストアに載せる画像を作る。docs/cws/ に保存する。
//   - store-icon-128.png（128×128）：ストアのアイコン。ストアの案内どおり、絵柄を 96×96 にして、周りに 16px の透明な余白を取る
//     （拡張の icon-128.png は、絵柄が 120×120 で余白が少ない）
//   - promo-small.png（440×280）：小さいプロモーション タイル
// スクリーンショット（1280×800）は、Firefox のストアと同じもの（docs/amo/screenshots/、npm run amo:screenshots）を使う。
//
// 使い方:
//   npm run cws:images
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/cws');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const icon = `data:image/png;base64,${fs.readFileSync(path.join(ROOT, 'extension/icons/icon-128.png')).toString('base64')}`;
// アイコンの SVG の絵柄（角丸の四角）は、128 の中の (4, 4) から 120×120。これが 96×96 になるように縮めて中央に置く
const iconSvg = fs.readFileSync(path.join(ROOT, 'extension/icons/icon.svg'), 'utf8')
  .replace('<svg ', '<svg style="display:block" width="102.4" height="102.4" ');
const GRADIENT = 'linear-gradient(135deg,#2f80ed,#7b3fe4)';

const IMAGES = [
  {
    file: 'store-icon-128.png',
    width: 128,
    height: 128,
    background: 'transparent',
    html: `<div style="display:grid;place-items:center;height:100%">${iconSvg}</div>`,
  },
  {
    file: 'promo-small.png',
    width: 440,
    height: 280,
    // 文字は少なく、縮小されても読めるように大きくする（ストアの案内に合わせる）
    html: `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:14px">
        <img src="${icon}" width="84" height="84" style="border-radius:20px;box-shadow:0 0 0 3px rgba(255,255,255,.9),0 10px 28px rgba(0,0,0,.25)">
        <div style="font-size:30px;font-weight:700;letter-spacing:.01em">Live Audio Enhancer</div>
        <div style="font-size:19px;font-weight:600;opacity:.95">配信の音を、聞きやすく</div>
      </div>`,
  },
];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--lang=ja'] });
try {
  fs.mkdirSync(OUT, { recursive: true });
  for (const image of IMAGES) {
    const page = await browser.newPage();
    await page.setViewport({ width: image.width, height: image.height, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><body style="margin:0;width:${image.width}px;height:${image.height}px;overflow:hidden;
        background:${image.background ?? GRADIENT};font-family:'Segoe UI','Yu Gothic UI',sans-serif;color:#fff">${image.html}</body></html>`);
    await page.screenshot({ path: path.join(OUT, image.file), omitBackground: image.background === 'transparent' });
    await page.close();
    console.log(path.relative(ROOT, path.join(OUT, image.file)));
  }
} finally {
  await browser.close();
}
