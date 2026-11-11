// 拡張のアイコンの PNG を、SVG（extension/icons/）から作る。
// インストール済みの Chrome をヘッドレスで起動し、SVG を各サイズで描いて、背景を透明にして保存する。
// 16px は、つまみが潰れるので簡略版（icon-small.svg）を使う。
// SVG はブロック要素にして描く（文字と同じ行に置くと、行の高さの分だけ下にずれて、下側が切れる）。
//
// 使い方:
//   npm run icons
//   Chrome の場所が違うときは環境変数 CHROME_PATH で指定する
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = path.join(ROOT, 'extension/icons');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SIZES = [[16, 'icon-small.svg'], [32, 'icon.svg'], [48, 'icon.svg'], [128, 'icon.svg']];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage();
  for (const [size, source] of SIZES) {
    const svg = fs.readFileSync(path.join(ICONS, source), 'utf8')
      .replace('<svg ', `<svg style="display:block" width="${size}" height="${size}" `);
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
    const file = path.join(ICONS, `icon-${size}.png`);
    await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log(`${path.relative(ROOT, file)}（${source} から）`);
  }
} finally {
  await browser.close();
}
