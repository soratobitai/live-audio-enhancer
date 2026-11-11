// Chrome ウェブストアに提出する ZIP を作る。
//
// extension/ をそのまま使い、ストアに不要なファイル（ソースマップ）だけを除く。
// manifest は共通のものをそのまま使う（Firefox だけの項目は tools/firefox.js がコピーにだけ足すので、ここには入っていない）。
//
// 使い方:
//   npm run pack:chrome   dist/live-audio-enhancer-<版>-chrome.zip を作る。ストアのデベロッパー ダッシュボードからアップロードする
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');
const WEB_EXT = path.join(ROOT, 'node_modules/web-ext/bin/web-ext.js');
// ストアに入れないファイル
const EXCLUDE = [/\.map$/];
// ストアの要約は manifest の description が使われ、132 文字まで
const SUMMARY_MAX = 132;

const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION, 'manifest.json'), 'utf8'));
const problems = [];
if ([...manifest.description].length > SUMMARY_MAX) problems.push(`description が ${SUMMARY_MAX} 文字を超えている（${[...manifest.description].length} 文字）`);
if (manifest.browser_specific_settings) problems.push('Firefox だけの項目（browser_specific_settings）が入っている');
if (problems.length) {
  console.error(`manifest に問題があります:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-audio-enhancer-chrome-'));
try {
  fs.cpSync(EXTENSION, dir, { recursive: true, filter: (src) => !EXCLUDE.some((re) => re.test(src)) });
  fs.mkdirSync(DIST, { recursive: true });
  const filename = `live-audio-enhancer-${manifest.version}-chrome.zip`;
  // ZIP にまとめるだけなので、Firefox 用と同じ web-ext build を使う（manifest は書き換えない）
  const r = spawnSync(process.execPath, [WEB_EXT, 'build', '--source-dir', dir, '--artifacts-dir', DIST, '--filename', filename, '--overwrite-dest'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ZIP を作れませんでした');
  console.log(`\nできたファイル: ${path.relative(ROOT, path.join(DIST, filename))}（v${manifest.version}）`);
} catch (e) {
  console.error(`\n${e.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
