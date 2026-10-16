'use strict';
/* SiarakasBCG calendar — runs fully on the phone. Data lives in IndexedDB (jobs + photos). */

/* ---------- tiny helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const key = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const todayKey = () => { const t = new Date(); return key(t.getFullYear(), t.getMonth(), t.getDate()); };
const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return key(d.getFullYear(), d.getMonth(), d.getDate()); };
const fmtDate = (k) => parseKey(k).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const MIN_KEY = '2025-01-01', MAX_KEY = '2100-12-31';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STATUS = { planned: 'Planned', progress: 'In progress', done: 'Done' };
const LABELS = ['before', 'after', 'other'];
const LABEL_TXT = { before: 'Before', after: 'After', other: 'Other' };

const ICON = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  share: '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/></svg>',
  map: '<svg viewBox="0 0 24 24"><path d="M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V18a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>'
};

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return e;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------- database ---------- */
const rp = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('siarakasbcg', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('jobs', { keyPath: 'id' });
        d.createObjectStore('photos', { keyPath: 'id' }).createIndex('job', 'jobId');
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  all(store) { return rp(this.db.transaction(store).objectStore(store).getAll()); },
  count(store) { return rp(this.db.transaction(store).objectStore(store).count()); },
  putMany(store, vals) {
    const t = this.db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    vals.forEach((v) => s.put(v));
    return txDone(t);
  },
  put(store, v) { return this.putMany(store, [v]); },
  del(store, id) {
    const t = this.db.transaction(store, 'readwrite');
    t.objectStore(store).delete(id);
    return txDone(t);
  },
  photosOf(jobId) { return rp(this.db.transaction('photos').objectStore('photos').index('job').getAll(jobId)); },
  delJob(id) {
    const t = this.db.transaction(['jobs', 'photos'], 'readwrite');
    t.objectStore('jobs').delete(id);
    const ps = t.objectStore('photos');
    const r = ps.index('job').getAllKeys(id);
    r.onsuccess = () => r.result.forEach((k) => ps.delete(k));
    return txDone(t);
  }
};

/* ---------- state ---------- */
const S = { view: { y: 2026, m: 9 }, jobs: [], byDate: new Map(), lastToday: '', screen: 'home', jobFilter: 'all' };

function reindex() {
  S.byDate = new Map();
  for (const j of S.jobs) {
    if (!S.byDate.has(j.date)) S.byDate.set(j.date, []);
    S.byDate.get(j.date).push(j);
  }
  for (const list of S.byDate.values()) list.sort((a, b) => (a.remind || '99').localeCompare(b.remind || '99') || a.created - b.created);
}
function upsertJob(j) {
  const i = S.jobs.findIndex((x) => x.id === j.id);
  if (i >= 0) S.jobs[i] = j; else S.jobs.push(j);
  reindex();
}
function removeJob(id) { S.jobs = S.jobs.filter((x) => x.id !== id); reindex(); }
const jobName = (j) => (j.name && j.name.trim()) || 'Untitled job';

/* ---------- money ---------- */
const round2 = (n) => Math.round(n * 100) / 100;
// Accepts "10000", "10,000", "10.000,50", "7500.5", "€ 3 000" ... and returns a number (never negative)
function parseMoney(str) {
  let s = String(str == null ? '' : str).replace(/[^\d.,]/g, '');
  if (!s) return 0;
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  let dec = -1;
  if (lc >= 0 && ld >= 0) dec = Math.max(lc, ld);              // both used: the last one is the decimal point
  else if (lc >= 0 || ld >= 0) {
    const i = Math.max(lc, ld), sep = s[i];
    const times = s.split(sep).length - 1, after = s.length - i - 1;
    if (times === 1 && after !== 3) dec = i;                   // "10,5" / "10.50" are decimals; "10,000" / "1.500" are thousands
  }
  const intPart = (dec >= 0 ? s.slice(0, dec) : s).replace(/[.,]/g, '');
  const frac = dec >= 0 ? s.slice(dec + 1).replace(/[.,]/g, '') : '';
  const n = parseFloat((intPart || '0') + '.' + (frac || '0'));
  return Number.isFinite(n) ? round2(n) : 0;
}
const nf0 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoney = (n) => '€' + (Number.isInteger(n) ? nf0 : nf2).format(n);
const priceOf = (j) => Number(j.price) || 0;
const paymentsOf = (j) => (Array.isArray(j.payments) ? j.payments : []);
const paidOf = (j) => (Array.isArray(j.payments)
  ? round2(j.payments.reduce((a, x) => a + (Number(x.amount) || 0), 0))
  : Number(j.paid) || 0);
const lastPayment = (j) => paymentsOf(j).filter((x) => Number(x.amount) > 0 && x.date).map((x) => x.date).sort().pop() || null;
const owedOf = (j) => round2(priceOf(j) - paidOf(j));
const isUnpaid = (j) => priceOf(j) > 0 && owedOf(j) > 0;
const owedText = (j) => (isUnpaid(j) ? fmtMoney(owedOf(j)) + ' missing' : null);
const shortDate = (k) => parseKey(k).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const clampView = (y, m) => {
  let i = y * 12 + m;
  i = Math.max(2025 * 12, Math.min(2100 * 12 + 11, i));
  return { y: Math.floor(i / 12), m: i % 12 };
};

/* ---------- layers (sheets / full screens) with Android back-button support ---------- */
const layer = $('#layer');
const stack = [];
let sentinel = false, ignorePops = 0;

