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

const micErrorText = (e) => (e.name === 'NotAllowedError' ? 'マイクの使用が許可されていません。設定 → Safari → マイク で許可してください。'
  : e.name === 'NotFoundError' ? 'マイクが見つかりません。' : '音声の準備に失敗しました。ブラウザを最新にしてお試しください。');

// 準備画面のマイクテスト：声を出してバーが動くか確かめる。box に .level と .diag を描く
// 呼ぶのはタップの処理の中から（await の前に unlock するため）
// もう一度押すか15秒たつと止まる
let testStop = null;
export async function micTest(box) {
  if (testStop) { testStop(); return; }
  engine.unlock();
  const btn = box.querySelector('[data-act=mic-test] span');
  const bar = box.querySelector('.meter i');
  const diag = box.querySelector('.diag');
  try {
    await engine.init();
  } catch (e) {
    diag.textContent = micErrorText(e);
    return;
  }
  let peak = 0;
  await engine.startMic(() => {}, (lv) => {
    peak = Math.max(peak, lv);
    bar.style.width = `${Math.min(100, lv * 600)}%`;
  });
  btn.textContent = 'テストを止める';
  const show = () => {
    diag.textContent = `${peak > 0.01 ? '声が届いています。マイクは使えます。' : '声を出してみてください。バーが動かないときは、この下の文字を教えてください。'}\n${engine.diag()}`;
  };
  const timer = setInterval(() => (box.isConnected ? show() : testStop?.()), 500);
  const limit = setTimeout(() => testStop?.(), 15000);
  testStop = () => {
    clearInterval(timer);
    clearTimeout(limit);
    testStop = null;
    // テストが終わったらマイクを閉じる（iPhone のマイク使用中の表示を消す）
    if (!active) engine.stopMic();
    if (!box.isConnected) return;
    bar.style.width = '0';
    btn.textContent = 'もう一度テストする';
    show();
    diag.textContent = diag.textContent.replace('声を出してみてください。', 'テストを終えました。');
  };
}

