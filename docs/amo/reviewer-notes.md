# Notes for Reviewers

Developer Hub の「Notes for Reviewers」（審査担当者へのメモ）に、次の線より下を貼り付ける。
審査担当者は英語で読むので英語で書いている。ライブラリの版を上げたら、版・リンク・SHA-256 を書き直す。

---

## What the add-on does

Live Audio Enhancer applies audio effects to `<video>` elements on supported sites: noise suppression, a loudness leveler (DynamicsCompressor), a 10-band equalizer with an automatic mode, and a protective limiter. A content script connects the video with `AudioContext.createMediaElementSource()` and processes the audio with the Web Audio API. All processing is local.

- No data collection and no transmission (`data_collection_permissions: none`). Settings are stored with `storage.local` only.
- No remote code. The only network requests are for files packaged in the add-on (AudioWorklet scripts, WebAssembly and the noise suppression model, exposed through `web_accessible_resources`).
- Permissions: `storage` only. Content scripts run on the six supported sites only.

## How to test

No account is needed. The UI is in Japanese; the English meaning of each control is given below.

1. Open a YouTube video with people talking (for example any news live stream) and start playback with sound (unmuted). Muted videos are not processed until they are unmuted.
2. Click the "Live Audio Enhancer" toolbar button.
3. ノイズキャンセル (Noise suppression): "オン" (On) reduces background noise. "オート" (Auto) applies it only while speech is dominant; the line starting with "今：" shows the current state. "標準" (Standard) uses RNNoise; "強め" (Strong) uses DeepFilterNet3 (more CPU, about 70 ms latency).
4. 音量をそろえる (Leveler): the switch compresses loud parts and lifts quiet parts.
5. イコライザー (Equalizer): "手動" (Manual) uses the preset menu and sliders. "オート" (Auto) adjusts the equalizer to the program automatically.
6. 有効 (Enabled), at the top: turning it off bypasses all effects.

Supported sites: live.nicovideo.jp, www.youtube.com, kick.com, www.twitch.tv, tver.jp, abema.tv. TVer and ABEMA are available only in Japan, so YouTube or Twitch are the easiest to test.

## Source code

All first-party code is plain, hand-written JavaScript with no build step, bundling, transpiling or minification: `shared/settings.js`, `audio/*.js`, `content/main.js` and `popup/*`.

## Third-party libraries

Included unmodified. Each file is byte-identical to the file in the npm release (SHA-256 below). License texts are included next to the files.

### 1. @sapphi-red/web-noise-suppressor 0.4.1 (MIT) — RNNoise

- npm: https://www.npmjs.com/package/@sapphi-red/web-noise-suppressor/v/0.4.1
- Release tarball: https://registry.npmjs.org/@sapphi-red/web-noise-suppressor/-/web-noise-suppressor-0.4.1.tgz
- Source (tag v0.4.1): https://github.com/sapphi-red/web-noise-suppressor/tree/v0.4.1

| File in the add-on | File in the npm package | SHA-256 |
|---|---|---|
| `vendor/web-noise-suppressor/rnnoise/workletProcessor.js` | `dist/rnnoise/workletProcessor.js` | `1e06facbb3d7459b89769aa4247cd4b71263e6662e4da0c54763f3bf06f5893b` |
| `vendor/web-noise-suppressor/rnnoise_simd.wasm` | `dist/rnnoise_simd.wasm` | `378fd17c294db15ee4e818ba5ef072242a21c8ad7445b483f7f46d7dc4f2c253` |

`rnnoise_simd.wasm` is RNNoise (https://github.com/xiph/rnnoise, BSD-3-Clause) compiled to WebAssembly by shiguredo/rnnoise-wasm (https://github.com/shiguredo/rnnoise-wasm, Apache-2.0), as shipped in the package above. The source map (`workletProcessor.js.map`) is not included in the add-on.

### 2. @workadventure/noise-suppression 0.2.0 (MIT) — DeepFilterNet3

- npm: https://www.npmjs.com/package/@workadventure/noise-suppression/v/0.2.0
- Release tarball: https://registry.npmjs.org/@workadventure/noise-suppression/-/noise-suppression-0.2.0.tgz
- Source (commit of the npm release, `gitHead`): https://github.com/workadventure/noise-suppression/tree/7e00a1b7522f044a31776fddc249a97a98de94ed

| File in the add-on | File in the npm package | SHA-256 |
|---|---|---|
| `vendor/deepfilternet/assets/deepfilternet-worklet-processor.js` | `dist/assets/deepfilternet-worklet-processor.js` | `e91ddfeb95288e1359d61c1828c39e46474e06c8bbb4789bcd7da32c4593bb52` |
| `vendor/deepfilternet/assets/deepfilternet/df_bg.wasm` | `dist/assets/deepfilternet/df_bg.wasm` | `8ebf2b217b80fc128505b993c8d7d7d892df5a845ab7a2516fed74b76e7fe708` |
| `vendor/deepfilternet/assets/deepfilternet/DeepFilterNet3_onnx.tar.gz` | `dist/assets/deepfilternet/DeepFilterNet3_onnx.tar.gz` | `c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616` |

`df_bg.wasm` is libDF of DeepFilterNet (https://github.com/Rikorose/DeepFilterNet, MIT or Apache-2.0) compiled to WebAssembly by the package's `scripts/build-deepfilternet-wasm.sh` (fork in `forks/deepfilternet/` of the source repository above). `DeepFilterNet3_onnx.tar.gz` contains the DeepFilterNet3 model weights.

## Other notes

- `web_accessible_resources` has `"use_dynamic_url": true` for Chrome. Firefox ignores this property.
- In Firefox, objects passed from the content script to the AudioWorklet are copied with `cloneInto()`, and the DeepFilterNet3 WebAssembly bytes are compiled inside the AudioWorklet.