function openLayer(node, onclose) {
  node._onclose = onclose;
  layer.append(node);
  layer.style.pointerEvents = 'auto';
  stack.push(node);
  if (stack.length === 1) { history.pushState({ s: 1 }, ''); sentinel = true; }
  return () => closeLayer(node);
}
function closeLayer(node) {
  const i = stack.indexOf(node);
  if (i < 0) return;
  stack.splice(i, 1);
  node.remove();
  if (node._onclose) node._onclose();
  if (!stack.length) {
    layer.style.pointerEvents = 'none';
    if (sentinel) { sentinel = false; ignorePops++; history.back(); }
  }
}
window.addEventListener('popstate', () => {
  if (ignorePops > 0) { ignorePops--; return; }
  if (!stack.length) { if (S.screen !== 'home') showScreen('home'); return; }   // phone Back button: section -> home
  const top = stack.pop();
  top.remove();
  if (top._onclose) top._onclose();
  if (stack.length) history.pushState({ s: 1 }, '');
  else { layer.style.pointerEvents = 'none'; sentinel = false; }
});

function makeSheet(title, sub) {
  const wrap = h('div', { class: 'wrap' });
  const scrim = h('div', { class: 'scrim' });
  const body = h('div', { class: 'sh-body' });
  const foot = h('div', { class: 'sh-foot' });
  const sheet = h('div', { class: 'sheet' },
    h('div', { class: 'grab' }),
    h('div', { class: 'sh-head' }, h('h2', null, title), sub ? h('p', null, sub) : null),
    body, foot);
  wrap.append(scrim, sheet);
  const api = { wrap, body, foot, sheet, close: null };
  scrim.addEventListener('click', () => api.close());
  return api;
}

/* ---------- screens: home / calendar / jobs / money ---------- */
const SCREENS = ['home', 'cal', 'jobs', 'money'];
function showScreen(name) {
  S.screen = name;
  SCREENS.forEach((n) => { $('#' + n + 'Screen').hidden = n !== name; });
  refreshAll();
}
function openSection(name) {            // from the home screen into a section
  history.pushState({ sec: name }, '');
  showScreen(name);
}
function goHome() {                     // back arrow inside a section
  if (S.screen === 'home') return;
  ignorePops++; history.back();
  showScreen('home');
}
function refreshAll() {
  renderCal(); renderHome(); renderJobs(); renderMoney();
}

function renderHome() {
  const t = todayKey();
  const todayN = (S.byDate.get(t) || []).length;
  $('#subDate').textContent = parseKey(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  $('#subCal').textContent = todayN ? `${todayN} job${todayN > 1 ? 's' : ''} today` : 'No jobs today';
  const n = S.jobs.length;
  $('#subJobs').textContent = n ? `${n} job${n > 1 ? 's' : ''}` : 'No jobs yet';
  const unpaid = S.jobs.filter(isUnpaid);
  const total = round2(unpaid.reduce((a, j) => a + owedOf(j), 0));
  $('#moneyBig').textContent = fmtMoney(total);
  $('#moneySub').textContent = unpaid.length
    ? `still missing · ${unpaid.length} unpaid job${unpaid.length > 1 ? 's' : ''}`
    : S.jobs.some((j) => priceOf(j) > 0) ? 'Nobody owes you money' : 'Add a price to a job to track it';
}

function renderJobs() {
  const chips = $('#jobChips');
  chips.replaceChildren();
  [['all', 'All'], ['planned', 'Planned'], ['progress', 'In progress'], ['done', 'Done']].forEach(([k, v]) =>
    chips.append(h('button', { class: 'chip' + (S.jobFilter === k ? ' on' : ''), onclick: () => { S.jobFilter = k; renderJobs(); } }, v)));
  const t = todayKey();
  const list = S.jobs.filter((j) => S.jobFilter === 'all' || (j.status || 'planned') === S.jobFilter);
  const cmp = (a, b) => a.date.localeCompare(b.date) || a.created - b.created;
  const ahead = list.filter((j) => j.date >= t).sort(cmp);
  const past = list.filter((j) => j.date < t).sort((a, b) => cmp(b, a));
  const grid = $('#jobsGrid');
  grid.replaceChildren();
  if (!list.length) {
    grid.append(h('div', { class: 'empty grid-empty' }, S.jobs.length ? 'No jobs with this status.' : 'No jobs yet. Tap the + button to add your first one.'));
    return;
  }
  [...ahead, ...past].forEach((j) => {
    const owe = owedText(j);
    grid.append(h('button', { class: 'jcard' + (j.date < t ? ' past' : ''), onclick: () => openJob(j, j.date, null) },
      h('div', { class: 'jtop' }, h('span', { class: 'jicon', html: ICON.folder }), h('i', { class: 'd ' + (j.status || 'planned') })),
      h('div', { class: 'jname' }, jobName(j)),
      h('div', { class: 'jmeta' }, shortDate(j.date) + (j.client ? ' · ' + j.client : '')),
      owe ? h('div', { class: 'jowed' }, owe) : priceOf(j) > 0 ? h('div', { class: 'jpaid' }, 'Paid in full') : null));
  });
}

function renderMoney() {
  const body = $('#moneyBody');
  body.replaceChildren();
  const unpaid = S.jobs.filter(isUnpaid).sort((a, b) => a.date.localeCompare(b.date) || a.created - b.created);   // oldest first
  const missing = round2(unpaid.reduce((a, j) => a + owedOf(j), 0));
  const got = round2(unpaid.reduce((a, j) => a + paidOf(j), 0));
  const total = round2(unpaid.reduce((a, j) => a + priceOf(j), 0));
  body.append(h('div', { class: 'msum' },
    h('div', { class: 'k' }, 'Still missing'),
    h('div', { class: 'big' }, fmtMoney(missing)),
    h('div', { class: 'sub' }, unpaid.length
      ? `Received ${fmtMoney(got)} of ${fmtMoney(total)} on ${unpaid.length} unpaid job${unpaid.length > 1 ? 's' : ''}`
      : 'Nobody owes you money right now.')));
  const list = h('div', { class: 'mlist' });
  if (!unpaid.length) {
    list.append(h('div', { class: 'empty' }, S.jobs.some((j) => priceOf(j) > 0)
      ? 'Every job with a price is paid in full.'
      : 'Open a job and enter its total price and what you have received. Jobs that still owe you money show up here.'));
  }
  unpaid.forEach((j) => {
    const pct = Math.max(0, Math.min(100, Math.round((paidOf(j) / priceOf(j)) * 100)));
    list.append(h('button', { class: 'mitem', onclick: () => openJob(j, j.date, null) },
      h('div', { class: 'mrow' }, h('div', { class: 'mname' }, jobName(j)), h('div', { class: 'mowed' }, fmtMoney(owedOf(j)))),
      h('div', { class: 'msub' }, [j.client, shortDate(j.date), lastPayment(j) ? 'Last payment ' + shortDate(lastPayment(j)) : null].filter(Boolean).join(' · ')),
      h('div', { class: 'bar2' }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'mrow small' }, h('span', null, 'Received ' + fmtMoney(paidOf(j))), h('span', null, 'Total ' + fmtMoney(priceOf(j))))));
  });
  body.append(list);
}