// ctx: { scene, stage, isTest, retention, noSupport, limitMin, onDone(sessionId) }
export async function startTalk(root, ctx) {
  const s = state.settings;
  if (s.mode === 'paid' && monthUsage().liveSec / 60 >= s.monthlyCapMin) {
    toast(`今月の上限 ${s.monthlyCapMin} 分に達しました。設定で上限を変更できます。`);
    return false;
  }
  // iPhone では、タップの直後（await の前）に音声を有効にしないと音が出ない・録れない
  engine.unlock();
  try {
    await engine.init();
  } catch (e) {
    toast(micErrorText(e));
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
        onAudio: (b64, rate) => { clearTimeout(this.replyWait); if (!this.ended) engine.playPcm(b64, rate); this.setStatus('ai'); },
        onInputText: (t) => this.addText('me', t),
        onOutputText: (t) => { clearTimeout(this.replyWait); this.addText('ai', t); },
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
    await engine.startMic((b64) => { if (this.micOn) this.live.sendAudio(b64); }, (lv) => {
      this.micLevel = lv;
      if (this.micOn) this.micPeak = Math.max(this.micPeak || 0, lv);
    });
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
    const box = this.helpBody();
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
  // 押して話すモード：「話す」で録音を始め、「送る」で送る
  // 自動判定モード：「話す」ボタンはマイクのオン・オフ
  talkPressed() {
    if (this.ended) return;
    engine.unlock(); // タップのたびに音声を再開（iPhone で止まっていた場合のため）
    if (!this.pushToTalk) {
      this.micOn = !this.micOn;
      engine.setMicEnabled(this.micOn);
      this.setStatus(this.micOn ? 'wait' : 'muted');
      return;
    }
    if (!this.pressing) this.startTalking();
  }

  sendPressed() {
    if (this.pushToTalk && this.pressing) this.stopTalking();
  }

  startTalking() {
    clearTimeout(this.replyWait);
    this.banner('');
    this.pressing = true;
    engine.stopPlayback();
    this.pressAt = performance.now();
    this.live.activityStart();
    this.micOn = true;
    engine.setMicEnabled(true);
    this.setStatus('me');
    this.watchMic();
  }

  async stopTalking() {
    if (!this.pressing) return;
    this.pressing = false;
    clearTimeout(this.micWatch);
    this.setStatus('think');
    // 話し終わりの音を取りこぼさないよう少し待ってから閉じる
    await new Promise((r) => setTimeout(r, 250));
    this.micOn = false;
    engine.setMicEnabled(false);
    this.live.activityEnd();
    this.banner('');
    // 返事が来ないまま止まらないよう、8秒で話せる状態に戻す
    clearTimeout(this.replyWait);
    this.replyWait = setTimeout(() => {
      if (this.ended || this.pressing || this.mode !== 'think') return;
      this.setStatus('wait');
      this.banner('うまく聞き取れなかったようです。もう一度「話す」を押して話してください。');
    }, 8000);
  }

  // 話している間にマイクの音が届いていなければ、診断つきで知らせる
  watchMic() {
    this.micPeak = 0;
    clearTimeout(this.micWatch);
    this.micWatch = setTimeout(() => {
      if (this.pressing && this.micPeak < 0.003) {
        this.banner(`マイクの音が届いていません。設定 → Safari → マイク を確認してください。
${engine.diag()}`);
      }
    }, 2000);
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
    clearTimeout(this.micWatch);
    clearTimeout(this.replyWait);
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
    const ptt = this.pushToTalk;
    this.root.innerHTML = `
    <section class="talk stage-${this.stage}">
      <header class="talk-head">
        <button class="ghost" data-act="end">会話を終える</button>
        <div class="who"><strong>${esc(sc.aiName)}</strong><span>${esc(sc.roleJa)}</span></div>
        <span class="timer" aria-label="残り時間"></span>
      </header>
      <p class="goal"><span>目的</span>${esc(sc.goalJa)}</p>
      <p class="banner" hidden role="alert"></p>
      <div class="log" aria-live="polite"></div>
      ${this.showHelp || this.canHint ? `
      <details class="help" ${this.showHelp ? 'open' : 'hidden'}>
        <summary>返答の候補</summary>
        <div class="help-body"><p class="help-wait">AIの最初のひと言を待っています…</p></div>
      </details>` : ''}
      <div class="meter" aria-hidden="true"><i></i></div>
      <p class="status" aria-live="polite"></p>
      <footer class="controls ${ptt ? 'ptt' : 'vad'}">
        <div class="aux">
          ${this.stage !== 'free' && !this.isTest ? '<button class="side" data-act="slower">Slower, please</button>' : ''}
          ${this.canHint ? '<button class="side" data-act="hint">ヒント</button>' : ''}
        </div>
        <button class="talk-btn" data-act="talk">${icon('mic')}<span>${ptt ? '話す' : 'マイク'}</span></button>
        ${ptt ? `<button class="send-btn" data-act="send" disabled>${icon('send')}<span>送る</span></button>` : '<span></span>'}
      </footer>
      <div class="overlay" hidden><div class="stamp-spin"></div><p>振り返りを作っています…</p></div>
    </section>`;
    const r = this.root;
    this.followLog();
    const ban = r.querySelector('.banner');
    ban.addEventListener('click', () => { ban.hidden = true; });
    // 押し間違いで終わらないよう確認する
    r.querySelector('[data-act=end]').onclick = () => {
      if (confirm('会話を終えて、振り返りに進みますか？')) this.finish();
    };
    r.querySelector('[data-act=slower]')?.addEventListener('click', () => this.slower());
    r.querySelector('[data-act=hint]')?.addEventListener('click', () => this.hint());
    r.querySelector('[data-act=talk]').addEventListener('click', () => this.talkPressed());
    r.querySelector('[data-act=send]')?.addEventListener('click', () => this.sendPressed());
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
    const ptt = this.pushToTalk;
    const t = {
      connect: '接続しています…',
      ai: `${this.scene.aiName} が話しています（「話す」で割り込めます）`,
      wait: ptt ? '「話す」を押して英語で話し、話し終わったら「送る」' : '話しかけてください（話し終わると自動で送ります）',
      me: '録音中… 話し終わったら「送る」を押してください',
      think: '返事を待っています…',
      muted: 'マイクはオフです。「マイク」でオン',
    }[kind];
    const el = this.root.querySelector('.status');
    if (el) el.textContent = t;
    const talk = this.root.querySelector('[data-act=talk]');
    const send = this.root.querySelector('[data-act=send]');
    if (ptt) {
      talk?.classList.toggle('on', kind === 'me');
      if (talk) talk.disabled = kind === 'me' || kind === 'connect';
      if (send) send.disabled = kind !== 'me';
      send?.classList.toggle('ready', kind === 'me');
    } else {
      talk?.classList.toggle('on', this.micOn && kind !== 'connect');
      if (talk) talk.querySelector('span').textContent = this.micOn ? 'マイク オン' : 'マイク オフ';
    }
  }

  // 会話ログは、自分で上にスクロールして読んでいる間だけ止め、それ以外は常に最新の発言を見せる
  // 返答候補の欄の高さが変わってログが縮んだときも、最新に合わせ直す
  followLog() {
    const log = this.root.querySelector('.log');
    this.stick = true;
    log.addEventListener('scroll', () => {
      if (this.autoScrolling) return;
      this.stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    }, { passive: true });
    new ResizeObserver(() => this.toBottom()).observe(log);
  }

  toBottom() {
    const log = this.root.querySelector('.log');
    if (!log || !this.stick) return;
    this.autoScrolling = true;
    log.scrollTop = log.scrollHeight;
    requestAnimationFrame(() => { this.autoScrolling = false; });
  }

  renderLog() {
    const log = this.root.querySelector('.log');
    if (!log) return;
    const lastMe = this.transcript.map((t) => t.who).lastIndexOf('me');
    log.innerHTML = this.transcript.map((t, i) => `
      <div class="bubble ${t.who}${t.retracted ? ' retracted' : ''}">
        <p>${esc(t.text)}</p>
        ${t.who === 'ai' && t.ja && this.showHelp ? `<p class="ja">${esc(t.ja)}</p>` : ''}
        ${t.who === 'me' && i === lastMe && !t.retracted ? '<button class="mini" data-act="retry">言い直す</button>' : ''}
      </div>`).join('');
    this.toBottom();
  }

  helpBody() {
    return this.root.querySelector('.help .help-body');
  }

  renderHelp() {
    const box = this.root.querySelector('.help');
    const body = this.helpBody();
    if (!box || !body || !this.helpData) return;
    box.hidden = false;
    if (this.canHint) box.open = true;
    const phrases = this.canHint && this.scene.phrases?.length
      ? `<div class="chips">${this.scene.phrases.map(([en]) => `<button class="chip" data-say="${esc(en)}">${esc(en)}</button>`).join('')}</div>` : '';
    body.innerHTML = `
      ${this.canHint ? `<p class="ja-line">${esc(this.helpData.ja)}</p>` : ''}
      <ul class="replies">${(this.helpData.replies || []).slice(0, 3).map((r, i) => `
        <li><button data-reply="${i}">${icon('play')}<span>${esc(r.en)}</span><small>${esc(r.ja)}</small></button></li>`).join('')}</ul>
      ${phrases}`;
    this.toBottom();
  }

  // 音量メーター：AIが話す時は出力音量、録音中はマイク音量
  draw() {
    const bar = this.root.querySelector('.meter i');
    const meter = this.root.querySelector('.meter');
    if (!bar) return;
    let smooth = 0;
    const loop = () => {
      if (this.ended) return;
      const ai = this.mode === 'ai';
      const lvl = ai ? engine.outputLevel() * 4 : this.micOn ? (this.micLevel || 0) * 8 : 0;
      smooth += (Math.min(1, lvl) - smooth) * 0.3;
      bar.style.width = `${Math.round(smooth * 100)}%`;
      meter.classList.toggle('ai', ai);
      meter.classList.toggle('active', ai || (this.micOn && this.mode !== 'muted'));
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
