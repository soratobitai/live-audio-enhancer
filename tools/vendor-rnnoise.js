// @sapphi-red/web-noise-suppressor から、拡張で使うファイルだけを extension/vendor/ にコピーする。
// パッケージを更新したら `npm run vendor` で実行し直す。
// 上流（shiguredo/rnnoise-wasm、xiph/rnnoise）のライセンス文はこのスクリプトでは扱わず、vendor/ に置いたものを使う。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'node_modules/@sapphi-red/web-noise-suppressor');
const DEST = path.join(ROOT, 'extension/vendor/web-noise-suppressor');

// パッケージ内のパス（dist/ の構成をそのまま保つ。sourceMappingURL が相対パスで書かれているため）
const FILES = [
  'LICENSE',
  'dist/rnnoise/workletProcessor.js',
  'dist/rnnoise/workletProcessor.js.map',
  'dist/rnnoise_simd.wasm',
];

const { version } = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
for (const file of FILES) {
  const to = path.join(DEST, file.replace(/^dist\//, ''));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(PKG, file), to);
  console.log(`${file} -> ${path.relative(ROOT, to)}`);
}
fs.writeFileSync(path.join(DEST, 'VERSION'), `@sapphi-red/web-noise-suppressor@${version}\n`);
console.log(`version: ${version}`);
