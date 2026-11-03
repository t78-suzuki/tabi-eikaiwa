// 端末内保存（IndexedDB）。スコア履歴・復習カード・進捗・設定
// APIキーだけは localStorage（「保存しない」を選ぶと sessionStorage）に置く

const DB_NAME = 'eikaiwa-trip';
let dbp;

function db() {
  dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('sessions', { keyPath: 'id' });
      d.createObjectStore('cards', { keyPath: 'id' });
      d.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    let out;
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  });
}

export const kvGet = (k) => tx('kv', 'readonly', (s) => s.get(k));
export const kvSet = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k));
export const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());
export const put = (store, v) => tx(store, 'readwrite', (s) => s.put(v));
export const remove = (store, id) => tx(store, 'readwrite', (s) => s.delete(id));

export async function exportAll() {
  const kv = {};
  for (const k of ['settings', 'progress']) kv[k] = await kvGet(k);
  return { app: 'eikaiwa-trip', version: 1, exportedAt: new Date().toISOString(), kv, sessions: await getAll('sessions'), cards: await getAll('cards') };
}

export async function wipeAll() {
  for (const store of ['sessions', 'cards', 'kv']) await tx(store, 'readwrite', (s) => s.clear());
}

// 読み込むファイルは外から来たものとして形を確かめる（壊れた・細工されたファイルを入れない）
const ID_RE = /^[\w-]{1,64}$/;
const num = (v) => Number.isFinite(Number(v));
const str = (v) => v == null || typeof v === 'string';

function validSession(s) {
  return s && ID_RE.test(s.id) && ID_RE.test(s.sceneId) && num(s.lv) && num(s.at)
    && Array.isArray(s.transcript) && s.transcript.every((t) => (t.who === 'ai' || t.who === 'me') && str(t.text))
    && (s.scores == null || ['goal', 'clarity', 'grammar', 'fluency', 'independence', 'total'].every((k) => num(s.scores[k])));
}

// 進捗は知っている項目だけを型どおりに組み直す（文字列などは捨てる）
const int = (v, min, max, def) => (Number.isInteger(v) && v >= min && v <= max ? v : def);
const time = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

function cleanProgress(p) {
  if (!p || typeof p !== 'object') return null;
  const tests = {};
  for (const [lv, t] of Object.entries(p.tests || {})) {
    if (!/^(10|[1-9])$/.test(lv) || !t || typeof t !== 'object') continue;
    tests[lv] = {
      ...(Number.isFinite(t.lastScore) ? { lastScore: t.lastScore } : {}),
      ...(t.passedAt ? { passedAt: time(t.passedAt) } : {}),
      ...(t.lastFailAt ? { lastFailAt: time(t.lastFailAt) } : {}),
    };
  }
  const ids = (a) => (Array.isArray(a) ? a.filter((x) => ID_RE.test(x)) : []);
  const usage = {};
  for (const [k, u] of Object.entries(p.usage || {})) {
    if (/^\d{4}-\d{2}(-\d{2})?$/.test(k) && u) usage[k] = { liveSec: time(u.liveSec), textCalls: time(u.textCalls), sessions: time(u.sessions) };
  }
  return {
    unlocked: int(p.unlocked, 1, 10, 1),
    current: int(p.current, 1, 10, 1),
    tests,
    testRun: null,
    graduated: p.graduated === true,
    days: Array.isArray(p.days) ? p.days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [],
    upgradeShownAt: time(p.upgradeShownAt),
    lv8Shown: p.lv8Shown === true,
    rateErrors: [],
    lastRetentionAt: time(p.lastRetentionAt),
    retentionSceneId: ID_RE.test(p.retentionSceneId || '') ? p.retentionSceneId : null,
    needsReview: ids(p.needsReview),
    usage,
  };
}

// 会話記録の数値・テスト結果も型どおりに組み直す
function cleanSession(s) {
  const out = { ...s };
  if (s.scores) out.scores = Object.fromEntries(['goal', 'clarity', 'grammar', 'fluency', 'independence', 'total'].map((k) => [k, Number(s.scores[k])]));
  out.lv = Number(s.lv);
  out.at = Number(s.at);
  out.durationSec = time(Number(s.durationSec));
  out.testAvg = Number.isFinite(s.testAvg) ? s.testAvg : undefined;
  out.testResult = s.testResult && typeof s.testResult === 'object'
    ? { passed: s.testResult.passed === true, newLevel: int(s.testResult.newLevel, 2, 10, null) } : undefined;
  out.goalAchieved = s.goalAchieved === true;
  out.cardIds = ids(s.cardIds);
  out.dueIds = ids(s.dueIds);
  return out;
}
const ids = (a) => (Array.isArray(a) ? a.filter((x) => ID_RE.test(x)) : []);

function validCard(c) {
  return c && ID_RE.test(c.id) && str(c.you) && str(c.better) && str(c.noteJa) && num(c.stage) && num(c.due);
}

export async function importAll(data) {
  if (data?.app !== 'eikaiwa-trip') throw new Error('このアプリの書き出しファイルではありません。');
  const sessions = data.sessions || [];
  const cards = data.cards || [];
  if (!Array.isArray(sessions) || !sessions.every(validSession) || !Array.isArray(cards) || !cards.every(validCard)) {
    throw new Error('ファイルの中身が正しくないため、読み込みませんでした。');
  }
  const { settings, progress } = data.kv || {};
  if (settings && !num(settings.monthlyCapMin)) throw new Error('ファイルの中身が正しくないため、読み込みませんでした。');
  await wipeAll();
  if (settings) await kvSet('settings', { ...settings, monthlyCapMin: Number(settings.monthlyCapMin) });
  const p = cleanProgress(progress);
  if (p) await kvSet('progress', p);
  for (const s of sessions) await put('sessions', cleanSession(s));
  for (const c of cards) await put('cards', { ...c, stage: Number(c.stage), due: Number(c.due), lv: Number(c.lv) || 1 });
}

const KEY = 'eikaiwa.apiKey';
export const apiKey = {
  get: () => localStorage.getItem(KEY) || sessionStorage.getItem(KEY) || '',
  set(v, remember) {
    localStorage.removeItem(KEY);
    sessionStorage.removeItem(KEY);
    if (v) (remember ? localStorage : sessionStorage).setItem(KEY, v);
  },
  remembered: () => !!localStorage.getItem(KEY),
};
