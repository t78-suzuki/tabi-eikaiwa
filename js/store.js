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

export async function importAll(data) {
  if (data?.app !== 'eikaiwa-trip') throw new Error('このアプリの書き出しファイルではありません。');
  await wipeAll();
  for (const [k, v] of Object.entries(data.kv || {})) if (v) await kvSet(k, v);
  for (const s of data.sessions || []) await put('sessions', s);
  for (const c of data.cards || []) await put('cards', c);
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
