# deepfilternet（DeepFilterNet3）

`@workadventure/noise-suppression` から、DeepFilterNet3 の AudioWorklet で使うファイルだけを取り出したもの。
バージョンは `VERSION` を参照。更新するときは `tools/vendor.js` の版を上げて `npm run vendor` を実行する。

| ファイル | 内容 |
|---|---|
| `deepfilternet.js` | `createDeepFilterNetAudioWorklet()` を持つ ES モジュール（content script から動的 import する） |
| `assets/deepfilternet-worklet-processor.js` | AudioWorkletProcessor（`workadventure-deepfilternet` を登録する） |
| `assets/deepfilternet/df_bg.wasm` | libDF の WASM |
| `assets/deepfilternet/DeepFilterNet3_onnx.tar.gz` | DeepFilterNet3 のモデル（gzip のまま渡す） |

`deepfilternet.js` は、ワークレット・WASM・モデルの URL を自分の URL（`import.meta.url`）からの相対パスで決めるので、この構成を崩さないこと。

## ライセンス

| 対象 | ライセンス | ファイル |
|---|---|---|
| workadventure/noise-suppression | MIT | `LICENSE` |
| DeepFilterNet（libDF とモデルの重み） | MIT または Apache-2.0（MIT を選ぶ） | `LICENSE-MIT.DeepFilterNet` |
