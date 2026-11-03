// 会話画面：準備 → 会話 → 採点（仕様書 5章）
import { levelOf } from './data.js';
import { AudioEngine, speak } from './audio.js';
import { LiveSession } from './live.js';
import { generateJSON } from './gemini.js';
import { liveSystemPrompt, helpPrompt, scorePrompt, HELP_SCHEMA, SCORE_SCHEMA, CONTROL } from './prompts.js';
import { apiKey } from './store.js';
import {
  state, localScores, totalOf, saveSession, addCard, reviewCard, dueCards, addUsage, noteRateError,
  FREE_SESSION_MIN, monthUsage,
} from './progress.js';
import { esc, icon, toast } from './ui.js';

const engine = new AudioEngine();
let active = null;

export const isTalking = () => !!active;

export function abortTalk() {
  if (!active) return;
  active.stop();
  active = null;
}

// ctx: { scene, stage, isTest, retention, noSupport, limitMin, onDone(sessionId) }
export async function startTalk(root, ctx) {
  const s = state.settings;
  if (s.mode === 'paid' && monthUsage().liveSec / 60 >= s.monthlyCapMin) {
    toast(`今月の上限 ${s.monthlyCapMin} 分に達しました。設定で上限を変更できます。`);
    return false;
  }
  try {
    await engine.init();
  } catch {
    toast('音声の準備に失敗しました。ブラウザを最新にしてお試しください。');
    return false;
  }
  active = new Talk(root, ctx);
  try {
    await active.begin();
  } catch (e) {
    active?.stop();
    active = null;
    throw e;
  }
  return true;
}

class Talk {
  constructor(root, ctx) {
    Object.assign(this, ctx);
    this.root = root;
    this.L = levelOf(this.scene.lv);
    this.speed = this.L.speed;
    const ptt = state.settings.ptt;
    this.pushToTalk = ptt === 'auto' ? this.scene.lv <= 3 : ptt === 'on';
    this.showHelp = this.stage === 'full' && !this.isTest;
    this.canHint = this.stage === 'assist' && !this.isTest;
    this.due = this.isTest || this.retention ? [] : dueCards(3);
    this.limitSec = (this.limitMin || FREE_SESSION_MIN) * 60;
    this.transcript = [];
    this.userTurns = [];
    this.helps = 0;
    this.helpUsedKeys = new Set();
    this.lastAiEnd = null;
    this.userTurnOpen = false;
    this.pressing = false;
    this.micOn = !this.pushToTalk;
    this.ended = false;
    this.helpData = null;
    this.helpSeq = 0;
    this.wrapSent = false;
  }

  async begin() {
    this.render();
    const key = apiKey.get();
    this.live = new LiveSession({
      apiKey: key,
      model: state.settings.liveModel,
      voice: state.settings.voice,
      pushToTalk: this.pushToTalk,
      silenceMs: this.scene.lv <= 3 ? 1200 : this.scene.lv <= 7 ? 900 : 700,
      systemText: liveSystemPrompt({ scene: this.scene, stage: this.stage, speed: this.speed, isTest: this.isTest, dueCards: this.due }),
      getHistory: () => this.transcript.map((t) => ({ role: t.who === 'ai' ? 'model' : 'user', parts: [{ text: t.text }] })),
      handlers: {
        onAudio: (b64, rate) => { if (!this.ended) engine.playPcm(b64, rate); this.setStatus('ai'); },
        onInputText: (t) => this.addText('me', t),
        onOutputText: (t) => this.addText('ai', t),
        onTurnComplete: () => this.aiTurnDone(),
        onInterrupted: () => engine.stopPlayback(),
        onReconnecting: () => this.banner('接続が切れたため、再接続しています…'),
        onReconnected: () => this.banner(''),
        onClose: (err) => this.fatal(err),
      },
    });
    engine.onIdle = () => {
      this.lastAiEnd = performance.now();
      if (!this.pressing) this.setStatus('wait');
      this.armSilence();
    };
    this.setStatus('connect');
    await this.live.connect();
    await engine.startMic((b64) => { if (this.micOn) this.live.sendAudio(b64); }, (lv) => { this.micLevel = lv; });
    engine.setMicEnabled(this.micOn);
    this.started = performance.now();
    this.live.sendControl(CONTROL.start);
    this.setStatus('ai');
    this.tick = setInterval(() => this.onTick(), 500);
    this.draw();
  }

