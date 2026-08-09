const CACHE = 'bird-survey-v163';
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
// 「オフライン地図の保存」で明示的に保存したタイル。利用者が消すまで自動では消さない
//（上限・間引きなし。activateの掃除・アプリ側の「最新に更新」からも保護する）
const PACK_CACHE = 'bird-map-pack-v1';

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
function isOwnCache(k){ return k === CACHE || k === TILE_CACHE || k === PACK_CACHE
  || k.startsWith('bird-survey-') || k.startsWith('bird-map-tiles-') || k.startsWith('bird-map-pack-'); }
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    // bird-map-pack-* は利用者が保存した地図なので、版の掃除では絶対に消さない
    //（現行名だけでなくprefix全体を除外: 将来PACK_CACHE名を変えたとき旧パックが巻き添えで消えないように。
    //  旧パックの移行・削除は明示的な処理でのみ行う）
    await Promise.all(keys.filter(k => isOwnCache(k) && k !== CACHE && k !== TILE_CACHE && !k.startsWith('bird-map-pack-')).map(k => caches.delete(k)));
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
  // 明示保存分（パック）を最優先。命中すればネットにも行かない＝圏外でも確実に表示できる
  const pack = await caches.open(PACK_CACHE);
  const packed = await pack.match(request.url);
  if (packed) return packed;
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

// ページからの依頼を受ける（オフライン地図の保存・実測・削除）。
// ダウンロードのループはページ側で回し、ここは PACK_CACHE への出し入れだけを担う。
// e.waitUntil で包み、チャンク処理中にSWが打ち切られないようにする
// パック操作は到着順に1つずつ実行する（直列化）。
// 応答待ちを打ち切られた savePackTiles がまだ動いている間に countPack が先回りして
// 枚数を数えると、数えた後にタイルが増えて実態とずれるため、必ず順番待ちさせる
let packChain = Promise.resolve();
function packEnqueue(fn){ const p = packChain.then(fn, fn); packChain = p.catch(()=>{}); return p; }

