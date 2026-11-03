// マイク音声を 16kHz・16bit PCM に変換して 40ms ごとに送るワークレット
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ratio = sampleRate / (options.processorOptions.targetRate || 16000);
    this.out = new Int16Array(640);
    this.n = 0;
    this.pos = 0;
    this.acc = 0;
    this.accN = 0;
    this.sum = 0;
    this.enabled = true;
    this.port.onmessage = (e) => {
      if ('enabled' in e.data) this.enabled = e.data.enabled;
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.accN++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const s = Math.max(-1, Math.min(1, this.acc / this.accN));
        this.acc = 0;
        this.accN = 0;
        this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        this.sum += s * s;
        if (this.n === this.out.length) {
          const level = Math.sqrt(this.sum / this.n);
          if (this.enabled) this.port.postMessage({ pcm: this.out.buffer.slice(0), level });
          else this.port.postMessage({ level });
          this.n = 0;
          this.sum = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