  // ---- 文字起こし ----
  addText(who, text) {
    if (this.ended) return;
    const last = this.transcript[this.transcript.length - 1];
    if (who === 'me') {
      clearTimeout(this.silenceTimer);
      this.root.querySelector('.help')?.classList.remove('nudge');
      if (!this.userTurnOpen) {
        this.userTurnOpen = true;
        const latency = this.pressAt ?? performance.now();
        this.userTurns.push({ latency: this.lastAiEnd ? Math.max(0, (latency - this.lastAiEnd) / 1000) : null, words: 0 });
      }
      if (last && last.who === 'me' && !last.closed) last.text += text;
      else this.transcript.push({ who, text });
      const cur = this.userTurns[this.userTurns.length - 1];
      cur.words = this.transcript[this.transcript.length - 1].text.trim().split(/\s+/).filter(Boolean).length;
    } else {
      if (last && last.who === 'me') last.closed = true;
      this.userTurnOpen = false;
      this.pressAt = null;
      if (last && last.who === 'ai' && !last.closed) last.text += text;
      else this.transcript.push({ who, text });
    }
    this.renderLog();
  }

  aiTurnDone() {
    const last = this.transcript[this.transcript.length - 1];
    if (last?.who === 'ai') {
      last.closed = true;
      if (this.showHelp) this.loadHelp();
    }
    if (!engine.playing) {
      this.lastAiEnd = performance.now();
      this.setStatus('wait');
      this.armSilence();
    }
  }

  // 沈黙5秒でヒントを促す（Lv1-3）
  armSilence() {
    clearTimeout(this.silenceTimer);
    if (!this.showHelp && !this.canHint) return;
    this.silenceTimer = setTimeout(() => {
      if (this.ended || this.pressing || this.userTurnOpen) return;
      const h = this.root.querySelector('.help');
      if (this.showHelp) h?.classList.add('nudge');
      else if (this.canHint && !this.helpData) this.root.querySelector('[data-act=hint]')?.classList.add('nudge');
    }, 5000);
  }

  async loadHelp() {
    const seq = ++this.helpSeq;
    const box = this.root.querySelector('.help');
    if (box) box.innerHTML = '<p class="help-wait">返答の候補を準備中…</p>';
    try {
      const data = await generateJSON(apiKey.get(), state.settings.textModel, helpPrompt({ scene: this.scene, transcript: this.transcript }), HELP_SCHEMA);
      addUsage({ textCalls: 1 });
      if (seq !== this.helpSeq || this.ended) return;
      this.helpData = data;
      const lastAi = [...this.transcript].reverse().find((t) => t.who === 'ai');
      if (lastAi && this.showHelp) lastAi.ja = data.ja;
      this.renderLog();
      this.renderHelp();
    } catch (e) {
      if (e.isQuota) noteRateError();
      if (box && seq === this.helpSeq) box.innerHTML = '<p class="help-wait">候補を出せませんでした。キーフレーズを参考に話してみましょう。</p>';
    }
  }

  // ---- 操作 ----
  async press(on) {
    if (this.ended) return;
    if (this.pushToTalk) {
      if (on === this.pressing) return;
      this.pressing = on;
      if (on) {
        engine.stopPlayback();
        this.pressAt = performance.now();
        this.live.activityStart();
        this.micOn = true;
        engine.setMicEnabled(true);
        this.setStatus('me');
      } else {
        // 話し終わりの音を取りこぼさないよう少し待ってから閉じる
        await new Promise((r) => setTimeout(r, 250));
        this.micOn = false;
        engine.setMicEnabled(false);
        this.live.activityEnd();
        this.setStatus('think');
      }
    } else if (on) {
      this.micOn = !this.micOn;
      engine.setMicEnabled(this.micOn);
      this.setStatus(this.micOn ? 'wait' : 'muted');
    }
  }

