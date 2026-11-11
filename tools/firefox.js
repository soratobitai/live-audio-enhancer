// Firefox 用のファイルを作り、Mozilla のストア（AMO）に提出する。
//
// 共通の manifest（extension/manifest.json）には Firefox だけの項目を書かない（Chrome で「認識できないキー」の警告が出るため）。
// ここで extension/ をコピーし、そのコピーの manifest にだけ、Firefox で必要な項目を足す。
//   - 拡張の ID（一度ストアに出したら変えられない）
//   - データ収集の申告（2025-11 から新しい拡張に必須。この拡張はデータを集めないので none）
//   - 対応する Firefox の最小の版（140。データ収集の申告を表示でき、サイトへのアクセスがインストール時に許可される）
// あわせて、ストアに不要なファイル（ソースマップ）を除く。
//
// 使い方:
//   npm run pack:firefox      ファイルを作る（Mozilla の検査ツールにかけてから、dist/ に ZIP を作る）
//   npm run release:firefox   ファイルを作って、新しい版としてストアに提出する（2 回目以降の版の更新用）
//     提出には AMO の API キーが要る。環境変数 WEB_EXT_API_KEY（JWT issuer）と WEB_EXT_API_SECRET（JWT secret）に入れておく
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');
const WEB_EXT = path.join(ROOT, 'node_modules/web-ext/bin/web-ext.js');

const GECKO = {
  id: 'live-audio-enhancer@mynicotools',
  strict_min_version: '140.0',
  data_collection_permissions: { required: ['none'] },
};
// ストアに入れないファイル
const EXCLUDE = [/\.map$/];

// web-ext を実行する。失敗したら止める
function webExt(args) {
  const r = spawnSync(process.execPath, [WEB_EXT, ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`web-ext ${args[0]} が失敗しました`);
}

// extension/ をコピーし、manifest に Firefox の項目を足す。コピーしたフォルダを返す
function prepare() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-audio-enhancer-firefox-'));
  fs.cpSync(EXTENSION, dir, {
    recursive: true,
    filter: (src) => !EXCLUDE.some((re) => re.test(src)),
  });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.browser_specific_settings = { gecko: GECKO };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, version: manifest.version };
}

function pack(dir, version) {
  console.log('■ Mozilla の検査ツール（web-ext lint）にかける');
  webExt(['lint', '--source-dir', dir]);
  console.log('\n■ ZIP を作る');
  fs.mkdirSync(DIST, { recursive: true });
  const filename = `live-audio-enhancer-${version}-firefox.zip`;
  webExt(['build', '--source-dir', dir, '--artifacts-dir', DIST, '--filename', filename, '--overwrite-dest']);
  return path.join(DIST, filename);
}

function release(dir) {
  if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
    throw new Error('AMO の API キーがありません。環境変数 WEB_EXT_API_KEY と WEB_EXT_API_SECRET を設定してください');
  }
  console.log('\n■ 新しい版としてストアに提出する（公開されるまで最大 24 時間。人の審査に回るともっとかかる）');
  // 審査の結果は待たない（承認はストアから知らせが来る）
  webExt(['sign', '--source-dir', dir, '--channel', 'listed', '--approval-timeout', '0']);
}

const command = process.argv[2];
if (!['pack', 'release'].includes(command)) {
  console.error('使い方: node tools/firefox.js pack | release');
  process.exit(1);
}
const { dir, version } = prepare();
try {
  const zip = pack(dir, version);
  console.log(`\nできたファイル: ${path.relative(ROOT, zip)}（v${version}、ID ${GECKO.id}）`);
  if (command === 'release') release(dir);
} catch (e) {
  console.error(`\n${e.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
