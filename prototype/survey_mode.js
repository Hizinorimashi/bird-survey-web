// 連続モード（調査中ずっと聞いて判別し、結果と鳴き声の前後数秒だけ残す）。試作。
// birdnet_test.html の ask / combinedList / labels / sciIndex / l2 / updateArea などを使う。
'use strict';
(function () {
  const SR = 48000, WIN = 144000;          // 3秒窓（重ねずに順に判別）
  const RING_SEC = 45;                     // 直近45秒の音を持っておく（切り出し用）
  const BATCH = 4;                         // 一度にAIへ渡す窓の数
  const GAP_MERGE = 5;                     // 同じ種の検出をまとめる間隔（窓数＝15秒）
  const HUMAN_THR = 0.3;                   // 人の声とみなす値
  const NONBIRD_SCI = ['Dog', 'Engine', 'Environmental', 'Fireworks', 'Gun', 'Human non-vocal', 'Human vocal',
    'Human whistle', 'Noise', 'Power tools', 'Siren'];

  const S = {
    running: false, ctx: null, stream: null, node: null, wakeLock: null, geoId: null, pos: null,
    ring: new Float32Array(SR * RING_SEC), written: 0, next: 0, busy: false,
    seg: null,                 // {t0: 録音開始の時刻(ms), id}
    sessionId: null, sessionStart: null,
    events: [], gaps: [], pendingClips: [], humanWins: new Set(),
    stats: { wins: 0, procMs: 0, lagSec: 0 }
  };
  window.SURVEY = S;

  let nonBirdNames = null, humanIdx = -1;
  function initNames() {
    if (nonBirdNames) return;
    nonBirdNames = new Set(NONBIRD_SCI.filter(s => sciIndex[s] !== undefined).map(s => nameOf(sciIndex[s])));
    humanIdx = sciIndex['Human vocal'];
  }

  // ---- 保存（クリップ音声と調査の記録）----
  function sdb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('birdnet-survey', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('clips', { keyPath: 'id' }); r.result.createObjectStore('sessions', { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function sput(store, obj) { const db = await sdb(); return new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(obj); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
  async function sget(store, id) { const db = await sdb(); return new Promise((res, rej) => { const r = db.transaction(store).objectStore(store).get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async function sdel(store, id) { const db = await sdb(); return new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
  let saveTimer = null;
  function saveSessionSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const evs = S.events.map(e => ({ ...e, emb: undefined }));
      sput('sessions', { id: S.sessionId, start: S.sessionStart, events: evs, gaps: S.gaps }).catch(() => {});
    }, 3000);
  }

  // ---- 時刻 ----
  const tOf = s => S.seg.t0 + s / SR * 1000;
  const hms = t => new Date(t).toTimeString().slice(0, 8);
  const hm = t => new Date(t).toTimeString().slice(0, 5);

  // ---- 音の受け取り ----
  function onPcm(chunk) {
    const L = S.ring.length;
    for (let i = 0; i < chunk.length; i++) S.ring[(S.written + i) % L] = chunk[i];
    S.written += chunk.length;
    pump();
  }
  function ringGet(a, b) {   // 区間[a,b)の音を取り出す（範囲外は0）
    const L = S.ring.length, out = new Float32Array(b - a);
    for (let s = Math.max(a, S.written - L, 0); s < Math.min(b, S.written); s++) out[s - a] = S.ring[s % L];
    return out;
  }

  // ---- 判別 ----
  async function pump() {
    if (S.busy || !S.running) return;
    const avail = Math.floor((S.written - S.next) / WIN);
    if (avail < 1) { flushClips(); return; }
    S.busy = true;
    try {
      const n = Math.min(BATCH, avail);
      const start = S.next;
      const pcm = ringGet(start, start + n * WIN);
      S.next += n * WIN;
      const t0 = performance.now();
      const r = await ask({ message: 'embed', pcm, hopSec: 3 }, [pcm.buffer]);
      S.stats.procMs += performance.now() - t0;
      S.stats.wins += r.nFrames;
      for (let f = 0; f < r.nFrames; f++) {
        const row = r.scores.subarray(f * r.C, (f + 1) * r.C);
        const frame = { e: l2(r.emb.subarray(f * r.D, (f + 1) * r.D)), bird: 0 };
        handleWindow(start + f * WIN, row, frame);
      }
      S.stats.lagSec = (S.written - S.next) / SR;
      flushClips();
      render();
    } catch (err) { console.warn(err); }
    S.busy = false;
    if (S.running) setTimeout(pump, 0);
  }

  function handleWindow(ws, row, frame) {
    if (humanIdx !== undefined && row[humanIdx] >= HUMAN_THR) S.humanWins.add(ws);
    const opt = { hokkaido: $('optHokkaido').checked, area: $('optArea').checked };
    const list = combinedList({ frames: [frame], maxv: row }, opt).filter(x => !nonBirdNames.has(x.ja));
    const top = list[0];
    const thr = parseFloat($('smThr').value) || 0.3;
    if (!top || top.score < thr) return;
    const src = top.nb > top.bn ? '手帳' : 'BirdNET';
    // 同じ種が続いていれば1件にまとめる
    let ev = S.events.find(e => e.ja === top.ja && !e.closed && ws - e.endS <= GAP_MERGE * WIN);
    if (!ev) {
      ev = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), ja: top.ja, startS: ws, endS: ws + WIN, seg: S.seg.id,
        t0: tOf(ws), t1: tOf(ws + WIN), count: 0, max: 0, bestS: ws, src, lat: S.pos && S.pos.lat, lng: S.pos && S.pos.lng, clip: null, note: '' };
      S.events.push(ev);
    }
    ev.count++; ev.endS = ws + WIN; ev.t1 = tOf(ws + WIN);
    if (top.score > ev.max) {
      ev.max = top.score; ev.bestS = ws; ev.src = src; ev.emb = frame.e;
      // 一番よく聞こえた窓の前後を、後ろの秒数が録れた時点で切り出す
      const pre = parseFloat($('smPad').value) || 5;
      S.pendingClips = S.pendingClips.filter(p => p.ev !== ev);
      S.pendingClips.push({ ev, a: Math.max(0, ws - pre * SR), b: ws + WIN + pre * SR });
    }
    // 古い検出は閉じる
    for (const e of S.events) if (!e.closed && ws - e.endS > GAP_MERGE * WIN) e.closed = true;
    saveSessionSoon();
  }

  async function flushClips() {
    const ready = S.pendingClips.filter(p => S.written >= p.b);
    S.pendingClips = S.pendingClips.filter(p => S.written < p.b);
    for (const p of ready) {
      const ev = p.ev;
      // 人の声が入っていれば音は保存しない
      let human = false;
      for (let s = Math.floor(p.a / WIN) * WIN; s < p.b; s += WIN) if (S.humanWins.has(s)) { human = true; break; }
      if (human) { ev.note = '人の声を含むため音声保存なし'; continue; }
      const pcm = ringGet(p.a, p.b);
      const i16 = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
      const cap = parseInt($('smCap').value, 10) || 10;
      const same = S.events.filter(e => e.ja === ev.ja && e.clip && e !== ev).sort((a, b) => a.max - b.max);
      if (same.length >= cap) {
        if (same[0].max >= ev.max) { ev.note = '上位' + cap + '件に入らないため音声保存なし'; continue; }
        await sdel('clips', same[0].clip); same[0].clip = null; same[0].note = '上位' + cap + '件から外れたため音声削除';
      }
      const id = (ev.clip && ev.clip) || ev.id;
      await sput('clips', { id, pcm: i16, t0: tOf(p.a) });
      ev.clip = id; ev.clipT0 = tOf(p.a); ev.clipSec = (p.b - p.a) / SR; ev.note = '';
    }
    if (ready.length) { saveSessionSoon(); render(); }
  }

  // ---- 開始・停止・中断 ----
  async function startCapture() {
    S.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    S.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
    await S.ctx.audioWorklet.addModule('pcm-recorder.js');
    const src = S.ctx.createMediaStreamSource(S.stream);
    S.node = new AudioWorkletNode(S.ctx, 'pcm-recorder');
    S.node.port.onmessage = e => onPcm(e.data);
    src.connect(S.node);
    // 区間をリセット（中断後は新しい区間として時刻を数え直す）
    S.ring.fill(0); S.written = 0; S.next = 0; S.humanWins.clear(); S.pendingClips = [];
    for (const e of S.events) e.closed = true;
    S.seg = { t0: Date.now(), id: (S.seg ? S.seg.id + 1 : 1) };
  }
  function stopCapture() {
    try { S.node && S.node.disconnect(); } catch (e) {}
    try { S.stream && S.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    try { S.ctx && S.ctx.close(); } catch (e) {}
    S.node = S.stream = S.ctx = null;
  }
  async function keepAwake() {
    try { if ('wakeLock' in navigator) S.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }

  async function start() {
    initNames();
    S.events = []; S.gaps = []; S.stats = { wins: 0, procMs: 0, lagSec: 0 }; S.seg = null;
    S.sessionId = 'S' + Date.now(); S.sessionStart = Date.now();
    await updateArea();
    await startCapture();
    S.running = true;
    await keepAwake();
    if (navigator.geolocation) S.geoId = navigator.geolocation.watchPosition(p => { S.pos = { lat: p.coords.latitude, lng: p.coords.longitude }; }, () => {}, { enableHighAccuracy: true });
    $('smStart').disabled = true; $('smStop').disabled = false; $('smResume').style.display = 'none';
    tick();
  }
  function stop() {
    S.running = false;
    stopCapture();
    if (S.geoId != null) navigator.geolocation.clearWatch(S.geoId);
    try { S.wakeLock && S.wakeLock.release(); } catch (e) {}
    for (const e of S.events) e.closed = true;
    saveSessionSoon();
    $('smStart').disabled = false; $('smStop').disabled = true; $('smResume').style.display = 'none';
    render();
  }

  // 画面が隠れたら停止区間として記録し、戻ったら再開を試みる
  document.addEventListener('visibilitychange', async () => {
    if (!S.running) return;
    if (document.hidden) {
      S.gaps.push({ from: Date.now(), to: null });
      stopCapture();
      render();
    } else {
      const g = S.gaps[S.gaps.length - 1]; if (g && !g.to) g.to = Date.now();
      await keepAwake();
      try { await startCapture(); $('smResume').style.display = 'none'; }
      catch (e) { $('smResume').style.display = ''; }   // 自動で再開できない端末は「再開」ボタンで
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
    $('smStats').innerHTML = `${S.running ? '<b style="color:#c00">● 録音中</b>' : '停止中'}　経過 ${Math.floor(el / 60)}分${el % 60}秒　` +
      `判別 ${S.stats.wins}区間（3秒の音を平均${avg.toFixed(2)}秒で処理）　遅れ ${S.stats.lagSec.toFixed(1)}秒　` +
      `検出 ${S.events.length}件　保存した音 ${clips}件（${mb.toFixed(1)}MB）`;
    // 時刻順の一覧（新しい順）。停止区間も混ぜる
    const rows = S.events.map(e => ({ t: e.t0, html:
      `<tr class="${e.review === 'ok' ? 'ok' : e.review === 'ng' ? 'ng' : e.review === 'fixed' ? 'fx' : ''}">` +
      `<td>${hms(e.t0)}〜${hms(e.t1)}</td><td>${e.ja}</td><td>${e.count}</td><td>${(e.max * 100).toFixed(0)}%</td><td>${e.src}</td>` +
      `<td>${e.clip ? `<button class="smPlay" data-id="${e.clip}">▶</button>` : ''}<span style="font-size:0.8em">${e.note}</span></td>` +
      `<td>${reviewCell(e)}</td>` +
      `<td>${e.lat != null ? e.lat.toFixed(4) + ',' + e.lng.toFixed(4) : ''}</td></tr>` }))
      .concat(S.gaps.map(g => ({ t: g.from, html: `<tr class="na"><td>${hms(g.from)}〜${g.to ? hms(g.to) : ''}</td><td colspan="7">録音停止（画面が消えた・別アプリ）</td></tr>` })))
      .sort((a, b) => b.t - a.t);
    $('smList').innerHTML = '<table><tr><th>時刻</th><th>種名</th><th>回数</th><th>最大</th><th>根拠</th><th>音</th><th>判定</th><th>位置（調査員）</th></tr>' + rows.map(r => r.html).join('') + '</table>';
    document.querySelectorAll('.smPlay').forEach(b => b.onclick = () => play(b.dataset.id));
    document.querySelectorAll('.smRv').forEach(b => b.onclick = () => review(b.dataset.id, b.dataset.act));
    renderBins();
  }

  // ---- 判定（正解・不正解・訂正）----
  const confirmedJa = e => e.review === 'ok' ? e.ja : e.review === 'fixed' ? e.fixedJa : '';
  function reviewCell(e) {
    const btn = (act, label) => `<button class="smRv" data-id="${e.id}" data-act="${act}">${label}</button>`;
    if (!e.review) return btn('ok', '○正解') + btn('ng', '×不正解') + btn('fix', '種を直す');
    const label = e.review === 'ok' ? '○正解' : e.review === 'ng' ? '×不正解' : '→' + e.fixedJa;
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
      if (!names.includes(v) && !confirm(`「${v}」は北海道の188種の一覧にありません。このまま使いますか？`)) return;
      e.review = 'fixed'; e.fixedJa = v;
    } else if (act === 'teach') {
      const ja = confirmedJa(e); if (!ja || !e.emb) return;
      const entry = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), ja, kind: 'bird', date: new Date().toISOString(), embs: [e.emb] };
      await idbPut(entry); nbEntries.push(entry); renderNotebook();
      e.taught = true;
    }
    saveSessionSoon(); render();
  }

  function renderBins() {
    const bin = parseInt($('smBin').value, 10) * 60000;
    if (!S.events.length) { $('smBins').innerHTML = ''; return; }
    const t0 = Math.floor(S.sessionStart / bin) * bin, t1 = Math.max(Date.now(), ...S.events.map(e => e.t1));
    const cols = []; for (let t = t0; t <= t1; t += bin) cols.push(t);
    // 不正解は数えない。訂正したものは直した種名で数える
    const evs = S.events.filter(e => e.review !== 'ng');
    const nm = e => e.review === 'fixed' ? e.fixedJa : e.ja;
    const sp = [...new Set(evs.map(nm))];
    const cnt = {}; for (const e of evs) { const k = nm(e) + '|' + Math.floor((e.t0 - t0) / bin); cnt[k] = (cnt[k] || 0) + e.count; }
    $('smBins').innerHTML = '<table><tr><th>種名</th>' + cols.map(c => `<th>${hm(c)}〜</th>`).join('') + '</tr>' +
      sp.map(ja => `<tr><td>${ja}</td>` + cols.map((c, i) => `<td style="text-align:center">${cnt[ja + '|' + i] || ''}</td>`).join('') + '</tr>').join('') + '</table>';
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

  async function exportZip() {
    if (!S.events.length) { alert('まだ検出がありません'); return; }
    const files = [];
    const d = new Date(S.sessionStart);
    const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const lines = [['開始時刻', '終了時刻', 'AIの種名', '判定', '確定した種名', '回数', '最大確からしさ', '根拠', '緯度（調査員）', '経度（調査員）', '音声ファイル', '音声の開始時刻', '備考']];
    const rvName = { ok: '正解', ng: '不正解', fixed: '訂正' };
    for (const e of S.events.slice().sort((a, b) => a.t0 - b.t0)) {
      let fn = '';
      if (e.clip) {
        const c = await sget('clips', e.clip);
        if (c) {
          fn = hms(e.t0).replace(/:/g, '') + '_' + e.ja + '_' + Math.round(e.max * 100) + '.wav';
          files.push({ name: fn, data: wav(c.pcm) });
        }
      }
      lines.push([hms(e.t0), hms(e.t1), e.ja, rvName[e.review] || '未判定', confirmedJa(e), e.count, (e.max * 100).toFixed(1), e.src, e.lat ?? '', e.lng ?? '', fn, e.clipT0 ? hms(e.clipT0) : '', e.note]);
    }
    for (const g of S.gaps) lines.push([hms(g.from), g.to ? hms(g.to) : '', '（録音停止）', '', '', '', '', '', '', '', '', '', '画面が消えた・別アプリ']);
    const csv = '﻿' + lines.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    files.unshift({ name: '一覧.csv', data: new TextEncoder().encode(csv) });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zip(files));
    a.download = `鳴き声_${ymd}_${hm(S.sessionStart).replace(':', '')}.zip`;
    a.click();
  }

  // ---- 画面部品 ----
  function build() {
    const box = document.getElementById('surveyBox');
    box.innerHTML = `
      <p style="font-size:0.9em">調査中ずっと聞いて判別し、鳥が聞こえた前後の音だけ残します。
      <b>画面を消したり別のアプリに切り替えると、その間は録音が止まります</b>（iPhoneの仕組み）。画面はつけたままにしてください。
      人の声が入った部分の音は保存しません。結果は候補なので、聞き直して確かめてください。</p>
      <div>判定の基準 <select id="smThr"><option value="0.1">10%</option><option value="0.2">20%</option><option value="0.3" selected>30%</option><option value="0.5">50%</option><option value="0.7">70%</option></select>
        前後 <select id="smPad"><option>3</option><option selected>5</option><option>10</option></select>秒
        1種あたり音の保存 <select id="smCap"><option>5</option><option selected>10</option><option>30</option></select>件まで</div>
      <div><button id="smStart" disabled>連続モード開始</button><button id="smStop" disabled>停止</button>
        <button id="smResume" style="display:none">録音を再開</button><button id="smZip">書き出し（ZIP）</button></div>
      <div id="smStats" style="margin:6px 0;font-size:0.9em"></div>
      <h3 style="font-size:1em">時刻順</h3><div id="smList"></div>
      <h3 style="font-size:1em">時間帯ごと <select id="smBin"><option value="5">5分</option><option value="10" selected>10分</option><option value="30">30分</option></select></h3>
      <div id="smBins"></div>`;
    $('smStart').onclick = () => start().catch(e => { alert('開始できませんでした: ' + e); stop(); });
    $('smStop').onclick = stop;
    $('smResume').onclick = async () => { try { await startCapture(); $('smResume').style.display = 'none'; } catch (e) { alert('再開できませんでした: ' + e); } };
    $('smZip').onclick = () => exportZip().catch(e => alert('書き出しエラー: ' + e));
    $('smBin').onchange = renderBins;
    // 開始ボタンはAIの読み込み完了時（birdnet_test.html の onLoaded）に有効になる
  }
  S.handleWindow = handleWindow; S.onPcm = onPcm; S.render = render; S.exportZip = exportZip; S.zip = zip; S.wav = wav; S.initNames = initNames;
  build();
})();
