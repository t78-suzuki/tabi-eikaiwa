// 評価・レベルアップ判定・復習（間隔反復）・利用量（仕様書 6章・8.1）
import { kvGet, kvSet, getAll, put } from './store.js';
import { LEVELS, SCENES, levelOf } from './data.js';

const DAY = 86400000;
export const SRS_DAYS = [1, 3, 7, 14];
export const UNLOCK_AVG = 75;
export const PASS_SCORE = 80;
export const RETENTION_DAYS = 14;
export const FREE_SESSION_MIN = 8;

export const DEFAULT_SETTINGS = {
  mode: 'free', // free | paid（自己申告）
  liveModel: '',
  textModel: '',
  voice: 'Aoede',
  strict: 'normal', // gentle | normal | strict
  ptt: 'auto', // auto: Lv1-3 は押して話す / on / off
  monthlyCapMin: 300,
  detailedScoring: false,
};

const DEFAULT_PROGRESS = {
  unlocked: 1,
  current: 1,
  tests: {},
  testRun: null,
  graduated: false,
  days: [],
  upgradeShownAt: 0,
  lv8Shown: false,
  rateErrors: [],
  lastRetentionAt: 0,
  retentionSceneId: null,
  needsReview: [],
  usage: {},
};

export const state = { settings: null, progress: null, sessions: [], cards: [] };

export async function loadState() {
  state.settings = { ...DEFAULT_SETTINGS, ...(await kvGet('settings')) };
  state.progress = { ...DEFAULT_PROGRESS, ...(await kvGet('progress')) };
  state.sessions = (await getAll('sessions')).sort((a, b) => a.at - b.at);
  state.cards = await getAll('cards');
}

export const saveSettings = () => kvSet('settings', state.settings);
export const saveProgress = () => kvSet('progress', state.progress);

export const today = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const month = (t = Date.now()) => today(t).slice(0, 7);

export function streak() {
  const set = new Set(state.progress.days);
  let n = 0;
  let t = Date.now();
  if (!set.has(today(t))) t -= DAY;
  while (set.has(today(t))) { n++; t -= DAY; }
  return n;
}

// ---- 利用量 ----
export function usageOf(key = today()) {
  return state.progress.usage[key] || { liveSec: 0, textCalls: 0, sessions: 0 };
}
export function addUsage({ liveSec = 0, textCalls = 0, sessions = 0 }) {
  for (const key of [today(), month()]) {
    const u = { ...usageOf(key) };
    u.liveSec += liveSec;
    u.textCalls += textCalls;
    u.sessions += sessions;
    state.progress.usage[key] = u;
  }
  // 古い日別記録は60日で捨てる
  const cutoff = today(Date.now() - 60 * DAY);
  for (const k of Object.keys(state.progress.usage)) if (k.length === 10 && k < cutoff) delete state.progress.usage[k];
  return saveProgress();
}
export const monthUsage = () => usageOf(month());

// ---- 採点 ----
// 流暢さ(15)：話し始めまでの時間と1回の発話の長さ / 自立度(15)：ヒント・候補・日本語の使用回数
export function localScores({ lv, userTurns, helps, japaneseTurns }) {
  const L = levelOf(lv);
  if (!userTurns.length) return { fluency: 0, independence: 0 };
  const lat = userTurns.map((u) => u.latency).filter((x) => x != null);
  const avgLat = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 4;
  const latPts = 8 * Math.max(0, Math.min(1, (8 - avgLat) / 6));
  const words = userTurns.reduce((a, u) => a + u.words, 0) / userTurns.length;
  const lenPts = 7 * Math.min(1, words / L.wordsTarget);
  const fluency = Math.round(latPts + lenPts);
  const independence = Math.max(0, 15 - helps * 2 - japaneseTurns * 4);
  return { fluency, independence };
}

export function totalOf(s) {
  return s.goal + s.clarity + s.grammar + s.fluency + s.independence;
}

// ---- レベルアップ判定（6.2）----
export function practiceOf(lv) {
  return state.sessions.filter((s) => s.lv === lv && !s.isTest && !s.retention);
}