/* ---------- calendar ---------- */
function renderCal() {
  const { y, m } = S.view;
  $('#titleMonth').textContent = MONTHS[m];
  $('#titleYear').textContent = y;
  const grid = $('#grid');
  grid.replaceChildren();
  const first = (new Date(y, m, 1).getDay() + 6) % 7; // Monday first
  const dim = new Date(y, m + 1, 0).getDate();
  const tk = todayKey();
  S.lastToday = tk;
  for (let i = 0; i < first; i++) grid.append(h('div', { class: 'cell blank' }));
  for (let d = 1; d <= dim; d++) {
    const k = key(y, m, d);
    const list = S.byDate.get(k) || [];
    const cls = ['cell'];
    if (k < tk) cls.push('past');
    if (k === tk) cls.push('today');
    const cell = h('button', {
      class: cls.join(' '),
      'data-date': k,
      'aria-label': fmtDate(k) + (list.length ? `, ${list.length} job${list.length > 1 ? 's' : ''}` : ''),
      onclick: () => openDay(k)
    }, h('span', { class: 'num' }, d));
    if (list.length) {
      const dots = h('div', { class: 'dots' });
      list.slice(0, 3).forEach((j) => dots.append(h('i', { class: j.status || 'planned' })));
      if (list.length > 3) dots.append(h('i', { class: 'more' }, '+' + (list.length - 3)));
      cell.append(dots);
    }
    grid.append(cell);
  }
  renderBanner();
}

function renderBanner() {
  const b = $('#banner');
  const t = todayKey();
  const a = (S.byDate.get(t) || []).filter((j) => j.status !== 'done').length;
  const c = (S.byDate.get(addDays(t, 1)) || []).filter((j) => j.status !== 'done').length;
  if (!a && !c) { b.hidden = true; return; }
  const parts = [];
  if (a) parts.push(`Today: ${a} job${a > 1 ? 's' : ''}`);
  if (c) parts.push(`Tomorrow: ${c} job${c > 1 ? 's' : ''}`);
  b.textContent = parts.join('   ·   ');
  b.onclick = () => openDay(a ? t : addDays(t, 1));
  b.hidden = false;
}

function go(delta) {
  S.view = clampView(S.view.y, S.view.m + delta);
  renderCal();
}
function goToday() {
  const t = new Date();
  S.view = { y: t.getFullYear(), m: t.getMonth() };
  renderCal();
}

function openPicker() {
  const sh = makeSheet('Go to month');
  let year = S.view.y;
  const sel = h('select', { class: 'inp' });
  for (let y = 2025; y <= 2100; y++) sel.append(h('option', { value: y, selected: y === year }, String(y)));
  const months = h('div', { class: 'months' });
  const paint = () => {
    months.replaceChildren();
    MONTHS.forEach((name, i) => {
      months.append(h('button', {
        class: year === S.view.y && i === S.view.m ? 'on' : '',
        onclick: () => { S.view = { y: year, m: i }; renderCal(); sh.close(); }
      }, name.slice(0, 3)));
    });
  };
  sel.addEventListener('change', () => { year = Number(sel.value); paint(); });
  sh.body.append(h('div', { class: 'picker-years' }, sel), months);
  sh.foot.append(h('button', { class: 'btn line block', onclick: () => { goToday(); sh.close(); } }, 'Jump to today'));
  paint();
  sh.close = openLayer(sh.wrap);
}

/* ---------- day sheet ---------- */
function openDay(k) {
  const sh = makeSheet(fmtDate(k), k < todayKey() ? 'Past day' : k === todayKey() ? 'Today' : '');
  const render = () => {
    sh.body.replaceChildren();
    const list = S.byDate.get(k) || [];
    if (!list.length) sh.body.append(h('div', { class: 'empty' }, 'No jobs on this day yet.'));
    list.forEach((j) => {
      sh.body.append(h('button', { class: 'job-item', onclick: () => openJob(j, k, render) },
        h('i', { class: 'd ' + (j.status || 'planned') }),
        h('div', { class: 'meta' },
          h('div', { class: 't' }, jobName(j)),
          h('div', { class: 's' }, [STATUS[j.status] || 'Planned', j.remind ? j.remind : null, j.client || null, owedText(j)].filter(Boolean).join(' · '))),
        h('span', { class: 'go' }, '›')));
    });
  };
  sh.foot.append(
    h('button', { class: 'btn gold block', onclick: () => openJob(null, k, render) }, '+ Add job'),
    h('button', { class: 'btn line', onclick: () => sh.close() }, 'Close'));
  render();
  sh.close = openLayer(sh.wrap, () => refreshAll());
}

/* ---------- photos ---------- */
async function shrink(file, max = 1600, q = 0.82) {
  try {
    const bmp = await createImageBitmap(file);
    const sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * sc), hh = Math.round(bmp.height * sc);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = hh;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, hh);
    if (bmp.close) bmp.close();
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', q));
    return blob || file;
  } catch (e) {
    return file; // keep the original if the browser can't decode it
  }
}
const blobToDataURL = (b) => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = () => rej(f.error); f.readAsDataURL(b); });
const dataURLToBlob = (u) => fetch(u).then((r) => r.blob());

