// 何も加工しない AudioWorkletProcessor。
// ノイズキャンセル（RNNoise）を入れる位置を先に用意しておくためのもので、ステップ4で置き換える。
registerProcessor('passthrough', class extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    for (let ch = 0; ch < output.length; ch++) {
      if (input[ch]) output[ch].set(input[ch]);
    }
    return true;
  }
});
