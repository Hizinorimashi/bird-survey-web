// 連続モード用: マイクの音を約0.5秒ずつまとめて画面側へ送る（AudioWorklet）
class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(24000);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(24000);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-recorder', PcmRecorder);