let noLockUntil = 0;
function pickFiles(inputId, handler) {
  const input = $(inputId);
  noLockUntil = Date.now() + 5 * 60 * 1000; // camera/gallery can send the app to background; don't re-lock for that
  input.onchange = async () => {
    const files = [...input.files];
    input.value = '';
    noLockUntil = Date.now() + 15000;
    if (files.length) await handler(files);
  };
  input.click();
}

/* ---------- job editor ---------- */
function jobText(j) {
  const lines = ['SiarakasBCG job', jobName(j), 'Date: ' + fmtDate(j.date), 'Status: ' + (STATUS[j.status] || 'Planned')];
  if (j.client) lines.push('Client: ' + j.client);
  if (j.phone) lines.push('Phone: ' + j.phone);
  if (j.address) lines.push('Address: ' + j.address, 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(j.address));
  const ms = (j.measures || []).filter((m) => (m.name || '').trim() || (m.value || '').trim());
  if (ms.length) { lines.push('', 'Measurements:'); ms.forEach((m) => lines.push(`${(m.name || '').trim() || '-'}: ${(m.value || '').trim()}`)); }
  if (j.notes) lines.push('', j.notes);
  return lines.join('\n');
}

async function shareJob(j, photos) {
  const text = jobText(j);
  const files = photos.map((p, i) => new File([p.blob], `${jobName(j).replace(/[^\w\-]+/g, '_')}-${p.label}-${i + 1}.jpg`, { type: p.blob.type || 'image/jpeg' }));
  try {
    if (files.length && navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ title: jobName(j), text, files });
    } else if (navigator.share) {
      await navigator.share({ title: jobName(j), text });
      if (files.length) toast('Photos could not be attached on this device');
    } else {
      await navigator.clipboard.writeText(text);
      toast('Job details copied');
    }
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('Sharing failed');
  }
}

