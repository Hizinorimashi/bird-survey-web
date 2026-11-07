// 連続モード（調査中ずっと聞いて判別し、結果と鳴き声の前後数秒だけ残す）。試作。
// birdnet_test.html の ask / combinedList / labels / sciIndex / l2 / updateArea / esc などを使う。
// 2026-11-07 Codex監査（Major 7件・Minor 3件）を反映:
//  - 切り出し範囲の窓がすべて判別済みになるまで音を保存しない（人の声の判定漏れ防止）
//  - 開始・停止・再開ごとに世代番号を進め、古い処理の結果は捨てる
//  - 音の保存は1本の列で順に行い、入れ替え（削除＋追加）は同じトランザクションで
//  - 処理が遅れてリングから消えた音は「欠測」として扱い、推論にも保存にも使わない
//  - 調査は1件だけ保持し、開き直しても復元・書き出し・消去できる（保存領域を際限なく使わない）
//  - 時間帯の表は検出ごとの時刻で数える
'use strict';
(function () {
  const SR = 48000, WIN = 144000;          // 3秒窓（重ねずに順に判別）
  const RING_SEC = 45;                     // 直近45秒の音を持っておく（切り出し用）
  const BATCH = 4;                         // 一度にAIへ渡す窓の数
  const GAP_MERGE = 5;                     // 同じ種の検出をまとめる間隔（窓数＝15秒）
  const HUMAN_THR = 0.3;                   // 人の声とみなす値
  const POS_MAX_AGE = 60000;               // 位置を使ってよい時間差（ms）
  const MAX_SPECIES_PER_WIN = 3;           // 1つの3秒区間で記録する種の上限（同時に鳴く複数種）
  const NONBIRD_SCI = ['Dog', 'Engine', 'Environmental', 'Fireworks', 'Gun', 'Human non-vocal', 'Human vocal',
    'Human whistle', 'Noise', 'Power tools', 'Siren'];

  const S = {
    running: false, starting: false, gen: 0,
    ctx: null, stream: null, node: null, wakeLock: null, geoId: null, pos: null,
    ring: new Float32Array(SR * RING_SEC), written: 0, next: 0, judged: 0, busy: null,
    seg: null,                 // {t0: 区間の録音開始時刻(ms), id}
    sessionId: null, sessionStart: null,
    events: [], gaps: [], pendingClips: [], humanWins: new Set(), lost: [],
    clipQueue: Promise.resolve(),
    stats: { wins: 0, procMs: 0, lagSec: 0 }
  };
  window.SURVEY = S;

  let nonBirdNames = null, humanIdx;
  function initNames() {
    if (nonBirdNames) return;
    nonBirdNames = new Set(NONBIRD_SCI.filter(s => sciIndex[s] !== undefined).map(s => nameOf(sciIndex[s])));
    humanIdx = sciIndex['Human vocal'];
  }

  // ---- 保存（クリップ音声と調査の記録）。調査は常に1件だけ保持する ----
  let dbP = null;
  function sdb() {
    if (!dbP) dbP = new Promise((res, rej) => {
      const r = indexedDB.open('birdnet-survey', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('clips')) db.createObjectStore('clips', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      };
      r.onsuccess = () => { const db = r.result; db.onversionchange = () => { db.close(); dbP = null; }; res(db); };
      r.onerror = () => { dbP = null; rej(r.error); };
    });
    return dbP;
  }
  function txDone(tx) { return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('abort')); }); }
  async function sget(store, id) { const db = await sdb(); return new Promise((res, rej) => { const r = db.transaction(store).objectStore(store).get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async function sall(store) { const db = await sdb(); return new Promise((res, rej) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  // 古い音の削除と新しい音の追加を、同じトランザクションで行う（途中で失敗したら両方取り消し）
  async function sReplace(delId, putObj) {
    const db = await sdb();
    const tx = db.transaction('clips', 'readwrite'), st = tx.objectStore('clips');
    if (delId) st.delete(delId);
    st.put(putObj);
    return txDone(tx);
  }
  async function sClearAll() {
    const db = await sdb();
    const tx = db.transaction(['clips', 'sessions'], 'readwrite');
    tx.objectStore('clips').clear(); tx.objectStore('sessions').clear();
    return txDone(tx);
  }
  function sessionObj() { return { id: S.sessionId, start: S.sessionStart, events: S.events, gaps: S.gaps }; }
  async function saveSessionNow() {
    if (!S.sessionId) return;
    const db = await sdb();
    const tx = db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').put(sessionObj());
    return txDone(tx);
  }
  let saveTimer = null;
  function saveSessionSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveSessionNow().catch(err => console.warn('記録の保存に失敗', err)), 3000);
  }

  // ---- 時刻 ----
  const tOfSeg = (seg, s) => seg.t0 + s / SR * 1000;
  const hms = t => new Date(t).toTimeString().slice(0, 8);
  const hm = t => new Date(t).toTimeString().slice(0, 5);

  // ---- 音の受け取り ----
  function onPcm(chunk) {
    const L = S.ring.length;
    for (let i = 0; i < chunk.length; i++) S.ring[(S.written + i) % L] = chunk[i];
    S.written += chunk.length;
    pump();
  }
  // 区間[a,b)の音を取り出す。すでにリングから消えている、またはまだ録れていなければ null
  function ringGet(a, b) {
    const L = S.ring.length;
    if (a < 0 || a < S.written - L || b > S.written) return null;
    const out = new Float32Array(b - a);
    for (let s = a; s < b; s++) out[s - a] = S.ring[s % L];
    return out;
  }
  const overlapsLost = (a, b) => S.lost.some(([x, y]) => a < y && x < b);

  // ---- 判別 ----
  async function pump() {
    if (S.busy !== null || !S.running || !S.seg) return;
    const gen = S.gen, seg = S.seg, L = S.ring.length;
    // 処理が遅れてリングから消えた窓は欠測にして飛ばす
    if (S.next < S.written - L) {
      const nn = Math.ceil((S.written - L) / WIN) * WIN;
      S.lost.push([S.next, nn]);
      S.gaps.push({ from: tOfSeg(seg, S.next), to: tOfSeg(seg, nn), reason: '処理が追いつかず判別できなかった' });
      S.next = nn; S.judged = nn;
    }
    const avail = Math.floor((S.written - S.next) / WIN);
    if (avail < 1) { queueFlush(); return; }
    const n = Math.min(BATCH, avail), start = S.next, end = start + n * WIN;
    const pcm = ringGet(start, end);
    if (!pcm) return;   // 上の欠測処理で起きないはずだが、念のため
    S.next = end;
    S.busy = gen;
    try {
      const t0 = performance.now();
      const r = await ask({ message: 'embed', pcm, hopSec: 3 }, [pcm.buffer]);
      if (gen !== S.gen) return;   // 途中で停止・再開した → 古い結果は捨てる
      S.stats.procMs += performance.now() - t0;
      S.stats.wins += r.nFrames;
      for (let f = 0; f < r.nFrames; f++) {
        const row = r.scores.subarray(f * r.C, (f + 1) * r.C);
        const frame = { e: l2(r.emb.subarray(f * r.D, (f + 1) * r.D)), bird: 0 };
        handleWindow(start + f * WIN, row, frame, seg);
      }
      S.judged = end;
      S.stats.lagSec = (S.written - S.next) / SR;
      queueFlush();
      render();
    } catch (err) {
      console.warn(err);
      if (gen === S.gen) {   // 判別に失敗した窓は欠測（その範囲の音は保存しない）
        S.lost.push([start, end]); S.judged = end;
        S.gaps.push({ from: tOfSeg(seg, start), to: tOfSeg(seg, end), reason: '判別に失敗' });
      }
    } finally {
      if (S.busy === gen) S.busy = null;
    }
    if (S.running && gen === S.gen) setTimeout(pump, 0);
  }

  // 3秒区間ごとの判定。鳥以外を除いたうえで、基準以上（thr以上）の種を上位から最大 MAX_SPECIES_PER_WIN 種まで記録する
  // （BirdNETは種ごとに独立した確からしさを出すので、同時に鳴いた複数種を扱える）。まとめ・切り出し・人の声の判定は種ごとに独立
  function handleWindow(ws, row, frame, seg) {
    if (humanIdx !== undefined && row[humanIdx] >= HUMAN_THR) S.humanWins.add(ws);
    const opt = { hokkaido: $('optHokkaido').checked, area: $('optArea').checked };
    const thr = parseFloat($('smThr').value) || 0.3;
    const hits = combinedList({ frames: [frame], maxv: row }, opt)
      .filter(x => !nonBirdNames.has(x.ja) && x.score >= thr)
      .slice(0, MAX_SPECIES_PER_WIN);
    const tw = tOfSeg(seg, ws);
    for (const top of hits) {
      const src = top.nb > top.bn ? '手帳' : 'BirdNET';
      // 同じ種が続いていれば1件にまとめる
      let ev = S.events.find(e => e.ja === top.ja && !e.closed && e.seg === seg.id && ws - e.endS <= GAP_MERGE * WIN);
      if (!ev) {
        const posOk = S.pos && Math.abs(S.pos.t - tw) <= POS_MAX_AGE;
        ev = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), ja: top.ja, startS: ws, endS: ws + WIN, seg: seg.id,
          t0: tw, t1: tOfSeg(seg, ws + WIN), count: 0, hits: [], max: 0, bestS: ws, src,
          lat: posOk ? S.pos.lat : null, lng: posOk ? S.pos.lng : null, acc: posOk ? S.pos.acc : null, clip: null, note: '',
          multi: false };
        S.events.push(ev);
      }
      ev.count++; ev.hits.push(tw); ev.endS = ws + WIN; ev.t1 = tOfSeg(seg, ws + WIN);
      if (hits.length > 1) ev.multi = true;   // 他の種と同じ区間で検出された（手帳に教えるときの注意表示に使う）
      if (top.score > ev.max) {
        ev.max = top.score; ev.bestS = ws; ev.src = src; ev.emb = frame.e; ev.embMulti = hits.length > 1;
        // 一番よく聞こえた窓の前後を、その範囲の窓がすべて判別し終わった時点で切り出す
        const pad = parseFloat($('smPad').value) || 5;
        const a = Math.max(0, ws - pad * SR), b = ws + WIN + pad * SR;
        S.pendingClips = S.pendingClips.filter(p => p.ev !== ev);
        S.pendingClips.push({ ev, a, b, need: Math.ceil(b / WIN) * WIN, seg, gen: S.gen });
      }
    }
    for (const e of S.events) if (!e.closed && e.seg === seg.id && ws - e.endS > GAP_MERGE * WIN) e.closed = true;
    if (hits.length) saveSessionSoon();
  }

  // 音の保存は1本の列で順に（同時に走ると上限の判定がずれるため）
  function queueFlush() {
    S.clipQueue = S.clipQueue.then(flushClips).catch(err => console.warn('音の保存処理で例外', err));
  }
  async function flushClips() {
    const ready = S.pendingClips.filter(p => p.gen === S.gen && S.judged >= p.need);
    if (!ready.length) return;
    S.pendingClips = S.pendingClips.filter(p => !ready.includes(p));
    for (const p of ready) {
      const ev = p.ev;
      if (p.gen !== S.gen) { ev.note = '録音が中断したため音声保存なし'; continue; }
      // 人の声・欠測を含む範囲は保存しない（範囲の窓はすべて判別済み）
      let human = false;
      for (let s = Math.floor(p.a / WIN) * WIN; s < p.b; s += WIN) if (S.humanWins.has(s)) { human = true; break; }
      if (human) { ev.note = '人の声を含むため音声保存なし'; continue; }
      if (overlapsLost(p.a, p.b)) { ev.note = '欠測を含むため音声保存なし'; continue; }
      const pcm = ringGet(p.a, p.b);
      if (!pcm) { ev.note = '処理が遅れ音が残っていないため保存なし'; continue; }
      const i16 = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
      const cap = parseInt($('smCap').value, 10) || 10;
      const same = S.events.filter(e => e.ja === ev.ja && e.clip && e !== ev).sort((x, y) => x.max - y.max);
      let loser = null;
      if (same.length >= cap) {
        if (same[0].max >= ev.max) { ev.note = '上位' + cap + '件に入らないため音声保存なし'; continue; }
        loser = same[0];
      }
      const id = ev.clip || ev.id;
      const clipT0 = tOfSeg(p.seg, p.a);
      try {
        await sReplace(loser ? loser.clip : null, { id, pcm: i16, t0: clipT0 });
        if (loser) { loser.clip = null; loser.note = '上位' + cap + '件から外れたため音声削除'; }
        ev.clip = id; ev.clipT0 = clipT0; ev.clipSec = (p.b - p.a) / SR; ev.note = '';
      } catch (err) {
        ev.note = '音声の保存に失敗（端末の空き容量など）';
        console.warn(err);
      }
    }
    saveSessionSoon(); render();
  }
  // 録音が止まるとき、まだ切り出せていない分は保存なしとして確定する
  function abandonPending(reason) {
    for (const p of S.pendingClips) if (!p.ev.clip) p.ev.note = reason;
    S.pendingClips = [];
  }

  // ---- 開始・停止・中断 ----
  // 別の操作に追い越された開始処理の例外（呼び出し側は「失敗」として扱わない）
  function superseded() { const e = new Error('別の操作に切り替わったため開始を取りやめました'); e.superseded = true; return e; }
  async function startCapture() {
    const gen = ++S.gen;
    abandonPending('録音が中断したため音声保存なし');
    const stale = () => gen !== S.gen || !S.running || document.hidden;
    if (stale()) throw superseded();
    let stream = null, ctx = null, node = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      if (stale()) throw superseded();
      ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
      await ctx.audioWorklet.addModule('pcm-recorder.js');
      if (stale()) throw superseded();
      const src = ctx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(ctx, 'pcm-recorder');
      // 区間をリセット（中断後は新しい区間として時刻を数え直す）
      S.ring.fill(0); S.written = 0; S.next = 0; S.judged = 0; S.busy = null;
      S.humanWins.clear(); S.lost = []; S.pendingClips = [];
      for (const e of S.events) e.closed = true;
      S.seg = { t0: Date.now(), id: (S.seg ? S.seg.id + 1 : 1) };
      node.port.onmessage = e => { if (gen === S.gen) onPcm(e.data); };
      src.connect(node);
      releaseCurrent();   // 念のため: 前のマイクが残っていれば、置き換える前に必ず放す
      S.stream = stream; S.ctx = ctx; S.node = node;
    } catch (err) {
      // 引き渡し前に失敗・中断したら、つかんだマイクや音声処理を必ず放す
      try { node && (node.port.onmessage = null, node.disconnect()); } catch (e) {}
      try { stream && stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      try { ctx && ctx.close(); } catch (e) {}
      if (stale()) throw superseded();   // すでに別の操作に追い越されていた要求の失敗は「取りやめ」扱い
      throw err;
    }
  }
  function releaseCurrent() {
    try { S.node && (S.node.port.onmessage = null, S.node.disconnect()); } catch (e) {}
    try { S.stream && S.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    try { S.ctx && S.ctx.close(); } catch (e) {}
    S.node = S.stream = S.ctx = null;
  }
  function stopCapture() {
    S.gen++;
    abandonPending('録音が中断したため音声保存なし');
    releaseCurrent();
  }
  async function keepAwake() {
    try { if ('wakeLock' in navigator) S.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }

  // 開始ボタンは「AIの準備」と「前回の調査の読み込み成功」の両方がそろってから押せる
  S.modelReady = false; S.restoreState = 'loading'; S.op = 0; S.resuming = null;
  function updateStartBtn() {
    const b = $('smStart'); if (!b) return;
    b.disabled = !(S.modelReady && S.restoreState === 'ok') || S.running || S.starting;
  }
  function setModelReady() { S.modelReady = true; updateStartBtn(); }

  async function start() {
    if (S.running || S.starting || !S.modelReady || S.restoreState !== 'ok') return;
    // 前の調査が残っていれば、消してよいか確認（保存領域を際限なく使わないため、調査は1件だけ保持）
    if (S.sessionId && S.events.length) {
      if (!confirm('前回の調査の記録と音を消して、新しい調査を始めます。\n書き出し（ZIP）は済みましたか？')) return;
    }
    S.starting = true; S.op++;
    updateStartBtn();
    try {
      await S.clipQueue;
      await sClearAll();
      initNames();
      S.events = []; S.gaps = []; S.stats = { wins: 0, procMs: 0, lagSec: 0 }; S.seg = null; S.pos = null;
      S.sessionId = 'S' + Date.now(); S.sessionStart = Date.now();
      $('smPrev').innerHTML = '';
      await updateArea();
      S.running = true;
      try { await startCapture(); }
      catch (err) { if (!err.superseded) throw err; }   // 画面切替などで追い越された → 再開側に任せる
      if (!S.running) return;                            // 開始中に「停止」が押された
      await keepAwake();
      if (navigator.geolocation) S.geoId = navigator.geolocation.watchPosition(
        p => { S.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: p.timestamp || Date.now() }; },
        () => {}, { enableHighAccuracy: true });
      $('smStop').disabled = false;
      if (S.stream) $('smResume').style.display = 'none';
      await saveSessionNow();
      tick();
    } catch (err) {
      // 開始の失敗で全体を止めるのは、他に動いている録音（画面復帰で再開済みなど）が無いときだけ
      if (!S.stream) stop();
      throw err;
    } finally {
      S.starting = false;
      updateStartBtn();
    }
  }
  function stop() {
    S.op++;
    S.running = false;
    stopCapture();
    if (S.geoId != null) { navigator.geolocation.clearWatch(S.geoId); S.geoId = null; }
    try { S.wakeLock && S.wakeLock.release(); } catch (e) {}
    const g = S.gaps[S.gaps.length - 1]; if (g && !g.to) g.to = Date.now();
    for (const e of S.events) e.closed = true;
    S.clipQueue.then(() => saveSessionNow()).catch(err => console.warn(err));
    $('smStop').disabled = true; $('smResume').style.display = 'none';
    updateStartBtn();
    render();
  }
  // 録音の再開。同時の要求は1つにまとめ、すでに再開済み（マイクあり）なら何もしない。
  // 処理中は「録音を再開」ボタンを押せなくする。実際に再開できたときだけ停止区間を閉じる
  async function resumeCapture() {
    while (S.resuming) { try { await S.resuming; } catch (e) {} }   // 実行中の再開があれば終わるのを待つ
    if (!S.running || document.hidden) throw superseded();
    if (S.stream) return;                                          // 既に再開済み
    const btn = $('smResume'); btn.disabled = true;
    const p = (async () => {
      await startCapture();
      const g = S.gaps[S.gaps.length - 1]; if (g && !g.to) g.to = Date.now();
      btn.style.display = 'none';
      saveSessionSoon(); render();
    })();
    S.resuming = p;   // 待ちのループを抜けてから同期的に設定するので、2つ目の要求はここで必ず待つ
    try { await p; }
    finally { if (S.resuming === p) S.resuming = null; btn.disabled = false; }
  }

  // 画面が隠れたら停止区間として記録し、戻ったら再開を試みる
  document.addEventListener('visibilitychange', async () => {
    const op = ++S.op;
    if (!S.running) return;
    if (document.hidden) {
      const last = S.gaps[S.gaps.length - 1];
      if (!last || last.to) S.gaps.push({ from: Date.now(), to: null, reason: '画面が消えた・別アプリ' });
      stopCapture();
      saveSessionSoon(); render();
      return;
    }
    await keepAwake();
    if (op !== S.op || !S.running || document.hidden) return;   // 待っている間に別の操作があった
    try { await resumeCapture(); }
    catch (e) {
      if (e.superseded) return;                                   // 追い越された（失敗ではない）
      if (op === S.op && S.running) $('smResume').style.display = '';   // 自動で再開できない端末は「再開」ボタンで
      render();
    }
  });

  let tickTimer = null;
  function tick() { clearTimeout(tickTimer); if (!S.running) return; render(); tickTimer = setTimeout(tick, 2000); }

  // ---- 表示 ----
  function render() {
    if (!S.sessionStart) return;
    const el = Math.round((Date.now() - S.sessionStart) / 1000);
    const avg = S.stats.wins ? S.stats.procMs / S.stats.wins / 1000 : 0;
    const clips = S.events.filter(e => e.clip).length;
    const mb = S.events.filter(e => e.clip).reduce((a, e) => a + (e.clipSec || 0) * SR * 2, 0) / 1e6;
    $('smStats').innerHTML = `${S.running ? '<b style="color:#c00">● 録音中</b>' : '停止中'}　` +
      (S.running ? `経過 ${Math.floor(el / 60)}分${el % 60}秒　判別 ${S.stats.wins}区間（3秒の音を平均${avg.toFixed(2)}秒で処理）　遅れ ${S.stats.lagSec.toFixed(1)}秒　` : `開始 ${new Date(S.sessionStart).toLocaleString()}　`) +
      `検出 ${S.events.length}件　保存した音 ${clips}件（${mb.toFixed(1)}MB）`;
    // 時刻順の一覧（新しい順）。停止区間も混ぜる
    const rows = S.events.map(e => ({ t: e.t0, html:
      `<tr class="${e.review === 'ok' ? 'ok' : e.review === 'ng' ? 'ng' : e.review === 'fixed' ? 'fx' : ''}">` +
      `<td>${hms(e.t0)}〜${hms(e.t1)}</td><td>${esc(canonName(e.ja))}</td><td>${e.count}</td><td>${(e.max * 100).toFixed(0)}%</td><td>${esc(e.src)}</td>` +
      `<td>${e.clip ? `<button class="smPlay" data-id="${esc(e.clip)}">▶</button>` : ''}<span style="font-size:0.8em">${esc(e.note)}</span></td>` +
      `<td>${reviewCell(e)}</td>` +
      `<td>${e.lat != null ? e.lat.toFixed(4) + ',' + e.lng.toFixed(4) : ''}</td></tr>` }))
      .concat(S.gaps.map(g => ({ t: g.from, html: `<tr class="na"><td>${hms(g.from)}〜${g.to ? hms(g.to) : ''}</td><td colspan="7">録音停止（${esc(g.reason || '画面が消えた・別アプリ')}）</td></tr>` })))
      .sort((a, b) => b.t - a.t);
    $('smList').innerHTML = '<table><tr><th>時刻</th><th>種名</th><th>回数</th><th>最大</th><th>根拠</th><th>音</th><th>判定</th><th>位置（調査員）</th></tr>' + rows.map(r => r.html).join('') + '</table>';
    document.querySelectorAll('.smPlay').forEach(b => b.onclick = () => play(b.dataset.id));
    document.querySelectorAll('.smRv').forEach(b => b.onclick = () => review(b.dataset.id, b.dataset.act));
    renderBins();
  }

  // ---- 判定（正解・不正解・訂正）----
  // 表示・書き出しの種名は読み替え後の名前（保存値は書き換えない）
  const confirmedJa = e => canonName(e.review === 'ok' ? e.ja : e.review === 'fixed' ? e.fixedJa : '') ;
  function reviewCell(e) {
    const btn = (act, label) => `<button class="smRv" data-id="${esc(e.id)}" data-act="${act}">${label}</button>`;
    if (!e.review) return btn('ok', '○正解') + btn('ng', '×不正解') + btn('fix', '種を直す');
    const label = e.review === 'ok' ? '○正解' : e.review === 'ng' ? '×不正解' : '→' + esc(canonName(e.fixedJa));
    const teach = e.review !== 'ng' && e.emb ? (e.taught ? ' 手帳に登録済み' : btn('teach', '手帳に教える')) : '';
    return `<b>${label}</b> ${btn('undo', '取消')}${teach}`;
  }
  async function review(id, act) {
    const e = S.events.find(x => x.id === id); if (!e) return;
    if (act === 'ok' || act === 'ng') e.review = act;
    else if (act === 'undo') { e.review = null; e.fixedJa = null; }
    else if (act === 'fix') {
      const names = [...document.querySelectorAll('#regSelect option')].map(o => o.value).filter(v => v && v !== '__free__');
      const v = (prompt('正しい種名を入力してください（例: ' + names.slice(0, 3).join('、') + '）', '') || '').trim();
      if (!v) return;
      if (v.length > 40) { alert('種名が長すぎます'); return; }
      if (!names.includes(canonName(v)) && !confirm(`「${v}」は北海道鳥類目録（505種）にありません。このまま使いますか？`)) return;
      e.review = 'fixed'; e.fixedJa = canonName(v);
    } else if (act === 'teach') {
      const ja = confirmedJa(e); if (!ja || !e.emb) return;
      if (e.embMulti && !confirm('この声は他の種と同じ3秒の中で聞こえていました。別の種の声が混ざって覚える可能性があります。手帳に教えますか？')) return;
      const entry = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), ja, kind: 'bird', date: new Date().toISOString(), embs: [e.emb] };
      await idbPut(entry); nbEntries.push(entry); renderNotebook();
      e.taught = true;
    }
    saveSessionSoon(); render();
  }

  // 時間帯ごとの表: 検出（3秒窓）ごとの時刻で数える。不正解は数えず、訂正は直した種名で数える
  function renderBins() {
    const bin = parseInt($('smBin').value, 10) * 60000;
    if (!S.events.length) { $('smBins').innerHTML = ''; return; }
    const hasHits = e => Array.isArray(e.hits) && e.hits.length > 0;
    const t0 = Math.floor(S.sessionStart / bin) * bin;
    const t1 = Math.max(S.running ? Date.now() : 0, ...S.events.map(e => e.t1));
    const cols = []; for (let t = t0; t <= t1; t += bin) cols.push(t);
    const evs = S.events.filter(e => e.review !== 'ng');
    const nm = e => canonName(e.review === 'fixed' ? e.fixedJa : e.ja);
    const cnt = new Map();
    for (const e of evs) {
      if (!cnt.has(nm(e))) cnt.set(nm(e), new Map());
      const row = cnt.get(nm(e));
      if (hasHits(e)) { for (const h of e.hits) { const i = Math.floor((h - t0) / bin); row.set(i, (row.get(i) || 0) + 1); } }
      else row.set('unknown', (row.get('unknown') || 0) + (e.count || 1));   // 旧形式の記録は時間帯の内訳が分からない
    }
    const anyUnknown = evs.some(e => !hasHits(e));
    $('smBins').innerHTML = '<table><tr><th>種名</th>' + cols.map(c => `<th>${hm(c)}〜</th>`).join('') + (anyUnknown ? '<th>時間帯不明</th>' : '') + '</tr>' +
      [...cnt.entries()].map(([ja, row]) => `<tr><td>${esc(ja)}</td>` + cols.map((c, i) => `<td style="text-align:center">${row.get(i) || ''}</td>`).join('') +
        (anyUnknown ? `<td style="text-align:center">${row.get('unknown') || ''}</td>` : '') + '</tr>').join('') + '</table>';
  }

  // ---- 音声ファイル ----
  function wav(i16) {
    const buf = new ArrayBuffer(44 + i16.length * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + i16.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, SR, true);
    v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, i16.length * 2, true);
    new Int16Array(buf, 44).set(i16);
    return new Uint8Array(buf);
  }
  let player = null;
  async function play(id) {
    const c = await sget('clips', id); if (!c) return;
    if (player) { player.pause(); URL.revokeObjectURL(player.src); }
    player = new Audio(URL.createObjectURL(new Blob([wav(c.pcm)], { type: 'audio/wav' })));
    player.play();
  }

  // ZIP（無圧縮）を作る。日本語ファイル名はUTF-8指定
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u) { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zip(files) {
    const enc = new TextEncoder(), parts = [], central = []; let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint32(14, crc, true); h.setUint32(18, sz, true); h.setUint32(22, sz, true); h.setUint16(26, name.length, true);
      parts.push(new Uint8Array(h.buffer), name, f.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint32(16, crc, true); c.setUint32(20, sz, true); c.setUint32(24, sz, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + sz;
    }
    const csize = central.reduce((a, b) => a + b.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, csize, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
  }

  // CSVのセル: 表計算ソフトが数式として解釈しないよう、=+-@ などで始まる文字列は先頭に ' を付ける
  function csvCell(x) {
    let s = String(x ?? '');
    if (typeof x === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  }
  const safeName = s => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 40);

  async function exportZip() {
    if (!S.events.length) { alert('まだ検出がありません'); return; }
    await S.clipQueue;
    const files = [];
    const d = new Date(S.sessionStart);
    const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const lines = [['開始時刻', '終了時刻', 'AIの種名', '判定', '確定した種名', '回数', '最大確からしさ', '根拠', '緯度（調査員）', '経度（調査員）', '位置の精度(m)', '音声ファイル', '音声の開始時刻', '備考']];
    const rvName = { ok: '正解', ng: '不正解', fixed: '訂正' };
    for (const e of S.events.slice().sort((a, b) => a.t0 - b.t0)) {
      let fn = '';
      if (e.clip) {
        const c = await sget('clips', e.clip);
        if (c) {
          fn = hms(e.t0).replace(/:/g, '') + '_' + safeName(canonName(e.ja)) + '_' + Math.round(e.max * 100) + '.wav';
          files.push({ name: fn, data: wav(c.pcm) });
        }
      }
      lines.push([hms(e.t0), hms(e.t1), canonName(e.ja), rvName[e.review] || '未判定', confirmedJa(e), e.count, (e.max * 100).toFixed(1), e.src,
        e.lat ?? '', e.lng ?? '', e.acc != null ? Math.round(e.acc) : '', fn, e.clipT0 ? hms(e.clipT0) : '', e.note]);
    }
    for (const g of S.gaps) lines.push([hms(g.from), g.to ? hms(g.to) : '', '（録音停止）', '', '', '', '', '', '', '', '', '', '', g.reason || '画面が消えた・別アプリ']);
    const csv = '﻿' + lines.map(r => r.map(csvCell).join(',')).join('\r\n');
    files.unshift({ name: '一覧.csv', data: new TextEncoder().encode(csv) });
    const a = document.createElement('a');
    const url = URL.createObjectURL(zip(files));
    a.href = url;
    a.download = `鳴き声_${ymd}_${hm(S.sessionStart).replace(':', '')}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---- 前回の調査（開き直したとき）----
  // 前回の調査を読み込む。成功するまで「開始」は押せない（読めないまま全消去しないため）
  async function loadPrevious() {
    S.restoreState = 'loading'; updateStartBtn();
    let all;
    try { all = await sall('sessions'); }
    catch (err) {
      S.restoreState = 'failed'; updateStartBtn();
      $('smPrev').innerHTML = '<div style="padding:6px;background:#fdd">前回の調査を読み込めませんでした。新しい調査を始める前に読み込み直してください。 <button id="smRetry">読み込み直す</button></div>';
      $('smRetry').onclick = () => loadPrevious().catch(() => {});
      throw err;
    }
    if (S.running || S.starting) { S.restoreState = 'ok'; updateStartBtn(); return; }   // 念のため（開始後に遅れて届いた結果は使わない）
    if (all.length) {
      const s = all.sort((a, b) => b.start - a.start)[0];
      S.sessionId = s.id; S.sessionStart = s.start; S.events = s.events || []; S.gaps = s.gaps || [];
      for (const e of S.events) e.closed = true;
      $('smPrev').innerHTML = `<div style="padding:6px;background:#eef">前回の調査（${esc(new Date(s.start).toLocaleString())}・検出${S.events.length}件）を表示しています。
        書き出し・判定ができます。 <button id="smClear">前回の調査を消す</button></div>`;
      $('smClear').onclick = async () => {
        if (S.running || S.starting) return;
        if (!confirm('前回の調査の記録と音を消します。書き出しは済みましたか？')) return;
        await S.clipQueue;
        await sClearAll();
        S.sessionId = null; S.sessionStart = null; S.events = []; S.gaps = [];
        $('smPrev').innerHTML = ''; $('smList').innerHTML = ''; $('smBins').innerHTML = ''; $('smStats').innerHTML = '';
      };
      render();
    } else {
      $('smPrev').innerHTML = '';
    }
    S.restoreState = 'ok'; updateStartBtn();
  }

  // ---- 画面部品 ----
  function build() {
    const box = document.getElementById('surveyBox');
    box.innerHTML = `
      <p style="font-size:0.9em">調査中ずっと聞いて判別し、鳥が聞こえた前後の音だけ残します。
      <b>画面を消したり別のアプリに切り替えると、その間は録音が止まります</b>（iPhoneの仕組み）。画面はつけたままにしてください。
      AIが人の声を検出した区間を含む音は保存しません（検出漏れにより人の声が保存される場合があります）。結果は候補なので、聞き直して確かめてください。
      保持できる調査は1件だけです。新しく始める前に書き出してください。</p>
      <div>判定の基準 <select id="smThr"><option value="0.1">10%</option><option value="0.2">20%</option><option value="0.3" selected>30%</option><option value="0.5">50%</option><option value="0.7">70%</option></select>
        前後 <select id="smPad"><option>3</option><option selected>5</option><option>10</option></select>秒
        1種あたり音の保存 <select id="smCap"><option>5</option><option selected>10</option><option>30</option></select>件まで</div>
      <div><button id="smStart" disabled>連続モード開始</button><button id="smStop" disabled>停止</button>
        <button id="smResume" style="display:none">録音を再開</button><button id="smZip">書き出し（ZIP）</button></div>
      <div id="smPrev"></div>
      <div id="smStats" style="margin:6px 0;font-size:0.9em"></div>
      <h3 style="font-size:1em">時刻順</h3><div id="smList"></div>
      <h3 style="font-size:1em">時間帯ごと <select id="smBin"><option value="5">5分</option><option value="10" selected>10分</option><option value="30">30分</option></select></h3>
      <div id="smBins"></div>`;
    $('smStart').onclick = () => start().catch(e => alert('開始できませんでした: ' + e));
    $('smStop').onclick = stop;
    $('smResume').onclick = async () => { S.op++; try { await resumeCapture(); } catch (e) { if (!e.superseded) alert('再開できませんでした: ' + e); } };
    $('smZip').onclick = () => exportZip().catch(e => alert('書き出しエラー: ' + e));
    $('smBin').onchange = renderBins;
    // 開始ボタンはAIの読み込み完了時（birdnet_test.html の onLoaded）に有効になる
    loadPrevious().catch(err => console.warn('前回の調査を読めませんでした', err));
    if (S.modelReady) updateStartBtn();
  }
  // 検証用に内部を公開（画面からは使わない）
  Object.assign(S, { handleWindow, onPcm, render, exportZip, zip, wav, initNames, queueFlush, pump, csvCell, saveSessionNow, loadPrevious, setModelReady, start, stop, startCapture, resumeCapture });
  build();
})();
