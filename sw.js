const CACHE = 'bird-survey-v18';
const ASSETS = [
  './bird_survey.html',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg',
  './leaflet.css',
  './leaflet.js',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js'
];

// 地図タイル用の別キャッシュ（容量制限付き）
const TILE_CACHE = 'bird-map-tiles-v1';
const MAX_TILES = 8000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(()=>{})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== TILE_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function isTile(url){ return url.includes('cyberjapandata.gsi.go.jp'); }

async function handleTile(request){
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try{
    const res = await fetch(request);
    if (res.ok){
      const keys = await cache.keys();
      if (keys.length >= MAX_TILES){ for (let i=0;i<200;i++) await cache.delete(keys[i]); }
      cache.put(request, res.clone());
    }
    return res;
  }catch(e){
    if (cached) return cached;
    return new Response('', { status: 408 });
  }
}

// アプリ本体(HTML/JS/CSS)はネット優先で常に最新を取得し、圏外時のみキャッシュへ退避。
// 地図タイルはタイル専用キャッシュ、その他はキャッシュ優先。
function isAppShell(url){
  return url.endsWith('/bird_survey.html') || url.endsWith('/') ||
         url.endsWith('/leaflet.js') || url.endsWith('/leaflet.css') || url.endsWith('/manifest.json');
}
self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (isTile(url)){ e.respondWith(handleTile(e.request)); return; }
  if (e.request.mode === 'navigate' || isAppShell(url)){
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy).catch(()=>{}));
        return res;
      }).catch(() => caches.match(e.request).then(c => c || caches.match('./bird_survey.html')))
    );
    return;
  }
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
});