  slower() {
    this.speed = Math.max(0, this.speed - 1);
    engine.stopPlayback();
    this.live.sendControl(CONTROL.slower);
    toast('ゆっくり話してもらいます');
  }

  retry() {
    const last = [...this.transcript].reverse().find((t) => t.who === 'me');
    if (last) last.retracted = true;
    engine.stopPlayback();
    this.live.sendControl(CONTROL.repeat);
    this.renderLog();
  }

  // 読み込み中は押せないようにして、連打で何度も API を呼ばない
  async hint() {
    const btn = this.root.querySelector('[data-act=hint]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.classList.remove('nudge');
    this.helps++;
    await this.loadHelp();
    btn.disabled = false;
  }

  playReply(i) {
    const r = this.helpData?.replies?.[i];
    if (!r) return;
    const k = `${this.helpSeq}:${i}`;
    if (!this.helpUsedKeys.has(k)) { this.helpUsedKeys.add(k); this.helps++; }
    speak(r.en, { slow: this.scene.lv <= 3 });
  }

  onTick() {
    const sec = (performance.now() - this.started) / 1000;
    const left = Math.max(0, this.limitSec - sec);
    const el = this.root.querySelector('.timer');
    if (el) el.textContent = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
    if (left < 40 && !this.wrapSent) { this.wrapSent = true; this.live.sendControl(CONTROL.wrapUp); }
    if (left <= 0) this.finish();
  }

  banner(text) {
    const b = this.root.querySelector('.banner');
    if (b) { b.textContent = text; b.hidden = !text; }
  }

  async fatal(err) {
    if (this.ended) return;
    if (err?.isQuota) {
      const repeated = await noteRateError();
      toast('Gemini の利用上限に達したため会話を終了しました。');
      this.onQuota?.(repeated);
    } else {
      toast('接続が切れて再接続できませんでした。ここまでの内容で振り返ります。');
    }
    this.finish();
  }

  stop() {
    this.ended = true;
    clearInterval(this.tick);
    clearTimeout(this.silenceTimer);
    cancelAnimationFrame(this.raf);
    this.live?.close();
    engine.close();
    speechSynthesis?.cancel?.();
  }

  // ---- 終了と採点 ----
  async finish() {
    if (this.ended) return;
    const durationSec = Math.round((performance.now() - (this.started || performance.now())) / 1000);
    this.stop();
    active = null;
    this.root.querySelector('.talk')?.classList.add('scoring');
    const ov = this.root.querySelector('.overlay');
    if (ov) ov.hidden = false;
    await addUsage({ liveSec: durationSec, sessions: 1 });
    const transcript = this.transcript.filter((t) => !t.retracted).map(({ who, text, ja }) => ({ who, text: text.trim(), ja }));
    const session = {
      id: `s${Date.now().toString(36)}`,
      sceneId: this.scene.id, lv: this.scene.lv, at: Date.now(), durationSec,
      stage: this.stage, noSupport: !!this.noSupport, isTest: !!this.isTest, retention: !!this.retention,
      transcript, helps: this.helps, userTurns: this.userTurns, scores: null, dueIds: this.due.map((c) => c.id),
    };
    await scoreSession(session, this.scene, this.due);
    await saveSession(session);
    this.onDone(session);
  }

  // ---- 描画 ----
  render() {
    const sc = this.scene;
    const phrases = (sc.phrases || []).map(([en, ja]) => `<button class="chip" data-say="${esc(en)}">${esc(en)}<small>${esc(ja)}</small></button>`).join('');
    this.root.innerHTML = `
    <section class="talk stage-${this.stage}">
      <header class="talk-head">
        <button class="ghost" data-act="end">終える</button>
        <div class="who"><strong>${esc(sc.aiName)}</strong><span>${esc(sc.roleJa)}</span></div>
        <span class="timer" aria-label="残り時間"></span>
      </header>
      <p class="goal"><span>目的</span>${esc(sc.goalJa)}</p>
      <p class="banner" hidden></p>
      <div class="log" aria-live="polite"></div>
      ${this.showHelp ? `<div class="help"><p class="help-wait">AIの最初のひと言を待っています…</p></div>` : ''}
      ${this.canHint ? `<div class="help" hidden></div>` : ''}
      ${this.showHelp && phrases ? `<details class="phrases"><summary>キーフレーズ</summary><div class="chips">${phrases}</div></details>` : ''}
      <footer class="controls">
        ${this.stage !== 'free' && !this.isTest ? `<button class="side" data-act="slower">Slower,<br>please</button>` : '<span></span>'}
        <div class="mic-wrap">
          <canvas class="wave" width="240" height="240" aria-hidden="true"></canvas>
          <button class="mic" data-act="mic" aria-label="${this.pushToTalk ? '押している間だけ話す' : 'マイクのオンオフ'}">${icon('mic')}</button>
        </div>
        ${this.canHint ? `<button class="side" data-act="hint">ヒント</button>` : '<span></span>'}
      </footer>
      <p class="status" aria-live="polite"></p>
      <div class="overlay" hidden><div class="stamp-spin"></div><p>振り返りを作っています…</p></div>
    </section>`;
    const r = this.root;
    r.querySelector('[data-act=end]').onclick = () => this.finish();
    r.querySelector('[data-act=slower]')?.addEventListener('click', () => this.slower());
    r.querySelector('[data-act=hint]')?.addEventListener('click', () => this.hint());
    const mic = r.querySelector('[data-act=mic]');
    if (this.pushToTalk) {
      mic.addEventListener('pointerdown', (e) => { e.preventDefault(); mic.setPointerCapture?.(e.pointerId); this.press(true); });
      for (const ev of ['pointerup', 'pointercancel']) mic.addEventListener(ev, () => this.press(false));
      mic.addEventListener('contextmenu', (e) => e.preventDefault());
    } else mic.addEventListener('click', () => this.press(true));
    r.querySelector('.talk').addEventListener('click', (e) => {
      const say = e.target.closest('[data-say]');
      if (say) speak(say.dataset.say, { slow: this.scene.lv <= 3 });
      const rep = e.target.closest('[data-reply]');
      if (rep) this.playReply(Number(rep.dataset.reply));
      if (e.target.closest('[data-act=retry]')) this.retry();
    });
  }

  setStatus(kind) {
    this.mode = kind;
    const t = {
      connect: '接続しています…',
      ai: `${this.scene.aiName} が話しています`,
      wait: this.pushToTalk ? 'ボタンを押している間だけ話せます' : '話しかけてください（話し終わると自動で送ります）',
      me: '聞いています… 指を離すと送ります',
      think: '考えています…',
      muted: 'マイクはオフです。タップでオン',
    }[kind];
    const el = this.root.querySelector('.status');
    if (el) el.textContent = t;
    this.root.querySelector('.mic')?.classList.toggle('on', kind === 'me' || (!this.pushToTalk && this.micOn));
  }

  renderLog() {
    const log = this.root.querySelector('.log');
    if (!log) return;
    const lastMe = this.transcript.map((t) => t.who).lastIndexOf('me');
    log.innerHTML = this.transcript.map((t, i) => `
      <div class="bubble ${t.who}${t.retracted ? ' retracted' : ''}">
        <p>${esc(t.text)}</p>
        ${t.who === 'ai' && t.ja && this.showHelp ? `<p class="ja">${esc(t.ja)}</p>` : ''}
        ${t.who === 'me' && i === lastMe && !t.retracted ? '<button class="mini" data-act="retry">もう一度</button>' : ''}
      </div>`).join('');
    log.scrollTop = log.scrollHeight;
  }

  renderHelp() {
    const box = this.root.querySelector('.help');
    if (!box || !this.helpData) return;
    box.hidden = false;
    const phrases = this.canHint && this.scene.phrases?.length
      ? `<div class="chips small">${this.scene.phrases.map(([en]) => `<button class="chip" data-say="${esc(en)}">${esc(en)}</button>`).join('')}</div>` : '';
    box.innerHTML = `
      ${this.canHint ? `<p class="ja-line">${esc(this.helpData.ja)}</p>` : ''}
      <p class="help-title">こう返せます（タップで聞く）</p>
      <ol class="replies">${this.helpData.replies.slice(0, 3).map((r, i) => `
        <li><button data-reply="${i}">${icon('play')}<span>${esc(r.en)}<small>${esc(r.ja)}</small></span></button></li>`).join('')}</ol>
      ${phrases}`;
  }

  // 波形：AIが話す時は出力音量、自分が話す時はマイク音量
  draw() {
    const cv = this.root.querySelector('.wave');
    if (!cv) return;
    const g = cv.getContext('2d');
    const css = getComputedStyle(this.root);
    let phase = 0;
    let smooth = 0;
    const loop = () => {
      if (this.ended) return;
      const lvl = this.mode === 'ai' ? engine.outputLevel() * 3 : this.micOn ? (this.micLevel || 0) * 6 : 0;
      smooth += (Math.min(1, lvl) - smooth) * 0.25;
      phase += 0.05;
      g.clearRect(0, 0, 240, 240);
      g.strokeStyle = this.mode === 'ai' ? css.getPropertyValue('--stamp') : css.getPropertyValue('--teal');
      g.lineWidth = 3;
      g.beginPath();
      for (let a = 0; a <= Math.PI * 2 + 0.01; a += Math.PI / 48) {
        const r = 78 + smooth * 30 * (0.6 + 0.4 * Math.sin(a * 6 + phase * 4));
        const x = 120 + r * Math.cos(a);
        const y = 120 + r * Math.sin(a);
        a === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }
}

// 採点：AI判定（目的・伝わりやすさ・文法）＋端末計測（流暢さ・自立度）
export async function scoreSession(session, scene, due = []) {
  const userTurns = session.transcript.filter((t) => t.who === 'me' && t.text);
  try {
    let model = state.settings.textModel;
    const detailed = state.settings.mode === 'paid' && state.settings.detailedScoring;
    if (detailed && state.settings.detailedModel) model = state.settings.detailedModel;
    const r = await generateJSON(apiKey.get(), model, scorePrompt({ scene, transcript: session.transcript, strict: state.settings.strict, dueCards: due, detailed }), SCORE_SCHEMA);
    await addUsage({ textCalls: 1 });
    const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
    const local = localScores({ lv: scene.lv, userTurns: userTurns.length ? session.userTurns : [], helps: session.helps, japaneseTurns: clamp(r.japaneseTurns, 99) });
    const scores = { goal: clamp(r.goal, 30), clarity: clamp(r.clarity, 20), grammar: clamp(r.grammar, 20), ...local };
    if (!userTurns.length) { scores.goal = 0; scores.clarity = 0; scores.grammar = 0; }
    scores.total = totalOf(scores);
    Object.assign(session, {
      scores, goalAchieved: !!r.goalAchieved && userTurns.length > 0,
      corrections: (r.corrections || []).slice(0, 8), summaryJa: r.summaryJa, nextTaskJa: r.nextTaskJa, scoreError: null,
    });
    for (const id of r.usedReviewIds || []) {
      const c = state.cards.find((x) => x.id === id);
      if (c) await reviewCard(c, true);
    }
    if (!session.isTest) {
      session.cardIds = [];
      for (const c of session.corrections) session.cardIds.push((await addCard(c, scene)).id);
    }
  } catch (e) {
    if (e.isQuota) noteRateError();
    session.scoreError = e.message || '採点できませんでした';
  }
  return session;
}
