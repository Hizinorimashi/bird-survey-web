// こえログ: 圏外でも開けるように、アプリの画面と地図の絵を端末に保存する
// 保存庫の名前は必ず 'koelog-' で始める（同じサイトの鳥類調査記録アプリの保存庫に触らない・触られないため）
// AI の部品（koelog-ai-app-*）と AI 本体（birdnet-ai-model-*）は画面側が管理する。ここでは扱わない
const CACHE = 'koelog-v2';
const TILE_CACHE = 'koelog-tiles-v1';
const TILE_MAX = 3000;
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './leaflet.js', './leaflet.css'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('koelog-v') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

const scopePath = () => new URL(self.registration.scope).pathname;
const isTile = u => u.startsWith('https://cyberjapandata.gsi.go.jp/xyz/');
let tilePuts = 0;
async function handleTile(req) {
  const hit = await caches.match(req);   // 鳥類調査記録アプリが保存した地図の絵も使える
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    const c = await caches.open(TILE_CACHE);
    await c.put(req, res.clone());
    if (++tilePuts % 100 === 0) {   // 増えすぎたら古い順に消す
      const ks = await c.keys();
      if (ks.length > TILE_MAX) await Promise.all(ks.slice(0, ks.length - TILE_MAX + 500).map(k => c.delete(k)));
    }
  }
  return res;
}
// 画面本体: まず通信で新しいものを取りに行く。ただし 4秒で返事が無い（弱い電波）・異常な応答（404・500 など）のときは
// 保存してある画面を出す（監査 Major5）。保存が無いときだけ通信の結果をそのまま返す
const NET_WAIT_MS = 4000;
async function cachedShell() {
  const c = await caches.open(CACHE);
  return (await c.match('./index.html')) || (await c.match('./'));
}
async function networkFirst(req) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), NET_WAIT_MS);
  let res = null, body = null;
  try {
    res = await fetch(req.url, { cache: 'no-store', signal: ctl.signal, credentials: 'same-origin' });
    // 本文を受け取り終えるまでを時間制限に含める（本文の途中で通信が止まる場合。再監査 Major）
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) body = await res.arrayBuffer();
  } catch (e) { body = null; if (res && res.ok) res = null; }
  finally { clearTimeout(timer); }
  if (body) {
    const fresh = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    try { const c = await caches.open(CACHE); await c.put('./index.html', fresh.clone()); } catch (e) {}
    return fresh;
  }
  const hit = await cachedShell();
  return hit || res || Response.error();
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (isTile(url)) { e.respondWith(handleTile(req)); return; }
  const u = new URL(url);
  if (u.origin !== location.origin || !u.pathname.startsWith(scopePath())) return;   // AI本体など外の通信はそのまま
  if (u.pathname.startsWith(scopePath() + 'ai/')) return;                            // AIの部品は画面側が保存庫から読む
  if (req.mode === 'navigate' || u.pathname === scopePath() || u.pathname.endsWith('/index.html')) { e.respondWith(networkFirst(req)); return; }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
