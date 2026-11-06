// マイク入力とAI音声の再生（iPhone Safari 対応のため AudioContext は1つだけ使う）
//
// iPhone Safari の注意点
// - AudioContext はタップの処理の中で、await より前に作る・再開する（unlock）。後からだと止まったままになる
// - AudioWorklet が動かない端末があるため、動かなければ ScriptProcessor に切り替える

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

// 任意のサンプルレートの音を 16kHz・16bit PCM に変換し、640サンプル（40ms）ずつ渡す
// capture-worklet.js と同じ処理（ワークレットからは import できないため複製している）
function makeDownsampler(rate, emit) {
  const ratio = rate / 16000;
  const out = new Int16Array(640);
  let n = 0, pos = 0, acc = 0, accN = 0, sum = 0;
  return (ch) => {
    for (let i = 0; i < ch.length; i++) {
      acc += ch[i];
      accN++;
      pos += 1;
      if (pos >= ratio) {
        pos -= ratio;
        const s = Math.max(-1, Math.min(1, acc / accN));
        acc = 0;
        accN = 0;
        out[n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        sum += s * s;
        if (n === out.length) {
          emit(out.buffer.slice(0), Math.sqrt(sum / n));
          n = 0;
          sum = 0;
        }
      }
    }
  };
}

const MIC = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } };

export class AudioEngine {
  // タップの処理の中で、最初の await より前に必ず呼ぶ
  unlock() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AC();
      this.out = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.out.connect(this.analyser).connect(this.ctx.destination);
      this.sources = new Set();
      this.nextTime = 0;
      this.levelBuf = new Uint8Array(this.analyser.fftSize);
      this.workletReady = null;
    }
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    // 無音を一瞬鳴らして、iPhone の音声出力を有効にする
    const src = this.ctx.createBufferSource();
    src.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    src.connect(this.ctx.destination);
    src.start(0);
  }

  // unlock() の直後に呼ぶ。マイクを開く
  async init() {
    if (!this.stream || this.stream.getAudioTracks().every((t) => t.readyState === 'ended')) {
      this.stream = await navigator.mediaDevices.getUserMedia(MIC);
    }
    await this.resume();
  }

  async resume() {
    if (this.ctx && this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch { /* 次のタップで再開する */ }
    }
  }

  // マイクの音を 16kHz に変換して onChunk(base64) に渡す。音量は onLevel(0〜1)
  async startMic(onChunk, onLevel) {
    this.stopCapture();
    this.onChunk = onChunk;
    this.onLevel = onLevel;
    this.ticks = 0;
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0;
    this.mute.connect(this.ctx.destination);
    let worklet = false;
    if (this.ctx.audioWorklet && !this.forceScript) {
      try {
        this.workletReady ||= this.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
        await this.workletReady;
        this.node = new AudioWorkletNode(this.ctx, 'capture', { processorOptions: { targetRate: 16000 } });
        this.node.port.onmessage = (e) => this.receive(e.data.pcm, e.data.level);
        this.node.port.postMessage({ enabled: true });
        this.src.connect(this.node).connect(this.mute);
        worklet = true;
      } catch {
        this.workletReady = null;
      }
    }
    if (!worklet) this.startScript();
    this.mode = worklet ? 'worklet' : 'script';
    await this.resume();
    // ワークレットが1.5秒たっても動かなければ ScriptProcessor に切り替える
    if (worklet) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = setTimeout(() => {
        if (this.ticks === 0 && this.node) {
          this.forceScript = true;
          this.node.disconnect();
          this.node = null;
          this.startScript();
          this.mode = 'script';
        }
      }, 1500);
    }
  }

  startScript() {
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    const down = makeDownsampler(this.ctx.sampleRate, (pcm, level) => this.receive(pcm, level));
    this.proc.onaudioprocess = (e) => down(e.inputBuffer.getChannelData(0));
    this.src.connect(this.proc).connect(this.mute);
  }

  receive(pcm, level) {
    this.ticks++;
    this.onLevel?.(level);
    if (pcm && this.enabled) this.onChunk?.(bufToB64(pcm));
  }

  setMicEnabled(on) {
    this.enabled = on;
  }

  stopCapture() {
    clearTimeout(this.fallbackTimer);
    for (const n of [this.src, this.node, this.proc, this.mute]) { try { n?.disconnect(); } catch { /* 切断済み */ } }
    if (this.proc) this.proc.onaudioprocess = null;
    this.src = this.node = this.proc = this.mute = null;
    this.enabled = false;
  }

  stopMic() {
    this.stopCapture();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  // 画面に出す診断情報（不具合の報告用）
  diag() {
    const t = this.stream?.getAudioTracks()[0];
    const rate = t?.getSettings?.().sampleRate;
    return [
      `音声:${this.ctx?.state || 'なし'}${this.ctx ? ` ${this.ctx.sampleRate}Hz` : ''}`,
      `マイク:${t ? t.readyState + (t.muted ? '・ミュート' : '') : 'なし'}${rate ? ` ${rate}Hz` : ''}`,
      `方式:${this.mode || '-'}`,
      `受信:${this.ticks || 0}`,
    ].join('／');
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
