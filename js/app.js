// 画面（ホーム・レベルマップ・場面選択・準備・会話・振り返り・復習・成長記録・設定）
import { LEVELS, SCENES, TESTS, STAGE_LABEL, VOICES, levelOf, scenesOf, findScene } from './data.js';
import { stageOf } from './prompts.js';
import { apiKey, exportAll, importAll, wipeAll } from './store.js';
import { listModels, liveModels, textModels } from './gemini.js';
import { speak } from './audio.js';
import { startTalk, abortTalk, isTalking, scoreSession, micTest } from './talk.js';
import {
  state, loadState, saveSettings, saveProgress, streak, testStatus, recordTest, retentionScene, recordRetention,
  dueCards, reviewCard, bestOf, shouldShowUpgrade, markUpgradeShown, usageOf, monthUsage, practiceOf,
  UNLOCK_AVG, PASS_SCORE, SRS_DAYS, FREE_SESSION_MIN, addCard,
} from './progress.js';
import { put, remove } from './store.js';
import { esc, icon, toast, modal, fmtDate, head } from './ui.js';

const app = document.getElementById('app');
const FREE_DAILY_GUIDE = 10; // 無料枠で上限に達しにくい1日の会話回数の目安（試作で計測して調整）
const PAID_LIMIT_MIN = 15;

