'use strict';

/* ===================== 상수 · 헬퍼 ===================== */

const LS_KEY = 'checkin-attendance';
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

const pad = n => String(n).padStart(2, '0');
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function yesterdayKey() {
  const t = new Date();
  return keyOf(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1));
}

// "HH:MM" → 분. 형식이 아니면 null.
function toMin(hm) {
  if (typeof hm !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hm)) return null;
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

// 분(0~1439)을 30분 단위로 내림한다: 14:45→14:30, 13:15→13:00
const snapMin30 = totalMin => Math.floor(totalMin / 30) * 30;
const minToHM = min => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const snapHM = hm => { const m = toMin(hm); return m === null ? null : minToHM(snapMin30(m)); };
// 도장용: 현재 시각을 30분 단위로 내림
const stampHM = () => { const d = new Date(); return minToHM(snapMin30(d.getHours() * 60 + d.getMinutes())); };

const fmtHM = min => `${Math.floor(min / 60)}:${pad(min % 60)}`;
const fmtSigned = min => min === 0 ? '±0:00' : (min < 0 ? '−' : '+') + fmtHM(Math.abs(min));
// 달력 칸 표시용 짧은 시각: "09:00" → "9:00"
const shortHM = hm => hm.replace(/^0/, '');

// 실제로 존재하는 날짜인지 확인 (예: 2026-06-31 거부)
function validDateKey(k) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return false;
  const [y, m, d] = k.split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= new Date(y, m, 0).getDate();
}

const $ = id => document.getElementById(id);

/* ===================== 상태 ===================== */

let data = null;            // { settings:{workStart,workEnd,workplace}, records:{...}, meta:{savedAt} }
let viewY = 0, viewM = 0;   // 달력에 표시 중인 연/월(0-based)
let editKey = null;         // 수정 모달이 열려 있는 날짜 키
let curTodayKey = '';       // 자정 감지용

/* ===================== 데이터 정규화 · 계산 ===================== */

function normalize(raw) {
  const d = (raw && typeof raw === 'object') ? raw : {};
  const s = (d.settings && typeof d.settings === 'object') ? d.settings : {};
  const r = (d.records && typeof d.records === 'object') ? d.records : {};
  const records = {};
  for (const [k, v] of Object.entries(r)) {
    if (!validDateKey(k) || !v || typeof v !== 'object') continue;
    const rec = {};
    if (toMin(v.in) !== null) rec.in = v.in;
    if (toMin(v.out) !== null) rec.out = v.out;
    if (rec.in || rec.out) records[k] = rec;
  }
  // 근무지 (위치 기반 자동 도장용)
  let workplace = null;
  const wp = s.workplace;
  if (wp && typeof wp === 'object' &&
      Number.isFinite(wp.lat) && Number.isFinite(wp.lng)) {
    workplace = { lat: wp.lat, lng: wp.lng, radius: 50 }; // 반경 50m 고정
  }
  return {
    settings: {
      workStart: toMin(s.workStart) !== null ? s.workStart : '09:00',
      workEnd: toMin(s.workEnd) !== null ? s.workEnd : '18:00',
      workplace,
    },
    records,
    // savedAt: 파일↔브라우저 중 어느 쪽이 최신인지 비교하는 기준
    meta: { savedAt: (d.meta && typeof d.meta.savedAt === 'string') ? d.meta.savedAt : '' },
  };
}

// 기준 근무시간(분). 퇴근이 출근보다 이르면 익일 퇴근 기준(야간 근무).
// 출근·퇴근이 같으면 null(계산 불가).
function stdMinutes() {
  const a = toMin(data.settings.workStart);
  const b = toMin(data.settings.workEnd);
  if (a === null || b === null || a === b) return null;
  return b > a ? b - a : b + 1440 - a;
}