self.addEventListener('message', e => {
  const m = e.data || {};
  const reply = r => { try{ e.ports[0] && e.ports[0].postMessage(r); }catch(err){} };
  if (m.type === 'countLegacy'){
    // 開いている画面のうち「この版であることを名乗れない画面（＝前の版のタブ）」を数える。
    // 数えられなかったときは ok:false を返し、アプリ側は安全側に倒して止まる
    e.waitUntil((async () => {
      try{
        const all = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
        // 数えるのはこのアプリの画面だけ。同じ場所の別のHTMLを巻き込まない
        const scopePath = new URL(self.registration.scope).pathname;   // 例: /bird-survey-web/
        // この場所のアプリ画面だけを数える（完全一致）。同じ場所の別のHTMLや別の場所のアプリを巻き込まない
        const okPaths = new Set([scopePath, scopePath + 'bird_survey.html', scopePath + 'index.html']);
        // 保存領域はオリジン全体で共有なので、別の場所に置いた bird_survey.html も検査する。
        //（index.html は場所ごとに別物があり得るので、この場所のものだけ）
        const cs = all.filter(c => {
          try{ const path = new URL(c.url).pathname;
            return okPaths.has(path) || /\/bird_survey\.html$/.test(path);
          }catch(err){ return false; }
        });
        let legacy = 0;
        await Promise.all(cs.map(c => new Promise(res => {
          const ch = new MessageChannel();
          const tm = setTimeout(() => { legacy++; res(); }, 1200);   // 遅いだけの現行タブを旧版と誤認しにくくする
          // 「この版の画面です」という形の答えだけを認める（形式の違う答えは前の版とみなす）
          ch.port1.onmessage = ev => { clearTimeout(tm);
            // 単一タブ判定の世代番号が完全に一致する画面だけを「今の版」と認める。
            // v:1 の頃の画面は使用権の名前が違い、両方が書けてしまうため legacy 扱いにする
            if(!(ev.data && ev.data.v === 3)) legacy++;   // 3=使用権をオリジン共通にした世代。v2以前は旧版扱い
            res(); };
          try{ c.postMessage({ type:'verCheck' }, [ch.port2]); }
          catch(err){ clearTimeout(tm); legacy++; res(); }
        })));
        reply({ ok:true, guardV:3, legacy, total: cs.length });   // guardV=単一タブ判定の世代番号
      }catch(err){ reply({ ok:false }); }
    })());
  } else if (m.type === 'ping'){
    // 疎通確認（アプリ更新直後、旧SWが残っていて依頼に応答できない状態を保存前に検知するため）。
    // feat はパック処理の機能改訂番号（2=15秒打ち切り・statsのerror応答あり）。v78内の改訂を区別する
    reply({ v: 78, feat: 2 });
  } else if (m.type === 'savePackTiles'){
    e.waitUntil(packEnqueue(async () => {
      let ok = 0, fail = 0;
      try{
        const pack = await caches.open(PACK_CACHE);
        for (const url of (m.urls || [])){
          const ac = new AbortController();
          const tm = setTimeout(() => ac.abort(), 15000);   // 1枚あたり15秒で打ち切り（通信が固まっても待ち行列が無限に延びない）
          try{
            if (await pack.match(url)){ ok++; continue; }   // すでに保存済み（中断後の再開・差分保存になる）
            const res = await fetch(url, { mode: 'cors', signal: ac.signal });
            // 2xxでも中身が画像でないもの（障害時のHTML等）は保存しない。
            // 一度パックに入ると match で再取得されなくなり、壊れた応答が永久に固定されるため
            const ct = (res.headers.get('content-type') || '').toLowerCase();
            if (res.ok && ct.startsWith('image/')){ await pack.put(url, res.clone()); ok++; } else fail++;
          }catch(err){ fail++; }
          finally{ clearTimeout(tm); }
        }
      }catch(err){ fail += Math.max(0, (m.urls||[]).length - ok - fail); }   // caches.open等の失敗でも必ず応答を返す
      reply({ ok, fail });
    }));
  } else if (m.type === 'countPack'){
    // 指定URLのうちパックに実在する枚数（保存後の結果照合用。本文は読まないため軽い）
    e.waitUntil(packEnqueue(async () => {
      try{
        const pack = await caches.open(PACK_CACHE);
        const have = new Set((await pack.keys()).map(r => r.url));
        let n = 0;
        for (const u of (m.urls || [])) if (have.has(u)) n++;
        reply({ count: n });
      }catch(err){ reply({ count: -1 }); }
    }));
  } else if (m.type === 'packStats'){
    e.waitUntil(packEnqueue(async () => {
      try{
        const pack = await caches.open(PACK_CACHE);
        const keys = await pack.keys();
        // 全タイルの本文を読むと数万枚では重すぎるため、200枚の実測平均×枚数で概算する
        const SAMPLE = 200;
        let bytes = 0, sampled = 0;
        const step = Math.max(1, keys.length / SAMPLE);   // 実数刻みで全体から等間隔に抽出（先頭偏重を避ける）
        for (let f = 0; f < keys.length && sampled < SAMPLE; f += step){
          const r = await pack.match(keys[Math.floor(f)]);
          try{ bytes += (await r.clone().blob()).size; sampled++; }catch(err){}
        }
        if (keys.length > 0 && sampled === 0){ reply({ error: true }); return; }   // 1枚も読めない＝計測失敗（0MBと区別）
        const est = sampled ? Math.round(bytes / sampled * keys.length) : 0;
        reply({ count: keys.length, bytes: est, sampled: sampled < keys.length });
      }catch(err){ reply({ error: true }); }   // 「0MB」と「計測失敗」を区別する（0MB扱いだと容量判定が過少になる）
    }));
  } else if (m.type === 'deletePack'){
    e.waitUntil(packEnqueue(async () => {
      try{
        const pack = await caches.open(PACK_CACHE);
        let n = 0;
        for (const url of (m.urls || [])){ if (await pack.delete(url)) n++; }
        reply({ deleted: n });
      }catch(err){ reply({ error: true }); }
    }));
  }
});

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