// ---------------- ルーター ----------------
const routes = [
  [/^#\/?$/, home],
  [/^#\/setup$/, setup],
  [/^#\/settings$/, settings],
  [/^#\/map$/, map],
  [/^#\/level\/(\d+)$/, level],
  [/^#\/prep\/([\w-]+)$/, prep],
  [/^#\/talk$/, () => { location.hash = '#/'; }],
  [/^#\/result\/([\w-]+)$/, result],
  [/^#\/review$/, review],
  [/^#\/growth$/, growth],
];

function query() {
  const q = location.hash.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(q));
}

function render() {
  if (isTalking()) abortTalk();
  const path = location.hash.split('?')[0] || '#/';
  if ((!apiKey.get() || !state.settings.liveModel) && !/^#\/(setup|settings)$/.test(path)) {
    location.replace('#/setup');
    return;
  }
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      fn(...m.slice(1));
      window.scrollTo(0, 0);
      return;
    }
  }
  location.replace('#/');
}

// ---------------- ホーム ----------------
function home() {
  const p = state.progress;
  const L = levelOf(p.current);
  const due = dueCards().length;
  const ret = retentionScene();
  const rec = recommendNew(p.current);
  const review = ret ? { scene: ret, label: '定着チェック', note: '前のレベルの力が残っているか確認します' }
    : p.needsReview.length ? { scene: findScene(p.needsReview[0]), label: '要復習の場面', note: '前回60点未満でした' }
      : null;
  const t = usageOf();
  const st = testStatus(p.current);
  app.innerHTML = `
  <section class="home">
    <header class="home-head">
      <div>
        <p class="sub">${p.graduated ? '卒業おめでとうございます' : `いまのレベル · ${esc(STAGE_LABEL[L.stage])}`}</p>
        <h1><span class="lvnum">Lv${L.lv}</span>${esc(L.title)}</h1>
        <p class="can">${esc(L.can)}</p>
      </div>
      <a class="icon-btn" href="#/settings" aria-label="設定">${icon('gear')}</a>
    </header>
    <div class="streak"><strong>${streak()}</strong>日連続<span>今日 ${t.sessions}回・${Math.round(t.liveSec / 60)}分</span></div>

    <h2>今日のおすすめ</h2>
    <a class="ticket" href="#/prep/${rec.id}">
      <span class="t-kind">新しい場面</span>
      <span class="t-title">${esc(rec.title)}</span>
      <span class="t-goal">${esc(rec.goalJa)}</span>
      <span class="t-meta">Lv${rec.lv} · 相手: ${esc(rec.roleJa)}</span>
    </a>
    ${review ? `
    <a class="ticket alt" href="#/prep/${review.scene.id}?retention=1">
      <span class="t-kind">${review.label}</span>
      <span class="t-title">${esc(review.scene.title)}</span>
      <span class="t-goal">${esc(review.note)}</span>
      <span class="t-meta">Lv${review.scene.lv}</span>
    </a>` : due ? `
    <a class="ticket alt" href="#/review">
      <span class="t-kind">復習カード</span>
      <span class="t-title">今日の復習 ${due}枚</span>
      <span class="t-goal">前の会話で指摘された言い方をもう一度</span>
    </a>` : ''}

    ${st.unlocked && !st.passed ? `<a class="notice" href="#/level/${p.current}">昇格テストを受けられます。Lv${p.current} の場面一覧から挑戦できます。</a>` : ''}

    <nav class="tiles">
      <a href="#/map"><strong>レベルマップ</strong><span>Lv1〜10</span></a>
      <a href="#/level/${p.current}"><strong>場面を選ぶ</strong><span>Lv${p.current}</span></a>
      <a href="#/review"><strong>復習</strong><span>${due}枚</span></a>
      <a href="#/growth"><strong>成長記録</strong><span>${state.sessions.length}回</span></a>
    </nav>
    ${state.settings.mode === 'free' ? `<p class="fine">無料枠の目安：1日 ${FREE_DAILY_GUIDE} 回程度まで（今日 ${t.sessions} 回）。上限に達したら翌日またはしばらく待つと使えます。</p>`
      : `<p class="fine">有料枠モード：今月 ${Math.round(monthUsage().liveSec / 60)} / ${state.settings.monthlyCapMin} 分</p>`}
  </section>`;
  if (p.unlocked >= 8 && !p.lv8Shown && state.settings.mode === 'free') {
    p.lv8Shown = true;
    saveProgress();
    upgradeSheet('lv8');
  }
}

function recommendNew(lv) {
  const list = scenesOf(lv);
  return list.map((s) => ({ s, n: bestOf(s.id).count })).sort((a, b) => a.n - b.n)[0].s;
}

// ---------------- レベルマップ（パスポートのスタンプ帳）----------------
function map() {
  const p = state.progress;
  app.innerHTML = `
  ${head('レベルマップ')}
  <section class="passport">
    <p class="lead">昇格テストに合格すると、スタンプが押されます。解放済みのレベルはいつでも練習できます。</p>
    <ol class="stamps">
      ${LEVELS.map((L) => {
        const open = L.lv <= p.unlocked;
        const st = testStatus(L.lv);
        const t = p.tests[L.lv];
        const cls = st.passed ? 'passed' : open ? 'open' : 'locked';
        const tilt = ((L.lv * 37) % 11) - 5;
        return `<li class="slot ${cls}">
          <a ${open ? `href="#/level/${L.lv}"` : 'aria-disabled="true"'}>
            <span class="stamp" style="--tilt:${tilt}deg">
              <span class="s-lv">Lv${L.lv}</span>
              <span class="s-title">${esc(L.title)}</span>
              <span class="s-date">${st.passed ? fmtDate(t.passedAt) : open ? (st.unlocked ? 'テスト可' : `練習 ${st.count}/5`) : L.cefr}</span>
            </span>
            <span class="slot-can">${open ? '' : icon('lock')}${esc(L.can)}</span>
          </a>
        </li>`;
      }).join('')}
    </ol>
  </section>`;
}

// ---------------- 場面選択 ----------------
function level(lvStr) {
  const lv = Number(lvStr);
  const L = levelOf(lv);
  if (!L || lv > state.progress.unlocked) { location.replace('#/map'); return; }
  const st = testStatus(lv);
  const ns = query().ns === '1';
  const scenes = scenesOf(lv);
  const testLabel = st.passed ? `合格済み（${st.lastTestScore}点）。もう一度受けることもできます。`
    : st.waitUntil ? `前回 ${st.lastTestScore}点。${new Date(st.waitUntil).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} から再受験できます。`
      : st.unlocked ? `受験できます。初見の場面・ヒントなし・1回限りで ${PASS_SCORE}点以上なら合格です。`
        : `直近5回の平均 ${UNLOCK_AVG}点以上・目的達成4回以上で解放（いま ${st.count}回・平均${st.avg}点・達成${st.goals}回）`;
  app.innerHTML = `
  ${head(`Lv${lv} ${L.title}`, '#/map')}
  <section class="scenes">
    <p class="lead">${esc(L.can)}。AIは${esc(L.place)}の人として話します。<br>サポート：${esc(STAGE_LABEL[L.stage])}</p>
    ${L.stage !== 'free' ? `<label class="switch"><input type="checkbox" id="ns" ${ns ? 'checked' : ''}><span>サポートなしで挑戦（ヒント・日本語なし）</span></label>` : ''}
    <ul class="scene-list">
      ${scenes.map((s) => {
        const b = bestOf(s.id);
        const flag = state.progress.needsReview.includes(s.id) ? '<em class="flag">要復習</em>' : '';
        return `<li><a href="#/prep/${s.id}${ns ? '?ns=1' : ''}">
          <span class="sc-title">${s.part ? `<i>${s.part}</i>` : ''}${esc(s.title)}${flag}</span>
          <span class="sc-goal">${esc(s.goalJa)}</span>
          <span class="sc-meta">${b.count ? `最高 ${b.best}点 · ${b.count}回` : 'まだ練習していません'}</span>
        </a></li>`;
      }).join('')}
    </ul>
    ${lv === 10 ? `<button class="wide outline" data-act="full-trip">通し旅行を一気に（15分超・有料枠）</button>` : ''}
    <div class="test-box ${st.unlocked && !st.waitUntil ? 'ready' : ''}">
      <h2>昇格テスト${lv === 10 ? '（卒業試験・3部構成）' : ''}</h2>
      <p>${esc(testLabel)}</p>
      ${st.unlocked && !st.waitUntil ? `<a class="btn" href="#/prep/${TESTS[lv][0].id}?test=1">テストを受ける</a>` : ''}
    </div>
  </section>`;
  app.querySelector('#ns')?.addEventListener('change', (e) => { location.replace(`#/level/${lv}${e.target.checked ? '?ns=1' : ''}`); });
  app.querySelector('[data-act=full-trip]')?.addEventListener('click', () => {
    if (state.settings.mode !== 'paid') { upgradeSheet('feature'); return; }
    location.hash = '#/prep/full-trip';
  });
}

// Lv10 通し旅行の一括版（有料枠）：5つの場面をひとつにまとめる
function fullTripScene() {
  const parts = scenesOf(10);
  return {
    id: 'full-trip', lv: 10, title: '通し旅行（一括）', role: 'each person the traveler meets, one after another', roleJa: '旅先で出会う人たち', aiName: 'Various',
    goalJa: '入国から交通・ホテル・食事・トラブルまでを一続きでこなす', goalEn: 'Complete a whole trip in one go: ' + parts.map((p) => p.goalEn).join(' Then '),
    setup: 'Play each role in order, announcing the change of place briefly (e.g. "[At the hotel]"). ' + parts.map((p, i) => `Part ${i + 1}: You are ${p.role}. ${p.setup}`).join(' '),
    hidden: parts.map((p) => p.hidden).join(' '),
  };
}

// ---------------- 準備 ----------------
function prep(id) {
  const q = query();
  const scene = id === 'full-trip' ? fullTripScene() : findScene(id);
  if (!scene || scene.lv > state.progress.unlocked) { location.replace('#/'); return; }
  const isTest = q.test === '1';
  const retention = q.retention === '1';
  const noSupport = q.ns === '1';
  const stage = isTest ? 'free' : stageOf(scene, noSupport);
  const L = levelOf(scene.lv);
  const ptt = state.settings.ptt === 'auto' ? scene.lv <= 3 : state.settings.ptt === 'on';
  const run = state.progress.testRun;
  const partNote = isTest && TESTS[scene.lv].length > 1 ? `<p class="fine">全${TESTS[scene.lv].length}部のうち 第${scene.part}部。各部の平均点で判定します。</p>` : '';
  app.innerHTML = `
  ${head(isTest ? '昇格テスト' : '準備', `#/level/${scene.lv}`)}
  <section class="prep">
    <div class="boarding">
      <div class="bp-row"><span>場面</span><strong>${esc(scene.title)}</strong></div>
      <div class="bp-row"><span>相手</span><strong>${esc(scene.roleJa)}（${esc(scene.aiName)}）</strong></div>
      <div class="bp-goal"><span>目的</span><p>${esc(scene.goalJa)}</p></div>
      <div class="bp-foot"><span>Lv${scene.lv}</span><span>${esc(isTest ? 'ヒントなし・1回限り' : STAGE_LABEL[stage])}</span><span>${id === 'full-trip' ? '最大20分' : `最大${state.settings.mode === 'paid' ? PAID_LIMIT_MIN : FREE_SESSION_MIN}分`}</span></div>
    </div>
    ${partNote}
    ${stage === 'full' && scene.phrases?.length ? `
      <h2>口慣らし</h2>
      <p class="fine">タップして聞き、声に出して言ってみましょう。</p>
      <ul class="drill">${scene.phrases.map(([en, ja]) => `
        <li><button data-say="${esc(en)}">${icon('play')}<span>${esc(en)}<small>${esc(ja)}</small></span></button>
        <button class="slow" data-slow="${esc(en)}" aria-label="ゆっくり再生">ゆっくり</button></li>`).join('')}</ul>` : ''}
    ${stage === 'assist' ? '<p class="fine">ヒントは会話中に「ヒント」を押したときだけ出ます。言い直しの指摘は会話のあとにまとめて表示します。</p>' : ''}
    ${stage === 'free' && !isTest ? '<p class="fine">台本も日本語もありません。相手は状況に合わせて自由に話します。予想外の質問にも落ち着いて答えましょう。</p>' : ''}
    <ul class="tips">
      <li>イヤホンを使うと聞き取りが安定し、AIが自分の声を拾いにくくなります。</li>
      <li>${ptt ? '<strong>「話す」</strong>を押してから英語で話し、話し終わったら<strong>「送る」</strong>を押します。' : '話し終わると自動で送ります。考え中の沈黙が長いと途中で送られることがあります。'}</li>
      <li>AIが話している途中でも、${ptt ? '「話す」を押せば' : '話し始めれば'}AIは止まります。</li>
    </ul>
    <div class="mic-test">
      <button class="outline" data-act="mic-test">${icon('mic')}<span>マイクをテストする</span></button>
      <div class="meter" aria-hidden="true"><i></i></div>
      <p class="diag fine">声を出して、バーが動けばマイクは使えます。</p>
    </div>
    <button class="wide" data-act="start">${icon('mic')}会話を始める</button>
    <p class="fine center">開始するとマイクの使用許可を求められます。録音は保存せず、文字起こしだけを端末に残します。</p>
  </section>`;
  app.querySelector('[data-act=mic-test]').onclick = () => micTest(app.querySelector('.mic-test'));
  app.querySelector('[data-act=start]').onclick = async (e) => {
    e.target.disabled = true;
    if (state.settings.mode === 'free' && usageOf().sessions >= FREE_DAILY_GUIDE * 2 && shouldShowUpgrade('rate')) upgradeSheet('rate');
    const limitMin = id === 'full-trip' ? 20 : state.settings.mode === 'paid' ? PAID_LIMIT_MIN : FREE_SESSION_MIN;
    try {
      const ok = await startTalk(app, {
        scene, stage, isTest, retention, noSupport, limitMin,
        onQuota: (repeated) => { if (repeated && shouldShowUpgrade('rate')) setTimeout(() => upgradeSheet('rate'), 1500); },
        onDone: (session) => afterTalk(session, scene, { isTest, retention, run }),
      });
      if (!ok) e.target.disabled = false;
      else history.replaceState(null, '', '#/talk');
    } catch (err) {
      e.target.disabled = false;
      const msg = err.name === 'NotAllowedError' ? 'マイクの使用が許可されていません。Safari の設定でマイクを許可してください。'
        : err.isQuota ? 'Gemini の利用上限に達しています。しばらく待ってからお試しください。' : err.message;
      toast(msg);
      prep(id);
    }
  };
}

function drillHandler(e) {
  const a = e.target.closest('[data-say]');
  if (a && !a.closest('.talk')) speak(a.dataset.say);
  const b = e.target.closest('[data-slow]');
  if (b) speak(b.dataset.slow, { slow: true });
}

async function afterTalk(session, scene, { isTest, retention }) {
  if (retention && session.scores) await recordRetention(scene.id, session.scores.total);
  if (isTest) {
    const parts = TESTS[scene.lv];
    const p = state.progress;
    if (parts.length > 1) {
      const runIds = scene.part === 1 ? [] : (p.testRun?.lv === scene.lv ? p.testRun.ids : []);
      runIds.push(session.id);
      p.testRun = { lv: scene.lv, ids: runIds };
      await saveProgress();
      if (scene.part < parts.length) {
        location.hash = `#/result/${session.id}?next=${parts[scene.part].id}`;
        return;
      }
      const list = runIds.map((id) => state.sessions.find((s) => s.id === id)).filter((s) => s?.scores);
      const avg = list.length === parts.length ? Math.round(list.reduce((a, s) => a + s.scores.total, 0) / list.length) : 0;
      p.testRun = null;
      session.testAvg = avg;
      await put('sessions', session);
      session.testResult = await recordTest(scene.lv, avg);
    } else if (session.scores) {
      session.testResult = await recordTest(scene.lv, session.scores.total);
    }
    await put('sessions', session);
  }
  location.hash = `#/result/${session.id}`;
}

// ---------------- 振り返り ----------------
function result(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) { location.replace('#/'); return; }
  const scene = s.sceneId === 'full-trip' ? fullTripScene() : findScene(s.sceneId);
  const q = query();
  // URL から来る値は既知の場面だけ通す
  const next = q.next && findScene(q.next) ? q.next : '';
  const sc = s.scores;
  const axes = sc ? [['目的達成', sc.goal, 30], ['伝わりやすさ', sc.clarity, 20], ['文法・語彙', sc.grammar, 20], ['流暢さ', sc.fluency, 15], ['自立度', sc.independence, 15]] : [];
  const tr = s.testResult;
  const verdict = s.isTest && tr ? (tr.passed ? '合格' : '不合格') : s.goalAchieved ? '達成' : 'もう一歩';
  const weak = sc ? axes.map(([n, v, m]) => [n, v / m]).sort((a, b) => a[1] - b[1])[0][0] : '';
  app.innerHTML = `
  ${head('振り返り', `#/level/${Number(s.lv) || 1}`)}
  <section class="result">
    ${sc ? `
    <div class="score-card">
      <div class="big"><strong>${Number(s.testAvg ?? sc.total)}</strong><span>${s.testAvg != null ? '3部の平均点' : '/ 100点'}</span></div>
      <span class="verdict ${s.goalAchieved || tr?.passed ? 'ok' : 'ng'}">${verdict}<small>${fmtDate(s.at)}</small></span>
    </div>
    ${tr ? `<p class="notice ${tr.passed ? 'ok' : ''}">${tr.passed ? (tr.newLevel ? `Lv${Number(tr.newLevel)} が解放されました。` : s.lv === 10 ? '卒業試験に合格しました。一人旅に出られる力がついています。' : '合格しました。') : `合格まであと少しです。弱かった観点は「${esc(weak)}」。24時間後に再受験できます。`}</p>` : ''}
    <ul class="axes">${axes.map(([n, v, m]) => `<li><span>${n}</span><meter min="0" max="${m}" value="${Number(v)}"></meter><b>${Number(v)}<small>/${m}</small></b></li>`).join('')}</ul>
    <p class="summary">${esc(s.summaryJa)}</p>
    <p class="next"><span>次回の課題</span>${esc(s.nextTaskJa)}</p>
    <p class="fine">点数と言い直し例はAIによる判定で、目安です。音声認識の聞き違いが含まれることもあります。</p>
    ` : `<div class="notice">${esc(s.scoreError || '採点できませんでした')}<br><button class="btn" data-act="rescore">採点をやり直す</button></div>`}

    ${s.corrections?.length ? `
    <h2>こう言うと自然</h2>
    <ul class="fixes">${s.corrections.map((c, i) => {
      const card = state.cards.find((x) => x.id === s.cardIds?.[i]);
      return `<li>
        <p class="you">${esc(c.you)}</p>
        <p class="better">${esc(c.better)}</p>
        <p class="note">${esc(c.noteJa)}</p>
        <div class="row">
          <button data-say="${esc(c.better)}">${icon('play')}聞く</button>
          <button data-slow="${esc(c.better)}">ゆっくり</button>
          ${sr() ? `<button data-try="${esc(c.better)}">${icon('mic')}言ってみる</button>` : ''}
          ${s.isTest ? '' : `<button class="card-toggle" data-card="${i}">${card && !card.removed ? '復習カードに追加済み' : '復習カードに追加'}</button>`}
        </div>
        <p class="try-out" hidden></p>
      </li>`;
    }).join('')}</ul>` : ''}

    <details class="transcript" ${sc ? '' : 'open'}><summary>文字起こし全文</summary>
      ${s.transcript.length ? s.transcript.map((t) => `<p class="${t.who === 'ai' ? 'ai' : 'me'}"><b>${t.who === 'ai' ? esc(scene?.aiName || 'AI') : 'あなた'}</b>${esc(t.text)}</p>`).join('') : '<p>会話の記録がありません。</p>'}
    </details>
    ${next ? `<a class="wide btn" href="#/prep/${esc(next)}?test=1">次の部へ進む</a>` : `
    <div class="actions">
      <a class="btn" href="#/prep/${esc(s.sceneId)}">もう一度</a>
      <a class="btn outline" href="#/">ホームへ</a>
    </div>`}
  </section>`;
  bindTry(app);
  app.querySelector('[data-act=rescore]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = '採点中…';
    const due = (s.dueIds || []).map((cid) => state.cards.find((c) => c.id === cid)).filter(Boolean);
    await scoreSession(s, scene, due);
    await put('sessions', s);
    if (s.isTest && s.scores && TESTS[s.lv].length === 1) { s.testResult = await recordTest(s.lv, s.scores.total); await put('sessions', s); }
    result(id);
  });
  app.querySelectorAll('[data-card]').forEach((b) => b.addEventListener('click', async () => {
    const i = Number(b.dataset.card);
    s.cardIds ||= [];
    const card = state.cards.find((x) => x.id === s.cardIds[i]);
    if (card && !card.removed) {
      card.removed = true;
      card.done = true;
      await remove('cards', card.id);
      state.cards = state.cards.filter((x) => x !== card);
      b.textContent = '復習カードに追加';
    } else {
      const c = await addCard(s.corrections[i], scene);
      s.cardIds[i] = c.id;
      await put('sessions', s);
      b.textContent = '復習カードに追加済み';
    }
  }));
}

// 言い直し練習：端末の音声認識（対応ブラウザのみ）で言えたか確かめる
const sr = () => window.SpeechRecognition || window.webkitSpeechRecognition;
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
function bindTry(root) {
  root.querySelectorAll('[data-try]').forEach((b) => b.addEventListener('click', () => {
    const SR = sr();
    const out = b.closest('li').querySelector('.try-out');
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = false;
    out.hidden = false;
    out.textContent = '聞いています…';
    rec.onresult = (e) => {
      const said = e.results[0][0].transcript;
      const target = norm(b.dataset.try);
      const got = new Set(norm(said));
      const hit = target.filter((w) => got.has(w)).length / target.length;
      out.textContent = `${hit >= 0.8 ? '言えました' : 'もう一度'}：「${said}」`;
      out.className = `try-out ${hit >= 0.8 ? 'ok' : ''}`;
      b.dispatchEvent(new CustomEvent('tried', { bubbles: true, detail: hit >= 0.8 }));
    };
    rec.onerror = () => { out.textContent = '聞き取れませんでした。マイクの許可を確認してください。'; };
    rec.start();
  }));
}

// ---------------- 復習 ----------------
function review() {
  const due = dueCards();
  const upcoming = state.cards.filter((c) => !c.done && c.due > Date.now()).length;
  const flagged = state.progress.needsReview.map(findScene).filter(Boolean);
  app.innerHTML = `
  ${head('復習')}
  <section class="review">
    <p class="lead">指摘された言い方を 1・3・7・14日後にくり返します。会話の中でも自然に出題されます。</p>
    <h2>今日の復習カード <small>${due.length}枚</small></h2>
    ${due.length ? `<ul class="fixes">${due.map((c) => `
      <li data-id="${esc(c.id)}">
        <p class="you">${esc(c.you)}</p>
        <p class="better">${esc(c.better)}</p>
        <p class="note">${esc(c.noteJa)}</p>
        <div class="row">
          <button data-say="${esc(c.better)}">${icon('play')}聞く</button>
          ${sr() ? `<button data-try="${esc(c.better)}">${icon('mic')}言ってみる</button>` : ''}
          <button class="ok" data-rate="1">言えた</button>
          <button data-rate="0">まだ</button>
        </div>
        <p class="try-out" hidden></p>
        <p class="fine">段階 ${c.stage + 1}/${SRS_DAYS.length}</p>
      </li>`).join('')}</ul>` : `<p class="empty">今日の復習はありません。${upcoming ? `次に出てくるカードが ${upcoming}枚あります。` : '会話のあとに指摘された表現がここに貯まります。'}</p>`}
    <h2>要復習の場面</h2>
    ${flagged.length ? `<ul class="scene-list">${flagged.map((s) => `<li><a href="#/prep/${s.id}?retention=1"><span class="sc-title">${esc(s.title)}</span><span class="sc-goal">Lv${s.lv} · 定着チェックで60点未満でした</span></a></li>`).join('')}</ul>`
      : '<p class="empty">要復習の場面はありません。</p>'}
  </section>`;
  bindTry(app);
  app.querySelectorAll('[data-rate]').forEach((b) => b.addEventListener('click', async () => {
    const li = b.closest('li');
    const c = state.cards.find((x) => x.id === li.dataset.id);
    await reviewCard(c, b.dataset.rate === '1');
    li.classList.add('gone');
    setTimeout(review, 300);
  }));
}

// ---------------- 成長記録 ----------------
function growth() {
  const list = state.sessions.filter((s) => s.scores);
  const totalMin = Math.round(state.sessions.reduce((a, s) => a + (s.durationSec || 0), 0) / 60);
  const achieved = new Set(list.filter((s) => s.goalAchieved).map((s) => s.sceneId)).size;
  const passed = LEVELS.filter((L) => state.progress.tests[L.lv]?.passedAt).pop();
  const keys = [['goal', '目的達成', 30], ['clarity', '伝わりやすさ', 20], ['grammar', '文法・語彙', 20], ['fluency', '流暢さ', 15], ['independence', '自立度', 15]];
  const recent = list.slice(-5);
  const prev = list.slice(-10, -5);
  const avg = (arr, k) => (arr.length ? arr.reduce((a, s) => a + s.scores[k] / keys.find((x) => x[0] === k)[2], 0) / arr.length : null);
  app.innerHTML = `
  ${head('成長記録')}
  <section class="growth">
    <div class="facts">
      <div><strong>${totalMin}</strong><span>話した分数</span></div>
      <div><strong>${achieved}</strong><span>達成した場面</span></div>
      <div><strong>${passed ? esc(passed.cefr) : '—'}</strong><span>CEFR目安</span></div>
    </div>
    <h2>総合点の推移</h2>
    ${list.length >= 2 ? chart(list.slice(-30).map((s) => s.scores.total)) : '<p class="empty">2回以上会話するとグラフが表示されます。</p>'}
    <h2>観点別（直近5回${prev.length ? ' と その前の5回' : ''}）</h2>
    <ul class="axes">${keys.map(([k, n]) => {
      const a = avg(recent, k);
      const b = avg(prev, k);
      return `<li><span>${n}</span><meter min="0" max="1" value="${a ?? 0}"></meter><b>${a == null ? '—' : Math.round(a * 100)}<small>${b == null ? '%' : `% (${a >= b ? '+' : ''}${Math.round((a - b) * 100)})`}</small></b></li>`;
    }).join('')}</ul>
    <h2>レベル別の練習</h2>
    <ul class="lv-rows">${LEVELS.filter((L) => L.lv <= state.progress.unlocked).map((L) => {
      const st = testStatus(L.lv);
      return `<li><span>Lv${L.lv} ${esc(L.title)}</span><span>${practiceOf(L.lv).length}回 · 直近平均 ${st.avg || '—'}</span></li>`;
    }).join('')}</ul>
  </section>`;
}

function chart(values) {
  const w = 320, h = 140, pad = 8;
  const step = (w - pad * 2) / (values.length - 1);
  const y = (v) => h - pad - (v / 100) * (h - pad * 2);
  const pts = values.map((v, i) => `${pad + i * step},${y(v)}`).join(' ');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="総合点の推移">
    <line x1="${pad}" x2="${w - pad}" y1="${y(UNLOCK_AVG)}" y2="${y(UNLOCK_AVG)}" class="guide"/>
    <text x="${w - pad}" y="${y(UNLOCK_AVG) - 4}" text-anchor="end" class="guide-t">${UNLOCK_AVG}点</text>
    <polyline points="${pts}" class="line"/>
    ${values.map((v, i) => `<circle cx="${pad + i * step}" cy="${y(v)}" r="3" class="dot"/>`).join('')}
  </svg>`;
}

// 送るもの・送り先の説明（初回設定と設定画面に表示）
const DATA_NOTICE = `
  <details class="fine-box" open><summary>あなたの声とデータの行き先</summary>
    <ul>
      <li>会話中の<b>声</b>と<b>文字起こし</b>は、AIが応答・採点するために Google の Gemini API に送られます。録音はこのアプリには保存しません。</li>
      <li>Gemini API の<b>無料枠</b>では、送った内容が Google のサービス改善に使われ、人が読むことがあります（有料枠では使われません）。会話の中で名前・住所・カード番号などの個人情報は話さないでください。</li>
      <li>スコア・文字起こし・復習カードは、この端末の中（ブラウザ）にだけ保存されます。設定の「すべてのデータを消す」で削除できます。</li>
    </ul>
  </details>`;

// ---------------- APIキーの初回設定 ----------------
function setup() {
  const has = !!apiKey.get();
  app.innerHTML = `
  <section class="setup">
    <h1 class="brand">旅する英会話</h1>
    <p class="lead">AIと英語で話しながら、一人で海外旅行に行ける会話力をめざすアプリです。あなた自身の Gemini APIキーで動きます（無料枠で使えます）。</p>
    <h2>APIキーの取り方</h2>
    <ol class="steps">
      <li><b>Google AI Studio を開く</b><span>下のボタンから開き、Googleアカウントでログインします。</span>
        <a class="btn outline" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio を開く</a></li>
      <li><b>「APIキーを作成」を押す</b><span>画面右上の「Create API key」を押し、プロジェクトを選ぶ（なければ新規作成）とキーが表示されます。</span>
        <div class="mock"><span class="mock-btn">Create API key</span><span class="mock-key">AIza••••••••••••••••</span></div></li>
      <li><b>キーをコピーして下に貼り付ける</b><span>キーは他人に見せないでください。この端末の中だけに保存され、Google 以外には送られません。</span></li>
    </ol>
    <form class="key-form">
      <label for="key">Gemini APIキー</label>
      <input id="key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="AIza…" ${has ? 'value="********"' : ''}>
      <label class="check"><input type="checkbox" id="remember" ${has && !apiKey.remembered() ? '' : 'checked'}><span>この端末に保存する（共有端末ではオフに。閉じると消えます）</span></label>
      <button class="wide" type="submit">キーを確かめて始める</button>
      <p class="form-msg" role="status"></p>
    </form>
    ${DATA_NOTICE}
    <details class="fine-box"><summary>キーを守るために</summary>
      <p>Google Cloud コンソールの「認証情報」で、このキーの使い道を「Generative Language API」だけに制限し、ウェブサイトの制限にこのアプリのアドレスを登録すると、万一キーが漏れても悪用されにくくなります。</p>
    </details>
  </section>`;
  const form = app.querySelector('.key-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = form.querySelector('.form-msg');
    const input = form.querySelector('#key').value.trim();
    const key = input === '********' ? apiKey.get() : input;
    if (!key) { msg.textContent = 'APIキーを貼り付けてください。'; return; }
    msg.textContent = 'キーを確認しています…';
    form.querySelector('button').disabled = true;
    try {
      const models = await listModels(key);
      const live = liveModels(models);
      const text = textModels(models);
      if (!live.length) throw new Error('このキーでは音声会話モデルが使えません。Google AI Studio で Live API が使えるか確認してください。');
      if (!text.lite.length && !text.flash.length) throw new Error('採点用のテキストモデルが見つかりません。');
      apiKey.set(key, form.querySelector('#remember').checked);
      const s = state.settings;
      if (!live.includes(s.liveModel)) s.liveModel = live[0];
      if (![...text.lite, ...text.flash].includes(s.textModel)) s.textModel = text.lite[0] || text.flash[0];
      s.detailedModel = text.flash[0] || s.textModel;
      s.availableLive = live;
      s.availableText = [...text.lite, ...text.flash];
      await saveSettings();
      toast('キーを確認しました');
      location.hash = '#/';
    } catch (err) {
      msg.textContent = err.message;
      form.querySelector('button').disabled = false;
    }
  });
}

// ---------------- 設定 ----------------
function settings() {
  const s = state.settings;
  const opt = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const mu = monthUsage();
  const min = Math.round(mu.liveSec / 60);
  app.innerHTML = `
  ${head('設定')}
  <section class="settings">
    <form class="form">
      <h2>会話</h2>
      <label>AIの声<select name="voice">${opt(VOICES.map(([v, d]) => [v, `${v}（${d}）`]), s.voice)}</select></label>
      <label>講師の厳しさ（採点）<select name="strict">${opt([['gentle', '優しい'], ['normal', '普通'], ['strict', '厳しい']], s.strict)}</select></label>
      <label>押して話すモード<select name="ptt">${opt([['auto', '自動（Lv1〜3は押して話す）'], ['on', 'いつも押して話す'], ['off', 'いつも自動で判定']], s.ptt)}</select></label>
      <p class="fine">AIの話す速さはレベルごとに決まり、会話中の「Slower, please」で一段ずつ落とせます。</p>

      <h2>利用枠</h2>
      <label>モード<select name="mode">${opt([['free', '無料枠モード'], ['paid', '有料枠モード（課金を有効にした方）']], s.mode)}</select></label>
      ${s.mode === 'paid' ? `
        <div class="meter-box"><span>今月の会話 ${min} / ${Number(s.monthlyCapMin)} 分</span><meter min="0" max="${Number(s.monthlyCapMin)}" value="${min}"></meter>
        <span class="fine">概算 ${Math.round(min * 1.8)}〜${Math.round(min * 5.3)} 円（実際の請求は Google AI Studio で確認してください）</span></div>
        <label>月の上限（分）<input name="monthlyCapMin" type="number" min="10" step="10" value="${Number(s.monthlyCapMin)}"></label>
        <label class="check"><input type="checkbox" name="detailedScoring" ${s.detailedScoring ? 'checked' : ''}><span>詳しい採点（上位モデル・発音のヒントつき）</span></label>`
        : `<button type="button" class="outline wide" data-act="upgrade">有料枠でできること</button>`}

      <h2>モデル</h2>
      <label>会話モデル<select name="liveModel">${opt((s.availableLive || [s.liveModel]).map((m) => [m, m]), s.liveModel)}</select></label>
      <label>採点モデル<select name="textModel">${opt((s.availableText || [s.textModel]).map((m) => [m, m]), s.textModel)}</select></label>
      <p class="fine">一覧はAPIキーの確認時に取得しています。新しいモデルが出たらキーを確かめ直すと更新されます。</p>
    </form>
    <h2>APIキー</h2>
    <p class="fine">${apiKey.get() ? (apiKey.remembered() ? 'この端末に保存されています。' : 'このタブを閉じるまで有効です（保存していません）。') : '未設定です。'}</p>
    <div class="actions">
      <a class="btn outline" href="#/setup">キーを変更・確認</a>
      <button class="outline" data-act="forget">キーを削除</button>
    </div>
    <h2>データ</h2>
    <p class="fine">スコア履歴と復習カードはこの端末の中だけにあります。機種変更の前に書き出してください。</p>
    <div class="actions">
      <button class="outline" data-act="export">ファイルに書き出す</button>
      <label class="btn outline file">読み込む<input type="file" accept="application/json" hidden></label>
    </div>
    <button class="outline wide danger" data-act="wipe">すべてのデータを消す</button>
    ${DATA_NOTICE}
  </section>`;
  app.querySelector('[data-act=wipe]').onclick = async () => {
    if (!confirm('スコア・文字起こし・復習カード・設定・APIキーを、この端末からすべて消します。元に戻せません。よろしいですか？')) return;
    await wipeAll();
    apiKey.set('', false);
    await loadState();
    toast('すべてのデータを消しました');
    location.hash = '#/setup';
  };
  const form = app.querySelector('.form');
  form.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.name === 'detailedScoring') s.detailedScoring = el.checked;
    else if (el.name === 'monthlyCapMin') s.monthlyCapMin = Math.max(10, Number(el.value) || 300);
    else if (el.name) s[el.name] = el.value;
    await saveSettings();
    if (el.name === 'mode') settings();
  });
  app.querySelector('[data-act=upgrade]')?.addEventListener('click', () => upgradeSheet('feature'));
  app.querySelector('[data-act=forget]').onclick = () => {
    if (!confirm('この端末からAPIキーを削除しますか？')) return;
    apiKey.set('', false);
    location.hash = '#/setup';
  };
  app.querySelector('[data-act=export]').onclick = async () => {
    const blob = new Blob([JSON.stringify(await exportAll(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `eikaiwa-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  app.querySelector('input[type=file]').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f || !confirm('いまのデータを読み込んだファイルの内容で置き換えます。よろしいですか？')) return;
    try {
      await importAll(JSON.parse(await f.text()));
      await loadState();
      toast('読み込みました');
      location.hash = '#/';
    } catch (err) { toast(err.message || '読み込めませんでした'); }
  };
}

// ---------------- 有料枠への案内（8.1）----------------
function upgradeSheet(reason) {
  if (!shouldShowUpgrade(reason)) return;
  markUpgradeShown();
  const lead = {
    feature: 'この機能は有料枠向けです。',
    rate: 'Gemini の無料枠の上限に何度か達しています。',
    lv8: 'Lv8 到達おめでとうございます。ここからは会話が長くなりがちです。',
  }[reason];
  const d = modal(`
    <h2>有料枠に切り替えると</h2>
    <p>${lead}基本機能は無料枠のまま使い続けられます。</p>
    <table class="compare">
      <thead><tr><th></th><th>無料枠</th><th>有料枠</th></tr></thead>
      <tbody>
        <tr><th>Lv1〜10の場面会話</th><td>1回8分まで</td><td>1回15分まで</td></tr>
        <tr><th>採点</th><td>軽量モデル</td><td>上位モデルで詳しく</td></tr>
        <tr><th>通し旅行</th><td>場面ごとに分割</td><td>一気に通しで</td></tr>
        <tr><th>1日の回数</th><td>目安 ${FREE_DAILY_GUIDE}回</td><td>上限なし（月の上限分数を設定）</td></tr>
      </tbody>
    </table>
    <p class="fine">費用の目安：毎日10分で月 約550〜1,600円。</p>
    <ol class="steps small">
      <li>Google AI Studio を開き、左の「Billing」または「プランを設定」を選ぶ</li>
      <li>お支払い方法を登録して課金を有効にする</li>
      <li>このアプリの設定で「有料枠モード」を選び、月の上限分数を決める</li>
    </ol>
    <div class="actions">
      <a class="btn" href="https://aistudio.google.com/" target="_blank" rel="noopener">AI Studio を開く</a>
      <button class="outline" data-close>今はしない</button>
    </div>`);
  return d;
}

// ---------------- 起動 ----------------
await loadState();
window.addEventListener('hashchange', render);
app.addEventListener('click', drillHandler);
render();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
