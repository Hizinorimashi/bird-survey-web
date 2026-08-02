const CACHE = 'bird-survey-v76';
// 必須資産（これが揃わないとアプリが成立しない）。install時に全部揃わなければ失敗させ、不完全キャッシュで有効化しない
const CORE = [
  './bird_survey.html',
  './manifest.json',
  './leaflet.css',
  './leaflet.js',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];
// 任意資産（無くても主要機能は動く）。個別に失敗を許容する
const OPTIONAL = [
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './vendor/leaflet-rotate.js'
];

// 地図タイル用の別キャッシュ（容量制限付き）。
// タイルとIndexedDB(写真・録音)は同じオリジンの保存容量を共有するため、上限を控えめにして
// タイルが写真・録音の保存を圧迫しないようにする。
const TILE_CACHE = 'bird-map-tiles-v1';
const MAX_TILES = 3000;

// URLの拡張子から期待するContent-Typeを検査する。
// HTTP 200でも認証画面・メンテHTMLなどをJS/CSS/JSONとして保存しないため。
function typeOkFor(url, res){
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (url.endsWith('.js'))  return ct.includes('javascript') || ct.includes('ecmascript');
  if (url.endsWith('.css')) return ct.includes('css');
  if (url.endsWith('.json') || url.endsWith('/manifest.json')) return ct.includes('json');
  if (url.endsWith('.svg')) return ct.includes('svg');
  if (url.endsWith('.html') || url.endsWith('/')) return ct.includes('html') || ct === '';
  return true;  // その他(画像等)は型検査しない
}
// 正常な同一オリジン応答(2xx)かつ内容型が期待どおりの時だけキャッシュ更新に使う
function cacheable(res, url){ return res && res.ok && res.type === 'basic' && typeOkFor(url, res); }
async function cachePut(cache, url){
  const res = await fetch(url, { cache: 'reload' });
  if (res.ok && typeOkFor(url, res)) { await cache.put(url, res.clone()); return true; }
  throw new Error('bad response for ' + url);
}
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(CORE.map(u => cachePut(c, u)));   // 必須。内容型NG含め1つでも失敗ならinstall失敗→再試行
    await Promise.allSettled(OPTIONAL.map(u => cachePut(c, u)));   // 任意は個別失敗を許容
  })());
  self.skipWaiting();
});

// 旧キャッシュ削除は「このアプリのキャッシュ」だけに限定する。
// 同一オリジンに別アプリ(別PWA)がある場合、そのキャッシュまで消さないため。
function isOwnCache(k){ return k === CACHE || k === TILE_CACHE || k.startsWith('bird-survey-') || k.startsWith('bird-map-tiles-'); }
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => isOwnCache(k) && k !== CACHE && k !== TILE_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();   // 開いている画面への適用も完了待ちに含める
  })());
});

function isTile(url){ return url.includes('cyberjapandata.gsi.go.jp'); }
// 静的ベンダ資産（更新頻度が低い）はキャッシュ優先で、圏外でも即表示・毎回の再取得を避ける
function isStaticVendor(url){
  return url.endsWith('/leaflet.js') || url.endsWith('/leaflet.css') ||
         url.endsWith('/vendor/pdf.min.js') || url.endsWith('/vendor/pdf.worker.min.js') ||
         url.endsWith('/vendor/leaflet-rotate.js') ||
         url.endsWith('/icon-192.svg') || url.endsWith('/icon-512.svg');
}
// アプリ本体(HTML/manifest)はネット優先で最新を取りに行く（ただしタイムアウト付き）
function isHtmlShell(url){
  return url.endsWith('/bird_survey.html') || url.endsWith('/') || url.endsWith('/manifest.json');
}
async function handleTile(request){
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try{
    const res = await fetch(request);
    if (res.ok){
      // キャッシュ保存に失敗（容量不足等）しても、取得できたタイルは必ず返す
      try{
        const keys = await cache.keys();
        if (keys.length >= MAX_TILES){ for (let i=0;i<200;i++) await cache.delete(keys[i]); }
        await cache.put(request, res.clone());
      }catch(e){}
    }
    return res;
  }catch(e){
    if (cached) return cached;
    return new Response('', { status: 408 });
  }
}

// ネット優先＋タイムアウト。時間内に取れなければキャッシュへフォールバック。
async function networkFirst(request){
  const cache = await caches.open(CACHE);
  const netP = fetch(request).then(res => {
    if (cacheable(res, request.url)) cache.put(request, res.clone()).catch(()=>{});
    return res;
  });
  const timeoutP = new Promise(resolve => setTimeout(() => resolve('timeout'), 3500));
  try{
    const r = await Promise.race([netP, timeoutP]);
    if (r !== 'timeout' && r && cacheable(r, request.url)) return r;   // 正常な2xxかつ期待どおりの内容型のみ即採用
    const cached = await cache.match(request);          // タイムアウト・障害応答(500や認証画面HTML等)→正常なキャッシュを優先
    if (cached) return cached;
    if (r !== 'timeout' && r) return r;                 // キャッシュが無ければ障害応答でもそのまま返す
    return await netP;                                  // タイムアウトかつキャッシュ無し→ネット完了を待つ
  }catch(e){
    const cached = await cache.match(request);
    return cached || cache.match('./bird_survey.html');
  }
}

// キャッシュ優先。無ければネット取得し、正常なら保存。
// 静的資産(JS/CSS等)の取得失敗時にHTMLを返すのは不適切なので、その場合はエラー応答を返す。
async function cacheFirst(request){
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try{
    const res = await fetch(request);
    if (cacheable(res, request.url)) cache.put(request, res.clone()).catch(()=>{});
    return res;
  }catch(e){
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  // GoogleドライブAPI・認証はSWを介さない（キャッシュ誤混入・認証干渉の防止。ドライブ同期のダウンロードはGETで来る）
  if (url.startsWith('https://www.googleapis.com/') || url.startsWith('https://accounts.google.com/')) return;
  if (isTile(url)){ e.respondWith(handleTile(req)); return; }
  if (req.mode === 'navigate' || isHtmlShell(url)){ e.respondWith(networkFirst(req)); return; }
  if (isStaticVendor(url)){ e.respondWith(cacheFirst(req)); return; }
  e.respondWith(caches.match(req).then(cached => cached || fetch(req)));
});
