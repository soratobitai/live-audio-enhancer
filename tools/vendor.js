// ノイズキャンセルのパッケージから、拡張で使うファイルだけを extension/vendor/ にコピーする。
// パッケージの版を変えたら `npm run vendor` で実行し直す。
// 上流（shiguredo/rnnoise-wasm、xiph/rnnoise、DeepFilterNet）のライセンス文はこのスクリプトでは扱わず、vendor/ に置いたものを使う。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'extension/vendor');

// パッケージ内のパス -> vendor/<dir>/ からのパス。
// 相対パスで書かれた参照（sourceMappingURL、import.meta.url からの URL）が切れないよう、構成は保つ
const PACKAGES = [
  {
    // devDependencies に入れてあるので node_modules から取る
    name: '@sapphi-red/web-noise-suppressor',
    dir: 'web-noise-suppressor',
    files: {
      'LICENSE': 'LICENSE',
      'dist/rnnoise/workletProcessor.js': 'rnnoise/workletProcessor.js',
      'dist/rnnoise/workletProcessor.js.map': 'rnnoise/workletProcessor.js.map',
      'dist/rnnoise_simd.wasm': 'rnnoise_simd.wasm',
    },
  },
  {
    // 依存を含めると非常に大きい（展開後 150MB 近く）ので node_modules には入れず、npm pack で取り出す
    name: '@workadventure/noise-suppression',
    version: '0.2.0',
    dir: 'deepfilternet',
    files: {
      'LICENSE': 'LICENSE',
      'dist/assets/deepfilternet-worklet-processor.js': 'assets/deepfilternet-worklet-processor.js',
      'dist/assets/deepfilternet/df_bg.wasm': 'assets/deepfilternet/df_bg.wasm',
      'dist/assets/deepfilternet/DeepFilterNet3_onnx.tar.gz': 'assets/deepfilternet/DeepFilterNet3_onnx.tar.gz',
    },
  },
];

// npm pack でパッケージを一時ディレクトリに取り出し、そのディレクトリを返す
function unpack(name, version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-fx-vendor-'));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const tgz = execFileSync(npm, ['pack', `${name}@${version}`, '--silent', '--pack-destination', tmp], { encoding: 'utf8', shell: process.platform === 'win32' })
    .trim().split('\n').at(-1);
  // GNU tar（Git Bash など）は「C:」を含むパスをリモートのホスト名と解釈するので、相対パスで渡す
  execFileSync('tar', ['-xzf', tgz], { cwd: tmp });
  return { dir: path.join(tmp, 'package'), cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

for (const pkg of PACKAGES) {
  const source = pkg.version
    ? unpack(pkg.name, pkg.version)
    : { dir: path.join(ROOT, 'node_modules', pkg.name), cleanup: () => {} };
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(source.dir, 'package.json'), 'utf8'));
    const dest = path.join(VENDOR, pkg.dir);
    for (const [from, to] of Object.entries(pkg.files)) {
      const target = path.join(dest, to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(source.dir, from), target);
      console.log(`${pkg.name}/${from} -> ${path.relative(ROOT, target)}`);
    }
    fs.writeFileSync(path.join(dest, 'VERSION'), `${pkg.name}@${version}\n`);
  } finally {
    source.cleanup();
  }
}
