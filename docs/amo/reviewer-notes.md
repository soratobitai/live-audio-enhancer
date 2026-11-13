# Notes for Reviewers

Developer Hub の「Notes for Reviewers」（審査担当者へのメモ）に、次の線より下をそのまま貼り付ける。
- 上限は 3000 文字（AMO の制限）。この欄は普通の文字の欄なので、Markdown の表や見出しは使わない
- 審査担当者は英語で読むので、英語で書いている
- ライブラリの版を上げたら、版・リンク・SHA-256 を書き直し、3000 文字を超えていないか数える

---

WHAT IT DOES
Applies noise suppression (RNNoise or DeepFilterNet3), a leveler, a 10-band EQ with an auto mode and a limiter to <video> on six sites, using createMediaElementSource() and the Web Audio API. All processing is local.
- No data collection or transmission. Settings use storage.local only.
- No remote code. Network requests only load packaged files (worklets, WASM, model) via web_accessible_resources.
- Permissions: storage only.

HOW TO TEST (no account needed; the UI is in Japanese)
1. Play a YouTube or Twitch video with talking, unmuted (muted videos are processed after unmuting).
2. Click the toolbar button.
3. ノイズキャンセル (Noise suppression): オフ/オート/オン = Off/Auto/On. Auto keeps it on and turns it off while music continues ("今：" shows the state). 標準 (Standard) = RNNoise, 強め (Strong) = DeepFilterNet3 (more CPU, ~70 ms latency).
4. 音量をそろえる (Leveler): on/off switch.
5. イコライザー (EQ): オート (Auto) or 手動 (Manual: presets and sliders).
6. Settings are per site. 有効 (Enabled) bypasses everything on this site; the サイト (Sites) tab turns each site on/off.
Sites: live.nicovideo.jp, www.youtube.com, kick.com, www.twitch.tv, tver.jp, abema.tv (TVer/ABEMA: Japan only).

SOURCE CODE
First-party code is hand-written JavaScript with no build step or minification (shared/, audio/, content/, popup/).

THIRD-PARTY LIBRARIES
Unmodified, byte-identical to the npm releases (SHA-256 below). Licenses are in each vendor/ folder.

1) @sapphi-red/web-noise-suppressor 0.4.1 (MIT)
https://registry.npmjs.org/@sapphi-red/web-noise-suppressor/-/web-noise-suppressor-0.4.1.tgz
Source: https://github.com/sapphi-red/web-noise-suppressor/tree/v0.4.1
vendor/web-noise-suppressor/ = dist/ of the package:
rnnoise/workletProcessor.js 1e06facbb3d7459b89769aa4247cd4b71263e6662e4da0c54763f3bf06f5893b
rnnoise_simd.wasm 378fd17c294db15ee4e818ba5ef072242a21c8ad7445b483f7f46d7dc4f2c253
(WASM: RNNoise, BSD-3-Clause, built by shiguredo/rnnoise-wasm, Apache-2.0)

2) @workadventure/noise-suppression 0.2.0 (MIT)
https://registry.npmjs.org/@workadventure/noise-suppression/-/noise-suppression-0.2.0.tgz
Source (gitHead of the release): https://github.com/workadventure/noise-suppression/tree/7e00a1b7522f044a31776fddc249a97a98de94ed
vendor/deepfilternet/assets/ = dist/assets/ of the package:
deepfilternet-worklet-processor.js e91ddfeb95288e1359d61c1828c39e46474e06c8bbb4789bcd7da32c4593bb52
deepfilternet/df_bg.wasm 8ebf2b217b80fc128505b993c8d7d7d892df5a845ab7a2516fed74b76e7fe708
deepfilternet/DeepFilterNet3_onnx.tar.gz c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616
(df_bg.wasm: DeepFilterNet libDF, MIT/Apache-2.0, built by the package's scripts/build-deepfilternet-wasm.sh; tar.gz: DeepFilterNet3 model weights)
