# deepfilternet（DeepFilterNet3）

`@workadventure/noise-suppression` から、DeepFilterNet3 の AudioWorklet で使うファイルだけを取り出したもの。
バージョンは `VERSION` を参照。更新するときは `tools/vendor.js` の版を上げて `npm run vendor` を実行する。

| ファイル | 内容 |
|---|---|
| `assets/deepfilternet-worklet-processor.js` | AudioWorkletProcessor（`workadventure-deepfilternet` を登録する） |
| `assets/deepfilternet/df_bg.wasm` | libDF の WASM |
| `assets/deepfilternet/DeepFilterNet3_onnx.tar.gz` | DeepFilterNet3 のモデル（gzip のまま渡す） |

パッケージの `createDeepFilterNetAudioWorklet()`（`dist/deepfilternet.js`）は使わず、
`extension/audio/audio-graph.js` でノードを自分で作っている。
Firefox では、この関数がワークレットに渡す `WebAssembly.Module` をページ側にコピーできないため。
ワークレットに渡す設定（`DEEPFILTERNET_OPTIONS`）はこの関数の既定値と同じにしているので、
パッケージを更新したら `dist/deepfilternet.js` の設定が変わっていないかを確かめる。

## ライセンス

| 対象 | ライセンス | ファイル |
|---|---|---|
| workadventure/noise-suppression | MIT | `LICENSE` |
| DeepFilterNet（libDF とモデルの重み） | MIT または Apache-2.0（MIT を選ぶ） | `LICENSE-MIT.DeepFilterNet` |
