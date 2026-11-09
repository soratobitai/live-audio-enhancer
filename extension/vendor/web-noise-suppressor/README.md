# web-noise-suppressor（RNNoise）

`@sapphi-red/web-noise-suppressor` から、RNNoise の AudioWorklet で使うファイルだけを取り出したもの。
バージョンは `VERSION` を参照。更新するときは package.json の版を上げて `npm run vendor` を実行する。

| ファイル | 内容 |
|---|---|
| `rnnoise/workletProcessor.js` | AudioWorkletProcessor（`@sapphi-red/web-noise-suppressor/rnnoise` を登録する） |
| `rnnoise_simd.wasm` | RNNoise の WASM（SIMD 版）。ワークレットへは `processorOptions.wasmBinary` で渡す |

## ライセンス

| 対象 | ライセンス | ファイル |
|---|---|---|
| sapphi-red/web-noise-suppressor | MIT | `LICENSE` |
| shiguredo/rnnoise-wasm（WASM のビルドと JS ラッパー） | Apache-2.0 | `LICENSE.shiguredo-rnnoise-wasm` |
| xiph/rnnoise | BSD-3-Clause | `COPYING.xiph-rnnoise` |