export function testStatus(lv) {
  const recent = practiceOf(lv).slice(-5);
  const avg = recent.length ? Math.round(recent.reduce((a, s) => a + s.scores.total, 0) / recent.length) : 0;
  const goals = recent.filter((s) => s.goalAchieved).length;
  const t = state.progress.tests[lv] || {};
  const waitUntil = t.lastFailAt ? t.lastFailAt + DAY : 0;
  return {
    count: recent.length,
    avg,
    goals,
    passed: !!t.passedAt,
    unlocked: recent.length >= 5 && avg >= UNLOCK_AVG && goals >= 4,
    waitUntil: waitUntil > Date.now() ? waitUntil : 0,
    lastTestScore: t.lastScore,
  };
}

// 昇格テストの結果を記録。戻り値 { passed, newLevel }
export async function recordTest(lv, score) {
  const t = { ...(state.progress.tests[lv] || {}) };
  t.lastScore = score;
  const passed = score >= PASS_SCORE;
  let newLevel = null;
  if (passed) {
    t.passedAt = Date.now();
    if (lv === 10) state.progress.graduated = true;
    else if (state.progress.unlocked < lv + 1) {
      state.progress.unlocked = lv + 1;
      state.progress.current = lv + 1;
      state.progress.lastRetentionAt = Date.now();
      newLevel = lv + 1;
    }
  } else t.lastFailAt = Date.now();
  state.progress.tests[lv] = t;
  await saveProgress();
  return { passed, newLevel };
}

// ---- 定着チェック（2週間に1回、下のレベルからランダム出題）----
export function retentionScene() {
  const p = state.progress;
  if (p.unlocked < 2) return null;
  if (p.retentionSceneId) return SCENES.find((s) => s.id === p.retentionSceneId) || null;
  if (Date.now() - p.lastRetentionAt < RETENTION_DAYS * DAY) return null;
  const pool = SCENES.filter((s) => s.lv < p.unlocked);
  const pick = pool[Math.floor(Math.random() * pool.length)];
  p.retentionSceneId = pick.id;
  saveProgress();
  return pick;
}

export async function recordRetention(sceneId, total) {
  const p = state.progress;
  p.retentionSceneId = null;
  p.lastRetentionAt = Date.now();
  p.needsReview = p.needsReview.filter((id) => id !== sceneId);
  if (total < 60) p.needsReview.push(sceneId);
  await saveProgress();
}

// ---- 復習カード（間隔反復 1・3・7・14日）----
export function dueCards(limit = 99) {
  const now = Date.now();
  return state.cards.filter((c) => !c.done && c.due <= now).sort((a, b) => a.due - b.due).slice(0, limit);
}

export async function addCard(corr, scene) {
  const exists = state.cards.find((c) => c.better.toLowerCase() === corr.better.toLowerCase());
  if (exists) return exists;
  const c = {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    you: corr.you, better: corr.better, noteJa: corr.noteJa,
    sceneId: scene.id, lv: scene.lv, createdAt: Date.now(), stage: 0, due: Date.now() + SRS_DAYS[0] * DAY, done: false,
  };
  state.cards.push(c);
  await put('cards', c);
  return c;
}

export async function reviewCard(card, ok) {
  if (ok) {
    card.stage += 1;
    if (card.stage >= SRS_DAYS.length) card.done = true;
    else card.due = Date.now() + SRS_DAYS[card.stage] * DAY;
  } else {
    card.due = Date.now() + DAY;
  }
  await put('cards', card);
}

// ---- 会話の保存 ----
export async function saveSession(s) {
  state.sessions.push(s);
  await put('sessions', s);
  const d = today();
  if (!state.progress.days.includes(d)) {
    state.progress.days.push(d);
    state.progress.days = state.progress.days.slice(-400);
    await saveProgress();
  }
}

export function bestOf(sceneId) {
  const list = state.sessions.filter((s) => s.sceneId === sceneId);
  return { count: list.length, best: list.length ? Math.max(...list.map((s) => s.scores.total)) : null };
}

// ---- 有料枠への案内（8.1）----
export function shouldShowUpgrade(reason) {
  const p = state.progress;
  if (state.settings.mode === 'paid') return false;
  if (reason === 'feature') return true; // 拡張機能を選んだときは毎回
  return Date.now() - p.upgradeShownAt > 7 * DAY;
}
export async function markUpgradeShown() {
  state.progress.upgradeShownAt = Date.now();
  await saveProgress();
}

// 制限超過エラーが10分以内に3回続いたら案内
export async function noteRateError() {
  const now = Date.now();
  const p = state.progress;
  p.rateErrors = [...p.rateErrors.filter((t) => now - t < 600000), now];
  await saveProgress();
  return p.rateErrors.length >= 3;
}

export const levelList = () => LEVELS;
