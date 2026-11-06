// マイク入力とAI音声の再生（iPhone Safari 対応のため AudioContext は1つだけ使う）

export function bufToB64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64ToFloat(b64) {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    if (v >= 0x8000) v -= 0x10000;
    out[i] = v / 0x8000;
  }
  return out;
}

export class AudioEngine {
  // ユーザー操作（タップ）の中で呼ぶこと
  // iPhone Safari では AudioContext より先にマイクを開かないと、マイクの音が無音になることがある
  async init() {
    if (!this.stream || this.stream.getAudioTracks().every((t) => t.readyState === 'ended')) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    }
    if (this.ctx) return this.resume();
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    // 電話の着信などで止まったら、次の操作で再開できるようにしておく
    this.ctx.onstatechange = () => this.onState?.(this.ctx.state);
    await this.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
    this.out = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.out.connect(this.analyser).connect(this.ctx.destination);
    this.sources = new Set();
    this.nextTime = 0;
    this.levelBuf = new Uint8Array(this.analyser.fftSize);
    await this.resume();
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  // init() で開いたマイクを、16kHz に変換するワークレットにつなぐ
  async startMic(onChunk, onLevel) {
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture', { processorOptions: { targetRate: 16000 } });
    this.node.port.onmessage = (e) => {
      if (e.data.pcm) onChunk(bufToB64(e.data.pcm));
      onLevel?.(e.data.level);
    };
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.src.connect(this.node).connect(mute).connect(this.ctx.destination);
    await this.resume();
  }

  setMicEnabled(on) {
    this.node?.port.postMessage({ enabled: on });
  }

  stopMic() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.src?.disconnect();
    this.node?.disconnect();
    this.stream = this.src = this.node = null;
  }

  playPcm(b64, rate = 24000) {
    const data = b64ToFloat(b64);
    if (!data.length) return;
    const buf = this.ctx.createBuffer(1, data.length, rate);
    buf.copyToChannel(data, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    const t = Math.max(this.ctx.currentTime + 0.02, this.nextTime);
    src.start(t);
    this.nextTime = t + buf.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (!this.sources.size) this.onIdle?.();
    };
  }

  get playing() {
    return this.sources?.size > 0;
  }

  stopPlayback() {
    this.sources?.forEach((s) => { try { s.stop(); } catch { /* 停止済み */ } });
    this.sources?.clear();
    this.nextTime = 0;
  }

  outputLevel() {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.levelBuf);
    let sum = 0;
    for (const v of this.levelBuf) sum += ((v - 128) / 128) ** 2;
    return Math.sqrt(sum / this.levelBuf.length);
  }

  close() {
    this.stopMic();
    this.stopPlayback();
  }
}

// 返答候補・言い直し例の読み上げ（端末内の音声合成。API利用枠を使わない）
export function speak(text, { slow = false } = {}) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = slow ? 0.7 : 0.92;
  const v = speechSynthesis.getVoices().find((x) => x.lang === 'en-US' && /Samantha|Google US|Aaron|Nicky/.test(x.name))
    || speechSynthesis.getVoices().find((x) => x.lang.startsWith('en'));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}