// 하루 기록의 상태. kind: empty | partial | invalid(출근=퇴근) | done
// done이면서 퇴근<출근이면 overnight(익일 퇴근)로 계산한다.
function dayStatus(rec) {
  const i = toMin(rec && rec.in);
  const o = toMin(rec && rec.out);
  if (i === null && o === null) return { kind: 'empty' };
  if (i === null || o === null) return { kind: 'partial', in: i, out: o };
  if (o === i) return { kind: 'invalid' };
  const overnight = o < i;
  const worked = overnight ? o + 1440 - i : o - i;
  const std = stdMinutes();
  return { kind: 'done', worked, overnight, diff: std === null ? null : worked - std };
}

/* ===================== IndexedDB (파일 핸들 + 데이터 미러) ===================== */

const IDB_NAME = 'checkin-fs';

function idbOpen() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(IDB_NAME, 2);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbSet(store, key, val) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(val, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(store, key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const rq = db.transaction(store).objectStore(store).get(key);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbDel(store, key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

/* ===================== 저장 · 불러오기 =====================
   localStorage(기본) + IndexedDB 미러(이중화) + 파일(PC, 선택) */

function persist() {
  data.meta = { savedAt: new Date().toISOString() };
  const json = JSON.stringify(data);
  try {
    localStorage.setItem(LS_KEY, json);
  } catch (e) {
    toast('저장 실패 — 브라우저 저장공간을 확인하세요', true);
  }
  idbSet('kv', 'data', json).catch(() => { /* 미러 실패는 무시 */ });
  if (fileOn && fileHandle) writeFileQueued();
}

async function loadData() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { /* 손상 무시 */ }
  if (!raw) {
    // localStorage가 비어 있으면 IndexedDB 미러에서 복구
    try {
      const backup = await idbGet('kv', 'data');
      if (backup) {
        raw = JSON.parse(backup);
        try { localStorage.setItem(LS_KEY, backup); } catch (e) { /* 무시 */ }
      }
    } catch (e) { /* 무시 */ }
  }
  data = normalize(raw);
}

/* ===================== 파일 저장 연결 (File System Access API) =====================
   Chrome/Edge/Whale 등 크로미움 계열(PC). 미지원 브라우저는 버튼이 숨겨진다. */

const FILE_API = typeof window.showSaveFilePicker === 'function';
let fileHandle = null;
let fileOn = false;

let writeQueue = Promise.resolve();
function writeFileQueued() {
  writeQueue = writeQueue.then(writeFileNow).catch(() => {
    fileOn = false;
    updateFileUI();
    toast('파일 저장 실패 — 파일 연결이 해제되었습니다', true);
  });
  return writeQueue;
}
async function writeFileNow() {
  if (!fileHandle) return;
  const w = await fileHandle.createWritable();
  await w.write(JSON.stringify(data, null, 2));
  await w.close();
}

// 연결된 파일을 읽어 브라우저 기록과 비교 — 최신 쪽을 채택하고 양쪽을 동기화한다
async function adoptFile() {
  try {
    const f = await fileHandle.getFile();
    let fileData = null;
    try { fileData = JSON.parse(await f.text()); } catch (e) { /* 빈/손상 파일 */ }
    if (fileData && typeof fileData === 'object' && typeof fileData.records === 'object') {
      const next = normalize(fileData);
      const fileSaved = (fileData.meta && fileData.meta.savedAt) || '';
      const localSaved = (data.meta && data.meta.savedAt) || '';
      const fileNewer = fileSaved > localSaved; // ISO 문자열이라 사전순 = 시간순
      const localEmpty = Object.keys(data.records).length === 0;
      if (fileNewer || (localEmpty && Object.keys(next.records).length > 0)) {
        data = next;
        render();
      }
    }
    fileOn = true;
    persist();
    updateFileUI();
    toast(`파일 연결됨: ${fileHandle.name}`);
  } catch (e) {
    fileOn = false;
    updateFileUI();
    toast('파일을 읽지 못했습니다', true);
  }
}

async function connectFile() {
  if (fileOn) {
    confirmBox(
      `파일(${fileHandle.name}) 연결을 해제할까요?\n이후 기록은 이 브라우저에만 저장됩니다.`,
      async () => {
        fileOn = false;
        fileHandle = null;
        try { await idbDel('handles', 'main'); } catch (e) { /* 무시 */ }
        updateFileUI();
        toast('파일 연결이 해제되었습니다');
      },
      '해제'
    );
    return;
  }
  try {
    if (fileHandle && typeof fileHandle.requestPermission === 'function') {
      const p = await fileHandle.requestPermission({ mode: 'readwrite' });
      if (p !== 'granted') { toast('파일 사용 권한이 거부되었습니다', true); return; }
      await adoptFile();
      return;
    }
    const h = await window.showSaveFilePicker({
      suggestedName: '출퇴근기록.json',
      types: [{ description: 'JSON 파일', accept: { 'application/json': ['.json'] } }],
    });
    fileHandle = h;
    try { await idbSet('handles', 'main', h); } catch (e) { /* 무시 */ }
    await adoptFile();
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    toast('파일 연결에 실패했습니다', true);
  }
}

async function initFile() {
  if (!FILE_API) return;
  $('btnFile').hidden = false;
  try { fileHandle = (await idbGet('handles', 'main')) || null; } catch (e) { fileHandle = null; }
  if (fileHandle && typeof fileHandle.queryPermission === 'function') {
    try {
      if ((await fileHandle.queryPermission({ mode: 'readwrite' })) === 'granted') {
        await adoptFile();
        return;
      }
    } catch (e) { /* 무시 */ }
    armAutoReconnect();
  }
  updateFileUI();
}

// 권한 요청은 사용자 제스처 안에서만 가능하므로 첫 상호작용에 얹는다
function armAutoReconnect() {
  const handler = e => {
    if (e.target && e.target.closest && e.target.closest('#btnFile')) return;
    document.removeEventListener('pointerdown', handler, true);
    document.removeEventListener('keydown', handler, true);
    if (!fileHandle || fileOn || typeof fileHandle.requestPermission !== 'function') return;
    toast("파일 다시 연결 중 — 권한 창에서 '매번 방문 시 허용'을 누르면 다음부터 자동입니다");
    fileHandle.requestPermission({ mode: 'readwrite' }).then(p => {
      if (p === 'granted') return adoptFile();
      toast("파일 연결 보류 — 하단 '파일 다시 연결'로 언제든 연결할 수 있어요", true);
      return null;
    }).catch(() => { /* 무시 */ });
  };
  document.addEventListener('pointerdown', handler, true);
  document.addEventListener('keydown', handler, true);
}

function updateFileUI() {
  const btn = $('btnFile');
  const hint = $('storeHint');
  if (fileOn) {
    btn.textContent = `파일 연결됨: ${fileHandle.name}`;
    btn.classList.add('on');
    hint.textContent = '기록은 파일과 브라우저 양쪽에 저장됩니다';
  } else if (fileHandle) {
    btn.textContent = '파일 다시 연결';
    btn.classList.remove('on');
    hint.textContent = '기록은 이 기기에 저장됩니다';
  } else {
    btn.textContent = '파일에 저장 연결';
    btn.classList.remove('on');
    hint.textContent = '기록은 이 기기에 저장됩니다';
  }
}

/* ===================== 위치 기반 자동 출퇴근 =====================
   근무지를 설정해 두면 앱이 열릴 때 위치를 확인해서
   - 근무지 안 + 오늘 출근 미기록 → 자동 출근 도장
   - 근무지 밖 + 출근 기록 있음 + 퇴근 미기록 → 자동 퇴근 도장
   (웹앱은 백그라운드 위치를 볼 수 없어 "앱이 열리는 순간" 판정합니다.
    iOS 단축어/안드 자동화로 도착·출발 시 이 앱을 열게 하면 자동화가 완성됩니다) */

const GEO_OK = 'geolocation' in navigator &&
  (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname));

function distMeters(a, b) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function getPosition() {
  return new Promise((res, rej) => {
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      rej,
      // 좁은 반경 판정을 위해 고정밀(GPS) 모드 사용
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

let geoChecking = false;

async function autoGeoCheck() {
  if (!GEO_OK || geoChecking) return;
  const wp = data.settings.workplace;
  if (!wp) return;
  geoChecking = true;
  try {
    const pos = await getPosition();
    const d = distMeters(pos, wp);
    const k = keyOf(new Date());
    const rec = data.records[k] || {};

    if (d <= wp.radius && pos.acc <= wp.radius * 1.5 && !rec.in) {
      // 근무지 안 + 측정 오차가 신뢰할 수준 + 출근 미기록 → 자동 출근
      applyAutoStamp(k, 'in');
    } else if (rec.in && !rec.out && d - pos.acc > wp.radius * 1.5) {
      // 확실히 근무지 밖(GPS 오차를 빼고도 반경의 1.5배 이상) + 퇴근 미기록 → 자동 퇴근
      applyAutoStamp(k, 'out');
    }
  } catch (e) {
    /* 위치 실패(권한 거부/시간초과)는 조용히 넘어감 */
  } finally {
    geoChecking = false;
  }
}

function applyAutoStamp(k, type) {
  const rec = Object.assign({}, data.records[k]);
  rec[type] = stampHM();
  data.records[k] = rec;
  persist();
  render();
  slam(type);
  toast(`📍 위치 기반 자동 ${type === 'in' ? '출근' : '퇴근'} ${rec[type]} 기록됨`);
}

function setupPlaceButton() {
  const btn = $('btnPlace');
  if (!GEO_OK) return; // 미지원 환경(PC file:// 등)에서는 숨김 유지
  btn.hidden = false;
  updatePlaceUI();

  btn.addEventListener('click', () => {
    if (data.settings.workplace) {
      confirmBox('근무지 설정을 해제할까요?\n위치 기반 자동 출퇴근이 꺼집니다.', () => {
        data.settings.workplace = null;
        persist();
        updatePlaceUI();
        toast('근무지 설정이 해제되었습니다');
      }, '해제');
      return;
    }
    toast('현재 위치를 확인하는 중…');
    getPosition().then(pos => {
      data.settings.workplace = { lat: pos.lat, lng: pos.lng, radius: 50 };
      persist();
      updatePlaceUI();
      toast('현재 위치가 근무지로 설정되었습니다 (반경 50m)');
      return null;
    }).catch(() => toast('위치를 가져오지 못했습니다 — 위치 권한을 확인하세요', true));
  });
}

function updatePlaceUI() {
  const btn = $('btnPlace');
  if (data.settings.workplace) {
    btn.textContent = '근무지 설정됨 ✓ (50m)';
    btn.classList.add('on');
  } else {
    btn.textContent = '근무지 설정';
    btn.classList.remove('on');
  }
}

/* ===================== 렌더링 ===================== */

function render() {
  renderSettings();
  renderToday();
  renderCalendar();
}

function renderSettings() {
  $('stdIn').value = data.settings.workStart;
  $('stdOut').value = data.settings.workEnd;
  const note = $('stdWarn');
  const a = toMin(data.settings.workStart);
  const b = toMin(data.settings.workEnd);
  if (a === b) {
    note.hidden = false;
    note.textContent = '출근·퇴근이 같아 ± 계산 불가';
    note.className = 'std-note warn';
  } else if (b < a) {
    note.hidden = false;
    note.textContent = '익일 퇴근 기준';
    note.className = 'std-note info';
  } else {
    note.hidden = true;
  }
}

function renderToday() {
  const now = new Date();
  const k = keyOf(now);
  curTodayKey = k;
  $('todayDate').textContent =
    `${now.getMonth() + 1}월 ${now.getDate()}일 ${DOW[now.getDay()]}요일`;

  const rec = data.records[k] || {};
  renderMark($('markIn'), rec, 'in');
  renderMark($('markOut'), rec, 'out');
  updateTodayStatus();
}

function renderMark(slot, rec, type) {
  const time = rec[type];
  slot.classList.toggle('stamped', !!time);
  slot.classList.toggle('mark-in', type === 'in');
  slot.classList.toggle('mark-out', type === 'out');
  if (time) {
    const st = dayStatus(rec);
    const nd = (type === 'out' && st.kind === 'done' && st.overnight)
      ? '<i class="nd">+1</i>' : '';
    slot.innerHTML = `<span class="mark-type">${type === 'in' ? '출' : '퇴'}</span>` +
      `<span class="mark-time">${time}${nd}</span>`;
  } else {
    slot.innerHTML = `<span class="mark-empty">${slot.dataset.label}<br>미기록</span>`;
  }
}

// 오늘 상태 문구 — 매초 호출되므로 바뀔 때만 DOM을 만진다.
function updateTodayStatus() {
  const rec = data.records[curTodayKey] || {};
  const st = dayStatus(rec);
  const el = $('todayStatus');
  let text = '', cls = '';

  if (st.kind === 'empty') {
    const yrec = data.records[yesterdayKey()];
    if (yrec && yrec.in && !yrec.out) {
      text = `어제 출근 ${yrec.in} — 퇴근 도장을 누르면 어제 기록으로 저장돼요`;
      cls = 'warn';
    } else {
      text = '아직 출근 전입니다';
    }
  } else if (st.kind === 'partial' && st.in !== null) {
    const elapsed = Math.max(0, toMin(nowHM()) - st.in);
    text = `근무 중 · 경과 ${fmtHM(elapsed)}`;
    cls = 'working';
  } else if (st.kind === 'partial') {
    text = '퇴근 기록만 있습니다 — 날짜를 눌러 출근 시각을 입력하세요';
    cls = 'warn';
  } else if (st.kind === 'invalid') {
    text = '출근과 퇴근이 같은 시각입니다 — 시간을 확인하세요';
    cls = 'warn';
  } else {
    const night = st.overnight ? ' (익일 퇴근)' : '';
    const diff = st.diff === null ? '' : ` · 기준 대비 ${fmtSigned(st.diff)}`;
    text = `오늘 근무 ${fmtHM(st.worked)}${night}${diff}`;
    cls = st.diff !== null && st.diff < 0 ? 'minus' : 'plus';
  }
  if (el.textContent !== text) el.textContent = text;
  el.className = 'today-status ' + cls;
}

function renderCalendar() {
  $('calTitle').textContent = `${viewY}년 ${viewM + 1}월`;

  const grid = $('calGrid');
  const frag = document.createDocumentFragment();

  for (const [i, name] of DOW.entries()) {
    const h = document.createElement('div');
    h.className = 'dow' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '');
    h.textContent = name;
    frag.appendChild(h);
  }

  const firstDow = new Date(viewY, viewM, 1).getDay();
  const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
  const todayK = keyOf(new Date());

  for (let i = 0; i < firstDow; i++) frag.appendChild(emptyCell());

  for (let d = 1; d <= daysInMonth; d++) {
    const k = `${viewY}-${pad(viewM + 1)}-${pad(d)}`;
    const dow = (firstDow + d - 1) % 7;
    const rec = data.records[k];
    const st = dayStatus(rec || {});

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.dataset.key = k;
    cell.className = 'cal-cell'
      + (dow === 0 ? ' sun' : dow === 6 ? ' sat' : '')
      + (k === todayK ? ' today' : '')
      + (rec ? ' has-rec' : '');

    let aria = `${viewY}년 ${viewM + 1}월 ${d}일 ${DOW[dow]}요일`;
    let html = `<span class="dnum">${d}</span>`;
    if (rec) {
      const nd = (st.kind === 'done' && st.overnight) ? '<i class="nd">+1</i>' : '';
      html += '<span class="times">'
        + (rec.in ? `<em class="t-in"><i>출 </i>${shortHM(rec.in)}</em>` : '')
        + (rec.out ? `<em class="t-out"><i>퇴 </i>${shortHM(rec.out)}${nd}</em>` : '')
        + '</span>';
      if (rec.in) aria += `, 출근 ${rec.in}`;
      if (rec.out) aria += `, 퇴근 ${rec.out}` + (st.kind === 'done' && st.overnight ? ' 익일' : '');
      if (st.kind === 'done' && st.diff !== null) {
        const sign = st.diff === 0 ? 'zero' : st.diff > 0 ? 'plus' : 'minus';
        html += `<span class="diff ${sign}">${fmtSigned(st.diff)}</span>`;
        aria += `, 기준 대비 ${fmtSigned(st.diff)}`;
      } else if (st.kind === 'invalid') {
        html += `<span class="diff warn">확인</span>`;
        aria += ', 시간 확인 필요';
      }
    } else {
      aria += ', 기록 없음';
    }
    cell.setAttribute('aria-label', aria + ', 기록 수정');
    cell.innerHTML = html;
    frag.appendChild(cell);
  }

  // 마지막 줄을 채워 격자선을 반듯하게
  const used = firstDow + daysInMonth;
  const trailing = (7 - (used % 7)) % 7;
  for (let i = 0; i < trailing; i++) frag.appendChild(emptyCell());

  grid.replaceChildren(frag);
  renderSummary();
}

function emptyCell() {
  const el = document.createElement('div');
  el.className = 'cal-cell empty';
  return el;
}

function renderSummary() {
  let days = 0, doneDays = 0, sum = 0, hasDiff = false;
  const prefix = `${viewY}-${pad(viewM + 1)}-`;
  for (const [k, rec] of Object.entries(data.records)) {
    if (!k.startsWith(prefix)) continue;
    days++;
    const st = dayStatus(rec);
    if (st.kind === 'done') {
      doneDays++;
      if (st.diff !== null) { sum += st.diff; hasDiff = true; }
    }
  }
  const parts = [`근무 ${days}일`];
  if (hasDiff) parts.push(`누적 <b class="${sum < 0 ? 'minus' : 'plus'}">${fmtSigned(sum)}</b>`);
  else if (doneDays > 0) parts.push('기준 근무시간이 올바르지 않아 ±를 계산할 수 없습니다');
  $('calSummary').innerHTML = parts.join('<span class="dot">·</span>');
}

/* ===================== 도장 찍기 ===================== */

function stamp(type) {
  const label = type === 'in' ? '출근' : '퇴근';

  // 날짜 키와 기록은 실제로 쓰는 순간 다시 읽는다 (자정·다중 탭 안전)
  const doIt = () => {
    const k = keyOf(new Date());
    const rec = Object.assign({}, data.records[k]);
    rec[type] = stampHM();
    data.records[k] = rec;
    persist();
    render();
    slam(type);
    toast(`${label} ${rec[type]} 기록됨`);
  };

  // 자정 넘어 퇴근: 오늘 출근 기록이 없고 어제가 퇴근 미기록이면 어제 기록으로 제안
  if (type === 'out') {
    const yk = yesterdayKey();
    const yrec = data.records[yk];
    const trec = data.records[keyOf(new Date())];
    if (yrec && yrec.in && !yrec.out && !(trec && trec.in)) {
      const [, m, d] = yk.split('-').map(Number);
      confirmBox(
        `어제(${m}월 ${d}일) 출근 ${yrec.in} 기록의 퇴근이 비어 있습니다.\n지금 시각을 어제의 퇴근(익일 ${stampHM()})으로 기록할까요?`,
        () => {
          const fresh = Object.assign({}, data.records[yk]);
          fresh.out = stampHM();
          data.records[yk] = fresh;
          persist();
          render();
          slam('out');
          toast(`어제 퇴근 ${fresh.out} 기록됨 (익일)`);
        },
        '어제 퇴근으로 기록'
      );
      return;
    }
  }

  const existing = (data.records[keyOf(new Date())] || {})[type];
  if (existing) {
    confirmBox(
      `오늘 ${label} 기록(${existing})이 이미 있습니다.\n지금 시각(${stampHM()})으로 덮어쓸까요?`,
      doIt,
      '덮어쓰기'
    );
  } else {
    doIt();
  }
}

function slam(type) {
  const el = type === 'in' ? $('markIn') : $('markOut');
  el.classList.remove('slam');
  void el.offsetWidth; // 애니메이션 재시작
  el.classList.add('slam');
}

/* ===================== 수정 모달 ===================== */

function openEdit(k) {
  editKey = k;
  const [y, m, d] = k.split('-').map(Number);
  const dow = DOW[new Date(y, m - 1, d).getDay()];
  $('editTitle').textContent = `${y}년 ${m}월 ${d}일 (${dow})`;
  const rec = data.records[k] || {};
  $('editIn').value = rec.in || '';
  $('editOut').value = rec.out || '';
  $('editDelete').hidden = !data.records[k];
  $('editHint').textContent = '';
  delete $('editHint').dataset.warned;
  openModal($('editModal'));
  $('editIn').focus();
}

function refocusCell(k) {
  const cell = document.querySelector(`[data-key="${k}"]`);
  if (cell) cell.focus();
}

function saveEdit() {
  // 입력값도 30분 단위로 내림 정렬
  const inV = snapHM($('editIn').value);
  const outV = snapHM($('editOut').value);
  const snapped =
    (inV !== null && inV !== $('editIn').value) ||
    (outV !== null && outV !== $('editOut').value);
  const rec = {};
  if (inV !== null) rec.in = inV;
  if (outV !== null) rec.out = outV;

  if (rec.in && rec.out && toMin(rec.out) === toMin(rec.in)) {
    $('editHint').textContent = '출근과 퇴근이 같은 시각입니다 — 한 번 더 누르면 이대로 저장됩니다 (± 계산 제외).';
    if ($('editHint').dataset.warned !== editKey) {
      $('editHint').dataset.warned = editKey;
      return;
    }
  }

  const overnight = rec.in && rec.out && toMin(rec.out) < toMin(rec.in);
  const k = editKey;
  if (rec.in || rec.out) data.records[k] = rec;
  else delete data.records[k];

  closeModal($('editModal'));
  persist();
  render();
  refocusCell(k);
  toast(
    overnight ? '저장됨 · 퇴근은 익일(다음날)로 계산됩니다'
      : snapped ? '30분 단위로 맞춰 저장되었습니다'
      : '기록이 저장되었습니다'
  );
}

function deleteEdit() {
  const k = editKey;
  const rec = data.records[k] || {};
  const parts = [rec.in ? `출근 ${rec.in}` : null, rec.out ? `퇴근 ${rec.out}` : null]
    .filter(Boolean).join(', ');
  confirmBox(
    `${$('editTitle').textContent} 기록(${parts})을 삭제할까요?`,
    () => {
      delete data.records[k];
      closeModal($('editModal'));
      persist();
      render();
      refocusCell(k);
      toast('기록이 삭제되었습니다');
    },
    '삭제'
  );
}

/* ===================== 모달 · 토스트 ===================== */

let confirmAction = null;
const modalStack = []; // { el, opener } — 포커스 복원용

function confirmBox(msg, onOk, okLabel) {
  $('confirmMsg').textContent = msg;
  $('confirmOk').textContent = okLabel || '확인';
  confirmAction = onOk;
  openModal($('confirmModal'));
  $('confirmOk').focus();
}

function openModal(el) {
  modalStack.push({ el, opener: document.activeElement });
  el.dataset.openedAt = String(performance.now());
  el.hidden = false;
  document.body.classList.add('modal-open');
}

function closeModal(el) {
  el.hidden = true;
  for (let i = modalStack.length - 1; i >= 0; i--) {
    if (modalStack[i].el === el) {
      const { opener } = modalStack.splice(i, 1)[0];
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
      break;
    }
  }
  if ($('editModal').hidden && $('confirmModal').hidden) {
    document.body.classList.remove('modal-open');
  }
}

function trapFocus(e) {
  if (!modalStack.length) return;
  const card = modalStack[modalStack.length - 1].el.querySelector('.modal-card');
  const focusables = Array.from(card.querySelectorAll('button:not([hidden]), input'))
    .filter(x => !x.disabled && x.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const inside = card.contains(document.activeElement);
  if (e.shiftKey && (!inside || document.activeElement === first)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
    e.preventDefault();
    first.focus();
  }
}

function toast(msg, isError) {
  const wrap = $('toastWrap');
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.classList.add('gone'), 2400);
  setTimeout(() => el.remove(), 3000);
}

/* ===================== 이벤트 ===================== */

function bindEvents() {
  $('btnIn').addEventListener('click', () => stamp('in'));
  $('btnOut').addEventListener('click', () => stamp('out'));

  $('prevM').addEventListener('click', () => moveMonth(-1));
  $('nextM').addEventListener('click', () => moveMonth(1));
  $('goToday').addEventListener('click', () => {
    const t = new Date();
    viewY = t.getFullYear(); viewM = t.getMonth();
    renderCalendar();
  });

  $('calGrid').addEventListener('click', e => {
    const cell = e.target.closest('button[data-key]');
    if (cell) openEdit(cell.dataset.key);
  });

  for (const id of ['stdIn', 'stdOut']) {
    $(id).addEventListener('change', () => {
      const v = snapHM($(id).value); // 기준시간도 30분 단위로
      if (v === null) { renderSettings(); return; }
      data.settings[id === 'stdIn' ? 'workStart' : 'workEnd'] = v;
      persist();
      render();
    });
  }

  $('btnFile').addEventListener('click', connectFile);

  $('editSave').addEventListener('click', saveEdit);
  $('editDelete').addEventListener('click', deleteEdit);
  $('editCancel').addEventListener('click', () => closeModal($('editModal')));

  $('confirmOk').addEventListener('click', () => {
    closeModal($('confirmModal'));
    const fn = confirmAction; confirmAction = null;
    if (fn) fn();
  });
  $('confirmCancel').addEventListener('click', () => {
    confirmAction = null;
    closeModal($('confirmModal'));
  });

  // 배경 클릭으로 닫기 — 더블클릭 오작동 방지 가드 포함
  for (const id of ['editModal', 'confirmModal']) {
    const el = $(id);
    let downOnBackdrop = false;
    el.addEventListener('mousedown', e => { downOnBackdrop = e.target === el; });
    el.addEventListener('click', e => {
      if (!downOnBackdrop || e.target !== el) return;
      if (performance.now() - Number(el.dataset.openedAt || 0) < 400) return;
      if (id === 'confirmModal') confirmAction = null;
      closeModal(el);
    });
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modalStack.length) {
      const top = modalStack[modalStack.length - 1].el;
      if (top === $('confirmModal')) confirmAction = null;
      closeModal(top);
    } else if (e.key === 'Tab') {
      trapFocus(e);
    }
  });

  // 다른 탭/창에서 저장한 내용 반영
  window.addEventListener('storage', e => {
    if (e.key === LS_KEY) { loadData().then(render); }
  });

  // 앱이 다시 화면에 나타나면 위치 자동 판정
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') autoGeoCheck();
  });
}

