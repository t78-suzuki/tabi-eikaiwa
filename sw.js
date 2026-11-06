// アプリ本体だけをキャッシュする（ネットワーク優先。Gemini への通信は扱わない）
const CACHE = 'eikaiwa-v3';
const SHELL = [
  './', 'index.html', 'css/app.css?v=3', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-180.png',
  'js/app.js?v=3', 'js/talk.js', 'js/live.js', 'js/audio.js', 'js/capture-worklet.js', 'js/gemini.js',
  'js/prompts.js', 'js/progress.js', 'js/store.js', 'js/data.js', 'js/ui.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    // 毎回サーバーに更新を確かめる（古いCSSとJSが混ざらないように）
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
