// 鳴き声AI判別 試作ページ専用の圏外対策（このフォルダ内だけで働く）
// 保存領域名は本体アプリ(sw.js)の掃除対象 "bird-survey-*" と重ならない名前にする
const CACHE = 'birdnet-proto-v8';

// AI本体の置き場（birdnet-worker.js の MODEL_BASE と同じ規則）
const MODEL_BASE = self.location.hostname.endsWith('github.io')
  ? 'https://raw.githubusercontent.com/Hizinorimashi/bird-survey-web/7e1e996105e4d2bfdf1cf9e84c5c5d3d715513b5/birdnet'
  : './models/birdnet';
const MODEL_FILES = [
  'model.json',
  ...Array.from({ length: 13 }, (_, i) => `group1-shard${i + 1}of13.bin`),
  'area-model/model.json',
  'area-model/group1-shard1of2.bin',
  'area-model/group1-shard2of2.bin'
].map(f => MODEL_BASE + '/' + f);
const PRECACHE = [
  './birdnet_test.html',
  './birdnet-worker.js',
  './tf.min.js',
  './eval_list.json',
  './hokkaido_list.json',
  './hokkaido_alias.json',
  './survey_mode.js',
  './pcm-recorder.js',
  './models/birdnet/labels/en_us.txt',
  './models/birdnet/labels/ja.txt',
  ...MODEL_FILES
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('birdnet-proto-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// 画面・判別プログラムはネット優先（更新を拾う）、だめなら保存分。AI本体は保存分優先。
const NET_FIRST = ['birdnet_test.html', 'birdnet-worker.js', 'eval_list.json', 'hokkaido_list.json', 'hokkaido_alias.json', 'survey_mode.js', 'pcm-recorder.js'];

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.href.startsWith(MODEL_BASE + '/')) {   // AI本体（版を固定したアドレスのみ）: 保存分優先
    e.respondWith(caches.open(CACHE).then(c => c.match(req.url)).then(c => c || fetch(req)));
    return;
  }
  const inScope = url.href.startsWith(self.registration.scope);
  if (!inScope) return;   // 答え合わせ用の本体音声(../assets/calls/)などは素通し
  const path = url.pathname;
  if (req.mode === 'navigate' || NET_FIRST.some(n => path.endsWith('/' + n))) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      } catch (err) {
        const cached = await cache.match(req, { ignoreSearch: true });
        return cached || Response.error();
      }
    })());
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(c => c || fetch(req)));
});