function moveMonth(delta) {
  const d = new Date(viewY, viewM + delta, 1);
  viewY = d.getFullYear(); viewM = d.getMonth();
  renderCalendar();
}

/* ===================== 시계 · 시작 ===================== */

function tick() {
  const now = new Date();
  $('clock').textContent =
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  if (keyOf(now) !== curTodayKey) { // 자정을 넘겼음
    render();
    return;
  }
  updateTodayStatus();
}

async function init() {
  await loadData();
  const t = new Date();
  viewY = t.getFullYear(); viewM = t.getMonth();
  bindEvents();
  render();
  tick();
  setInterval(tick, 1000);
  initFile();        // 파일 연결 (PC)
  setupPlaceButton(); // 근무지 설정 (모바일)

  // 브라우저에 저장공간 영구 보존 요청 (모바일 임의 삭제 방지)
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (e) { /* 무시 */ }

  // PWA 오프라인 지원 — https(호스팅)에서만, PC file:// 사용에는 영향 없음
  if ('serviceWorker' in navigator &&
      (location.protocol === 'https:' ||
       ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* 무시 */ });
  }

  // 위치 자동 판정 — 단축어/자동화가 ?auto=1 로 열어도 같은 경로
  autoGeoCheck();
  if (new URLSearchParams(location.search).has('auto')) {
    history.replaceState(null, '', location.pathname);
  }
}

init();
