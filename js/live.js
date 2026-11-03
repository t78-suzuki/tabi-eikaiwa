// Gemini Live API（音声→音声）クライアント。ブラウザから直接 WebSocket で接続する
// 切断時はセッション再開ハンドルで自動再接続する（仕様書 9.1 安定性）

const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const QUOTA_RE = /quota|exceed|exhaust|rate limit|429/i;

export class LiveError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.isQuota = QUOTA_RE.test(message || '');
  }
}

export class LiveSession {
  // opts: { apiKey, model, voice, systemText, pushToTalk, silenceMs, handlers, getHistory }
  constructor(opts) {
    Object.assign(this, opts);
    this.handle = null;
    this.closedByUser = false;
    this.retries = 0;
  }

  connect() {
    return this._open();
  }

  _setup() {
    const aad = this.pushToTalk ? { disabled: true } : { silenceDurationMs: this.silenceMs || 900 };
    return {
      model: `models/${this.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
      },
      systemInstruction: { parts: [{ text: this.systemText }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: aad },
      sessionResumption: this.handle ? { handle: this.handle } : {},
      contextWindowCompression: { slidingWindow: {} },
    };
  }

  _open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(this.apiKey)}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let ready = false;
      const dec = new TextDecoder();
      ws.onopen = () => ws.send(JSON.stringify({ setup: this._setup() }));
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : dec.decode(ev.data)); } catch { return; }
        if (msg.setupComplete && !ready) {
          ready = true;
          this.retries = 0;
          resolve();
        }
        this._handle(msg);
      };
      ws.onclose = (ev) => {
        if (this.ws !== ws) return;
        if (!ready) {
          const reason = /API key/i.test(ev.reason || '') ? 'APIキーが正しくありません。設定から確認してください。' : ev.reason;
          reject(new LiveError(reason || '接続できませんでした。APIキーとモデル名を確認してください。', ev.code));
          return;
        }
        if (this.closedByUser) return;
        const err = new LiveError(ev.reason || '接続が切れました', ev.code);
        if (err.isQuota) { this.handlers.onClose?.(err); return; }
        this._reconnect(err);
      };
    });
  }

  async _reconnect(err) {
    if (this.retries >= 4) { this.handlers.onClose?.(err); return; }
    this.retries++;
    this.handlers.onReconnecting?.();
    const old = this.ws;
    this.ws = null;
    try { old && old.readyState <= 1 && old.close(); } catch { /* 無視 */ }
    await new Promise((r) => setTimeout(r, 400 * this.retries));
    if (this.closedByUser) return;
    try {
      const resumed = !!this.handle;
      await this._open();
      // 再開ハンドルがない場合はそれまでの会話を文字で渡して続きから始める
      if (!resumed) {
        const turns = this.getHistory?.() || [];
        if (turns.length) this._send({ clientContent: { turns, turnComplete: false } });
      }
      this.handlers.onReconnected?.();
    } catch (e) {
      if (e.isQuota) this.handlers.onClose?.(e);
      else this._reconnect(e);
    }
  }

  _handle(msg) {
    const h = this.handlers;
    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) {
      this.handle = msg.sessionResumptionUpdate.newHandle;
    }
    if (msg.goAway) this._reconnect(new LiveError('goAway'));
    if (msg.usageMetadata) h.onUsage?.(msg.usageMetadata);
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.interrupted) h.onInterrupted?.();
    for (const p of sc.modelTurn?.parts || []) {
      if (p.inlineData?.data) {
        const rate = Number((p.inlineData.mimeType || '').match(/rate=(\d+)/)?.[1]) || 24000;
        h.onAudio?.(p.inlineData.data, rate);
      }
    }
    if (sc.inputTranscription?.text) h.onInputText?.(sc.inputTranscription.text);
    if (sc.outputTranscription?.text) h.onOutputText?.(sc.outputTranscription.text);
    if (sc.turnComplete) h.onTurnComplete?.();
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendAudio(b64) {
    this._send({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } });
  }

  activityStart() { this._send({ realtimeInput: { activityStart: {} } }); }
  activityEnd() { this._send({ realtimeInput: { activityEnd: {} } }); }

  // アプリからの指示（[APP] で始まる文）を送る。turnComplete=true は生成中の応答を止める
  sendControl(text) {
    this._send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
  }

  close() {
    this.closedByUser = true;
    try { this.ws?.close(); } catch { /* 無視 */ }
  }
}