async function openJob(job, dateKey, onChange) {
  const cur = job ? { ...job } : {
    id: uid(), date: dateKey, name: '', status: 'planned', client: '', phone: '', address: '',
    notes: '', remind: '', price: 0, paid: 0, payments: [], measures: [], created: Date.now(), updated: Date.now()
  };
  // work on copies of the lists so nothing is changed until it is saved
  if (!Array.isArray(cur.payments)) {
    const old = Number(cur.paid) || 0;              // jobs saved by the earlier version: turn the single amount into one payment
    const d = new Date(cur.updated || Date.now());
    cur.payments = old > 0 ? [{ id: uid(), date: key(d.getFullYear(), d.getMonth(), d.getDate()), amount: old }] : [];
  } else cur.payments = cur.payments.map((x) => ({ ...x }));
  cur.measures = Array.isArray(cur.measures) ? cur.measures.map((x) => ({ ...x })) : [];
  let saved = !!job, timer = null, deleted = false;
  const photos = job ? await DB.photosOf(cur.id) : [];
  const urls = new Map();
  const urlOf = (p) => { if (!urls.has(p.id)) urls.set(p.id, URL.createObjectURL(p.blob)); return urls.get(p.id); };
  const emptyJob = () => !cur.name.trim() && !cur.client && !cur.phone && !cur.address && !cur.notes && !cur.remind && !cur.price && !paidOf(cur) && !cur.measures.some((m) => (m.name || '').trim() || (m.value || '').trim()) && !photos.length;

  const saveNow = async () => {
    clearTimeout(timer); timer = null;
    if (deleted) return;
    cur.updated = Date.now();
    cur.paid = paidOf(cur);                      // keep the plain total in step with the payments list
    try {
      await DB.put('jobs', { ...cur });
      upsertJob({ ...cur });
      saved = true;
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    } catch (e) { toast('Could not save (storage full?)'); }
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(saveNow, 350); };

  const node = h('div', { class: 'full' });
  const bar = h('div', { class: 'bar has-right' },
    h('button', { class: 'icon-btn', 'aria-label': 'Back', html: ICON.back, onclick: () => close() }),
    h('h2', null, 'Job'),
    h('button', { class: 'icon-btn', 'aria-label': 'Share job', html: ICON.share, onclick: async () => { await saveNow(); shareJob(cur, photos); } }));
  const body = h('div', { class: 'body' });
  node.append(bar, body);

  const field = (label, input) => h('label', { class: 'f' }, h('span', null, label), input);
  const bind = (el, prop, after) => el.addEventListener('input', () => { cur[prop] = el.value; if (after) after(); later(); });

  const name = h('input', { class: 'inp', placeholder: 'e.g. Kitchen renovation, Glyfada', value: cur.name });
  bind(name, 'name');
  const date = h('input', { class: 'inp', type: 'date', min: MIN_KEY, max: MAX_KEY, value: cur.date });
  date.addEventListener('change', () => { if (date.value >= MIN_KEY && date.value <= MAX_KEY) { cur.date = date.value; later(); toast('Moved to ' + fmtDate(cur.date)); } else date.value = cur.date; });

  const seg = h('div', { class: 'seg' });
  const paintSeg = () => {
    seg.replaceChildren();
    Object.entries(STATUS).forEach(([k, v]) => seg.append(h('button', { class: cur.status === k ? 'on' : '', onclick: () => { cur.status = k; paintSeg(); later(); } }, h('i', { class: 'd ' + k }), v)));
  };
  paintSeg();

  const client = h('input', { class: 'inp', placeholder: 'Client name', value: cur.client });
  bind(client, 'client');
  const phone = h('input', { class: 'inp', type: 'tel', placeholder: 'Phone number', value: cur.phone });
  bind(phone, 'phone');
  const address = h('input', { class: 'inp', placeholder: 'Address', value: cur.address });
  bind(address, 'address');
  const remind = h('input', { class: 'inp', type: 'time', value: cur.remind });
  bind(remind, 'remind');
  const notes = h('textarea', { class: 'inp', placeholder: 'Write everything about the job here…' });
  notes.value = cur.notes;
  bind(notes, 'notes');

  // money: total price + any number of dated payments; what is still missing is calculated live
  const moneyText = (n) => (n ? String(n) : '');
  const price = h('input', { class: 'inp', inputmode: 'decimal', placeholder: '0', value: moneyText(priceOf(cur)), 'aria-label': 'Total price in euros' });
  const payList = h('div', { class: 'rows' });
  const payTotal = h('span', { class: 'sumtxt' });
  const moneyBox = h('div', { class: 'moneybox' });
  const paintMoney = () => {
    const got = paidOf(cur);
    payTotal.textContent = fmtMoney(got);
    moneyBox.replaceChildren();
    const left = owedOf(cur);
    if (priceOf(cur) <= 0 && got <= 0) {
      moneyBox.className = 'moneybox';
      moneyBox.append('Enter the total price to track what you are owed.');
    } else if (left > 0) {
      moneyBox.className = 'moneybox owe';
      moneyBox.append(h('div', { class: 'row2' },
        h('div', null, 'Still missing', h('br'), h('b', null, fmtMoney(left))),
        h('button', { class: 'btn line small', onclick: () => addPayment(left, false) }, 'Mark fully paid')));
    } else if (left === 0) {
      moneyBox.className = 'moneybox ok';
      moneyBox.append('Paid in full');
    } else {
      moneyBox.className = 'moneybox over';
      moneyBox.append('Received ' + fmtMoney(-left) + ' more than the price');
    }
  };
  const paintPayments = () => {
    payList.replaceChildren();
    cur.payments.forEach((pm) => {
      const d = h('input', { class: 'inp', type: 'date', min: MIN_KEY, max: MAX_KEY, value: pm.date, 'aria-label': 'Date money received' });
      d.addEventListener('change', () => { pm.date = d.value || pm.date; later(); });
      const a = h('input', { class: 'inp', inputmode: 'decimal', placeholder: 'Amount (€)', value: moneyText(pm.amount), 'aria-label': 'Amount received' });
      a.addEventListener('input', () => { pm.amount = parseMoney(a.value); paintMoney(); later(); });
      payList.append(h('div', { class: 'prow' }, d, a,
        h('button', { class: 'x', 'aria-label': 'Remove payment', html: ICON.close, onclick: () => { cur.payments = cur.payments.filter((x) => x !== pm); paintPayments(); paintMoney(); later(); } })));
    });
  };
  const addPayment = (amount, focus) => {
    cur.payments.push({ id: uid(), date: todayKey(), amount: amount || 0 });
    paintPayments(); paintMoney(); later();
    if (focus) { const last = payList.lastChild && payList.lastChild.querySelector('input[inputmode]'); if (last) last.focus(); }
  };
  price.addEventListener('input', () => { cur.price = parseMoney(price.value); paintMoney(); later(); });
  paintPayments();
  paintMoney();

  // measurements: item name (small box) + measurement (bigger box), as many rows as needed
  const measList = h('div', { class: 'rows' });
  const paintMeasures = () => {
    measList.replaceChildren();
    cur.measures.forEach((m) => {
      const n = h('input', { class: 'inp', placeholder: 'Item', value: m.name || '', 'aria-label': 'Measurement item name' });
      n.addEventListener('input', () => { m.name = n.value; later(); });
      const v = h('input', { class: 'inp', placeholder: 'e.g. 2.4 x 1.8 m', value: m.value || '', 'aria-label': 'Measurement' });
      v.addEventListener('input', () => { m.value = v.value; later(); });
      measList.append(h('div', { class: 'mrow2' }, n, v,
        h('button', { class: 'x', 'aria-label': 'Remove measurement', html: ICON.close, onclick: () => { cur.measures = cur.measures.filter((x) => x !== m); paintMeasures(); later(); } })));
    });
  };
  const addMeasure = () => {
    cur.measures.push({ id: uid(), name: '', value: '' });
    paintMeasures(); later();
    const first = measList.lastChild && measList.lastChild.querySelector('input'); if (first) first.focus();
  };
  paintMeasures();

  const photoGrid = h('div', { class: 'photos' });
  const paintPhotos = () => {
    photoGrid.replaceChildren();
    if (!photos.length) { photoGrid.style.display = 'block'; photoGrid.append(h('div', { class: 'empty' }, 'No photos yet.')); return; }
    photoGrid.style.display = '';
    const order = { before: 0, after: 1, other: 2 };
    [...photos].sort((a, b) => order[a.label] - order[b.label] || a.added - b.added).forEach((p) => {
      photoGrid.append(h('button', { class: 'ph', onclick: () => viewPhoto(p) },
        h('img', { src: urlOf(p), alt: LABEL_TXT[p.label] + ' photo' }),
        h('span', { class: 'tag ' + p.label }, LABEL_TXT[p.label])));
    });
  };

  const addPhotos = (label) => (files) => {
    return (async () => {
      await saveNow();
      toast('Adding photos…');
      for (const f of files) {
        const blob = await shrink(f);
        const rec = { id: uid(), jobId: cur.id, label, blob, added: Date.now() };
        try { await DB.put('photos', rec); photos.push(rec); } catch (e) { toast('Storage is full'); break; }
      }
      paintPhotos();
      toast('Photos added');
    })();
  };

  function viewPhoto(p) {
    const img = h('img', { src: urlOf(p), alt: '' });
    const lab = h('button', { class: 'btn gold' }, 'Label: ' + LABEL_TXT[p.label]);
    const v = h('div', { class: 'viewer' },
      h('div', { class: 'vtop' },
        h('button', { class: 'icon-btn', html: ICON.close, 'aria-label': 'Close photo', onclick: () => vclose() })),
      h('div', { class: 'vimg' }, img),
      h('div', { class: 'vbot' },
        lab,
        h('button', { class: 'btn dark', onclick: async () => {
          const f = new File([p.blob], `${LABEL_TXT[p.label]}.jpg`, { type: p.blob.type || 'image/jpeg' });
          try { if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f] }); else toast('Sharing photos is not supported here'); } catch (e) { /* cancelled */ }
        } }, 'Share'),
        h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm('Delete this photo?')) return;
          await DB.del('photos', p.id);
          photos.splice(photos.indexOf(p), 1);
          if (urls.has(p.id)) { URL.revokeObjectURL(urls.get(p.id)); urls.delete(p.id); }
          paintPhotos(); vclose();
        } }, 'Delete')));
    lab.addEventListener('click', async () => {
      p.label = LABELS[(LABELS.indexOf(p.label) + 1) % LABELS.length];
      lab.textContent = 'Label: ' + LABEL_TXT[p.label];
      await DB.put('photos', p);
      paintPhotos();
    });
    const vclose = openLayer(v);
  }

  body.append(
    field('Job name (folder)', name),
    field('Date (change it to move the job)', date),
    h('div', { class: 'f' }, h('span', { class: 'lab', style: 'display:block;font-size:12px;font-weight:700;color:#8A6A0E;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px' }, 'Status'), seg),
    h('div', { class: 'sec2' }, 'Money'),
    field('Total price (€)', price),
    h('div', { class: 'sumline' }, h('b', null, 'Money received'), h('span', null, 'Total: ', payTotal)),
    payList,
    h('button', { class: 'btn line small block', onclick: () => addPayment(0, true) }, '+ Add payment'),
    h('div', { style: 'height:10px' }),
    moneyBox,
    h('div', { style: 'height:14px' }),
    field('Client', client),
    field('Phone', h('div', { class: 'inline' }, phone,
      h('button', { class: 'mini', 'aria-label': 'Call', html: ICON.phone, onclick: () => { const n = cur.phone.replace(/[^\d+]/g, ''); if (n) location.href = 'tel:' + n; else toast('Add a phone number first'); } }))),
    field('Address', h('div', { class: 'inline' }, address,
      h('button', { class: 'mini', 'aria-label': 'Open in Maps', html: ICON.map, onclick: () => { if (cur.address.trim()) window.open('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(cur.address), '_blank'); else toast('Add an address first'); } }))),
    field('Remind me at (optional)', remind),
    h('div', { class: 'sec2' }, 'Measurements'),
    measList,
    h('button', { class: 'btn line small block', onclick: () => addMeasure() }, '+ Add measurement'),
    h('div', { style: 'height:14px' }),
    field('Notes', notes),
    h('div', { class: 'sec' }, 'Photos'),
    h('div', { class: 'addrow' },
      h('button', { class: 'btn line small', onclick: () => pickFiles('#fileBefore', addPhotos('before')) }, '+ Before'),
      h('button', { class: 'btn line small', onclick: () => pickFiles('#fileAfter', addPhotos('after')) }, '+ After'),
      h('button', { class: 'btn line small', onclick: () => pickFiles('#fileOther', addPhotos('other')) }, '+ Other')),
    photoGrid,
    h('div', { style: 'height:24px' }),
    h('button', { class: 'btn danger block', onclick: async () => {
      if (!confirm(`Delete "${jobName(cur)}" and all its photos?`)) return;
      deleted = true; clearTimeout(timer);
      await DB.delJob(cur.id);
      removeJob(cur.id);
      close();
    } }, 'Delete job'));
  paintPhotos();

  // runs on every way of closing (back arrow, Android back button, delete)
  const finalize = async () => {
    if (!deleted) {
      const sig = () => cur.payments.length + '|' + cur.measures.length;
      const before = sig();
      cur.payments = cur.payments.filter((x) => Number(x.amount) > 0);                                           // drop blank payment rows
      cur.measures = cur.measures.filter((m) => (m.name || '').trim() || (m.value || '').trim());                // drop blank measurement rows
      if (timer !== null || before !== sig()) await saveNow();                                                  // flush edits typed in the last moment
      if (saved && emptyJob()) {                           // nothing left in it: drop the empty folder
        deleted = true;
        await DB.delJob(cur.id);
        removeJob(cur.id);
      }
    }
    for (const u of urls.values()) URL.revokeObjectURL(u);
    urls.clear();
    if (onChange) onChange();
    refreshAll();
  };

  const close = openLayer(node, finalize);
  // new job: put the cursor in the name box, unless you have already tapped another box
  if (!job) setTimeout(() => { const a = document.activeElement; if (!a || a === document.body || !node.contains(a)) name.focus(); }, 250);
}

/* ---------- search ---------- */
function openSearch() {
  const node = h('div', { class: 'full' });
  const input = h('input', { class: 'inp', type: 'search', placeholder: 'Search jobs, clients, addresses, notes…', autocomplete: 'off' });
  const results = h('div', { class: 'body' });
  const close = openLayer(node);
  node.append(
    h('div', { class: 'bar' },
      h('button', { class: 'icon-btn', html: ICON.back, 'aria-label': 'Back', onclick: () => close() }),
      h('h2', null, 'Search')),
    h('div', { class: 'search-in' }, input), results);
  const run = () => {
    const q = input.value.trim().toLowerCase();
    results.replaceChildren();
    if (!q) { results.append(h('div', { class: 'empty' }, 'Type to search across all jobs.')); return; }
    const t = todayKey();
    const hits = S.jobs.filter((j) => [j.name, j.client, j.phone, j.address, j.notes, ...(j.measures || []).flatMap((m) => [m.name, m.value])].some((x) => x && x.toLowerCase().includes(q)))
      .sort((a, b) => Math.abs(parseKey(a.date) - parseKey(t)) - Math.abs(parseKey(b.date) - parseKey(t)));
    if (!hits.length) { results.append(h('div', { class: 'empty' }, 'Nothing found.')); return; }
    hits.slice(0, 200).forEach((j) => results.append(h('button', { class: 'job-item', onclick: () => openJob(j, j.date, () => { run(); }) },
      h('i', { class: 'd ' + (j.status || 'planned') }),
      h('div', { class: 'meta' }, h('div', { class: 't' }, jobName(j)), h('div', { class: 's' }, [fmtDate(j.date), j.client, owedText(j)].filter(Boolean).join(' · '))),
      h('span', { class: 'go' }, '›'))));
  };
  input.addEventListener('input', run);
  run();
  setTimeout(() => input.focus(), 250);
}

/* ---------- PIN lock ---------- */
async function hashPin(pin) {
  const salt = 'siarakasbcg-v1:';
  if (window.crypto && crypto.subtle) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + pin));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  return btoa(salt + pin);
}
const getPinHash = () => { try { return localStorage.getItem('pinHash'); } catch (e) { return null; } };

function pinPrompt({ title, cancellable = false, verify = null }) {
  return new Promise((resolve) => {
    const lock = $('#lock');
    let val = '';
    $('#lockTitle').textContent = title;
    $('#lockErr').textContent = '';
    const dots = [...$('#pinDots').children];
    const paint = () => dots.forEach((d, i) => d.classList.toggle('on', i < val.length));
    const finish = (v) => { lock.hidden = true; resolve(v); };
    const press = async (d) => {
      if (val.length >= 4) return;
      val += d; paint();
      if (val.length === 4) {
        const v = val;
        if (verify && !(await verify(v))) {
          $('#lockErr').textContent = 'Wrong PIN';
          if (navigator.vibrate) navigator.vibrate(120);
          setTimeout(() => { val = ''; paint(); }, 200);
          return;
        }
        finish(v);
      }
    };
    const pk = $('#keypad');
    pk.replaceChildren();
    for (let i = 1; i <= 9; i++) pk.append(h('button', { onclick: () => press(String(i)) }, String(i)));
    pk.append(cancellable ? h('button', { class: 'ghost', style: 'font-size:15px', onclick: () => finish(null) }, 'Cancel') : h('button', { class: 'ghost', disabled: true }));
    pk.append(h('button', { onclick: () => press('0') }, '0'));
    pk.append(h('button', { class: 'ghost', 'aria-label': 'Delete', onclick: () => { val = val.slice(0, -1); paint(); $('#lockErr').textContent = ''; } }, '⌫'));
    paint();
    lock.hidden = false;
  });
}

async function unlockFlow() {
  const stored = getPinHash();
  if (!stored) return;
  await pinPrompt({ title: 'Enter PIN', verify: async (p) => (await hashPin(p)) === stored });
}

/* ---------- reminders ---------- */
function notifiedSet() { try { return new Set(JSON.parse(localStorage.getItem('notified') || '[]')); } catch (e) { return new Set(); } }
function saveNotified(s) { try { localStorage.setItem('notified', JSON.stringify([...s].slice(-300))); } catch (e) { /* ignore */ } }

async function checkReminders() {
  const t = todayKey();
  const list = (S.byDate.get(t) || []).filter((j) => j.remind && j.status !== 'done');
  if (!list.length) return;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const done = notifiedSet();
  let changed = false;
  for (const j of list) {
    const [hh, mm] = j.remind.split(':').map(Number);
    const at = hh * 60 + mm;
    const id = `${j.id}|${j.date}|${j.remind}`;
    if (nowMin >= at && nowMin - at < 12 * 60 && !done.has(id)) {
      done.add(id); changed = true;
      toast(`Reminder: ${jobName(j)} (${j.remind})`);
      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          const reg = await navigator.serviceWorker.ready;
          reg.showNotification('SiarakasBCG · ' + jobName(j), { body: [j.remind, j.client, j.address].filter(Boolean).join(' · '), icon: 'icon-192.png', badge: 'icon-192.png', tag: id });
        } catch (e) { /* ignore */ }
      }
    }
  }
  if (changed) saveNotified(done);
}

/* ---------- settings / backup ---------- */
async function exportBackup() {
  toast('Preparing backup…');
  const jobs = await DB.all('jobs');
  const ph = await DB.all('photos');
  const photos = [];
  for (const p of ph) photos.push({ id: p.id, jobId: p.jobId, label: p.label, added: p.added, data: await blobToDataURL(p.blob) });
  const json = JSON.stringify({ app: 'SiarakasBCG', version: 1, exportedAt: new Date().toISOString(), jobs, photos });
  const blob = new Blob([json], { type: 'application/json' });
  const name = `SiarakasBCG-backup-${todayKey()}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      toast('Backup ready'); return;
    }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Backup downloaded');
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'SiarakasBCG' || !Array.isArray(data.jobs)) throw new Error('bad');
    if (!confirm(`Import ${data.jobs.length} jobs and ${(data.photos || []).length} photos? Jobs with the same ID will be replaced.`)) return;
    await DB.putMany('jobs', data.jobs);
    const recs = [];
    for (const p of data.photos || []) recs.push({ id: p.id, jobId: p.jobId, label: p.label, added: p.added, blob: await dataURLToBlob(p.data) });
    await DB.putMany('photos', recs);
    S.jobs = await DB.all('jobs'); reindex(); refreshAll();
    toast('Backup imported');
  } catch (e) { toast('That file is not a valid backup'); }
}

function openSettings() {
  const node = h('div', { class: 'full' });
  const close = openLayer(node);
  const body = h('div', { class: 'body' });
  node.append(h('div', { class: 'bar' },
    h('button', { class: 'icon-btn', html: ICON.back, 'aria-label': 'Back', onclick: () => close() }),
    h('h2', null, 'Settings')), body);

  const paint = async () => {
    body.replaceChildren();
    const jc = await DB.count('jobs'), pc = await DB.count('photos');
    const hasPin = !!getPinHash();
    const notifState = 'Notification' in window ? Notification.permission : 'unsupported';
    let persisted = false;
    try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch (e) { /* ignore */ }

    body.append(
      h('div', { class: 'set-row' }, h('div', null, h('b', null, 'Your data'), h('small', null, `${jc} jobs · ${pc} photos, stored on this phone only`))),
      h('div', { class: 'set-row' }, h('div', null, h('b', null, 'Backup'), h('small', null, 'Save everything to a file you can keep in Google Drive, WhatsApp or email.')),
        h('button', { class: 'btn gold small', onclick: exportBackup }, 'Export')),
      h('div', { class: 'set-row' }, h('div', null, h('b', null, 'Restore from backup'), h('small', null, 'Use this on a new phone.')),
        h('button', { class: 'btn line small', onclick: () => { noLockUntil = Date.now() + 120000; const f = $('#fileBackup'); f.onchange = () => { const file = f.files[0]; f.value = ''; if (file) importBackup(file).then(paint); }; f.click(); } }, 'Import')),
      h('div', { class: 'set-row' }, h('div', null, h('b', null, 'PIN lock'), h('small', null, hasPin ? 'On. Asked when you open the app.' : 'Off.')),
        hasPin
          ? h('div', { class: 'row', style: 'flex:none' },
            h('button', { class: 'btn line small', onclick: async () => { await changePin(); paint(); } }, 'Change'),
            h('button', { class: 'btn danger small', onclick: async () => { await removePin(); paint(); } }, 'Remove'))
          : h('button', { class: 'btn gold small', onclick: async () => { await changePin(); paint(); } }, 'Set PIN')),
      h('div', { class: 'set-row' }, h('div', null, h('b', null, 'Notifications'), h('small', null, notifState === 'granted' ? 'Allowed.' : notifState === 'denied' ? 'Blocked in phone settings.' : notifState === 'unsupported' ? 'Not supported on this device.' : 'Needed for job reminders.')),
        notifState === 'default' ? h('button', { class: 'btn gold small', onclick: async () => { await Notification.requestPermission(); paint(); } }, 'Allow') : null),
      h('div', { class: 'set-row' }, h('div', null, h('b', null, 'Protect data from cleanup'), h('small', null, persisted ? 'On. The phone will not auto-delete app data.' : 'Ask the phone to keep this data safe.')),
        persisted ? null : h('button', { class: 'btn line small', onclick: async () => { try { const ok = await navigator.storage.persist(); toast(ok ? 'Protected' : 'The phone declined'); } catch (e) { toast('Not supported'); } paint(); } }, 'Enable')),
      h('div', { class: 'note' },
        h('b', null, 'Good to know. '),
        'Reminders show up when the app is open or you open it, because a home-screen web app cannot reliably wake the phone by itself. ',
        'The PIN keeps people out of the app, but it does not encrypt the data. If you forget the PIN, the only way back in is clearing the app data, which erases everything, so export a backup first. ',
        'Clearing browser data or uninstalling the app also erases jobs and photos, which is why Export exists.'));
  };
  paint();
}

async function changePin() {
  const stored = getPinHash();
  if (stored) {
    const ok = await pinPrompt({ title: 'Current PIN', cancellable: true, verify: async (p) => (await hashPin(p)) === stored });
    if (ok == null) return;
  }
  const a = await pinPrompt({ title: 'New PIN (4 digits)', cancellable: true });
  if (a == null) return;
  const b = await pinPrompt({ title: 'Repeat the PIN', cancellable: true });
  if (b == null) return;
  if (a !== b) { toast('PINs did not match'); return; }
  try { localStorage.setItem('pinHash', await hashPin(a)); toast('PIN saved'); } catch (e) { toast('Could not save the PIN'); }
}
async function removePin() {
  const stored = getPinHash();
  const ok = await pinPrompt({ title: 'Enter PIN to remove it', cancellable: true, verify: async (p) => (await hashPin(p)) === stored });
  if (ok == null) return;
  try { localStorage.removeItem('pinHash'); toast('PIN removed'); } catch (e) { /* ignore */ }
}

/* ---------- boot ---------- */
async function boot() {
  $('#weekdays').append(...WEEK.map((d) => h('div', null, d)));
  $('#prev').onclick = () => go(-1);
  $('#next').onclick = () => go(1);
  $('#btnToday').onclick = goToday;
  $('#btnTitle').onclick = openPicker;
  $('#btnSearch').onclick = openSearch;
  $('#btnSearchHome').onclick = openSearch;
  $('#btnSearchJobs').onclick = openSearch;
  $('#btnSettings').onclick = openSettings;
  $('#tileCal').onclick = () => openSection('cal');
  $('#tileJobs').onclick = () => openSection('jobs');
  $('#tileMoney').onclick = () => openSection('money');
  $('#backCal').onclick = goHome;
  $('#backJobs').onclick = goHome;
  $('#backMoney').onclick = goHome;
  $('#btnNewJob').onclick = () => openJob(null, todayKey(), null);

  // swipe left / right to change month
  let sx = 0, sy = 0;
  const grid = $('#grid');
  grid.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  grid.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  }, { passive: true });

  goToday();
  try {
    await DB.open();
    S.jobs = await DB.all('jobs');
    reindex();
  } catch (e) {
    toast('Storage is not available in this browser');
  }
  refreshAll();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // when a newer version of the app takes over, reload once so you are not stuck on the old screens
    let hadController = !!navigator.serviceWorker.controller, reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; }
      if (reloaded) return;
      reloaded = true;
      if (!stack.length && $('#lock').hidden) location.reload();
      else toast('App updated. Close it and open it again.');
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  await unlockFlow();
  checkReminders();

  // re-lock after the app has been in the background for a while; refresh "today" at midnight
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (S.lastToday !== todayKey()) refreshAll();
    if (getPinHash() && $('#lock').hidden && hiddenAt && Date.now() - hiddenAt > 30000 && Date.now() > noLockUntil) await unlockFlow();
    checkReminders();
  });
  setInterval(() => { if (S.lastToday !== todayKey()) refreshAll(); checkReminders(); }, 30000);
}

boot();
