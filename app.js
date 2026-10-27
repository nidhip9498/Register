// Ward Register front end. Plain JavaScript, no libraries, works offline.
'use strict';

const ROLE_NAMES = { admin: 'Admin (SR)', sr: 'SR', jr: 'JR', consultant: 'Consultant', viewer: 'View only (Rounds)' };
const OUTCOMES = ['Discharged', 'LAMA', 'Referred', 'Transferred to other unit', 'Expired'];
const S = { user: null, meta: null, date: null, filters: { ward: '', emptyOnly: false, q: '' }, dirty: new Set() };

// ---------- Small helpers ----------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// All data is on this device (store.js); this keeps the old server-style calls working.
async function api(method, url, body) {
  try {
    return JSON.parse(JSON.stringify((await Store.handle(method, url, body)) ?? {}));
  } catch (e) {
    if (e.status === 401 && !url.endsWith('/login')) { S.user = null; render(); }
    throw e;
  }
}

function toast(msg, bad) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ''), 2600);
}

function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}
function fmtDay(d) {
  return new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function addDays(d, n) {
  const x = new Date(d + 'T12:00:00');
  x.setDate(x.getDate() + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
// Day of admission (1 on the day of admission); blank when no admission date was entered.
const dayNo = (a, date) => (a.admit_date ? String(daysBetween(a.admit_date, date) + 1) : '');
function daysBetween(a, b) { return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5); }

const canEdit = () => S.user && ['admin', 'sr', 'jr'].includes(S.user.role);
// A discharge can be undone for 24 hours after it was made (the server checks the same).
const canUndoDischarge = (a) => !!a.discharge_date && (typeof a.discharged_at === 'number' ? Date.now() - a.discharged_at <= 24 * 3600e3 : a.discharge_date >= addDays(S.meta.today, -1));
// Editors enter rounds; a 'viewer' only reads them.
const canSeeRounds = () => canEdit() || (S.user && S.user.role === 'viewer');
const isViewer = () => S.user && S.user.role === 'viewer';
const paramMap = () => Object.fromEntries(S.meta.params.map((p) => [p.key, p]));
const isIcu = (bed) => !!bed && (S.meta.icuBeds || []).includes(bed);

// ICU babies: age in days from the date of birth, so it moves on by itself every day.
function ageText(a, date) {
  if (a.dob) { const d = daysBetween(a.dob, date); return d >= 0 ? `${d} day${d === 1 ? '' : 's'}` : ''; }
  return a.age || '';
}
const ageSex = (a, date) => [ageText(a, date), a.sex].filter(Boolean).join(' / ');
const fieldLabel = (k) => { const p = paramMap()[k]; return p ? p.label : k.replace(/^x:/, ''); };

// The round fields shown for a patient: the Ward SR's choice, or else the standard ward / ICU list.
function monitorFor(a) {
  const group = isIcu(a.bed_on_date || a.bed) ? 'icu' : 'ward';
  const groupParams = S.meta.params.filter((p) => p.group === group);
  if (a.fields_set || (a.monitor || []).some((k) => groupParams.some((p) => p.key === k))) return a.monitor || [];
  return groupParams.filter((p) => p.active).map((p) => p.key);
}

function stayBadges(a, date) {
  const out = dayNo(a, date) ? [h('span', { class: 'badge' }, `Day ${dayNo(a, date)}`)] : [];
  const pod = podText(a, date);
  if (pod) out.push(h('span', { class: 'badge pod' }, pod));
  const planned = [a.surgery_date, a.surgery_date2, a.surgery_date3].filter((d) => d && d > date);
  if (planned.length) out.push(h('span', { class: 'badge plan' }, `Surgery ${fmtDate(planned[0])}`));
  if (a.admit_date === date) out.push(h('span', { class: 'badge new' }, 'Admitted today'));
  if (a.discharge_date === date) out.push(h('span', { class: 'badge out' }, a.outcome || 'Discharged'));
  return out;
}

// "POD 5/2" when there has been more than one surgery, like the old sheet.
function podText(a, date) {
  // POD goes up at midnight: Rounds after 11:30 show the next day's page, but POD stays today's.
  const now = localStamp(new Date()).slice(0, 10);
  if (date > now) date = now;
  const pods = [a.surgery_date, a.surgery_date2, a.surgery_date3].filter((d) => d && d <= date).map((d) => daysBetween(d, date));
  if (!pods.length) return '';
  return 'POD ' + pods.join('/');
}

// A patient's own extra fields, as { key, label, type, unit }. Older records stored just the name.
function extrasOf(a) {
  return (a.extra_fields || []).map((x) => (typeof x === 'string' ? { label: x, type: 'text', unit: '' } : x))
    .map((e) => ({ ...e, key: 'x:' + e.label }));
}
const unitOf = (k, a) => {
  const p = paramMap()[k];
  if (p) return p.type === 'number' ? p.unit : '';
  const e = a && extrasOf(a).find((x) => x.key === k);
  return e ? e.unit : '';
};

// "Fever: No · Urine output: 480 ml · Right stent output: 30 ml"
function summariseVals(vals, monitorKeys, a) {
  const keys = [...new Set([...(monitorKeys || []), ...(a ? extrasOf(a).map((e) => e.key) : []), ...Object.keys(vals || {})])];
  return keys.filter((k) => vals && vals[k]).map((k) => {
    const unit = unitOf(k, a);
    return `${fieldLabel(k)}: ${vals[k]}${unit ? ' ' + unit : ''}`;
  }).join(' · ');
}

// ---------- Boot and routing ----------

async function boot() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // When a new version of the app has been saved on this device, switch to it straight away.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !boot.reloading && !S.dirty.size) { boot.reloading = true; location.reload(); }
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
  }
  await Store.load();
  if (!(await Sync.restore())) return render();
  await Store.restoreSession();
  if (!boot.started) {
    boot.started = true;
    Sync.onStatus(drawSyncChip);
    Store.onChange((src) => { if (src === 'remote') remoteUpdate(); });
    Sync.start();
  }
  await refreshState();
}

// ---------- Lock after 15 minutes without use ----------
// The screen is covered (nothing typed is lost) until the person enters their password again.
const LOCK_MINUTES = 15;
const idle = { last: Date.now(), touched: 0, locked: false };
function noteActivity() {
  if (idle.locked) return;
  idle.last = Date.now();
  if (S.user && idle.last - idle.touched > 60e3) { idle.touched = idle.last; api('POST', '/api/touch').catch(() => {}); }
}
function checkIdle() {
  if (!idle.locked && S.user && Date.now() - idle.last > LOCK_MINUTES * 60e3) lockScreen();
}
function lockScreen() {
  idle.locked = true;
  document.body.classList.add('locked');
  const err = h('p', { class: 'error' });
  const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const cover = h('div', { class: 'lockscreen' }, h('form', { class: 'card auth', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/login', { username: S.user.username, password: pass.value });
      idle.locked = false; idle.last = idle.touched = Date.now(); cover.remove(); document.body.classList.remove('locked');
    } catch (x) { err.textContent = x.status === 401 ? 'Wrong password' : x.message; pass.select(); }
  } },
  h('img', { src: 'icon.svg', alt: '', class: 'logo' }),
  h('h1', {}, 'Locked'),
  h('p', { class: 'muted subtitle' }, `The app locked after ${LOCK_MINUTES} minutes without use. Anything you were typing is kept.`),
  h('label', {}, `Password for ${S.user.name}`, pass),
  err,
  h('button', { class: 'primary', type: 'submit' }, 'Unlock'),
  h('button', { type: 'button', class: 'ghost', onclick: async () => {
    if (S.dirty.size && !confirm('Unsaved round entries will be lost. Sign out anyway?')) return;
    await api('POST', '/api/logout').catch(() => {}); S.user = null; S.dirty.clear(); idle.locked = false; cover.remove(); document.body.classList.remove('locked'); render();
  } }, 'Sign in as someone else')));
  document.body.append(cover);
  pass.focus();
}
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => document.addEventListener(ev, noteActivity, { passive: true, capture: true }));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkIdle(); });
setInterval(checkIdle, 30e3);

async function refreshState() {
  await Store.upgrade();
  const st = await api('GET', '/api/state');
  S.user = st.user;
  S.setupNeeded = st.setupNeeded;
  S.date = S.date || st.today;
  if (S.user) S.meta = await api('GET', '/api/meta');
  render();
}

window.addEventListener('hashchange', () => render());
// When the app stays open past midnight (or past 11:30 am on Rounds), move to the new day by itself.
let lastRoundsDay = null;
function checkNewDay() {
  if (!S.meta || !S.user) return;
  const d = localStamp(new Date()).slice(0, 10);
  const route = (location.hash.slice(1) || 'register').split('/')[0];
  let redraw = false;
  if (d !== S.meta.today) { if (S.date === S.meta.today) S.date = d; S.meta.today = d; redraw = true; }
  const rd = roundsDay() + '|' + rosterDay(d);
  if (rd !== lastRoundsDay && (route === 'rounds' || route === 'icurounds' || route === 'register')) redraw = true;
  lastRoundsDay = rd;
  if (redraw && !S.dirty.size && !document.querySelector('#modal-root > *')) render();
}
setInterval(checkNewDay, 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkNewDay(); });
window.addEventListener('beforeunload', (e) => { if (S.dirty.size) { e.preventDefault(); e.returnValue = ''; } });

// Another device's changes arrived. Redraw unless someone is typing or has unsaved entries.
let updatesWaiting = false;
async function remoteUpdate() {
  const busy = S.dirty.size || document.getElementById('modal-root').childNodes.length ||
    (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && document.activeElement.type !== 'checkbox');
  if (!Sync.configured()) return;
  // On the sign-in screen, keep what's being typed; only a ward still waiting for its first account needs a redraw.
  if (!S.user) { if (S.setupNeeded) await refreshState(); return; }
  if (busy) { updatesWaiting = true; drawSyncChip(Sync.status()); return; }
  updatesWaiting = false;
  S.meta = await api('GET', '/api/meta');
  render();
}

function drawSyncChip(st) {
  const chip = document.getElementById('sync-chip');
  if (!chip) return;
  let text, cls;
  if (updatesWaiting) { text = 'New entries · tap to show'; cls = 'new'; }
  else if (st.state === 'syncing') { text = 'Syncing…'; cls = ''; }
  else if (st.state === 'offline') { text = st.waiting ? `Offline · ${st.waiting} change${st.waiting === 1 ? '' : 's'} waiting` : 'Offline'; cls = 'warn'; }
  else if (st.state === 'error') { text = st.waiting ? `Not synced · ${st.waiting} waiting` : 'Not synced'; cls = 'warn'; }
  else if (st.waiting) { text = `${st.waiting} waiting to sync`; cls = ''; }
  else { text = st.lastOk ? 'Synced ' + new Date(st.lastOk).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Not synced yet'; cls = 'ok'; }
  chip.textContent = text;
  chip.className = 'sync-chip ' + cls;
  chip.title = st.error || 'Tap to sync now';
}

// The ward's chosen look. Remembered on this device so the sign-in screen matches too.
function applyTheme() {
  let t = S.meta && S.meta.theme;
  try { if (t) localStorage.setItem('ward-theme', t); else t = localStorage.getItem('ward-theme'); } catch (e) { /* storage blocked */ }
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// A redraw of the same page (e.g. after a sync brings in someone else's entry) keeps the place on screen instead of jumping to the top.
let lastHash = null;
function render() {
  applyTheme();
  lastRoundsDay = roundsDay() + '|' + rosterDay(localStamp(new Date()).slice(0, 10));
  const app = document.getElementById('app');
  const keep = location.hash === lastHash ? window.scrollY : 0, height = document.documentElement.scrollHeight;
  lastHash = location.hash;
  app.replaceChildren();
  if (!Sync.configured()) return app.append(connectView());
  if (S.setupNeeded) return app.append(setupView());
  if (!S.user) return app.append(loginView());
  const [route, arg] = location.hash.replace(/^#\/?/, '').split('/');
  app.append(topBar(route || 'register'));
  drawSyncChip(Sync.status());
  const main = h('main', {});
  app.append(main);
  if (keep) { main.style.minHeight = height + 'px'; window.scrollTo(0, keep); }
  Promise.resolve(view(route, arg, main)).catch(() => {}).then(() => { if (keep) { window.scrollTo(0, keep); main.style.minHeight = ''; } });
}
function view(route, arg, main) {
  if (route === 'patients') return statusView(main);
  if (route === 'patient') return patientView(main, arg);
  if (route === 'print') return printView(main, arg || S.date, location.hash.split('/')[2] || '');
  if (route === 'census') return censusView(main);
  if (route === 'monthly') return monthlyView(main, arg);
  if (route === 'ot') return arg ? otDatesView(main, arg) : otHomeView(main);
  if (route === 'otlist') return otListView(main, decodeURIComponent(arg || ''));
  if (route === 'otlog') return otLogView(main, decodeURIComponent(arg || ''));
  if (route === 'rounds' && canSeeRounds()) return roundsView(main, decodeURIComponent(arg || ''), false);
  if (route === 'icurounds' && canSeeRounds()) return roundsView(main, decodeURIComponent(arg || ''), true);
  if (route === 'notes') return notesView(main, decodeURIComponent(arg || ''));
  if (route === 'admin' && S.user.role === 'admin') return adminView(main, arg || 'users');
  if (route === 'icu') return registerView(main, 'icu');
  return registerView(main, 'ward');
}

function topBar(route) {
  const link = (r, label) => h('a', { href: '#' + r, class: route === r || (r === 'ot' && (route === 'otlist' || route === 'otlog')) ? 'active' : '' }, label);
  return h('header', { class: 'top' },
    h('div', { class: 'brand' }, h('img', { src: 'icon.svg', alt: '' }), h('div', {}, h('b', {}, 'Register'), h('small', {}, 'Department of Pediatric Surgery'))),
    h('nav', {}, link('register', 'Ward Register'), link('icu', 'ICU Register'), canSeeRounds() && link('rounds', 'Rounds'), canSeeRounds() && link('icurounds', 'ICU Rounds'), link('census', 'Bed Occupancy'), link('ot', 'OT Lists'), link('patients', 'Status'), link('monthly', 'Census'), S.user.role === 'admin' && link('admin', 'Admin')),
    h('div', { class: 'me' },
      h('button', { id: 'sync-chip', class: 'sync-chip', onclick: async () => {
        if (updatesWaiting) { if (!confirmLeave()) return; updatesWaiting = false; S.dirty.clear(); S.meta = await api('GET', '/api/meta'); render(); }
        else Sync.syncNow();
      } }),
      h('button', { class: 'link', onclick: changePasswordModal, title: 'Change password' }, `${S.user.name} · ${ROLE_NAMES[S.user.role] || S.user.role}`),
      h('button', { class: 'ghost small', onclick: async () => { await api('POST', '/api/logout'); S.user = null; render(); } }, 'Sign out')));
}

// ---------- Connecting this device to the ward ----------

function connectView() {
  const err = h('p', { class: 'error' });
  let mode = 'join';
  const modeBtns = h('div', { class: 'seg' });
  const drawMode = () => modeBtns.replaceChildren(
    h('button', { type: 'button', class: mode === 'join' ? 'on' : '', onclick: () => { mode = 'join'; drawMode(); } }, 'Join the ward'),
    h('button', { type: 'button', class: mode === 'create' ? 'on' : '', onclick: () => { mode = 'create'; drawMode(); } }, 'Set up a new ward'));
  drawMode();
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Connect');
  const form = h('form', { class: 'card auth', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (mode === 'create' && form.passcode.value !== form.passcode2.value) return (err.textContent = 'The two passcodes do not match');
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      await Sync.connect(form.url.value, form.passcode.value, { create: mode === 'create' });
      if (mode === 'join') { btn.textContent = 'Downloading the ward register…'; await Sync.syncNow(); }
      await boot();
    } catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = 'Connect'; }
  } },
  h('img', { src: 'icon.svg', alt: '', class: 'logo' }),
  h('h1', {}, 'Register'), h('p', { class: 'muted subtitle' }, 'Department of Pediatric Surgery'),
  h('p', { class: 'muted' }, 'Connect this phone or laptop to your ward once. After that it works without internet and shares entries whenever there is a connection.'),
  modeBtns,
  h('label', {}, 'Ward sync address (Web app URL)', h('input', { name: 'url', required: true, placeholder: 'https://script.google.com/macros/s/…/exec', autocapitalize: 'none', autocomplete: 'off' })),
  h('label', {}, 'Ward passcode', h('input', { name: 'passcode', type: 'password', required: true, minlength: 8, autocomplete: 'off' })),
  h('label', { class: 'create-only' }, 'Repeat ward passcode', h('input', { name: 'passcode2', type: 'password', minlength: 8, autocomplete: 'off' })),
  h('p', { class: 'muted small create-only' }, 'Everything is encrypted with this passcode before it leaves the device. If it is lost, the shared data cannot be recovered, so keep it somewhere safe and share it only with the ward SRs.'),
  err, btn);
  const toggleCreate = () => form.querySelectorAll('.create-only').forEach((el) => (el.hidden = mode !== 'create'));
  modeBtns.addEventListener('click', toggleCreate);
  setTimeout(toggleCreate);
  return h('div', { class: 'center' }, form);
}

// ---------- Sign in / first-time setup ----------

function loginView() {
  const err = h('p', { class: 'error' });
  const help = h('div', {});
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'card auth', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = ''; help.replaceChildren();
    const creds = { username: form.username.value, password: form.password.value };
    try {
      try { S.user = await api('POST', '/api/login', creds); }
      catch (x) {
        // A new account may have been made on another device: fetch the latest from the ward and try once more.
        if (x.status !== 401) throw x;
        btn.disabled = true; btn.textContent = 'Checking for new accounts…';
        await Sync.syncNow();
        btn.disabled = false; btn.textContent = 'Sign in';
        try { S.user = await api('POST', '/api/login', creds); }
        catch (y) {
          const st = Sync.status();
          if (st.state === 'error' || st.state === 'offline') help.replaceChildren(syncTrouble(st));
          throw y;
        }
      }
      S.meta = await api('GET', '/api/meta');
      render();
    } catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = 'Sign in'; }
  } },
  h('img', { src: 'icon.svg', alt: '', class: 'logo' }),
  h('h1', {}, 'Register'), h('p', { class: 'muted subtitle' }, 'Department of Pediatric Surgery'),
  h('label', {}, 'Username', h('input', { name: 'username', autocomplete: 'username', autocapitalize: 'none', required: true })),
  h('label', {}, 'Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
  err, help, btn);
  return h('div', { class: 'center' }, form);
}

// Shown on the sign-in screen when this device can't fetch the ward's latest entries.
function syncTrouble(st) {
  const waiting = st.waiting;
  return h('div', { class: 'trouble' },
    st.state === 'offline'
      ? h('p', {}, 'This device is offline, so it can\'t check for accounts made on other devices. Connect to the internet and try again.')
      : [h('p', {}, `This device can't reach the ward: ${st.error}.`),
        /passcode/i.test(st.error || '') && h('p', {}, 'The ward passcode has changed since this device joined. Connect it again with the new passcode.'),
        h('button', { type: 'button', class: 'ghost small', onclick: async () => {
          if (waiting && !confirm(`${waiting} changes on this device have not been sent and will be lost. Continue?`)) return;
          await Store.wipe(); location.reload();
        } }, 'Connect this device to the ward again')]);
}

function setupView() {
  const err = h('p', { class: 'error' });
  const form = h('form', { class: 'card auth', onsubmit: async (e) => {
    e.preventDefault();
    if (form.password.value !== form.password2.value) return (err.textContent = 'The two passwords do not match');
    try {
      S.user = await api('POST', '/api/setup', { name: form.fullname.value, username: form.username.value, password: form.password.value });
      S.setupNeeded = false;
      S.meta = await api('GET', '/api/meta');
      render();
    } catch (x) { err.textContent = x.message; }
  } },
  h('h1', {}, 'Welcome'),
  h('p', { class: 'muted' }, 'Create the admin account. The admin adds the other SRs and sets up beds and monitoring fields.'),
  h('label', {}, 'Your name', h('input', { name: 'fullname', required: true })),
  h('label', {}, 'Username', h('input', { name: 'username', autocapitalize: 'none', required: true })),
  h('label', {}, 'Password', h('input', { name: 'password', type: 'password', minlength: 6, required: true })),
  h('label', {}, 'Repeat password', h('input', { name: 'password2', type: 'password', minlength: 6, required: true })),
  err,
  h('button', { class: 'primary', type: 'submit' }, 'Create admin account'));
  return h('div', { class: 'center' }, form);
}

// ---------- Daily register ----------

// The ward as a grid of bed boxes: red border when occupied, green when empty.
const wardOf = (bed) => bed.split('/')[0];
function wardTitle(w) {
  const sec = S.meta.sections.find((s) => /ICU/i.test(s.name) && s.beds.some((b) => wardOf(b) === w));
  return sec ? sec.name : `${w} Ward`;
}

// mode 'ward' = Ward Register (6B and 6A), mode 'icu' = ICU Register (6C).
// The same UHID admitted twice: pick the entry to keep; the other's rounds, notes and OT findings move into it.
function dupBanner() {
  const box = h('div', { class: 'dupbar', hidden: true });
  api('GET', '/api/duplicates').then((groups) => {
    if (!groups.length) return;
    box.hidden = false;
    box.replaceChildren(...groups.map((g) => h('div', { class: 'duprow' },
      h('p', {}, h('b', {}, `UHID ${g[0].uhid} is entered ${g.length} times`), ` (${[...new Set(g.map((a) => a.bed))].join(', ')}). Tap the one to keep. The other's rounds, notes and OT findings are moved into it.`),
      h('div', { class: 'dupbtns' }, g.map((a) => h('button', { type: 'button', class: 'ghost', onclick: async () => {
        const others = g.filter((x) => x.id !== a.id);
        if (!confirm(`Keep "${a.name}" in ${a.bed} and remove ${others.map((x) => `"${x.name}"`).join(', ')}? Their rounds and notes move into the kept entry.`)) return;
        try { for (const o of others) await api('POST', `/api/admissions/${encodeURIComponent(a.id)}/merge`, { other: o.id }); toast('Duplicate removed'); render(); } catch (x) { toast(x.message, true); }
      } }, h('b', {}, a.name), h('span', { class: 'small muted' }, ` · ${a.bed} · ${a.rounds ? `${a.rounds} round${a.rounds === 1 ? '' : 's'}, last ${fmtDate(a.last_round)}` : 'no rounds'}`)))))));
  }).catch(() => {});
  return box;
}
async function registerView(main, mode) {
  const icuMode = mode === 'icu';
  const date = S.date;
  const mine = (bed) => isIcu(bed) === icuMode;
  const sections = S.meta.sections.map((s) => ({ ...s, beds: s.beds.filter(mine) })).filter((s) => s.beds.length);
  const go = (d) => { if (confirmLeave()) { S.date = d; render(); } };
  const dateInput = h('input', { type: 'date', value: date, onchange: (e) => e.target.value && go(e.target.value) });
  const wards = [...new Set(sections.flatMap((s) => s.beds).map(wardOf))];
  const wardFilter = () => (wards.length > 1 && wards.includes(S.filters.ward) ? S.filters.ward : '');
  const wardSel = wards.length > 1 && h('select', { onchange: (e) => { S.filters.ward = e.target.value; drawGrid(); } },
    h('option', { value: '' }, 'All wards'), wards.map((w) => h('option', { value: w }, wardTitle(w))));
  if (wardSel) wardSel.value = wardFilter();
  const alerts = h('div', {});
  const emptyToggle = h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: S.filters.emptyOnly, onchange: (e) => { S.filters.emptyOnly = e.target.checked; drawGrid(); } }), 'Show empty beds');
  const search = h('input', { type: 'search', placeholder: 'Find bed, name, UHID…', value: S.filters.q, oninput: (e) => { S.filters.q = e.target.value; drawGrid(); } });

  main.append(
    h('div', { class: 'toolbar' },
      h('div', { class: 'datenav' },
        h('button', { class: 'ghost', onclick: () => go(addDays(date, -1)), 'aria-label': 'Previous day' }, '‹'),
        dateInput,
        h('button', { class: 'ghost', onclick: () => go(addDays(date, 1)), 'aria-label': 'Next day' }, '›'),
        date !== S.meta.today && h('button', { class: 'ghost small', onclick: () => go(S.meta.today) }, 'Today')),
      h('div', { class: 'filters' }, wardSel, search, emptyToggle),
      h('div', { class: 'actions' },
        canEdit() && h('button', { class: 'primary', onclick: () => admitModal(null, null, { icu: icuMode }) }, icuMode ? '+ Admit to ICU' : '+ Admit'),
        !icuMode && h('button', { class: 'ghost', onclick: () => shiftsModal() }, 'Bed shifts'),
        wards.map((w) => h('a', { class: 'button ghost', href: `#print/${date}/${w}` }, 'Print ' + w)))),
    icuMode ? '' : rosterStrip(date),
    canEdit() && dupBanner(),
    alerts,
    h('h2', { class: 'daytitle' }, icuMode ? 'ICU Register · ' : 'Ward Register · ', fmtDay(date)));

  const summary = h('div', { class: 'summary' });
  const grid = h('div', { class: 'register' }, h('p', { class: 'loading' }, 'Loading…'));
  main.append(summary, grid);

  let data;
  try { data = await api('GET', '/api/register?date=' + date); } catch (e) { grid.replaceChildren(h('p', { class: 'error' }, e.message)); return; }
  S.dirty.clear();

  const inBed = (bed) => data.admissions.filter((a) => a.bed_on_date === bed && a.discharge_date !== date);
  drawOtAlerts(alerts, data.admissions, (a) => bedPanel(a.bed_on_date), date, !icuMode);

  function drawGrid() {
    const allBeds = sections.flatMap((s) => s.beds);
    const here = data.admissions.filter((a) => mine(a.bed_on_date));
    summary.replaceChildren(
      stat('Patients', here.filter((a) => a.discharge_date !== date).length),
      (() => { const empty = allBeds.filter((b) => !inBed(b).length); const el = stat('Empty beds', empty.length); el.classList.add('clickable'); el.title = 'Show the empty beds'; el.onclick = () => emptyBedsPanel(empty, date); return el; })(),
      clickStat('Admitted today', here.filter((a) => a.admit_date === date), date, false),
      clickStat('Discharged today', here.filter((a) => a.discharge_date === date), date, true),
      (() => {
        const rows = invFrom(here.filter((a) => a.discharge_date !== date), date);
        const el = stat('Upcoming investigations', rows.length); el.classList.add('clickable'); el.title = 'Show all booked investigations';
        el.onclick = () => upcomingPanel(rows, date); return el;
      })());

    const q = S.filters.q.trim().toLowerCase();
    const show = (bed) => {
      const pts = inBed(bed);
      if (S.filters.emptyOnly && pts.length) return false;
      return !q || bed.toLowerCase().includes(q) || pts.some((a) => [a.name, a.ip_no, a.diagnosis].join(' ').toLowerCase().includes(q));
    };

    grid.replaceChildren();
    for (const w of wards) {
      if (wardFilter() && wardFilter() !== w) continue;
      const parts = sections
        .map((sec) => ({ name: sec.name, beds: sec.beds.filter((b) => wardOf(b) === w && show(b)) }))
        .filter((sec) => sec.beds.length);
      if (!parts.length) continue;
      grid.append(h('section', { class: 'ward' }, h('h3', {}, wardTitle(w)),
        parts.map((sec) => [
          parts.length > 1 && sec.name !== wardTitle(w) && h('div', { class: 'subhead' }, sec.name),
          h('div', { class: 'bedgrid' }, sec.beds.map((b) => bedBox(b, inBed(b)))),
        ])));
    }
    if (!grid.childNodes.length) grid.append(h('p', { class: 'muted empty-note' }, 'No beds match.'));
  }

  function bedBox(bed, pts) {
    const a = pts[0];
    if (!a) {
      return h('button', { class: 'bedbox free', onclick: () => canEdit() ? admitModal(bed) : toast(`${bed} is empty`) },
        h('span', { class: 'bedno' }, bed), h('span', { class: 'freelabel' }, 'Empty'));
    }
    const pod = podText(a, date);
    return h('button', { class: 'bedbox taken', onclick: () => bedPanel(bed) },
      h('span', { class: 'bedno' }, bed),
      h('span', { class: 'bname' }, a.name),
      h('span', { class: 'bmeta' }, [ageSex(a, date).replace(' / ', '/'), a.unit].filter(Boolean).join(' · ')),
      h('span', { class: 'bmeta' }, [pod, dayNo(a, date) && `Day ${dayNo(a, date)}`].filter(Boolean).join(' · ')),
      pts.length > 1 && h('span', { class: 'badge' }, `+${pts.length - 1} more`));
  }

  // Clicking an occupied bed opens that patient's details (read only).
  function bedPanel(bed) {
    const root = document.getElementById('modal-root');
    const close = () => { if (confirmLeave()) { S.dirty.clear(); root.replaceChildren(); } };
    root.replaceChildren(h('div', { class: 'backdrop', onclick: (e) => e.target === e.currentTarget && close() },
      h('div', { class: 'modal card panel' },
        h('div', { class: 'mhead' }, h('h2', {}, `Bed ${bed}`), h('button', { type: 'button', class: 'ghost small', onclick: close }, 'Close')),
        inBed(bed).map((a) => patientDetails(a, date)))));
  }

  drawGrid();
}

function stat(label, n, cls) { return h('div', { class: 'stat ' + (cls && n ? cls : '') }, h('b', {}, n), h('span', {}, label)); }

// Planned bed shifts: write the list the evening before, then Execute after the morning round.
async function shiftsModal() {
  const root = document.getElementById('modal-root');
  const close = () => root.replaceChildren();
  const [plan, reg] = await Promise.all([api('GET', '/api/shifts'), api('GET', '/api/register?date=' + S.meta.today)]);
  const order = S.meta.sections.flatMap((s) => s.beds);
  const inBed = (b) => reg.admissions.filter((a) => a.bed_on_date === b && !a.discharge_date);
  const who = (b) => inBed(b).map((a) => a.name).join(', ');
  const edit = canEdit();
  let rows = plan.rows.length ? plan.rows.map((r) => ({ ...r })) : [{ from: '', to: '' }];
  let saved = true;
  const tbody = h('tbody', {});
  const sheet = h('div', { class: 'printonly' });
  const msg = h('div', { class: 'error shiftmsg' });
  const status = h('p', { class: 'muted' });

  const locked = () => !!plan.executed_at && saved; // a carried-out list is read-only until "Start a new list"
  const bedSelect = (val, onchange, occupiedOnly) => h('select', { disabled: !edit || locked(), onchange },
    h('option', { value: '' }, '—'),
    order.filter((b) => !occupiedOnly || inBed(b).length || b === val).map((b) => h('option', { value: b, selected: b === val }, b)));
  // What happens to whoever is already in the To bed.
  const toNote = (r, movingFrom) => {
    if (!r.to || !inBed(r.to).length) return r.to ? { text: 'Empty' } : { text: '' };
    if (r.swap) return { text: `Swap: ${who(r.to)} goes to ${r.from || 'the From bed'}` };
    if (movingFrom.has(r.to)) return { text: `Now: ${who(r.to)} (also moving)` };
    return { text: `Waits until ${who(r.to)} is discharged`, warn: true };
  };
  const doneNote = (r) => r.status === 'waiting' ? { text: `Waiting: moves when ${r.wait_for} is discharged`, warn: true }
    : r.status === 'cancelled' ? { text: `Not done: ${r.note || 'cancelled'}`, warn: true }
    : { text: r.swap && r.name2 ? `Swapped: ${r.name2}` : r.done_at ? `Moved after discharge · ${r.done_at}` : '' };
  const draw = () => {
    const done = !!plan.executed_at && saved;
    const movingFrom = new Set(rows.map((r) => r.from).filter(Boolean));
    tbody.replaceChildren(...rows.map((r, i) => {
      const note = done ? doneNote(r) : toNote(r, movingFrom);
      return h('tr', {},
        h('td', {}, bedSelect(r.from, (e) => { r.from = e.target.value; changed(); }, true), h('div', { class: 'small muted' }, done ? (r.name ? (r.status === 'done' || !r.status ? `Moved: ${r.name}` : r.name) : '') : r.from ? who(r.from) || 'Empty' : '')),
        h('td', { class: 'arrow' }, r.swap ? '⇄' : '→'),
        h('td', {}, bedSelect(r.to, (e) => { r.to = e.target.value; changed(); }), h('div', { class: 'small ' + (note.warn ? 'warntext' : 'muted') }, note.text)),
        h('td', { class: 'swapcell' }, h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: !!r.swap, disabled: !edit || done, onchange: (e) => { r.swap = e.target.checked; changed(); } }), 'Swap')),
        edit && h('td', {}, done
          ? (r.status === 'waiting' && h('button', { type: 'button', class: 'ghost small', onclick: async () => {
            if (!confirm(`Cancel the waiting shift ${r.from} → ${r.to}?`)) return;
            try { await api('POST', '/api/shifts/cancel', { index: i }); shiftsModal(); } catch (e) { msg.textContent = e.message; }
          } }, 'Cancel'))
          : h('button', { type: 'button', class: 'ghost small', onclick: () => { rows.splice(i, 1); if (!rows.length) rows.push({ from: '', to: '' }); changed(); } }, 'Remove')));
    }));
    const nWait = rows.filter((r) => r.status === 'waiting').length;
    status.textContent = done ? `Carried out by ${plan.executed_by} · ${plan.executed_at}${nWait ? ` · ${nWait} waiting for a discharge` : ''}` : plan.saved_at ? `${saved ? 'Saved' : 'Last saved'} by ${plan.saved_by} · ${plan.saved_at}${saved ? '' : ' · unsaved changes'}` : 'Not saved yet';
    save.hidden = addBtn.hidden = !edit || done;
    exec.disabled = !saved || !!plan.executed_at || !rows.some((r) => r.from && r.to);
    const list = rows.filter((r) => r.from || r.to);
    sheet.replaceChildren(h('h2', {}, 'Bed shifts · ', fmtDay(S.meta.today)),
      h('table', { class: 'print' }, h('thead', {}, h('tr', {}, ['From', 'Patient', 'To', 'Note', 'Done'].map((t) => h('th', {}, t)))),
        h('tbody', {}, list.map((r) => h('tr', {}, h('td', {}, h('b', {}, r.from)), h('td', {}, done ? r.name || '' : who(r.from)), h('td', {}, h('b', {}, r.swap ? '⇄ ' : '', r.to)),
          h('td', {}, done ? (r.swap && r.name2 ? `Swap: ${r.name2} → ${r.from}` : doneNote(r).text) : (toNote(r, movingFrom).text || '').replace(/^Empty$/, '')), h('td', { class: 'blank' }))))));
  };
  const addBtn = h('button', { type: 'button', class: 'ghost small', onclick: () => { rows.push({ from: '', to: '' }); changed(); } }, '+ Add a shift');
  const changed = () => { saved = false; msg.textContent = ''; draw(); };
  const save = h('button', { type: 'button', class: 'primary', onclick: async () => {
    try { await api('PUT', '/api/shifts', { rows: rows.filter((r) => r.from || r.to) }); toast('Bed shift list saved'); shiftsModal(); } catch (e) { msg.textContent = e.message; }
  } }, 'Save list');
  const exec = h('button', { type: 'button', class: 'danger', onclick: async () => {
    const movingFrom = new Set(rows.map((r) => r.from).filter(Boolean));
    const later = rows.filter((r) => toNote(r, movingFrom).warn).map((r) => `${r.from} → ${r.to} (after ${who(r.to)} is discharged)`);
    if (!confirm('Move the patients to their new beds now?' + (later.length ? `\n\nThese will wait and move by themselves after the discharge, along with any shift that needs the bed they leave:\n${later.join('\n')}` : ''))) return;
    try { const r = await api('POST', '/api/shifts/execute', { date: S.meta.today }); toast(`${r.moved} shift${r.moved === 1 ? '' : 's'} done` + (r.waiting ? `, ${r.waiting} waiting for a discharge` : '')); close(); render(); } catch (e) { msg.textContent = e.message; }
  } }, 'Execute');
  const fresh = h('button', { type: 'button', class: 'ghost', onclick: () => {
    if (rows.some((r) => r.status === 'waiting') && !confirm('Some shifts are still waiting for a discharge. A new list replaces them once you save it. Continue?')) return;
    rows = [{ from: '', to: '' }]; plan.executed_at = ''; changed();
  } }, 'Start a new list');

  root.replaceChildren(h('div', { class: 'backdrop', onclick: (e) => e.target === e.currentTarget && close() },
    h('div', { class: 'modal card panel shifts' },
      h('div', { class: 'mhead noprint' }, h('h2', {}, 'Bed shifts'), h('div', { class: 'btns' }, h('button', { type: 'button', class: 'ghost small', onclick: close }, 'Close'))),
      h('div', { class: 'noprint' },
        h('p', { class: 'muted' }, 'Write the shifts the evening before and save. After the morning round, press Execute to move everyone at once. Tick Swap to exchange the two patients. Without Swap, if the To bed still has a patient (for example, going home later today), that shift waits and happens by itself when the patient is discharged, together with any shift into the bed it frees.'),
        status,
        h('table', { class: 'list shiftlist' }, h('thead', {}, h('tr', {}, h('th', {}, 'From bed'), h('th', {}), h('th', {}, 'To bed'), h('th', {}), edit && h('th', {}))), tbody),
        addBtn,
        msg,
        h('div', { class: 'btns shiftbtns' },
          save,
          h('button', { type: 'button', class: 'ghost', onclick: () => { document.body.classList.add('print-modal'); window.print(); document.body.classList.remove('print-modal'); } }, 'Print'),
          edit && plan.executed_at && fresh,
          edit && exec)),
      sheet)));
  draw();
}

// New OT findings & instructions posted by others, shown under the search bar until marked as read.
// What each person has read is remembered on their own device.
function otSeenKey() { return 'ward-ot-seen:' + (S.user && S.user.id); }
function otSeen() { try { return localStorage.getItem(otSeenKey()) || ''; } catch { return ''; } }
const localStamp = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
// The work day runs 9 am to 9 am: before 9 am it is still yesterday's (worklist and today's investigations).
const workDay = () => { const d = new Date(); if (d.getHours() < 9) d.setDate(d.getDate() - 1); return localStamp(d).slice(0, 10); };
// The bell (today's investigations) and, on the Ward Register, the Worklist tile: half the row each.
function drawOtAlerts(box, admissions, open, date, withWork) {
  const day = !date || date === S.meta.today ? workDay() : date;
  const inv = invOn(admissions.filter((a) => !a.discharge_date || a.discharge_date > day), day);
  if (!inv.length && !withWork) return box.replaceChildren();
  const bell = inv.length ? h('button', { type: 'button', class: 'otbar invbar', onclick: () => invPanel('Investigations today', inv, day) },
    h('span', { class: 'bell', 'aria-hidden': 'true' }, '🔔'),
    h('b', {}, `${inv.length} investigation${inv.length === 1 ? '' : 's'} today`),
    h('span', { class: 'muted small' }, 'Tap to view'))
    : h('div', { class: 'otbar quiet' }, h('span', { 'aria-hidden': 'true' }, '🔔'), h('span', { class: 'muted small' }, 'No investigations today'));
  if (!withWork) return box.replaceChildren(h('div', { class: 'alertbar one' }, bell));
  const count = h('span', { class: 'muted small' }, 'Tap to open');
  const tile = h('button', { type: 'button', class: 'otbar workbar', onclick: () => worklistPanel(() => drawOtAlerts(box, admissions, open, date, withWork)) },
    h('span', { 'aria-hidden': 'true' }, '📝'), h('b', {}, 'Worklist'), count);
  api('GET', '/api/work').then((w) => {
    const pend = w.filter((x) => !x.done), pri = pend.filter((x) => x.priority).length;
    count.replaceChildren(pend.length ? `${pend.length} pending${pri ? ` · ` : ''}` : 'Nothing pending', pri ? h('b', { class: 'prio' }, `${pri} priority`) : '');
    tile.classList.toggle('haspri', !!pri);
  }).catch(() => {});
  box.replaceChildren(h('div', { class: 'alertbar' }, bell, tile));
}

// ---------- Worklist: JR and SR to-dos per patient, ticked ones cleared at 9 am ----------
const BIN_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
const WORK_TABS = [['jr', 'JR Worklist'], ['sr', 'SR Worklist']];
const workSort = (x, y) => (x.done !== y.done ? (x.done ? 1 : -1) : x.done ? (x.done_at || 0) - (y.done_at || 0)
  : x.priority !== y.priority ? (x.priority ? -1 : 1) : bedRank(x.bed) - bedRank(y.bed) || x.at - y.at);
async function worklistPanel(onClose) {
  const root = document.getElementById('modal-root');
  const close = () => { root.replaceChildren(); if (onClose) onClose(); };
  const body = h('div', {}, h('p', { class: 'loading' }, 'Loading…'));
  const seg = h('div', { class: 'seg worktabs' });
  root.replaceChildren(h('div', { class: 'backdrop', onclick: (ev) => ev.target === ev.currentTarget && close() },
    h('div', { class: 'modal card panel worklist' }, h('div', { class: 'mhead' }, h('h2', {}, 'Worklist'), h('div', { class: 'btns' }, h('button', { type: 'button', class: 'ghost small', onclick: close }, 'Close'))),
      seg, body)));
  const reg = await api('GET', '/api/register?date=' + S.meta.today).catch(() => ({ admissions: [] }));
  const pts = reg.admissions.filter((a) => !a.discharge_date).sort((x, y) => bedRank(x.bed_on_date) - bedRank(y.bed_on_date));
  let items = [];
  const tab = () => S.workTab || 'jr';
  // Add a to-do: a patient in the ward, or "Other" for someone not in the ward (type the bed or name).
  const who = h('select', {}, h('option', { value: '' }, 'Choose patient'), pts.map((a) => h('option', { value: a.id }, `${a.bed_on_date} · ${a.name}`)), h('option', { value: 'other' }, 'Other (not in ward)…'));
  const otherIn = h('input', { placeholder: 'Bed / ward and name, e.g. 7C/2 Riya', hidden: true });
  who.onchange = () => { otherIn.hidden = who.value !== 'other'; if (!otherIn.hidden) otherIn.focus(); };
  const text = h('input', { placeholder: 'To do, e.g. Send CBC, Call radiology for USG' });
  const pri = h('input', { type: 'checkbox' });
  const add = async () => {
    if (!who.value) return toast('Choose the patient', true);
    if (!text.value.trim()) return toast('Type what is to be done', true);
    const b = { list: tab(), text: text.value, priority: pri.checked };
    if (who.value === 'other') { if (!otherIn.value.trim()) return toast('Type the bed or name', true); b.bed = otherIn.value; } else b.admission_id = who.value;
    try { await api('POST', '/api/work', b); text.value = ''; pri.checked = false; await load(); text.focus(); } catch (e) { toast(e.message, true); }
  };
  text.onkeydown = (ev) => { if (ev.key === 'Enter') add(); };
  const form = canEdit() ? h('div', { class: 'workadd' }, who, otherIn, text, h('label', { class: 'inline prioopt' }, pri, ' Priority'), h('button', { type: 'button', class: 'primary small', onclick: add }, 'Add')) : '';
  const table = h('div', { class: 'tablewrap' });
  body.replaceChildren(form, table, h('p', { class: 'muted small' }, 'Ticked work stays struck through until 9 am, then clears. Pending work carries over to the next day.'));
  const set = async (w, b) => { try { await api('PUT', '/api/work/' + encodeURIComponent(w.id), b); await load(); } catch (e) { toast(e.message, true); } };
  function draw() {
    seg.replaceChildren(...WORK_TABS.map(([k, label]) => { const n = items.filter((w) => w.list === k && !w.done).length;
      return h('button', { type: 'button', class: k === tab() ? 'on' : '', onclick: () => { S.workTab = k; draw(); } }, label, n ? ` · ${n}` : ''); }));
    const rows = items.filter((w) => w.list === tab()).sort(workSort);
    // One line per to-do: bed, name and the to-do (widest), then the Priority and Done boxes and a bin.
    table.replaceChildren(rows.length ? h('ul', { class: 'worklines' }, rows.map((w) => h('li', { class: 'workline' + (w.done ? ' done' : '') + (w.priority && !w.done ? ' prio' : '') },
        h('span', { class: 'bedno' }, w.bed || '—'),
        h('span', { class: 'wtodo' }, w.name ? h('span', { class: 'wname' }, w.name + ' · ') : '', h('span', { class: 'wtext' }, w.text), w.discharged ? h('span', { class: 'small muted' }, ' · discharged') : ''),
        h('label', { class: 'wbox', title: 'Priority' }, h('input', { type: 'checkbox', checked: w.priority, disabled: !canEdit() || w.done, onchange: (ev) => set(w, { priority: ev.target.checked }) }), h('span', {}, 'Priority')),
        h('label', { class: 'wbox', title: 'Done' }, h('input', { type: 'checkbox', class: 'tick', checked: w.done, disabled: !canEdit(), onchange: (ev) => set(w, { done: ev.target.checked }) }), h('span', {}, 'Done')),
        canEdit() ? iconBtn(BIN_SVG, 'Delete', () => { if (confirm(`Delete "${w.text}"?`)) api('DELETE', '/api/work/' + encodeURIComponent(w.id)).then(load).catch((e) => toast(e.message, true)); }, 'pencil bin') : '')))
      : h('p', { class: 'muted' }, `Nothing on the ${WORK_TABS.find(([k]) => k === tab())[1]} yet.`));
  }
  async function load() { items = await api('GET', '/api/work').catch((e) => { toast(e.message, true); return items; }); draw(); }
  await load();
}
// In a Rounds card: add work for this patient to the JR or SR worklist, and see what is pending.
function workBox(a) {
  const box = h('div', {});
  const text = h('input', { placeholder: 'Add to worklist, e.g. Repeat KFT' });
  const list = h('select', {}, WORK_TABS.map(([k, label]) => h('option', { value: k }, label.replace(' Worklist', ''))));
  const pri = h('input', { type: 'checkbox' });
  list.value = S.workTab || 'jr';
  const draw = (items) => {
    const mine = items.filter((w) => w.admission_id === a.id).sort(workSort);
    const pend = mine.filter((w) => !w.done);
    box.replaceChildren(foldBox('work:' + a.id, 'work', 'Worklist', pend.length ? `${pend.length} pending` : '', [
      mine.length ? h('ul', { class: 'invlist worklistmini' }, mine.map((w) => h('li', { class: (w.done ? 'done' : '') + (w.priority && !w.done ? ' prio' : '') },
        h('b', {}, w.list.toUpperCase()), ` · ${w.text}`))) : null,
      canEdit() && h('div', { class: 'otadd invadd workadd' }, text, list, h('label', { class: 'inline prioopt' }, pri, ' Priority'), h('button', { type: 'button', class: 'ghost small', onclick: add }, 'Add'))]));
  };
  const load = () => api('GET', '/api/work').then(draw).catch(() => draw([]));
  const add = async () => {
    if (!text.value.trim()) return;
    try { await api('POST', '/api/work', { list: list.value, admission_id: a.id, text: text.value, priority: pri.checked }); toast(`Added to the ${list.value.toUpperCase()} worklist`); text.value = ''; pri.checked = false; load(); } catch (e) { toast(e.message, true); }
  };
  text.onkeydown = (ev) => { if (ev.key === 'Enter') add(); };
  load();
  return box;
}

// List of empty beds, one column per ward (6B, 6A).
function emptyBedsPanel(beds, date) {
  const root = document.getElementById('modal-root');
  const close = () => root.replaceChildren();
  const wards = [...new Set(beds.map(wardOf))];
  root.replaceChildren(h('div', { class: 'backdrop', onclick: (e) => e.target === e.currentTarget && close() },
    h('div', { class: 'modal card panel' },
      h('div', { class: 'mhead' }, h('h2', {}, `Empty beds · ${beds.length}`), h('div', { class: 'btns' }, h('button', { type: 'button', class: 'ghost small', onclick: close }, 'Close'))),
      h('p', { class: 'muted' }, fmtDay(date), canEdit() ? ' · Click a bed to admit a patient to it.' : ''),
      beds.length ? h('div', { class: 'emptycols' }, wards.map((w) => {
        const list = beds.filter((b) => wardOf(b) === w);
        return h('div', {}, h('h3', {}, `${w} · ${list.length}`),
          h('ul', {}, list.map((b) => h('li', {}, canEdit() ? h('a', { href: 'javascript:void 0', onclick: () => { close(); admitModal(b); } }, b) : b))));
      })) : h('p', {}, 'No empty beds.'))));
}

// Admitted / Discharged today: tap the count to see those patients, one column per ward.
function clickStat(label, list, date, out) {
  const el = stat(label, list.length);
  el.classList.add('clickable'); el.title = 'Show these patients'; el.onclick = () => patientsPanel(label, list, date, out);
  return el;
}
// One column per ward (6B, 6A); on a wide screen each patient takes a single line.
const bedRank = (bed) => { const i = S.meta.sections.flatMap((x) => x.beds).indexOf(bed); return i < 0 ? 1e6 : i; };
function wardCols(rows, line) {
  rows = [...rows].sort((x, y) => bedRank(x.bed) - bedRank(y.bed));
  const wards = [...new Set(rows.map((r) => wardOf(r.bed)))];
  return h('div', { class: 'emptycols ptcols' }, wards.map((w) => {
    const list = rows.filter((r) => wardOf(r.bed) === w);
    return h('div', {}, h('h3', {}, `${w} · ${list.length}`), h('ul', {}, list.map((r) => h('li', {}, line(r)))));
  }));
}
function listModal(title, ...kids) {
  const root = document.getElementById('modal-root');
  const close = () => root.replaceChildren();
  root.replaceChildren(h('div', { class: 'backdrop', onclick: (e) => e.target === e.currentTarget && close() },
    h('div', { class: 'modal card panel wide' },
      h('div', { class: 'mhead' }, h('h2', {}, title), h('div', { class: 'btns' }, h('button', { type: 'button', class: 'ghost small', onclick: close }, 'Close'))), ...kids)));
}
function wardListPanel(title, date, rows, line, emptyText) {
  listModal(`${title} · ${rows.length}`, h('p', { class: 'muted' }, fmtDay(date)), rows.length ? wardCols(rows, line) : h('p', {}, emptyText));
}
function patientsPanel(label, list, date, out) {
  wardListPanel(label, date, list.map((a) => ({ a, bed: a.bed_on_date || a.bed })), ({ a, bed }) => [
    h('span', { class: 'muted small' }, bed), h('b', {}, a.name),
    h('span', { class: 'small' }, ageSex(a, date) || '—'),
    a.diagnosis ? h('span', { class: 'small muted' }, a.diagnosis) : null,
    out && a.outcome && a.outcome !== 'Discharged' ? h('span', { class: 'small outcome-bad' }, a.outcome) : null], out ? 'No discharges.' : 'No admissions.');
}
// Investigations booked for `day` among these patients, in bed order.
const invOn = (adms, day) => adms.flatMap((a) => (a.inv || []).filter((v) => v.date === day).map((v) => ({ a, v, bed: a.bed_on_date || a.bed })));
const invLine = ({ a, v, bed }) => [
  h('b', { class: 'invname' }, v.text), h('span', { class: 'muted small' }, bed), h('span', {}, a.name),
  a.diagnosis ? h('span', { class: 'small muted' }, a.diagnosis) : null];
function invPanel(title, rows, day) { wardListPanel(title, day, rows, invLine, 'No investigations booked.'); }
// Every investigation booked from `day` on, among these patients.
const invFrom = (adms, day) => adms.flatMap((a) => (a.inv || []).filter((v) => v.date >= day).map((v) => ({ a, v, bed: a.bed_on_date || a.bed })));
// Upcoming investigations, date by date, each day split by ward.
function upcomingPanel(rows, today) {
  const days = [...new Set(rows.map((r) => r.v.date))].sort();
  listModal(`Upcoming investigations · ${rows.length}`,
    rows.length ? days.map((d) => h('section', { class: 'invday' },
      h('h3', { class: 'invdate' }, d === today ? 'Today · ' : d === addDays(today, 1) ? 'Tomorrow · ' : '', fmtDay(d)),
      wardCols(rows.filter((r) => r.v.date === d), invLine))) : h('p', {}, 'No investigations booked.'));
}

function emptyBed(bed) {
  return h('div', { class: 'bed empty' },
    h('span', { class: 'bedno' }, bed),
    h('span', { class: 'muted' }, 'Empty'),
    canEdit() && h('button', { class: 'ghost small', onclick: () => admitModal(bed) }, 'Admit'));
}

// Yes / No as two buttons. Tapping the chosen one again clears it.
function yesNo(key, value, onInput) {
  const hidden = h('input', { type: 'hidden', 'data-key': key, value: value || '' });
  const wrap = h('div', { class: 'yn' });
  const draw = () => wrap.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === hidden.value));
  ['Yes', 'No'].forEach((v) => wrap.append(h('button', { type: 'button', 'data-v': v, class: 'yn-' + v.toLowerCase(),
    onclick: () => { hidden.value = hidden.value === v ? '' : v; draw(); onInput(); } }, v)));
  wrap.append(hidden);
  draw();
  return wrap;
}

function fieldFor(p, value, onInput) {
  if (p.type === 'yesno') return yesNo(p.key, value, onInput);
  const common = { 'data-key': p.key, oninput: onInput, onchange: onInput };
  if (p.type === 'choice') {
    const opts = p.options.split(',').map((o) => o.trim()).filter(Boolean);
    if (value && !opts.includes(value)) opts.push(value);
    return h('select', { ...common, value: value || '' }, h('option', { value: '' }, '—'), opts.map((o) => h('option', { value: o, selected: o === value }, o)));
  }
  if (p.type === 'number') return h('input', { ...common, inputmode: 'decimal', value: value || '', placeholder: p.unit || '' });
  return h('input', { ...common, value: value || '' });
}

// OT findings and instructions: anyone can post; each post shows who wrote it and when.
function otList(entries, onChanged) {
  return h('ul', { class: 'otlist' }, entries.map((o) => {
    const li = h('li', {});
    const show = () => li.replaceChildren(...[
      h('div', { class: 'othdrrow' }, h('small', { class: 'muted' }, `${fmtDate(o.at.slice(0, 10))} ${o.at.slice(11, 16)} · ${o.by || ''}${o.edited ? ` · edited by ${o.edited}` : ''}`),
        onChanged && canEdit() && (() => { const b = h('button', { type: 'button', class: 'pencil', title: 'Edit', 'aria-label': 'Edit', onclick: edit }); b.innerHTML = PENCIL_SVG; return b; })()),
      o.text && h('div', {}, o.text),
      (o.scrub || []).length ? h('div', { class: 'team small' }, h('b', {}, 'Scrubbed: '), o.scrub.join('/'), o.surgery ? h('div', { class: 'muted' }, o.surgery) : null) : null].filter(Boolean));
    // The pencil opens the text in place; Save keeps the change, Delete (own posts) removes it.
    const edit = () => {
      const ta = h('textarea', { rows: Math.min(10, Math.max(3, Math.ceil((o.text || '').length / 80))) }, o.text || '');
      li.replaceChildren(ta, h('div', { class: 'btns' },
        o.mine && h('button', { type: 'button', class: 'link small del', onclick: async () => {
          if (!confirm('Delete this entry?')) return;
          try { await api('DELETE', '/api/ot/' + encodeURIComponent(o.id)); toast('Deleted'); onChanged(); } catch (e) { toast(e.message, true); }
        } }, 'Delete'),
        h('button', { type: 'button', class: 'ghost small', onclick: show }, 'Cancel'),
        h('button', { type: 'button', class: 'primary small', onclick: async () => {
          try { await api('PUT', '/api/ot/' + encodeURIComponent(o.id), { text: ta.value }); toast('Saved'); onChanged(); } catch (e) { toast(e.message, true); }
        } }, 'Save')));
      ta.focus();
    };
    show();
    return li;
  }));
}

// Scrub-team initials. Consultants as in SURGEONS (SN is Dr Sachit Anand, SA is Dr Sandeep Agarwala), then the residents.
const SR_INITIALS = [['KI', 'Kiran'], ['JD', 'Jagadish'], ['SY', 'Shreya'], ['PA', 'Priyanjali'], ['DC', 'Deepak'], ['VN', 'Vinanti'], ['NN', 'Nikunj'], ['PS', 'Prateek'], ['TE', 'Tirth'], ['NP', 'Nidhi'],
  ['SG', 'Sugandha'], ['AR', 'Aranya'], ['VG', 'Vivek'], ['SD', 'Sakthi'], ['PD', 'Pratisruti'], ['KG', 'Kartavya'], ['NC', 'Nitin'], ['DV', 'Digvijay'], ['AM', 'Archisman'], ['SJ', 'Sarthak Jain']];
const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth'];
const roleName = (n) => (n === 1 ? 'Operating surgeon' : `${ORDINALS[n - 2] || n - 1 + 'th'} assistant`);
const roleShort = (n) => (n === 1 ? 'operating' : `${['1st', '2nd', '3rd'][n - 2] || n - 1 + 'th'} asst`);
// Users added with initials (Admin > Users) join the tiles: consultants with the consultants, everyone else with the residents.
const userPeople = (consultant) => ((S.meta && S.meta.people) || []).filter((u) => (u.role === 'consultant') === consultant).map((u) => [u.initials, u.name]);
const allPeople = () => [...SURGEONS, ...SR_INITIALS, ...userPeople(true), ...userPeople(false)];
const personName = (i) => { const p = allPeople().find(([x]) => x === i); return p ? p[1] : i; };
function myInitials() {
  if (S.user && S.user.initials) return S.user.initials;
  const name = (S.user && S.user.name || '').trim().replace(/^dr\.?\s+/i, ''), first = name.split(/\s+/)[0] || '';
  const c = SURGEONS.find(([, n]) => squash(n).replace(/^dr/, '') === squash(name).replace(/^dr/, ''));
  if (c) return c[0];
  const r = SR_INITIALS.find(([, n]) => n.toLowerCase() === name.toLowerCase()) || SR_INITIALS.find(([, n]) => !n.includes(' ') && n.toLowerCase() === first.toLowerCase());
  return r ? r[0] : '';
}

// Tap the people who scrubbed in, in order: 1 operating surgeon, 2 first assistant, 3 second assistant… Opens in place, no pop-up.
function scrubPicker(initial, onSave) {
  let team = [...(initial || [])];
  const known = new Set(allPeople().map(([i]) => i));
  const builtIn = new Set([...SURGEONS, ...SR_INITIALS].map(([i]) => i));
  const extraCons = userPeople(true).filter(([i]) => !builtIn.has(i)), extraRes = userPeople(false).filter(([i]) => !builtIn.has(i) && !extraCons.some(([c]) => c === i));
  const addIn = h('input', { placeholder: 'Name of the person', onkeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } } });
  const add = () => { const v = addIn.value.trim(); if (v && !team.includes(v)) team.push(v); addIn.value = ''; addRow.hidden = true; draw(); };
  const addRow = h('div', { class: 'saddrow' }, addIn, h('button', { type: 'button', class: 'ghost small', onclick: add }, 'Add'));
  addRow.hidden = true;
  const grid = h('div', { class: 'scrubgrid' });
  const tile = (i) => { const n = team.indexOf(i) + 1; return h('button', { type: 'button', class: 'stile' + (n ? ' on' : ''), title: personName(i), onclick: () => { if (n) team.splice(n - 1, 1); else team.push(i); draw(); } },
    n ? h('span', { class: 'snum' }, n) : null, i); };
  const draw = () => grid.replaceChildren(
    h('small', { class: 'muted' }, 'Tap in order: 1 operating surgeon, 2 first assistant, 3 second assistant… Tap again to remove.'),
    h('div', { class: 'slabel' }, 'Consultants'), h('div', { class: 'stiles' }, SURGEONS.map(([i]) => tile(i)), extraCons.map(([i]) => tile(i))),
    h('div', { class: 'slabel' }, 'Residents'), h('div', { class: 'stiles' }, SR_INITIALS.map(([i]) => tile(i)), extraRes.map(([i]) => tile(i)), team.filter((x) => !known.has(x)).map(tile),
      h('button', { type: 'button', class: 'stile add', title: 'Someone else', onclick: () => { addRow.hidden = false; addIn.focus(); } }, '+')),
    addRow,
    h('div', { class: 'btns' }, h('span', { class: 'small grow' }, team.length ? team.map((x, k) => `${k + 1} ${x}`).join(' · ') : 'No one chosen'),
      h('button', { type: 'button', class: 'primary small', onclick: () => onSave(team.slice()) }, 'Save team')));
  draw();
  return grid;
}

const postedText = (r) => { const s = r && r.surgery; return !s || s.already ? 'Posted' : s.full ? 'Posted. Three surgery dates are already filled, so this one was not added.' : `Posted. ${fmtDate(s.date)} saved as surgery ${s.n}. POD counts from it.`; };
// Rounds boxes fold into a dropdown; one left open stays open when its card is redrawn.
const openBoxes = new Set();
function foldBox(key, cls, title, hint, kids) {
  const d = h('details', { class: 'ot fold ' + cls, open: openBoxes.has(key) || null, ontoggle: () => (d.open ? openBoxes.add(key) : openBoxes.delete(key)) },
    h('summary', {}, h('span', { class: 'othead' }, title), hint ? h('span', { class: 'foldhint small' }, hint) : null), ...kids);
  return d;
}
// A text box with a pencil in the corner; the pencil opens it for editing in place (short notes, OT Overs, procedure done).
function penBox(cls, label, value, opts) {
  const box = h('div', { class: cls });
  const show = () => {
    const pen = canEdit() && iconBtn(PENCIL_SVG, 'Edit ' + label.toLowerCase(), edit);
    box.replaceChildren(h('div', { class: 'grow' }, h('b', {}, label + ': '), value || h('span', { class: 'muted' }, opts.empty || 'None yet'), opts.extra ? opts.extra() : null), pen || '');
  };
  const edit = () => {
    const ta = h('textarea', { rows: Math.min(10, Math.max(3, Math.ceil((value || '').length / 110) + 1)), placeholder: opts.placeholder || '' }, value || '');
    const more = opts.editExtra ? opts.editExtra() : null;
    box.replaceChildren(h('div', { class: 'grow' }, h('b', {}, label), opts.hint ? h('small', { class: 'muted block' }, opts.hint) : null, ta, more ? more.nodes : null,
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'ghost small', onclick: show }, 'Cancel'),
        h('button', { type: 'button', class: 'primary small', onclick: async () => {
          try { await opts.save(ta.value.trim(), more && more.values()); value = ta.value.trim(); toast(label + ' saved'); show(); } catch (e) { toast(e.message, true); }
        } }, 'Save'))));
    ta.focus();
  };
  show();
  return box;
}
// Procedure done (from the scrub team on the OT list, editable here) with the surgery dates and each OT day's team.
function procedureBox(a, surgeries, onDates) {
  return penBox('procbox', 'Procedure done', a.procedure_done, {
    empty: 'Not operated yet',
    extra: () => [surgeries.length ? h('small', {}, ' on ' + surgeries.map(fmtDate).join(', ')) : null,
      (a.otprocs || []).map((x) => h('div', { class: 'small muted otprocrow' }, `${otName(x.ot)} · ${fmtDate(x.date)}${x.done ? `: ${x.done}` : ''} · ${x.scrub.join('/')} `,
        canEdit() && x.list_id ? pencilLink(`#otlist/${x.list_id}/${x.entry_id}`, 'Edit on the OT list') : null))],
    // ICU babies admitted before the app often had surgery already: their surgery dates can be typed in here.
    editExtra: isIcu(a.bed_on_date || a.bed) ? () => {
      const ins = ['surgery_date', 'surgery_date2', 'surgery_date3'].map((k) => h('input', { type: 'date', value: a[k] || '', max: S.meta.today }));
      return { nodes: h('div', { class: 'sxdates' }, h('small', { class: 'muted block' }, 'Date of surgery (POD counts from it). Add a 2nd or 3rd if operated again.'), h('div', { class: 'sxdaterow' }, ins)),
        values: () => { const d = [...new Set(ins.map((i) => i.value).filter(Boolean))].sort(); return { surgery_date: d[0] || null, surgery_date2: d[1] || null, surgery_date3: d[2] || null }; } };
    } : null,
    save: (v, dates) => api('PUT', '/api/admissions/' + encodeURIComponent(a.id), { procedure_done: v, ...(dates || {}) }).then(() => { a.procedure_done = v; Object.assign(a, dates || {}); if (dates && onDates) onDates(); }),
  });
}
// OT Findings: what was found at operation, below OT Overs.
function findingsBox(a) {
  return penBox('instr findings', 'OT Findings', a.ot_findings, {
    placeholder: 'e.g. Dilated proximal colon, transition zone at rectosigmoid', hint: 'Write what was found at operation.',
    save: (v) => api('PUT', '/api/admissions/' + encodeURIComponent(a.id), { ot_findings: v }).then(() => { a.ot_findings = v; }),
  });
}
// OT Overs: what is to be done after the operation and when.
const OVERS_HINT = 'Write the OT overs, e.g. Rectal pack to be removed on POD 2; Stent to be removed on POD 10; Drain out when output < 20 ml.';
function oversBox(a) {
  return penBox('instr overs', 'OT Overs', a.ot_overs, {
    placeholder: 'e.g. Rectal pack to be removed on POD 2\nStent to be removed on POD 10', hint: OVERS_HINT,
    save: (v) => api('PUT', '/api/admissions/' + encodeURIComponent(a.id), { ot_overs: v }).then(() => { a.ot_overs = v; }),
  });
}

// Investigations booked for a date (Barium swallow, CT under GA, PET CT…). The register shows tomorrow's; the alert bar shows today's.
function invBox(a, date, onChanged) {
  const text = h('input', { placeholder: 'Investigation, e.g. CT abdomen under GA' });
  const when = h('input', { type: 'date', value: addDays(date, 1) });
  const add = async () => {
    if (!text.value.trim()) return;
    try { await api('POST', '/api/inv/' + a.id, { text: text.value, date: when.value }); toast('Investigation added'); onChanged(); } catch (e) { toast(e.message, true); }
  };
  const inv = a.inv || [], next = inv.find((v) => v.date >= date);
  const when2 = (d) => (d === date ? 'Today' : d === addDays(date, 1) ? 'Tomorrow' : fmtDate(d));
  return foldBox('inv:' + a.id, 'inv', 'Investigations', next ? `${when2(next.date)}: ${next.text}${inv.filter((v) => v.date >= date).length > 1 ? ` +${inv.filter((v) => v.date >= date).length - 1}` : ''}` : '', [
    inv.length ? h('ul', { class: 'invlist' }, inv.map((v) => h('li', { class: v.date < date ? 'past' : v.date === date ? 'today' : '' },
      h('b', {}, v.date === date ? 'Today' : v.date === addDays(date, 1) ? 'Tomorrow' : fmtDate(v.date)), ` · ${v.text}`,
      canEdit() && h('button', { type: 'button', class: 'link small del', onclick: async () => {
        if (!confirm(`Delete ${v.text}?`)) return;
        try { await api('DELETE', '/api/inv/' + encodeURIComponent(v.id)); toast('Deleted'); onChanged(); } catch (e) { toast(e.message, true); }
      } }, 'Delete')))) : null,
    canEdit() && h('div', { class: 'otadd invadd' }, text, when, h('button', { type: 'button', class: 'ghost small', onclick: add }, 'Add'))]);
}

function patientCard(a, date, refresh) {
  const pm = paramMap();
  const chosen = monitorFor(a).map((k) => pm[k]).filter(Boolean);
  const checks = chosen.filter((p) => p.type === 'yesno');
  const extras = extrasOf(a);
  checks.push(...extras.filter((e) => e.type === 'yesno'));
  const values = [...chosen.filter((p) => p.type !== 'yesno'), ...extras.filter((e) => e.type !== 'yesno')];
  const vals = (a.round && a.round.vals) || {};
  const prev = (a.prev_round && a.prev_round.vals) || {};
  const discharged = a.discharge_date && a.discharge_date < date;
  const id = a.id;
  const icu = isIcu(a.bed_on_date);
  const status = h('span', { class: 'round-status' });
  const card = h('article', { class: 'bed occupied rcard' + (a.discharge_date === date ? ' leaving' : '') });

  // Urine output in ml/kg/hr worked out from the 24 h urine output and the weight, as a check.
  const calc = h('small', { class: 'calc' });
  const updateCalc = () => {
    const el = card.querySelector('[data-key="w_uo"]');
    const ml = parseFloat(el && el.value), kg = parseFloat(a.weight);
    calc.textContent = ml > 0 && kg > 0 ? `Worked out: ${(ml / kg / 24).toFixed(1)} ml/kg/hr (over 24 h, ${kg} kg)` : '';
  };
  const setStatus = () => {
    if (S.dirty.has(id)) { status.textContent = 'Not saved yet'; status.className = 'round-status dirty'; }
    else if (a.round) { status.textContent = `✓ ${a.round.filled_by || ''} · ${a.round.filled_at.slice(11, 16)}`; status.className = 'round-status done'; }
    else { status.textContent = ''; status.className = 'round-status'; }
  };
  const markDirty = () => { S.dirty.add(id); setStatus(); updateCalc(); };

  const box = (p) => h(p.type === 'yesno' ? 'div' : 'label', { class: 'field' },
    h('span', { class: 'flabel' }, p.label, p.unit ? h('small', {}, ` (${p.unit})`) : null),
    fieldFor(p, vals[p.key], markDirty),
    p.key === 'w_uo_kg' ? calc : null,
    prev[p.key] ? h('small', { class: 'prev' }, `Yesterday: ${prev[p.key]}`) : null);
  const remarks = h('textarea', { rows: 2, placeholder: 'Other findings / remarks', oninput: markDirty }, (a.round && a.round.remarks) || '');

  const save = async () => {
    const out = {};
    card.querySelectorAll('[data-key]').forEach((el) => (out[el.dataset.key] = el.value));
    try {
      await api('PUT', `/api/rounds/${id}/${date}`, { vals: out, remarks: remarks.value });
      S.dirty.delete(id);
      toast(`Saved ${a.bed_on_date}`);
      refresh(id);
    } catch (e) { toast(e.message, true); }
  };

  const pod = podText(a, date);
  const surgeries = [a.surgery_date, a.surgery_date2, a.surgery_date3].filter(Boolean);
  const add = (...kids) => card.append(...kids.filter(Boolean));
  add(
    h('div', { class: 'rhead' },
      h('div', { class: 'rmain' },
        h('div', { class: 'rtitle' }, h('span', { class: 'bedno' }, a.bed_on_date), h('a', { href: '#patient/' + id, class: 'rname' }, a.name)),
        h('div', { class: 'muted small' }, [a.ip_no && `UHID ${a.ip_no}`, dayNo(a, date) && `Day ${dayNo(a, date)} of admission`,
          icu && a.birth_weight && `BW ${a.birth_weight} g`, icu && a.gestation && `GA ${a.gestation} wk`, icu && a.current_weight && `Wt ${a.current_weight} g`,
          !icu && a.weight && `Wt ${a.weight} kg`].filter(Boolean).join(' · ')),
        a.diagnosis && h('div', { class: 'rdx' }, h('span', {}, 'Diagnosis'), a.diagnosis),
        procedureBox(a, surgeries, () => refresh(id))),
      h('div', { class: 'rcorner' },
        h('div', { class: 'cfact' }, h('span', {}, 'Age / Sex'), h('b', {}, ageSex(a, date) || '—')),
        h('div', { class: 'cfact' }, h('span', {}, 'Consultant'), h('b', {}, a.unit || '—')),
        h('div', { class: 'cfact pod' }, h('span', {}, 'POD'), h('b', {}, pod ? pod.replace('POD ', '') : '—')))),
    a.unit_note && h('p', { class: 'instr unitnote' }, h('b', {}, `${a.unit || 'Consultant'} round: `), a.unit_note),
    oversBox(a),
    findingsBox(a),
    invBox(a, date, () => refresh(id)),
    workBox(a));

  if (!discharged && a.discharge_date !== date) {
    add(
      checks.length && h('div', { class: 'fields checks' }, checks.map(box)),
      values.length && h('div', { class: 'fields' }, values.map(box)),
      !checks.length && !values.length && h('p', { class: 'muted small' }, 'No round fields chosen. Use Edit details / fields to pick some.'),
      shortNotesBox(a),
      h('label', { class: 'field remarks' }, h('span', { class: 'flabel' }, 'Other findings / remarks'), remarks),
      a.prev_round && a.prev_round.remarks ? h('p', { class: 'prev' }, 'Yesterday: ' + a.prev_round.remarks) : null,
      h('div', { class: 'foot' }, status,
        h('div', { class: 'btns' },
          canEdit() && h('button', { class: 'ghost small', onclick: () => admitModal(null, a) }, 'Edit details / fields'),
          h('button', { class: 'primary small', onclick: save }, 'Save'))));
    setStatus();
    updateCalc();
  } else {
    add(a.instructions && h('p', { class: 'instr' }, h('b', {}, 'Short notes: '), a.instructions));
    if (a.round) add(h('p', { class: 'small' }, summariseVals(a.round.vals, a.monitor, a)), a.round.remarks && h('p', { class: 'small' }, a.round.remarks));
  }
  return card;
}
// Short notes (the patient's standing notes, printed under the bed) with a pencil to edit them in place.
function shortNotesBox(a) {
  const box = h('div', { class: 'instr shortnotes' });
  const show = () => {
    const pen = h('button', { type: 'button', class: 'pencil', title: 'Edit short notes', 'aria-label': 'Edit short notes', onclick: edit });
    pen.innerHTML = PENCIL_SVG;
    box.replaceChildren(h('div', { class: 'grow' }, h('b', {}, 'Short notes: '), a.instructions || h('span', { class: 'muted' }, 'None yet')), pen);
  };
  const edit = () => {
    const ta = h('textarea', { rows: Math.min(10, Math.max(3, Math.ceil((a.instructions || '').length / 110) + 1)), placeholder: 'Short notes for this patient' }, a.instructions || '');
    box.replaceChildren(h('div', { class: 'grow' }, h('b', {}, 'Short notes'), ta,
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'ghost small', onclick: show }, 'Cancel'),
        h('button', { type: 'button', class: 'primary small', onclick: async () => {
          try { await api('PUT', '/api/admissions/' + encodeURIComponent(a.id), { instructions: ta.value }); toast('Short notes saved'); a.instructions = ta.value.trim(); show(); } catch (e) { toast(e.message, true); }
        } }, 'Save'))));
    ta.focus();
  };
  show();
  return box;
}

// Rounds: every patient, ward by ward and then the ICU, in bed order, with the fields chosen for them.
// A bed counts as done when that day's round has something filled in and was saved between 4 am and 11:30 am that morning.
function morningDone(r, date) {
  if (!r || !r.filled_at || r.filled_at.slice(0, 10) !== date) return false;
  if (!Object.values(r.vals || {}).some((v) => String(v).trim()) && !(r.remarks || '').trim()) return false;
  const t = r.filled_at.slice(11, 16);
  return t >= '04:00' && t < '11:30';
}
// The Rounds form clears at 11:30 am: from then on it opens on tomorrow's date (blank), for the next morning's SR.
// Today's entries stay on the register, Status and the prints until midnight. Every day's rounds stay in the patient's history.
const ROUNDS_CLEAR_MIN = 11 * 60 + 30;
function roundsDay() {
  const n = new Date(), d = localStamp(n).slice(0, 10);
  return n.getHours() * 60 + n.getMinutes() >= ROUNDS_CLEAR_MIN ? addDays(d, 1) : d;
}
// Ward rounds (#rounds: 6B, 6A and other wards) and ICU rounds (#icurounds: 6C) are separate tabs.
async function roundsView(main, focus, icuTab) {
  const tab = icuTab ? 'icurounds' : 'rounds';
  const mine = (a) => !!isIcu(a.bed_on_date) === !!icuTab;
  // Opened from a bed on the register (#rounds/<patient>): show that patient's card.
  if (focus) { S.roundsSel = focus; history.replaceState(null, '', '#' + tab); lastHash = location.hash; }
  // A viewer reads the rounds already saved, so they see today's (not the next day's empty rounds after 11:30).
  const def = canEdit() ? roundsDay() : localStamp(new Date()).slice(0, 10);
  // A day picked with the arrows holds until the next 11:30 switch.
  const date = S.roundsPick && S.roundsPick.for === def ? S.roundsPick.d : def;
  const go = (d) => { if (confirmLeave()) { S.roundsPick = { d, for: def }; render(); } };
  const wards = [...new Set(S.meta.sections.flatMap((s) => s.beds).filter((b) => !!isIcu(b) === !!icuTab).map(wardOf))];
  const wardSel = h('select', { onchange: (e) => { S.filters.ward = e.target.value; draw(); } },
    h('option', { value: '' }, 'All wards'), wards.map((w) => h('option', { value: w }, wardTitle(w))));
  wardSel.value = S.filters.ward || '';
  const search = h('input', { type: 'search', placeholder: 'Find bed, name, UHID…', value: S.filters.q, oninput: (e) => { S.filters.q = e.target.value; draw(); } });
  main.append(dupBanner(),
    h('div', { class: 'toolbar' },
      h('div', { class: 'datenav' },
        h('button', { class: 'ghost', onclick: () => go(addDays(date, -1)), 'aria-label': 'Previous day' }, '‹'),
        h('input', { type: 'date', value: date, onchange: (e) => e.target.value && go(e.target.value) }),
        h('button', { class: 'ghost', onclick: () => go(addDays(date, 1)), 'aria-label': 'Next day' }, '›'),
        date !== def && h('button', { class: 'ghost small', onclick: () => go(def) }, 'Current rounds')),
      h('div', { class: 'filters' }, icuTab ? '' : wardSel, search)),
    h('h2', { class: 'daytitle' }, icuTab ? 'ICU Rounds · ' : 'Rounds · ', fmtDay(date)),
    canEdit() && date === def && def !== localStamp(new Date()).slice(0, 10) ? h('p', { class: 'muted small roundsnote' },
      `Cleared at 11:30 am for the next rounds. What you save now goes under ${fmtDay(date)}. Today's rounds stay on Status and the print until midnight, and in each patient's history.`) : '');
  const strips = h('div', { class: 'bedstrips' });
  const list = h('div', { class: 'register' }, h('p', { class: 'loading' }, 'Loading…'));
  main.append(strips, list);
  const load = async () => { const d = await api('GET', '/api/register?date=' + date); return { ...d, admissions: d.admissions.filter(mine) }; };
  let data = await load();
  // A patient opened on the wrong tab (moved to or from the ICU) goes to the right one.
  if (focus && !data.admissions.some((a) => a.id === focus)) { const all = await api('GET', '/api/register?date=' + date); if (all.admissions.some((a) => a.id === focus)) { location.hash = '#' + (icuTab ? 'rounds' : 'icurounds') + '/' + encodeURIComponent(focus); return; } }
  S.dirty.clear();
  const order = S.meta.sections.flatMap((s) => s.beds);
  const cards = new Map();
  const cardFor = (a) => { const c = canEdit() ? patientCard(a, date, reloadOne)
    : h('article', { class: 'bed occupied rcard' }, h('div', { class: 'rtitle' }, h('span', { class: 'bedno' }, a.bed_on_date)), patientDetails(a, date)); cards.set(a.id, c); return c; };
  // One strip of bed numbers per ward (6B, 6A), slides left and right. Tap a bed to see only that patient; All shows everyone.
  const pick = (id) => { if (id === S.roundsSel || !confirmLeave()) return; S.dirty.clear(); S.roundsSel = id; draw(); window.scrollTo({ top: strips.offsetTop - 70 }); };
  function drawStrips() {
    const here = data.admissions.filter((a) => a.discharge_date !== date).sort((x, y) => order.indexOf(x.bed_on_date) - order.indexOf(y.bed_on_date));
    const icuNo = (a) => +String(a.bed_on_date).split('/')[1];
    const groups = icuTab ? [['ICU A', (a) => icuNo(a) <= 10, '6C'], ['ICU B', (a) => icuNo(a) > 10, '6C']]
      : [['6B', (a) => wardOf(a.bed_on_date) === '6B', '6B'], ['6A', (a) => wardOf(a.bed_on_date) === '6A', '6A']];
    strips.replaceChildren(...groups.map(([label, test, w]) => {
      const pts = here.filter(test);
      if (!pts.length) return null;
      const row = h('div', { class: 'bedstrip' }, h('span', { class: 'bswho' }, label),
        h('div', { class: 'bsrow' }, pts.map((a) => h('button', { type: 'button', class: 'bschip' + (a.id === S.roundsSel ? ' on' : '') + (morningDone(a.round, date) ? ' done' : ''), title: a.name, onclick: () => pick(a.id) },
          a.bed_on_date.replace(new RegExp('^' + w + '/', 'i'), '')))));
      return row;
    }).filter(Boolean), h('div', { class: 'bsfoot' }, h('span', { class: 'muted bslegend' }, 'Green border = morning round saved (4 am to 11:30 am)'),
      S.roundsSel ? h('button', { type: 'button', class: 'ghost small bsall', onclick: () => pick(null) }, 'Show all patients') : ''));
    const on = strips.querySelector('.bschip.on');
    if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  function draw() {
    const q = S.filters.q.trim().toLowerCase();
    if (S.roundsSel && !data.admissions.some((a) => a.id === S.roundsSel && a.discharge_date !== date)) S.roundsSel = null;
    drawStrips();
    const pts = data.admissions.filter((a) => a.discharge_date !== date)
      .filter((a) => !S.roundsSel || a.id === S.roundsSel)
      .filter((a) => icuTab || !S.filters.ward || wardOf(a.bed_on_date) === S.filters.ward)
      .filter((a) => !q || [a.bed_on_date, a.name, a.ip_no, a.diagnosis].join(' ').toLowerCase().includes(q))
      .sort((x, y) => order.indexOf(x.bed_on_date) - order.indexOf(y.bed_on_date));
    list.replaceChildren();
    for (const w of wards) {
      const here = pts.filter((a) => wardOf(a.bed_on_date) === w);
      if (here.length) list.append(h('section', {}, h('h3', {}, wardTitle(w)), here.map(cardFor)));
    }
    const other = pts.filter((a) => !wards.includes(wardOf(a.bed_on_date)));
    if (other.length) list.append(h('section', {}, h('h3', {}, 'Other beds'), other.map(cardFor)));
    if (!list.childNodes.length) list.append(h('p', { class: 'muted empty-note' }, icuTab ? 'No babies in the ICU on this date.' : 'No patients in the ward on this date.'));
  }
  // Redraw only the card that changed, so entries typed in other cards are kept.
  async function reloadOne(id) {
    data = await load();
    const a = data.admissions.find((x) => x.id === id), old = cards.get(id);
    if (a && old && old.isConnected) { old.replaceWith(cardFor(a)); drawStrips(); } else draw();
  }
  draw();
}

// Read-only summary shown when a bed box is clicked. Round entry and editing live on the Rounds tab.
function patientDetails(a, date) {
  const pod = podText(a, date);
  const surgeries = [a.surgery_date, a.surgery_date2, a.surgery_date3].filter(Boolean);
  const findings = a.round ? summariseVals(a.round.vals, monitorFor(a), a) : '';
  const icu = isIcu(a.bed_on_date || a.bed);
  const big = (label, value, cls = '') => value ? h('div', { class: 'bigfact ' + cls }, h('span', {}, label), h('b', {}, value)) : null;
  return h('article', { class: 'details' },
    h('div', { class: 'dhead' },
      h('a', { href: '#patient/' + a.id, class: 'dname' }, a.name),
      h('span', { class: 'muted' }, [a.ip_no && `UHID ${a.ip_no}`, a.admit_date && `Date of admission ${fmtDate(a.admit_date)}`, !icu && a.weight && `Weight ${a.weight} kg`].filter(Boolean).join(' · '))),
    h('div', { class: 'bigfacts' },
      big('Age / Sex', ageSex(a, date)),
      big('Consultant', a.unit),
      big('POD', pod ? pod.replace('POD ', '') : '', 'pod'),
      big('Day of admission', dayNo(a, date))),
    icu && h('div', { class: 'bigfacts baby' },
      big('Date of birth', fmtDate(a.dob)),
      big('Birth weight', a.birth_weight && `${a.birth_weight} g`),
      big('Gestation', a.gestation && `${a.gestation} wk`),
      big('Current weight', a.current_weight && `${a.current_weight} g`)),
    a.diagnosis && h('div', { class: 'diagnosis' }, h('span', {}, 'Diagnosis'), h('b', {}, a.diagnosis)),
    (a.procedure_done || surgeries.length > 0) && h('div', { class: 'surgery' },
      h('span', {}, 'Procedure done'),
      h('b', {}, a.procedure_done || '—'),
      surgeries.length ? h('small', {}, 'on ' + surgeries.map(fmtDate).join(', ')) : null),
    a.instructions && h('p', { class: 'instr' }, h('b', {}, 'Short notes: '), a.instructions),
    a.unit_note && h('p', { class: 'instr unitnote' }, h('b', {}, `${a.unit || 'Consultant'} round: `), a.unit_note),
    a.ot_overs && h('p', { class: 'instr overs' }, h('b', {}, 'OT Overs: '), a.ot_overs),
    a.ot_findings && h('p', { class: 'instr findings' }, h('b', {}, 'OT Findings: '), a.ot_findings),
    (findings || (a.round && a.round.remarks)) && h('div', { class: 'today' },
      h('span', { class: 'muted small' }, `Today's round · ${a.round.filled_by || ''} ${a.round.filled_at.slice(11, 16)}`),
      findings && h('p', {}, findings), a.round.remarks && h('p', {}, h('b', {}, 'Remarks: '), a.round.remarks)),
    !canEdit() && !isViewer() && a.unit && h('div', { class: 'foot' },
      h('div', { class: 'btns' },
        h('a', { class: 'button ghost small', href: '#notes/' + encodeURIComponent(a.unit), onclick: () => document.getElementById('modal-root').replaceChildren() }, `${a.unit} round notes`),
        h('button', { class: 'ghost small', onclick: () => addToOtModal(a) }, 'Add to OT list'))),
    canEdit() && h('div', { class: 'foot' },
      h('div', { class: 'btns' },
        h('a', { class: 'button ghost small', href: (isIcu(a.bed_on_date || a.bed) ? '#icurounds/' : '#rounds/') + encodeURIComponent(a.id), onclick: () => document.getElementById('modal-root').replaceChildren() }, 'Go to Rounds'),
        h('button', { class: 'ghost small', onclick: () => addToOtModal(a) }, 'Add to OT list'),
        h('button', { class: 'ghost small', onclick: () => transferModal(a) }, 'Move bed'),
        h('button', { class: 'ghost small', onclick: () => dischargeModal(a) }, 'Discharge'))));
}

function confirmLeave() {
  return !S.dirty.size || confirm('Some round entries are not saved. Leave without saving?');
}

// ---------- Modals: admit / edit, transfer, discharge ----------

function modal(title, body, onSubmit, submitLabel = 'Save') {
  const root = document.getElementById('modal-root');
  const err = h('p', { class: 'error' });
  const close = () => root.replaceChildren();
  const form = h('form', { class: 'modal card', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    try { if ((await onSubmit(form, err)) !== false) close(); } catch (x) { err.textContent = x.message; }
  } },
  h('div', { class: 'mhead' }, h('h2', {}, title), h('button', { type: 'button', class: 'ghost small', onclick: close }, 'Close')),
  body, err,
  h('div', { class: 'mfoot' }, h('button', { type: 'button', class: 'ghost', onclick: close }, 'Cancel'), h('button', { class: 'primary', type: 'submit' }, submitLabel)));
  root.replaceChildren(h('div', { class: 'backdrop', onclick: (e) => e.target === e.currentTarget && close() }, form));
  const first = form.querySelector('input, select, textarea');
  if (first) first.focus();
  return form;
}

function bedSelect(name, selected, filter = () => true) {
  return h('select', { name, required: true },
    h('option', { value: '' }, 'Choose bed'),
    S.meta.sections.map((s) => ({ ...s, beds: s.beds.filter(filter) })).filter((s) => s.beds.length)
      .map((s) => h('optgroup', { label: s.name }, s.beds.map((b) => h('option', { value: b, selected: b === selected }, b)))));
}

// Extra round fields for one patient: a name and what kind of entry (ml, cm, Yes / No…). Add as many as needed.
const EXTRA_KINDS = [['ml', 'Amount (ml)'], ['cm', 'Measure (cm)'], ['ml/kg/hr', 'Rate (ml/kg/hr)'], ['number', 'Number'], ['yesno', 'Yes / No'], ['text', 'Text']];
function extraEditor(extras) {
  const list = h('div', { class: 'xlist' });
  const addRow = (e = { label: '', type: 'number', unit: 'ml' }) => {
    const kind = e.type === 'number' ? (e.unit || 'number') : e.type;
    const kinds = EXTRA_KINDS.some(([k]) => k === kind) ? EXTRA_KINDS : [...EXTRA_KINDS, [kind, `Amount (${kind})`]];
    const row = h('div', { class: 'xrow' },
      h('input', { class: 'xlabel', value: e.label, placeholder: 'e.g. Gastrostomy output', 'aria-label': 'Field name' }),
      h('select', { class: 'xtype', 'aria-label': 'Kind of entry' }, kinds.map(([k, v]) => h('option', { value: k, selected: k === kind }, v))),
      h('button', { type: 'button', class: 'ghost small', onclick: () => row.remove() }, 'Remove'));
    list.append(row);
    return row;
  };
  extras.forEach(addRow);
  return h('fieldset', { class: 'span2 extras' }, h('legend', {}, 'Extra fields for this patient'),
    list,
    h('button', { type: 'button', class: 'ghost small', onclick: () => addRow().querySelector('input').focus() }, '+ Add a field'));
}

function admitModal(bed, a, opts = {}) {
  const editing = !!a;
  a = a || { monitor: [], admit_date: S.date, ...(opts.prefill || {}) };
  const icu = editing ? isIcu(a.bed) : bed ? isIcu(bed) : !!opts.icu;
  const input = (label, name, attrs = {}, cls) => h('label', { class: cls }, label, h('input', { name, value: a[name] || '', ...attrs }));
  const sexSel = h('label', {}, 'Sex', h('select', { name: 'sex' }, ['', 'M', 'F', 'Other'].map((s) => h('option', { value: s, selected: s === (a.sex || '') }, s || '—'))));

  // Round fields for this patient, chosen by the Ward SR from Rounds > Edit details / fields.
  let chooser = null;
  if (editing) {
    const group = icu ? 'icu' : 'ward';
    const chosen = monitorFor(a);
    const gp = S.meta.params.filter((p) => p.group === group && (p.active || chosen.includes(p.key)));
    const tick = (p) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'monitor', value: p.key, checked: chosen.includes(p.key) }), p.label + (p.unit ? ` (${p.unit})` : ''));
    chooser = [
      h('fieldset', { class: 'span2 monitor' }, h('legend', {}, 'Yes / No checks on the round'), gp.filter((p) => p.type === 'yesno').map(tick)),
      h('fieldset', { class: 'span2 monitor' }, h('legend', {}, 'Values to fill in'), gp.filter((p) => p.type !== 'yesno').map(tick)),
      extraEditor(extrasOf(a)),
    ];
  }

  // A UHID seen before (earlier admission or an OT list) fills the empty boxes; nothing typed is overwritten.
  const uhidNote = h('small', { class: 'muted' });
  const uhidPrefill = async (form) => {
    const u = form.ip_no.value.trim();
    if (!u) return;
    const r = await api('GET', `/api/uhid/${encodeURIComponent(u)}?date=${form.admit_date.value || S.date}`).catch(() => ({}));
    if (!r || !r.name) { uhidNote.textContent = 'New UHID.'; return; }
    const set = (n, val) => { const el = form.elements.namedItem(n); if (el && val && !el.value.trim()) el.value = val; };
    set('name', r.name); set('age', r.age); set('sex', r.sex); set('diagnosis', r.diagnosis);
    const first = (r.consultant || '').split('/')[0].trim();
    const ini = (SURGEONS.find(([i, n]) => n === first || i === first) || [])[0];
    if (ini && S.meta.units.some((x) => x.name === ini)) set('unit', ini);
    uhidNote.textContent = r.bed ? `${r.name} is already admitted in ${r.bed}.` : `Found ${r.name}: details filled in. Check them.`;
    uhidNote.className = r.bed ? 'warntext small' : 'muted small';
  };

  const body = h('div', { class: 'grid2' },
    editing ? h('label', {}, 'Bed', h('input', { value: a.bed, disabled: true })) : h('label', {}, 'Bed', bedSelect('bed', bed, (b) => isIcu(b) === icu)),
    input('Admission date', 'admit_date', { type: 'date' }),
    input('Patient name / initials', 'name', { required: true }, 'span2'),
    editing ? input('UHID', 'ip_no') : h('label', {}, 'UHID', h('input', { name: 'ip_no', value: a.ip_no || '', inputmode: 'numeric', autocomplete: 'off',
      onchange: (ev) => uhidPrefill(ev.target.form), onkeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); uhidPrefill(ev.target.form); } } }), uhidNote),
    h('label', {}, 'Consultant / unit', h('select', { name: 'unit' }, h('option', { value: '' }, '—'),
      [...S.meta.units.map((u) => u.name), ...(a.unit && !S.meta.units.some((u) => u.name === a.unit) ? [a.unit] : [])]
        .map((u) => h('option', { value: u, selected: u === a.unit }, u)))),
    icu ? [
      input('Date of birth (age in days is worked out from this)', 'dob', { type: 'date', max: S.meta.today }),
      sexSel,
      input('Birth weight (g)', 'birth_weight', { inputmode: 'decimal' }),
      input('Gestation (weeks + days)', 'gestation', { placeholder: 'e.g. 34+2' }),
      input('Current weight (g)', 'current_weight', { inputmode: 'decimal' }),
    ] : [
      input('Age', 'age', { placeholder: 'e.g. 3 y, 8 m, 12 d' }),
      sexSel,
      input('Weight (kg)', 'weight', { inputmode: 'decimal' }),
    ],
    input('Diagnosis', 'diagnosis', {}, 'span2'),
    input('Procedure done', 'procedure_done'),
    chooser,
    h('label', { class: 'span2' }, 'Short notes', h('textarea', { name: 'instructions', rows: 3 }, a.instructions || '')));

  modal(editing ? `Edit ${a.name}` : icu ? 'Admit baby to ICU' : 'Admit patient', body, async (form) => {
    const v = (n) => (form.elements.namedItem(n) ? form.elements.namedItem(n).value : '');
    const payload = {
      bed: v('bed') || a.bed,
      name: v('name'), ip_no: v('ip_no'), unit: v('unit'), age: v('age'), sex: v('sex'), weight: v('weight'),
      dob: v('dob'), birth_weight: v('birth_weight'), gestation: v('gestation'), current_weight: v('current_weight'),
      diagnosis: v('diagnosis'), procedure_done: v('procedure_done'),
      admit_date: v('admit_date'), instructions: v('instructions'),
    };
    if (editing) {
      payload.monitor = [...form.querySelectorAll('input[name=monitor]:checked')].map((c) => c.value);
      payload.extra_fields = [...form.querySelectorAll('.xrow')].map((r) => {
        const kind = r.querySelector('.xtype').value;
        return { label: r.querySelector('.xlabel').value.trim(), type: ['yesno', 'text'].includes(kind) ? kind : 'number', unit: ['yesno', 'text', 'number'].includes(kind) ? '' : kind };
      }).filter((e) => e.label);
      payload.fields_set = true;
    }
    if (editing) await api('PUT', '/api/admissions/' + a.id, payload);
    else {
      let res;
      try { res = await api('POST', '/api/admissions', payload); }
      catch (e) {
        if (e.status !== 409 || !confirm(e.message + '. Admit to the same bed anyway?')) throw e;
        res = await api('POST', '/api/admissions', { ...payload, force: true });
      }
      if (opts.onAdmitted) await opts.onAdmitted(res, payload);
    }
    toast(editing ? 'Patient updated' : 'Patient admitted');
    render();
  }, editing ? 'Save' : 'Admit');
}

function transferModal(a) {
  const body = h('div', { class: 'grid2' },
    h('p', { class: 'span2' }, `${a.name} is in ${a.bed}.`),
    h('label', {}, 'Move to bed', bedSelect('bed')),
    h('label', {}, 'Date', h('input', { type: 'date', name: 'date', value: S.date, required: true })));
  modal('Move to another bed', body, async (form) => {
    const payload = { bed: form.bed.value, date: form.date.value };
    try { await api('POST', `/api/admissions/${a.id}/transfer`, payload); toast('Bed changed'); }
    catch (e) {
      if (e.status !== 409) throw e;
      if (confirm(`${e.message}.\n\nOK = swap the two patients' beds\nCancel = more options`)) {
        await api('POST', `/api/admissions/${a.id}/transfer`, { ...payload, swap: true });
        toast('Beds swapped');
      } else if (confirm('Put both patients in the same bed?')) {
        await api('POST', `/api/admissions/${a.id}/transfer`, { ...payload, force: true });
        toast('Bed changed');
      } else return false;
    }
    render();
  }, 'Move');
}

function dischargeModal(a) {
  const body = h('div', { class: 'grid2' },
    h('p', { class: 'span2' }, `${a.name}, ${a.bed}`),
    h('label', {}, 'Date', h('input', { type: 'date', name: 'date', value: S.date, required: true })),
    h('label', {}, 'Outcome', h('select', { name: 'outcome' }, OUTCOMES.map((o) => h('option', { value: o }, o)))));
  modal('Discharge', body, async (form) => {
    const r = await api('POST', `/api/admissions/${a.id}/discharge`, { date: form.date.value, outcome: form.outcome.value });
    toast(r.shifted ? `Discharged. ${r.shifted} waiting bed shift${r.shifted === 1 ? '' : 's'} carried out.` : 'Discharged');
    render();
  }, 'Discharge');
}

function changePasswordModal() {
  const body = h('div', { class: 'grid1' },
    h('label', {}, 'Current password', h('input', { type: 'password', name: 'current', required: true })),
    h('label', {}, 'New password', h('input', { type: 'password', name: 'password', minlength: 6, required: true })),
    h('label', {}, 'Repeat new password', h('input', { type: 'password', name: 'password2', minlength: 6, required: true })));
  modal('Change your password', body, async (form, err) => {
    if (form.password.value !== form.password2.value) { err.textContent = 'The two passwords do not match'; return false; }
    await api('POST', '/api/me/password', { current: form.current.value, password: form.password.value });
    toast('Password changed');
  }).append(h('div', { class: 'device' },
    h('p', { class: 'muted small' }, 'Handing this device to someone outside the ward? Remove the ward data from it. Entries not yet synced will be lost.'),
    h('button', { type: 'button', class: 'ghost small danger', onclick: async () => {
      const waiting = Sync.status().waiting;
      if (!confirm(waiting ? `${waiting} changes have not been sent yet and will be lost. Remove all ward data from this device?` : 'Remove all ward data from this device? You can connect again later with the ward passcode.')) return;
      await Store.wipe();
      location.reload();
    } }, 'Remove ward data from this device')));
}

// ---------- Patient history ----------

async function patientView(main, id) {
  let a;
  try { a = await api('GET', '/api/admissions/' + id); } catch (e) { main.append(h('p', { class: 'error' }, e.message)); return; }
  const pm = paramMap();
  const keys = [...new Set([...monitorFor(a), ...extrasOf(a).map((e) => e.key), ...a.rounds.flatMap((r) => Object.keys(r.vals))])];
  const icu = isIcu(a.bed);
  const end = a.discharge_date || S.meta.today;
  const rows = [...new Set([...a.rounds.map((r) => r.date), ...a.notes.map((n) => n.date)])].sort()
    .map((d) => a.rounds.find((r) => r.date === d) || { date: d, vals: {}, remarks: '', filled_by: '' });
  main.append(
    h('div', { class: 'toolbar' },
      h('a', { href: isIcu(a.bed) ? '#icu' : '#register', class: 'button ghost' }, '‹ Register'),
      h('div', { class: 'actions' },
        canEdit() && canUndoDischarge(a) && h('button', { class: 'ghost', onclick: async () => {
          if (!confirm('Bring this patient back into the ward register?')) return;
          try { await api('POST', `/api/admissions/${a.id}/undo-discharge`); toast('Discharge undone'); render(); } catch (e) { toast(e.message, true); }
        } }, 'Undo discharge'),
        h('button', { class: 'ghost', onclick: () => window.print() }, 'Print'))),
    h('div', { class: 'card' },
      h('h2', {}, a.name, ' ', h('span', { class: 'muted' }, ageSex(a, end))),
      h('dl', { class: 'facts' },
        fact('Bed', a.bed), fact('UHID', a.ip_no), fact('Unit', a.unit), fact('Admitted', fmtDate(a.admit_date)),
        fact('Diagnosis', a.diagnosis), fact('Procedure', a.procedure_done), fact('Surgery dates', [a.surgery_date, a.surgery_date2, a.surgery_date3].filter(Boolean).map(fmtDate).join(', ')),
        fact('Discharged', a.discharge_date && `${fmtDate(a.discharge_date)} (${a.outcome})`),
        a.admit_date && fact('Stay', `${daysBetween(a.admit_date, end) + 1} days`),
        fact('Bed moves', a.moves.map((m) => `${m.from_bed} → ${m.to_bed} on ${fmtDate(m.move_date)}`).join('; ')),
        icu && fact('Date of birth', fmtDate(a.dob)), icu && fact('Birth weight', a.birth_weight && `${a.birth_weight} g`),
        icu && fact('Gestation', a.gestation && `${a.gestation} wk`), icu && fact('Current weight', a.current_weight && `${a.current_weight} g`),
        !icu && fact('Weight', a.weight && `${a.weight} kg`),
        fact('Short notes', a.instructions)),
      canEdit() && !a.discharge_date && h('button', { class: 'ghost small', onclick: () => admitModal(null, a) }, 'Edit details')),
    a.ot.length ? [h('h3', {}, 'OT findings & instructions'), h('div', { class: 'card ot' }, otList(a.ot, () => render()))] : null,
    h('h3', {}, 'Daily rounds'),
    rows.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'hist' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Date'), a.surgery_date && h('th', {}, 'POD'), keys.map((k) => h('th', {}, fieldLabel(k) + (unitOf(k, a) ? ` (${unitOf(k, a)})` : ''))), h('th', {}, 'Remarks'), h('th', {}, `${a.unit || 'Consultant'} notes`), h('th', {}, 'By'))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', {}, fmtDate(r.date)),
        a.surgery_date && h('td', {}, podText(a, r.date).replace('POD ', '')),
        keys.map((k) => h('td', {}, r.vals[k] || '')),
        h('td', {}, r.remarks), h('td', {}, (a.notes.find((n) => n.date === r.date) || {}).note || ''), h('td', { class: 'muted' }, r.filled_by)))))) : h('p', { class: 'muted' }, 'No round entries yet.'));
}
function fact(label, value) { return value ? [h('dt', {}, label), h('dd', {}, value)] : null; }

// ---------- Status: everyone's round entries for the day, 6B then 6A then 6C ----------

async function statusView(main) {
  const date = S.date;
  const go = (d) => { S.date = d; render(); };
  main.append(
    h('div', { class: 'toolbar' },
      h('div', { class: 'datenav' },
        h('button', { class: 'ghost', onclick: () => go(addDays(date, -1)), 'aria-label': 'Previous day' }, '‹'),
        h('input', { type: 'date', value: date, onchange: (e) => e.target.value && go(e.target.value) }),
        h('button', { class: 'ghost', onclick: () => go(addDays(date, 1)), 'aria-label': 'Next day' }, '›'),
        date !== S.meta.today && h('button', { class: 'ghost small', onclick: () => go(S.meta.today) }, 'Today')),
      h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: () => {
        // The Rounds dropdown is what prints; open it for the print, then put it back.
        const was = roundsDrop.open; roundsDrop.open = true; window.print(); roundsDrop.open = was;
      } }, 'Print'))),
    h('h2', { class: 'daytitle' }, 'Status · ', fmtDay(date)));
  // Everything on Status is a dropdown, closed until tapped; the open ones stay open while you move around the app.
  S.statusOpen = S.statusOpen || {};
  const drop = (key, title, ...kids) => { const d = h('details', { class: 'statusdrop' + (key === 'rounds' ? '' : ' noprint'), ontoggle: () => { S.statusOpen[key] = d.open; } }, h('summary', {}, title), ...kids); d.open = !!S.statusOpen[key]; return d; };
  const box = h('div', { class: 'register' }, h('p', { class: 'loading' }, 'Loading…'));
  const wardBox = h('div', {}, h('p', { class: 'loading' }, 'Loading…'));
  const wardTitleEl = h('span', {}, 'Current ward list');
  const roundsTitleEl = h('span', {}, 'Rounds');
  const wardDrop = drop('ward', wardTitleEl, wardBox);
  const roundsDrop = drop('rounds', roundsTitleEl, box);
  main.append(wardDrop, roundsDrop);
  const data = await api('GET', '/api/register?date=' + date);
  const order = S.meta.sections.flatMap((s) => s.beds);
  const pts = data.admissions.filter((a) => a.discharge_date !== date).sort((x, y) => order.indexOf(x.bed_on_date) - order.indexOf(y.bed_on_date));
  const filled = pts.filter((a) => a.round).length;
  wardTitleEl.textContent = `Current ward list · ${pts.length}`;
  roundsTitleEl.textContent = `Rounds · filled for ${filled} of ${pts.length}`;
  // The patients in the ward on this date, by bed: a quick list without the round details.
  wardBox.replaceChildren(pts.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'list wardlist' },
    h('thead', {}, h('tr', {}, ['Bed', 'Patient', 'UHID', 'Age / Sex', 'Consultant', 'Diagnosis', 'POD · Day'].map((t) => h('th', {}, t)))),
    h('tbody', {}, pts.map((a) => h('tr', {}, h('td', {}, h('span', { class: 'bedno' }, a.bed_on_date)), h('td', {}, h('a', { href: '#patient/' + a.id, class: 'pname' }, a.name)),
      h('td', {}, a.ip_no || ''), h('td', {}, ageSex(a, date)), h('td', {}, a.unit || ''), h('td', {}, a.diagnosis || ''),
      h('td', {}, [podText(a, date), dayNo(a, date) && `Day ${dayNo(a, date)}`].filter(Boolean).join(' · '))))))) : h('p', { class: 'muted' }, 'No patients on this date.'));
  box.replaceChildren(h('p', { class: 'muted' }, `Round entries filled for ${filled} of ${pts.length} patients. Click a name for their full record.`));
  // Same layout as the printed register: every section in bed order, with the morning round and short notes.
  const byBed = {};
  for (const a of pts) (byBed[a.bed_on_date] = byBed[a.bed_on_date] || []).push(a);
  for (const sec of wardBeds()) {
    if (!sec.beds.some((b) => byBed[b])) continue;
    box.append(h('section', { class: 'printsec' }, h('h3', {}, wardTitle(sec.ward)), h('div', { class: 'tablewrap' }, h('table', { class: 'list status print' },
      h('thead', {}, h('tr', {}, ['Bed', 'Patient', 'Consultant', 'Diagnosis / Surgery', 'POD · Day', 'Morning round', 'Remarks'].map((t) => h('th', {}, t)))),
      h('tbody', {}, sec.beds.flatMap((bed) => (byBed[bed] || []).flatMap((a) => [h('tr', { class: notesRow(a, 7) ? 'hasnotes' : '' },
        h('td', {}, h('span', { class: 'bedno' }, bed)),
        h('td', {}, h('a', { href: '#patient/' + a.id, class: 'pname' }, a.name), h('div', { class: 'muted small' }, ageSex(a, date))),
        h('td', {}, a.unit),
        h('td', {}, a.diagnosis, a.procedure_done ? h('div', { class: 'muted small' }, a.procedure_done) : null),
        h('td', {}, [podText(a, date), dayNo(a, date) && `Day ${dayNo(a, date)}`].filter(Boolean).join(' · ')),
        h('td', {}, a.round ? summariseVals(a.round.vals, monitorFor(a), a).split(' · ').filter(Boolean).map((t) => h('div', {}, t)) : h('span', { class: 'muted' }, 'Not filled yet')),
        h('td', {}, a.round ? a.round.remarks || '' : '')), notesRow(a, 7)])))))));
  }
  if (!pts.length) box.append(h('p', { class: 'muted empty-note' }, 'No patients on this date.'));
  // Discharged by mistake? The last week's discharges, each with Undo (back into the same bed).
  if (canEdit()) {
    const recent = (await api('GET', '/api/patients?from=' + addDays(S.meta.today, -7))).filter((a) => a.discharge_date)
      .sort((x, y) => (x.discharge_date < y.discharge_date ? 1 : -1));
    main.append(drop('discharges', `Recent discharges · ${recent.length}`, h('section', { class: 'noprint undodis' },
      h('p', { class: 'muted small' }, 'Discharged in the last 7 days. Undo brings the patient back into the same bed, and works for 24 hours after the discharge.'),
      recent.length ? h('ul', { class: 'invlist' }, recent.map((a) => h('li', {},
        h('b', {}, fmtDate(a.discharge_date)), ` · ${a.bed} · `, h('a', { href: '#patient/' + a.id }, a.name), a.diagnosis ? h('span', { class: 'muted small' }, ` · ${a.diagnosis}`) : null,
        a.outcome && a.outcome !== 'Discharged' ? h('span', { class: 'small outcome-bad' }, ` · ${a.outcome}`) : null,
        canUndoDischarge(a) ? h('button', { type: 'button', class: 'ghost small undo', onclick: async () => {
          if (!confirm(`Undo the discharge of ${a.name} and bring them back into ${a.bed}?`)) return;
          try { await api('POST', `/api/admissions/${a.id}/undo-discharge`); toast(`${a.name} is back in ${a.bed}`); render(); } catch (e) { toast(e.message, true); }
        } }, 'Undo discharge') : ''))) : h('p', { class: 'muted' }, 'No discharges in the last 7 days.'))));
  }
  const search = h('section', { class: 'noprint' });
  main.append(drop('find', 'Find any patient, including discharged', search));
  patientSearch(search);
  const arch = h('section', { class: 'noprint' }, h('p', { class: 'muted small' }, 'Patients discharged more than a year ago and archived by the admin. Needs internet.'));
  main.append(drop('archive', 'Search the archive', arch));
  archiveSearch(arch);
}

function archiveSearch(box) {
  const out = h('div', { class: 'archout' });
  const q = h('input', { type: 'search', placeholder: 'Name, UHID or diagnosis', onkeydown: (ev) => { if (ev.key === 'Enter') run(); } });
  const run = async () => {
    const t = q.value.trim().toLowerCase();
    if (t.length < 2) return;
    out.replaceChildren(h('p', { class: 'muted' }, 'Fetching the archive…'));
    let recs;
    try { recs = await Sync.readArchive(); } catch (e) { out.replaceChildren(h('p', { class: 'error' }, e.message)); return; }
    const of = (type) => recs.filter((r) => r.type === type && r.data).map((r) => ({ id: r.id, ...r.data }));
    const adms = of('admission').filter((a) => [a.name, a.ip_no, a.diagnosis].some((x) => (x || '').toLowerCase().includes(t)));
    const rounds = of('round'), ots = of('ot');
    out.replaceChildren(adms.length ? h('div', { class: 'otcards' }, adms.map((a) => {
      const ar = rounds.filter((r) => r.admission_id === a.id).sort((x, y) => (x.date < y.date ? -1 : 1));
      const ao = ots.filter((o) => o.admission_id === a.id).sort((x, y) => (x.at < y.at ? -1 : 1));
      return h('div', { class: 'card' },
        h('b', { class: 'big' }, a.name), h('div', { class: 'muted small' }, [a.ip_no && `UHID ${a.ip_no}`, ageSex(a, a.discharge_date || S.meta.today), a.unit, a.bed].filter(Boolean).join(' · ')),
        h('dl', { class: 'otfacts' },
          fact('Admitted', a.admit_date && fmtDate(a.admit_date)), fact('Discharged', a.discharge_date && `${fmtDate(a.discharge_date)}${a.outcome ? ` (${a.outcome})` : ''}`),
          fact('Diagnosis', a.diagnosis), fact('Procedure', a.procedure_done),
          fact('Surgery dates', [a.surgery_date, a.surgery_date2, a.surgery_date3].filter(Boolean).map(fmtDate).join(', ')), fact('Short notes', a.instructions)),
        (ar.length || ao.length) ? h('details', {}, h('summary', {}, `OT findings (${ao.length}) and rounds (${ar.length})`),
          ao.map((o) => h('p', { class: 'small' }, h('b', {}, fmtDate(o.at.slice(0, 10)) + ': '), o.text)),
          ar.map((r) => h('p', { class: 'small' }, h('b', {}, fmtDate(r.date) + ': '), summariseVals(r.vals, monitorFor(a), a), r.remarks ? ` · ${r.remarks}` : ''))) : null);
    })) : h('p', { class: 'muted' }, 'No one in the archive matches.'));
  };
  box.append(h('div', { class: 'saddrow' }, q, h('button', { class: 'ghost', onclick: run }, 'Search')), out);
}

// ---------- Patients list (search / discharged) ----------

function patientSearch(main) {
  const q = h('input', { type: 'search', placeholder: 'Name, UHID, diagnosis or bed' });
  const from = h('input', { type: 'date' });
  const to = h('input', { type: 'date' });
  const out = h('div', {});
  const run = async () => {
    const rows = await api('GET', `/api/patients?q=${encodeURIComponent(q.value)}&from=${from.value}&to=${to.value}`);
    out.replaceChildren(rows.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, ['Name', 'UHID', 'Bed', 'Diagnosis', 'Admitted', 'Discharged'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((r) => h('tr', { onclick: () => (location.hash = 'patient/' + r.id), class: 'clickable' },
        h('td', {}, h('a', { href: '#patient/' + r.id }, r.name)), h('td', {}, r.ip_no), h('td', {}, r.bed), h('td', {}, r.diagnosis),
        h('td', {}, fmtDate(r.admit_date)), h('td', {}, r.discharge_date ? `${fmtDate(r.discharge_date)} · ${r.outcome}` : h('span', { class: 'badge new' }, 'In ward'))))))) :
      h('p', { class: 'muted' }, 'No patients found.'));
  };
  main.append(
    h('form', { class: 'toolbar', onsubmit: (e) => { e.preventDefault(); run(); } },
      q, h('label', { class: 'inline' }, 'In ward between ', from), h('label', { class: 'inline' }, 'and ', to), h('button', { class: 'primary' }, 'Search')),
    out);
  run();
}

// ---------- Printable daily register ----------

// ward = '6B', '6A' or '6C' to print just that ward; blank prints everything.
async function printView(main, date, ward) {
  const icuWard = !!ward && (S.meta.icuBeds || []).some((b) => wardOf(b) === ward);
  const data = await api('GET', '/api/register?date=' + date);
  const byBed = {};
  // Patients discharged on this day have left the bed, as on the register.
  for (const a of data.admissions.filter((x) => x.discharge_date !== date)) (byBed[a.bed_on_date] = byBed[a.bed_on_date] || []).push(a);
  main.append(
    h('div', { class: 'toolbar noprint' }, h('a', { href: icuWard ? '#icu' : '#register', class: 'button ghost' }, icuWard ? '‹ ICU Register' : '‹ Ward Register'), h('button', { class: 'primary', onclick: () => window.print() }, 'Print')),
    h('h2', {}, ward ? `${ward} · ` : '', icuWard ? 'ICU register · ' : 'Ward register · ', fmtDay(date)),
    ...wardBeds(ward).map(({ ward: w, beds }) => h('section', { class: 'printsec' }, ward ? null : h('h3', {}, wardTitle(w)),
      h('table', { class: 'print' },
        h('thead', {}, h('tr', {}, ['Bed', 'Patient', 'Unit', 'Diagnosis / procedure', 'POD', 'Morning round', 'Remarks'].map((t) => h('th', {}, t)))),
        h('tbody', {}, beds.map((bed) => {
          const here = byBed[bed] || [];
          if (!here.length) return h('tr', { class: 'emptyrow' }, h('td', {}, bed), h('td', { colspan: 6 }, ''));
          return here.map((a) => [h('tr', { class: notesRow(a, 7) ? 'hasnotes' : '' },
            h('td', {}, bed),
            h('td', {}, h('b', {}, a.name), h('br'), ageSex(a, date), a.ip_no ? ` · ${a.ip_no}` : ''),
            h('td', {}, a.unit),
            h('td', {}, a.diagnosis, a.procedure_done ? h('div', { class: 'muted' }, a.procedure_done) : null),
            h('td', {}, podText(a, date).replace('POD ', '')),
            h('td', {}, a.round ? summariseVals(a.round.vals, monitorFor(a), a) : ''),
            h('td', {}, a.round ? a.round.remarks || '' : '')), notesRow(a, 7)]);
        }))))));
}
// Beds grouped by ward only (6B, 6A…), in bed order: the print has no sub-headings such as Post-Op or Chemo cubicle.
function wardBeds(only) {
  const beds = S.meta.sections.flatMap((x) => x.beds).filter((b) => !only || wardOf(b) === only);
  return [...new Set(beds.map(wardOf))].map((w) => ({ ward: w, beds: beds.filter((b) => wardOf(b) === w) }));
}
// Short notes (and the consultant's round note) as one strip under the patient, across every column.
function notesRow(a, cols) {
  const procs = (a.otprocs || []).filter((x) => x.scrub.length);
  if (!a.instructions && !a.unit_note && !procs.length && !a.ot_overs) return null;
  return h('tr', { class: 'notesrow' }, h('td', { colspan: cols },
    procs.length ? h('div', { class: 'otnotes' }, h('b', {}, 'OT: '),
      procs.map((x) => h('span', {}, `${fmtDate(x.date)} ${otName(x.ot)}: ${x.done || ''}${x.scrub.length ? ` (${x.scrub.join('/')})` : ''}. `))) : null,
    a.ot_overs ? h('div', { class: 'otnotes' }, h('b', {}, 'OT Overs: '), a.ot_overs) : null,
    a.instructions ? [h('b', {}, 'Short notes: '), a.instructions] : null,
    a.unit_note ? h('span', { class: 'unote' }, h('b', {}, `${a.unit || 'Consultant'}: `), a.unit_note) : null));
}

// ---------- OT lists: OT 11 to 16, one list per OT per day ----------

const OT_ROOMS = [['11', 'Routine'], ['12', 'Routine'], ['13', ''], ['14', ''], ['15', ''], ['16', 'Emergency']];
// OTs the admin has blocked (not running yet): their old lists stay, but no new list can be made there.
const otBlocked = (ot) => ((S.meta && S.meta.otBlocked) || []).includes(ot);
const BLOCK_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>';
const DAY_CARE = 'MCH2/PAR';
const otName = (ot) => `OT ${ot}`;
const bedLabel = (bed) => (!bed ? 'Bed not yet allotted' : bed.toUpperCase() === DAY_CARE ? 'Day care (MCH2/PAR)' : bed);
const wardCol = (bed) => (!bed ? '' : /^MCH/i.test(bed) ? bed.toUpperCase() : 'MCH ' + bed);
// Surgeons as printed on OT lists: always the formal name, never initials ("SN" is Dr Sachit Anand's unit in the ward).
const SURGEONS = [['VJ', 'Dr Vishesh Jain'], ['SA', 'Dr Sandeep Agarwala'], ['AD', 'Dr Anjan Dhua'], ['DKY', 'Dr Devendra K Yadav'], ['PG', 'Dr Prabudh Goel'], ['AV', 'Dr Ajay Verma'], ['GD', 'Dr G Divya'], ['SN', 'Dr Sachit Anand']];
const squash = (x) => x.toLowerCase().replace(/[^a-z]/g, '');
const fullName = (x) => { const t = (x || '').trim(); const hit = t && SURGEONS.find(([i, n]) => i === t.toUpperCase() || squash(n) === squash(t)); return hit ? hit[1] : t; };
const fullNames = (x) => (x || '').split('/').map(fullName).filter(Boolean).join('/');
// A dropdown of the surgeons; a name typed in earlier that is not on the list is kept as its own choice.
const surgeonSelect = (val, blank, extra = [], attrs = {}) => {
  const names = [...extra, ...SURGEONS.map(([, n]) => n)].filter((n, i, a) => a.indexOf(n) === i);
  if (val && !names.includes(val)) names.push(val);
  return h('select', attrs, h('option', { value: '' }, blank), names.map((n) => h('option', { value: n, selected: n === val }, n)));
};
const stampText = (t) => (t ? `${fmtDate(t.slice(0, 10))}, ${t.slice(11, 16)}` : '');
// The OT list as a landscape A4 picture, laid out like the printout, to circulate on WhatsApp.
// Drawn straight onto a canvas so it works offline and the same on every phone.
async function saveOtJpg(l, rows, extraNote) {
  const W = 1754, M = 70, FONT = 'Arial, Helvetica, sans-serif';
  const cols = [['SL NO', 4], ['WARD', 8], ['NAME', 12], ['AGE/SEX', 8], ['UHID', 9], ['DIAGNOSIS', 14], ['SURGERY', 15], ['CONSULTANT', 11], ['BLOOD ARRANGE', 9], ['SPECIAL REQ', 10]];
  const total = cols.reduce((n, c) => n + c[1], 0), tw = W - 2 * M;
  const widths = cols.map((c) => Math.round((c[1] / total) * tw));
  const cells = rows.map((e, i) => [String(i + 1), wardCol(e.bed), (e.name || '').toUpperCase(), [e.age, e.sex].filter(Boolean).join('/'), e.uhid || '',
    e.diagnosis || '', e.surgery || '', fullNames(e.consultant), e.blood || '', e.special || '']);
  const cv = document.createElement('canvas'), g = cv.getContext('2d');
  const wrap = (text, width, font) => {
    g.font = font; const out = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const t = line ? line + ' ' + word : word;
        if (g.measureText(t).width <= width) { line = t; continue; }
        if (line) out.push(line);
        line = word;
        while (g.measureText(line).width > width && line.length > 1) { let k = line.length; while (k > 1 && g.measureText(line.slice(0, k)).width > width) k--; out.push(line.slice(0, k)); line = line.slice(k); }
      }
      out.push(line);
    }
    return out;
  };
  const BODY = `22px ${FONT}`, HEAD = `bold 19px ${FONT}`, LH = 28, PAD = 10;
  const heads = cols.map((c, j) => wrap(c[0], widths[j] - 2 * PAD, HEAD));
  const headH = Math.max(...heads.map((x) => x.length)) * LH + 2 * PAD;
  const lines = cells.map((row) => row.map((t, j) => wrap(t, widths[j] - 2 * PAD, BODY)));
  const rowH = lines.map((row) => Math.max(1, ...row.map((x) => x.length)) * LH + 2 * PAD);
  const titles = [[`bold 30px ${FONT}`, 'Department of Pediatric Surgery, MCH Block'], [`28px ${FONT}`, `${l.kind || 'Routine'} OT List - `, otName(l.ot)], [`26px ${FONT}`, `(${shortDate(l.date)})`]];
  if (l.surgeon) titles.push([`bold 26px ${FONT}`, fullNames(l.surgeon).toUpperCase()]);
  titles.push([`bold 26px ${FONT}`, 'KEEP OT WARM']);
  if (extraNote) titles.push([`bold 26px ${FONT}`, extraNote.toUpperCase()]);
  const top = M + titles.length * 42 + 16;
  const tableH = headH + rowH.reduce((a, b) => a + b, 0);
  cv.width = W; cv.height = Math.max(1240, top + tableH + 150);
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#000'; g.strokeStyle = '#000'; g.lineWidth = 2; g.textBaseline = 'top';
  let y = M;
  for (const [font, text, bold] of titles) {
    g.font = font; const a = g.measureText(text).width;
    const bf = font.startsWith('bold') ? font : 'bold ' + font, b = bold ? (g.font = bf, g.measureText(bold).width) : 0;
    let x = (W - a - b) / 2; g.font = font; g.textAlign = 'left'; g.fillText(text, x, y);
    if (bold) { g.font = bf; g.fillText(bold, x + a, y); }
    y += 42;
  }
  y = top;
  const drawRow = (row, h, font) => {
    let x = M;
    row.forEach((ls, j) => { g.strokeRect(x, y, widths[j], h); g.font = font; g.textAlign = 'center';
      ls.forEach((t, k) => g.fillText(t, x + widths[j] / 2, y + PAD + k * LH + 3)); x += widths[j]; });
    y += h;
  };
  drawRow(heads, headH, HEAD);
  lines.forEach((row, i) => drawRow(row, rowH[i], BODY));
  y += 70; g.font = `bold 24px ${FONT}`; g.textAlign = 'left'; g.fillText(`DATE: ${fmtDate(S.meta.today)}`, M + 60, y);
  g.textAlign = 'right'; g.fillText('SIGNATURE', W - M - 60, y);
  const blob = await new Promise((ok) => cv.toBlob(ok, 'image/jpeg', 0.92));
  const name = `${otName(l.ot).replace(/\s+/g, '')}_${l.kind || 'Routine'}_${l.date}.jpg`;
  const file = new File([blob], name, { type: 'image/jpeg' });
  // Phones: the share menu (Save to gallery, WhatsApp…). Laptops: straight to Downloads.
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob), a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Saved ' + name);
}
const shortDate = (d) => { const [y, m, day] = d.split('-'); return `${day}/${m}/${y.slice(2)}`; };
const listCard = (l, withOt = true) => h('a', { class: 'otcard', href: '#otlist/' + encodeURIComponent(l.id) },
  h('b', {}, withOt ? `${otName(l.ot)} · ` : '', fmtDay(l.date)),
  h('span', { class: 'muted small' }, [fullNames(l.surgeon), `${l.count} patient${l.count === 1 ? '' : 's'}`].filter(Boolean).join(' · ')));
// One list per line (an OT's own page); today's list gets a green box.
const listRow = (l) => h('a', { class: 'otlrow' + (l.date === S.meta.today ? ' today' : ''), href: '#otlist/' + encodeURIComponent(l.id) },
  h('b', {}, fmtDay(l.date)), h('span', { class: 'grow' }, fullNames(l.surgeon) || h('span', { class: 'muted' }, 'No surgeon set')),
  h('span', { class: 'muted small' }, `${l.count} patient${l.count === 1 ? '' : 's'}`));

async function otHomeView(main) {
  const today = S.meta.today;
  // Once per session: clear postings of a child who was operated on another list (see dropDuplicateEntries).
  if (canEdit() && !S.dedupeDone) { S.dedupeDone = true; try { await api('POST', '/api/otentries/dedupe'); } catch {} }
  const [lists, kinds] = await Promise.all([api('GET', '/api/otlists'), api('GET', '/api/otrooms')]);
  // The arrows step to the previous / next day that has OT lists; the day shown is kept while you move around the app.
  const day = S.otDay || today;
  const dates = [...new Set(lists.map((l) => l.date))].sort();
  const prev = dates.filter((d) => d < day).pop(), next = dates.find((d) => d > day);
  const goDay = (d) => { S.otDay = d === today ? null : d; render(); };
  const todays = lists.filter((l) => l.date === day).sort((x, y) => (x.ot < y.ot ? -1 : 1));
  const full = await Promise.all(todays.map((l) => api('GET', '/api/otlists/' + encodeURIComponent(l.id))));
  main.append(
    h('div', { class: 'toolbar' }, h('h2', {}, 'OT Lists'),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => createOtListModal() }, '+ Create list'), h('a', { class: 'button ghost', href: '#otlog' }, 'Logbook'))),
    // A blocked OT is a plain grey tile that does not open; the admin taps it to unblock.
    h('div', { class: 'otgrid' }, OT_ROOMS.map(([ot]) => otBlocked(ot)
      ? h('div', { class: 'otroom blocked', onclick: async () => {
        if (S.user.role !== 'admin' || !confirm(`Unblock ${otName(ot)}?`)) return;
        try { await api('PUT', '/api/otrooms/' + ot, { blocked: false }); S.meta = await api('GET', '/api/meta'); toast(`${otName(ot)} unblocked`); render(); } catch (e) { toast(e.message, true); }
      } }, h('b', {}, otName(ot)))
      : h('a', { class: 'otroom' + (kinds[ot] === 'Emergency' ? ' emerg' : ''), href: '#ot/' + ot }, h('b', {}, otName(ot))))),
    h('div', { class: 'otsearchrow' }, otSearchBox(), h('button', { type: 'button', class: 'link viewall', onclick: allOtListsPopup }, 'View all OT lists')),
    h('div', { class: 'otdaynav' },
      h('button', { type: 'button', class: 'ghost small', disabled: !prev, title: prev ? `Previous OT day: ${fmtDay(prev)}` : 'No earlier lists', 'aria-label': 'Previous OT day', onclick: () => goDay(prev) }, '‹'),
      h('h3', {}, day === today ? 'Today · ' : day < today ? 'Earlier · ' : 'Coming up · ', fmtDay(day)),
      h('button', { type: 'button', class: 'ghost small', disabled: !next, title: next ? `Next OT day: ${fmtDay(next)}` : 'No later lists', 'aria-label': 'Next OT day', onclick: () => goDay(next) }, '›'),
      day !== today && h('button', { type: 'button', class: 'ghost small', onclick: () => goDay(today) }, 'Back to today')),
    full.length ? h('div', { class: 'otdays' }, full.map(todayDrop)) : h('p', { class: 'muted' }, day === today ? 'No lists for today yet.' : 'No lists on this day.'));
}

// A pencil like the usual edit icon on websites.
const PENCIL_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const pencilLink = (href, title) => { const a = h('a', { class: 'pencil', href, title, 'aria-label': title }); a.innerHTML = PENCIL_SVG; return a; };
// Scrub team in a pop-up (tap the initials in order, Save team).
function scrubPopup(e, done, listDate) {
  const root = document.getElementById('modal-root');
  const doneIn = h('textarea', { rows: 2, placeholder: 'Procedure actually done' }, e.done || e.surgery || '');
  const close = () => root.replaceChildren();
  root.replaceChildren(h('div', { class: 'backdrop', onclick: (ev) => ev.target === ev.currentTarget && close() },
    h('div', { class: 'modal card panel' },
      h('div', { class: 'mhead' }, h('h2', {}, `Scrub team · ${e.name}`), h('div', { class: 'btns' }, h('button', { type: 'button', class: 'ghost small', onclick: close }, 'Close'))),
      // First: the procedure actually done (starts as the planned surgery). It goes to the Logbook, Rounds and the Ward Register.
      h('label', { class: 'field donefield' }, h('span', { class: 'flabel' }, 'Procedure done'), doneIn),
      scrubPicker(e.scrub, async (team) => {
        // A team saved after the OT day (e.g. two days later) is confirmed first: it sets that day as the surgery date.
        if (team.length && listDate && listDate < S.meta.today && !confirm(`This OT list was on ${fmtDay(listDate)}. Save the scrub team for that day? ${fmtDate(listDate)} becomes the surgery date (POD 0).`)) return;
        try { const res = await api('PUT', `/api/otentries/${encodeURIComponent(e.id)}/scrub`, { scrub: team, done: doneIn.value.trim() }); close(); toast((res.surgery ? postedText(res).replace('Posted', 'Scrub team saved') : 'Scrub team saved') + (res.removed ? ` · ${res.removed} duplicate posting removed` : '')); done(); } catch (x) { toast(x.message, true); }
      }),
      caseCancelForm(e, () => { close(); done(); }))));
}
// Not operated today: the patient stays on the list (greyed) for the record; no surgery date, not in anyone's logbook.
function caseCancelForm(e, done) {
  const reason = h('input', { placeholder: 'Reason (optional), e.g. URTI, no blood, OT time over' });
  return h('div', { class: 'casecancel' }, h('div', { class: 'slabel' }, 'Case cancelled?'),
    h('div', { class: 'otadd' }, reason, h('button', { type: 'button', class: 'ghost small danger', onclick: async () => {
      if (!confirm(`Mark ${e.name}'s case as cancelled (not operated)?`)) return;
      try { await api('PUT', `/api/otentries/${encodeURIComponent(e.id)}/casecancel`, { reason: reason.value }); toast('Marked case cancelled'); done(); } catch (x) { toast(x.message, true); }
    } }, 'Case cancelled')));
}
async function undoCaseCancel(e, done) {
  if (!confirm(`Undo "case cancelled" for ${e.name}?`)) return;
  try { await api('PUT', `/api/otentries/${encodeURIComponent(e.id)}/casecancel`, { undo: true }); toast('Case restored'); done(); } catch (x) { toast(x.message, true); }
}
const caseCancelText = (c) => `Case cancelled${c.reason ? `: ${c.reason}` : ''}${c.by ? ` · ${c.by}` : ''}`;
// Today's list of one OT, always open: one box with a row per patient, each with its scrub team; the pencil opens the list to edit.
// One patient row: name, bed, diagnosis / surgery, the scrub team button (today and earlier lists) and a pencil to the list.
function otRow(e, i, listId, date) {
  const listHref = '#otlist/' + encodeURIComponent(listId);
  return h('div', { class: 'otrow' + (e.case_cancelled || e.cancelled ? ' casecancelled' : '') }, h('div', { class: 'otrowmain' },
    h('div', { class: 'grow' },
      h('div', {}, h('b', {}, i == null ? e.name : `${i + 1}. ${e.name}`), e.uhid && i == null ? h('span', { class: 'muted small' }, ` · UHID ${e.uhid}`) : null, h('span', { class: 'muted small' }, ` · ${bedLabel(e.bed)}${[e.age, e.sex].filter(Boolean).length ? ' · ' + [e.age, e.sex].filter(Boolean).join(' / ') : ''}`)),
      h('div', { class: 'small' }, [e.diagnosis, e.done ? `Done: ${e.done}` : e.surgery].filter(Boolean).join(' · ') || h('span', { class: 'warntext' }, 'Surgery not filled yet')),
      e.case_cancelled ? h('div', { class: 'small cctag' }, caseCancelText(e.case_cancelled)) : null,
      e.cancelled && e.reposted_to ? h('div', { class: 'small cctag' }, `Shifted to ${otName(e.reposted_to.ot)}, ${fmtDay(e.reposted_to.date)}`) : null),
    h('div', { class: 'otrowbtns' },
      e.cancelled ? null
        : e.case_cancelled ? h('button', { type: 'button', class: 'ghost small', onclick: () => undoCaseCancel(e, render) }, 'Undo')
        : date <= S.meta.today ? h('button', { type: 'button', class: 'ottile small', onclick: () => scrubPopup(e, render, date) }, (e.scrub || []).length ? e.scrub.join('/') : '+ Add scrub team') : null,
      !e.cancelled && !e.case_cancelled ? oversBtn(e) : null,
      pencilLink(listHref + '/' + encodeURIComponent(e.id), `Edit ${e.name}`))));
}
function todayDrop(l) {
  const live = l.entries.filter((e) => !e.cancelled);
  const listHref = '#otlist/' + encodeURIComponent(l.id);
  const row = (e, i) => otRow(e, i, l.id, l.date);
  return h('div', { class: 'card otday' },
    h('div', { class: 'otdayhead' }, h('b', {}, otName(l.ot)), h('span', { class: 'muted small grow' }, ' · ' + [fullNames(l.surgeon), `${live.length} patient${live.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')),
      pencilLink(listHref, `Edit the ${otName(l.ot)} list`)),
    live.length ? h('div', { class: 'otrows' }, live.map(row)) : h('p', { class: 'muted small' }, 'No patients yet.'));
}

// Routine / Emergency for one day's list. Only the admin can change it.
function listKindSeg(l, reload) {
  const admin = S.user.role === 'admin', kind = l.kind || 'Routine';
  return h('div', { class: 'seg otkind' }, ['Routine', 'Emergency'].map((k) => h('button', { type: 'button', class: (k === kind ? 'on' : '') + (k === 'Emergency' ? ' em' : ''), disabled: !admin && k !== kind, title: admin ? '' : 'Only the admin can change this', onclick: async () => {
    if (k === kind || !admin) return;
    try { await api('PUT', `/api/otlists/${encodeURIComponent(l.id)}/kind`, { kind: k }); toast(`This list is now ${k}`); reload(); } catch (e) { toast(e.message, true); }
  } }, k)));
}

async function otDatesView(main, ot) {
  const today = S.meta.today;
  const [lists, kinds] = await Promise.all([api('GET', '/api/otlists?ot=' + encodeURIComponent(ot)), api('GET', '/api/otrooms')]);
  const seg = h('div', { class: 'seg otkind' });
  const admin = S.user.role === 'admin';
  const drawKind = (kind) => seg.replaceChildren(...['Routine', 'Emergency'].map((k) => h('button', { type: 'button', class: (k === kind ? 'on' : '') + (k === 'Emergency' ? ' em' : ''), disabled: !admin && k !== kind, title: admin ? '' : 'Only the admin can change this', onclick: async () => {
    if (k === kind || !admin) return;
    try { await api('PUT', '/api/otrooms/' + ot, { kind: k }); drawKind(k); toast(`${otName(ot)} marked ${k}. Today's and later lists follow.`); } catch (e) { toast(e.message, true); }
  } }, k)));
  drawKind(kinds[ot] || 'Routine');
  const up = lists.filter((l) => l.date >= today).sort((x, y) => (x.date < y.date ? -1 : 1));
  const blocked = otBlocked(ot);
  // Admin: block / unblock this OT. Lists already made for today or later can first be shifted to another OT.
  const blockBox = h('div', { class: 'card blockbox' });
  const setBlocked = async (v) => {
    try { await api('PUT', '/api/otrooms/' + ot, { blocked: v }); S.meta = await api('GET', '/api/meta'); toast(`${otName(ot)} ${v ? 'blocked' : 'unblocked'}`); render(); } catch (e) { toast(e.message, true); }
  };
  const askBlock = () => {
    if (!up.length) { if (confirm(`Block ${otName(ot)}? No new lists can be made for it until you unblock it. Earlier lists stay.`)) setBlocked(true); return; }
    const targets = OT_ROOMS.map(([o]) => o).filter((o) => o !== ot && !otBlocked(o));
    blockBox.hidden = false;
    blockBox.replaceChildren(
      h('p', {}, h('b', {}, `${otName(ot)} has ${up.length} list${up.length === 1 ? '' : 's'} from today on: `), up.map((l) => fmtDay(l.date)).join(', '), '. Shift them to another OT before blocking? Each goes to the same day; if that OT already has a list that day, the patients join it.'),
      h('div', { class: 'btns wrap' }, targets.map((o) => h('button', { type: 'button', class: 'primary small', onclick: async () => {
        try { for (const l of up) await api('POST', `/api/otlists/${encodeURIComponent(l.id)}/shift`, { ot: o, date: l.date }); } catch (e) { toast(e.message, true); return; }
        await setBlocked(true);
      } }, `Shift to ${otName(o)} and block`)),
        h('button', { type: 'button', class: 'ghost small', onclick: () => setBlocked(true) }, 'Block, keep the lists here'),
        h('button', { type: 'button', class: 'ghost small', onclick: () => { blockBox.hidden = true; } }, 'Cancel')));
  };
  blockBox.hidden = true;
  main.append(
    h('div', { class: 'toolbar' }, h('a', { class: 'button ghost', href: '#ot' }, '‹ OT Lists'), h('h2', {}, otName(ot)),
      h('div', { class: 'actions' },
        admin && h('button', { class: 'ghost' + (blocked ? '' : ' danger'), onclick: () => (blocked ? setBlocked(false) : askBlock()) }, blocked ? 'Unblock OT' : 'Block OT'),
        !blocked && h('button', { class: 'primary', onclick: () => createOtListModal(ot) }, '+ Create list'))),
    blocked ? (() => { const p = h('p', { class: 'blockednote' }); p.innerHTML = BLOCK_SVG; p.append(` ${otName(ot)} is blocked. Earlier lists are kept below; no new lists until the admin unblocks it.`); return p; })() : '',
    blockBox,
    h('div', { class: 'field otkindrow' }, h('span', { class: 'flabel' }, 'This OT is', admin ? '' : ' (set by the admin)'), seg),
    h('h3', {}, 'Today and coming up'),
    up.length ? h('div', { class: 'otlrows' }, up.map(listRow)) : h('p', { class: 'muted' }, 'No lists coming up.'),
    ...(lists.length ? [h('h3', {}, 'By month'), monthGroups(lists)] : []));
}

// Find a patient by UHID or name: every OT list they were posted on, newest first.
function otSearchBox() {
  const out = h('div', { class: 'otfound' });
  let timer;
  const run = async (q) => {
    if (q.trim().length < 2) { out.replaceChildren(); return; }
    const rows = await api('GET', '/api/otsearch?q=' + encodeURIComponent(q.trim())).catch(() => []);
    // Same rows as the day view, one box per OT list (newest first), headed by the OT and the date.
    const groups = new Map();
    for (const r of rows) { if (!groups.has(r.list_id)) groups.set(r.list_id, []); groups.get(r.list_id).push(r); }
    out.replaceChildren(rows.length ? h('div', { class: 'otdays' }, [...groups.values()].map((rs) => h('div', { class: 'card otday' },
      h('div', { class: 'otdayhead' }, h('b', {}, `${otName(rs[0].ot)} · ${fmtDay(rs[0].date)}`), h('span', { class: 'muted small grow' }, rs[0].surgeon ? ' · ' + fullNames(rs[0].surgeon) : ''),
        pencilLink('#otlist/' + encodeURIComponent(rs[0].list_id), `Open the ${otName(rs[0].ot)} list`)),
      h('div', { class: 'otrows' }, rs.map((r) => otRow(r, null, r.list_id, r.date)))))) : h('p', { class: 'muted' }, 'Not found on any OT list.'));
  };
  return h('div', { class: 'otsearch' },
    h('input', { type: 'search', placeholder: 'Search a patient by UHID or name', autocomplete: 'off', value: S.otQ || '', oninput: (ev) => { S.otQ = ev.target.value; clearTimeout(timer); timer = setTimeout(() => run(ev.target.value), 250); } }),
    out, S.otQ ? (run(S.otQ), '') : '');
}

// Every patient on every OT list in one table, with filters (OT, day, month, Routine / Emergency) and newest or oldest first.
async function allOtListsPopup() {
  const root = document.getElementById('modal-root');
  const close = () => root.replaceChildren();
  const body = h('div', {}, h('p', { class: 'loading' }, 'Loading…'));
  root.replaceChildren(h('div', { class: 'backdrop', onclick: (ev) => ev.target === ev.currentTarget && close() },
    h('div', { class: 'modal card panel wide allot' }, h('div', { class: 'mhead' }, h('h2', {}, 'All OT lists'), h('div', { class: 'btns' }, h('button', { type: 'button', class: 'ghost small', onclick: close }, 'Close'))), body)));
  const rows = await api('GET', '/api/otall').catch((e) => { toast(e.message, true); return []; });
  const f = S.otAllFilter || (S.otAllFilter = { ot: '', date: '', month: '', kind: '', newest: true });
  const otSel = h('select', { onchange: (e) => { f.ot = e.target.value; draw(); } }, h('option', { value: '' }, 'All OTs'), OT_ROOMS.map(([ot]) => h('option', { value: ot }, otName(ot))));
  const dateIn = h('input', { type: 'date', onchange: (e) => { f.date = e.target.value; if (f.date) { f.month = ''; monthIn.value = ''; } draw(); } });
  const monthIn = h('input', { type: 'month', onchange: (e) => { f.month = e.target.value; if (f.month) { f.date = ''; dateIn.value = ''; } draw(); } });
  const kindSel = h('select', { onchange: (e) => { f.kind = e.target.value; draw(); } }, h('option', { value: '' }, 'Routine and Emergency'), h('option', { value: 'Routine' }, 'Routine'), h('option', { value: 'Emergency' }, 'Emergency'));
  otSel.value = f.ot; dateIn.value = f.date; monthIn.value = f.month; kindSel.value = f.kind;
  const sortBtn = h('button', { type: 'button', class: 'ghost small', onclick: () => { f.newest = !f.newest; draw(); } });
  const clear = h('button', { type: 'button', class: 'link small', onclick: () => { Object.assign(f, { ot: '', date: '', month: '', kind: '' }); otSel.value = dateIn.value = monthIn.value = kindSel.value = ''; draw(); } }, 'Clear filters');
  const count = h('p', { class: 'muted small' });
  const table = h('div', { class: 'tablewrap' });
  body.replaceChildren(h('div', { class: 'allotfilters' },
    h('label', {}, 'OT', otSel), h('label', {}, 'Date', dateIn), h('label', {}, 'Month', monthIn), h('label', {}, 'List', kindSel),
    h('div', { class: 'allotsort' }, sortBtn, clear)), count, table);
  function draw() {
    const shown = rows.filter((r) => (!f.ot || r.ot === f.ot) && (!f.date || r.date === f.date) && (!f.month || r.date.startsWith(f.month)) && (!f.kind || r.kind === f.kind))
      .sort((x, y) => (x.date !== y.date ? (x.date < y.date ? -1 : 1) * (f.newest ? -1 : 1) : x.ot !== y.ot ? (x.ot < y.ot ? -1 : 1) : x.order - y.order));
    sortBtn.textContent = f.newest ? 'Newest first ↓' : 'Oldest first ↑';
    count.textContent = `${shown.length} patient${shown.length === 1 ? '' : 's'}${shown.length ? ` on ${new Set(shown.map((r) => r.list_id)).size} list${new Set(shown.map((r) => r.list_id)).size === 1 ? '' : 's'}` : ''}`;
    table.replaceChildren(shown.length ? h('table', { class: 'list allottable' },
      h('thead', {}, h('tr', {}, ['Date', 'UHID', 'Name', 'Age / Sex', 'Diagnosis', 'Procedure', 'Consultant', 'OT', 'Scrub team'].map((t) => h('th', {}, t)))),
      h('tbody', {}, shown.map((r) => h('tr', { class: r.case_cancelled ? 'casecancelled' : '', onclick: () => { close(); location.hash = `otlist/${encodeURIComponent(r.list_id)}/${encodeURIComponent(r.entry_id)}`; } },
        h('td', { class: 'nowrap' }, fmtDate(r.date)), h('td', {}, r.uhid), h('td', {}, h('b', {}, r.name)), h('td', { class: 'nowrap' }, [r.age, r.sex].filter(Boolean).join(' / ')),
        h('td', {}, r.diagnosis), h('td', {}, r.procedure, r.case_cancelled ? h('div', { class: 'small cctag' }, 'Case cancelled') : ''), h('td', {}, fullNames(r.consultant)),
        h('td', { class: 'nowrap' }, otName(r.ot), r.kind === 'Emergency' ? h('div', { class: 'small emtag' }, 'Emergency') : ''), h('td', {}, r.scrub.join('/')))))) : h('p', { class: 'muted' }, 'No OT lists match these filters.'));
  }
  draw();
}

// Every list of one OT grouped by month and year; tapping a month opens its dates right there.
function monthGroups(lists) {
  const groups = new Map();
  for (const l of lists) { const k = l.date.slice(0, 7); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
  return h('div', { class: 'otmonths' }, [...groups.keys()].sort().reverse().map((k) => {
    const ls = groups.get(k).sort((x, y) => (x.date < y.date ? -1 : 1));
    const [y, m] = k.split('-');
    const title = new Date(+y, +m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    return h('details', { class: 'otmonth' },
      h('summary', {}, h('b', {}, title), h('span', { class: 'muted small' }, ` · ${ls.length} list${ls.length === 1 ? '' : 's'}`)),
      h('div', { class: 'otlrows' }, ls.map(listRow)));
  }));
}

// Pick an OT and a date. Opens the list (an existing one if that OT already has a list that day).
function createOtListModal(ot = '11', onCreated) {
  let pick = ot;
  const seg = h('div', { class: 'seg otseg' });
  if (otBlocked(pick)) pick = (OT_ROOMS.find(([o]) => !otBlocked(o)) || [pick])[0];
  const drawSeg = () => seg.replaceChildren(...OT_ROOMS.map(([o]) => h('button', { type: 'button', class: o === pick ? 'on' : '', disabled: otBlocked(o), title: otBlocked(o) ? `${otName(o)} is blocked` : '', onclick: () => { pick = o; drawSeg(); } }, o)));
  drawSeg();
  modal('Create OT list', h('div', { class: 'grid1' },
    h('div', { class: 'field' }, h('span', { class: 'flabel' }, 'OT'), seg),
    h('label', {}, 'Date', h('input', { type: 'date', name: 'date', value: addDays(S.meta.today, 1), required: true }))),
  async (form) => {
    const l = await api('POST', '/api/otlists', { ot: pick, date: form.date.value });
    if (l.existed) toast(`${otName(l.ot)} already has a list on ${fmtDate(l.date)}. Opened it.`);
    if (onCreated) return onCreated(l);
    location.hash = 'otlist/' + encodeURIComponent(l.id);
  }, 'Create');
}

async function otListView(main, id) {
  let l;
  try { l = await api('GET', '/api/otlists/' + encodeURIComponent(id)); } catch (e) { main.append(h('p', { class: 'error' }, e.message), h('a', { href: '#ot' }, '‹ OT Lists')); return; }
  const reload = () => { if (location.hash.startsWith('#otlist/' + encodeURIComponent(id))) render(); };
  // Opened from a pencil on today's lists: bring that patient's card into view.
  const focusId = decodeURIComponent(location.hash.split('/')[2] || '');
  if (focusId) setTimeout(() => { const c = document.querySelector(`[data-entry="${CSS.escape(focusId)}"]`); if (c) { c.classList.add('flash'); c.scrollIntoView({ block: 'center' }); } }, 50);
  // Shifted and cancelled cases stay on the day's list (greyed) but are left off the print.
  const live = l.entries.filter((e) => !e.cancelled), cancelled = l.entries.filter((e) => e.cancelled);
  const surgeonValue = () => [surgeon.value, surgeon2.value].filter((n, i, a) => n && a.indexOf(n) === i).join('/');
  const saveHead = async () => { try { await api('PUT', '/api/otlists/' + encodeURIComponent(id), { surgeon: surgeonValue(), note: note.value }); reload(); toast('Saved'); } catch (e) { toast(e.message, true); } };
  const [s1, s2] = fullNames(l.surgeon).split('/');
  const surgeon = surgeonSelect(s1 || '', '— Choose —', [], { onchange: saveHead });
  const surgeon2 = surgeonSelect(s2 || '', 'None', [], { onchange: saveHead });
  // KEEP OT WARM is printed on every list; older lists may still carry it as their note.
  const extraNote = /^\s*keep\s*(the\s*)?ot\s*warm\s*$/i.test(l.note || '') ? '' : (l.note || '');
  const note = h('input', { value: extraNote, placeholder: 'Anything else to print on top', onchange: saveHead });
  const sheet = h('div', { class: 'printonly otprint' });
  const drawSheet = () => sheet.replaceChildren(
    h('h1', {}, 'Department of Pediatric Surgery, MCH Block'), h('p', { class: 'c t2' }, `${l.kind || 'Routine'} OT List - `, h('b', {}, otName(l.ot))), h('p', { class: 'c' }, `(${shortDate(l.date)})`),
    l.surgeon && h('p', { class: 'c b' }, fullNames(l.surgeon).toUpperCase()), h('p', { class: 'c b' }, 'KEEP OT WARM'), extraNote && h('p', { class: 'c b' }, extraNote.toUpperCase()),
    h('table', {}, h('thead', {}, h('tr', {}, ['SL NO', 'WARD', 'NAME', 'AGE/SEX', 'UHID', 'DIAGNOSIS', 'SURGERY', 'CONSULTANT', 'BLOOD ARRANGE', 'SPECIAL REQ'].map((t) => h('th', {}, t)))),
      h('tbody', {}, live.filter((e) => !e.case_cancelled).map((e, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}, wardCol(e.bed)), h('td', {}, (e.name || '').toUpperCase()), h('td', {}, [e.age, e.sex].filter(Boolean).join('/')),
        h('td', {}, e.uhid), h('td', {}, e.diagnosis), h('td', {}, e.surgery), h('td', {}, fullNames(e.consultant)), h('td', {}, e.blood), h('td', {}, e.special))))),
    h('div', { class: 'otfoot' }, h('b', {}, `DATE: ${fmtDate(S.meta.today)}`), h('b', {}, 'SIGNATURE')));
  drawSheet();
  const doJpg = () => saveOtJpg(l, live.filter((e) => !e.case_cancelled), extraNote);
  const doPrint = () => { const st = h('style', {}, '@page { size: A4 landscape; margin: 16mm 15mm; }'); document.head.append(st); window.print(); st.remove(); };
  const move = async (e, dir) => { try { await api('POST', `/api/otentries/${encodeURIComponent(e.id)}/move`, { dir }); reload(); } catch (x) { toast(x.message, true); } };
  const card = (e, i) => h('div', { class: 'card otentry' + (e.case_cancelled ? ' casecancelled' : ''), 'data-entry': e.id },
    e.case_cancelled && h('p', { class: 'cctag' }, caseCancelText(e.case_cancelled), ' ', h('button', { type: 'button', class: 'link small', onclick: () => undoCaseCancel(e, reload) }, 'Undo')),
    h('div', { class: 'othead2' }, h('span', { class: 'slno' }, i + 1), h('div', { class: 'grow' }, h('b', { class: 'big' }, e.name), h('div', { class: 'muted small' }, [[e.age, e.sex].filter(Boolean).join(' / '), e.uhid && `UHID ${e.uhid}`].filter(Boolean).join(' · '))),
      h('span', { class: 'bedno' + (e.bed ? '' : ' nobed') }, bedLabel(e.bed))),
    e.reposted_from && h('p', { class: 'small reposted' }, `${e.reposted_from.kept ? 'Also on' : 'Shifted from'} ${otName(e.reposted_from.ot)}, ${fmtDate(e.reposted_from.date)}${e.reposted_from.reason ? ` (${e.reposted_from.reason})` : ''}`),
    h('dl', { class: 'otfacts' },
      e.diagnosis && [h('dt', {}, 'Diagnosis'), h('dd', {}, e.diagnosis)],
      [h('dt', {}, 'Surgery'), h('dd', {}, e.surgery || h('span', { class: 'warntext' }, 'Not filled yet'))],
      e.consultant && [h('dt', {}, 'Consultant'), h('dd', {}, fullNames(e.consultant))],
      e.blood && [h('dt', {}, 'Blood'), h('dd', {}, e.blood)],
      e.special && [h('dt', {}, 'Special req'), h('dd', { class: 'instr' }, e.special)],
      e.done && [h('dt', {}, 'Done'), h('dd', {}, h('b', {}, e.done))],
      (e.scrub || []).length ? [h('dt', {}, 'Scrub team'), h('dd', {}, h('b', {}, e.scrub.join('/')))] : null,
      !e.admission_id && e.ot_overs ? [h('dt', {}, 'OT Overs'), h('dd', { class: 'instr' }, e.ot_overs)] : null),
    otExtras(l, e, reload),
    h('div', { class: 'btns' },
      h('button', { class: 'ghost small', onclick: () => otEntryModal(l, e, reload) }, 'Edit'),
      h('button', { class: 'ghost small', disabled: i === 0, onclick: () => move(e, 'up'), 'aria-label': 'Move up' }, '↑'),
      h('button', { class: 'ghost small', disabled: i === live.length - 1, onclick: () => move(e, 'down'), 'aria-label': 'Move down' }, '↓'),
      h('button', { class: 'ghost small', onclick: (ev) => { const c = ev.target.closest('.otentry'), old = c.querySelector('.otmove'); if (old) old.remove(); else c.append(repostForm(l, e)); } }, 'Repost'),
      !e.admission_id && (!e.bed || e.bed.toUpperCase() === DAY_CARE) && h('button', { class: 'ghost small', onclick: () => admitFromOt(e, reload) }, 'Admit to ward'),
      h('button', { class: 'ghost small danger', onclick: async () => {
        if (!confirm(`Remove ${e.name} from this list?`)) return;
        try { await api('DELETE', '/api/otentries/' + encodeURIComponent(e.id)); toast('Removed'); reload(); } catch (x) { toast(x.message, true); }
      } }, 'Remove')));
  // Shift the whole list to another OT (same day by default); it joins that OT's list if there is one.
  const shiftBox = h('div', { class: 'noprint card' }, otMoveForm(l, { title: `Shift this whole list (${live.length} patient${live.length === 1 ? '' : 's'}) to:`, actions: [
    { label: (to) => `Shift list to ${to}`, cls: 'primary small', run: async (ot, date) => {
      const r = await api('POST', `/api/otlists/${encodeURIComponent(id)}/shift`, { ot, date });
      toast(r.merged ? `Patients added to the ${otName(ot)} list${r.skipped.length ? ` (${r.skipped.join(', ')} already there)` : ''}` : `List shifted to ${otName(ot)}`);
      if (r.list_id === id) render(); else location.hash = 'otlist/' + encodeURIComponent(r.list_id);
    } }] }));
  shiftBox.hidden = true;
  main.append(
    h('div', { class: 'toolbar noprint' }, h('a', { class: 'button ghost', href: '#ot/' + l.ot }, '‹ ' + otName(l.ot)),
      h('h2', {}, `${otName(l.ot)} · `, fmtDay(l.date)),
      h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: doPrint }, 'Print'), h('button', { class: 'ghost', onclick: doJpg }, 'Save as JPG'),
        h('button', { class: 'ghost', onclick: () => { shiftBox.hidden = !shiftBox.hidden; } }, 'Shift list'),
        h('button', { class: 'ghost danger', onclick: async () => {
          if (!confirm(`Delete the whole ${otName(l.ot)} list for ${fmtDate(l.date)}${live.length ? ` with its ${live.length} patients` : ''}?`)) return;
          try { await api('DELETE', '/api/otlists/' + encodeURIComponent(id)); toast('List deleted'); location.hash = 'ot/' + l.ot; } catch (x) { toast(x.message, true); }
        } }, 'Delete list'))),
    shiftBox,
    h('div', { class: 'noprint' },
      h('div', { class: 'card othdr' }, h('div', { class: 'label' }, 'This list is', listKindSeg(l, reload)), h('label', {}, 'Surgeon', surgeon), h('label', {}, 'Second surgeon (if two run the OT)', surgeon2),
        h('label', {}, 'Extra note (optional)', note, h('small', { class: 'muted' }, 'KEEP OT WARM is always printed.'))),
      h('div', { class: 'otadd' },
        h('button', { class: 'primary', onclick: () => otEntryModal(l, null, reload) }, '+ Add patient'),
        h('button', { class: 'ghost', onclick: () => fromWardModal(l, reload) }, '+ From ward / ICU')),
      live.length ? h('div', { class: 'otentries' }, live.map(card)) : h('p', { class: 'muted' }, 'No patients on this list yet.'),
      ...(cancelled.length ? [h('h3', {}, 'Shifted to another OT / day'), h('div', { class: 'otentries' }, cancelled.map((e) => h('div', { class: 'card otentry cancelled' },
        h('b', {}, e.name), h('span', { class: 'muted small' }, e.uhid ? ` · UHID ${e.uhid}` : ''),
        h('p', { class: 'small' }, 'Shifted to ', h('a', { href: '#otlist/' + encodeURIComponent(e.reposted_to.list_id) }, `${otName(e.reposted_to.ot)}, ${fmtDay(e.reposted_to.date)}`), e.cancel_reason ? ` · ${e.cancel_reason}` : ''))))] : []),
      h('div', { class: 'otmeta' },
        h('p', {}, `Created by ${l.created_by || '—'}${l.created_at ? ` on ${stampText(l.created_at)}` : ''}`),
        (l.edits || []).length ? h('p', {}, 'Recent edits:') : null,
        (l.edits || []).map((x) => h('p', {}, `${x.by} ${x.what} · ${stampText(x.at)}`)))),
    sheet);
}

// OT Overs live with the patient in Rounds: the button opens that patient's Rounds card.
const oversBtn = (e, done) => !canEdit() ? null
  : h('button', { type: 'button', class: 'ghost small ottile' + (e.ot_overs ? ' hasovers' : ''), title: 'OT Overs', onclick: () => (e.admission_id ? roundsPopup(e.admission_id) : entryOversPopup(e, done || render)) }, 'OT Overs');
// Ward patient: their Rounds card opens in a pop-up right here.
async function roundsPopup(admId) {
  const root = document.getElementById('modal-root');
  const date = roundsDay();
  const body = h('div', {}, h('p', { class: 'loading' }, 'Loading…'));
  const close = () => { if (confirmLeave()) { S.dirty.clear(); root.replaceChildren(); } };
  root.replaceChildren(h('div', { class: 'backdrop', onclick: (ev) => ev.target === ev.currentTarget && close() },
    h('div', { class: 'modal card panel roundspop' }, h('div', { class: 'mhead' }, h('h2', {}, 'Rounds · ', fmtDay(date)), h('div', { class: 'btns' }, h('button', { type: 'button', class: 'ghost small', onclick: close }, 'Close'))), body)));
  const load = async () => {
    const data = await api('GET', '/api/register?date=' + date);
    const a = data.admissions.find((x) => x.id === admId);
    body.replaceChildren(a ? patientCard(a, date, load) : h('p', { class: 'muted' }, 'This patient is not in the ward on this date.'));
    const ov = body.querySelector('.instr.overs'); if (ov) ov.scrollIntoView({ block: 'center' });
  };
  try { await load(); } catch (x) { body.replaceChildren(h('p', { class: 'error' }, x.message)); }
}
// Private ward, day care or any child not in our wards: OT Overs are kept on the OT list entry.
function entryOversPopup(e, done) {
  const ta = h('textarea', { name: 'overs', rows: 5, placeholder: 'e.g. Rectal pack to be removed on POD 2\nStent to be removed on POD 10' }, e.ot_overs || '');
  modal(`OT Overs · ${e.name}`, h('div', {}, h('p', { class: 'muted small' }, OVERS_HINT), ta), async () => {
    await api('PUT', '/api/otentries/' + encodeURIComponent(e.id), { ot_overs: ta.value.trim() });
    toast('OT Overs saved'); done();
  }, 'Save');
}
// Scrub team (with the procedure done) and OT Overs for one patient on the list.
function otExtras(l, e, reload) {
  return h('div', { class: 'ottiles' },
    l.date <= S.meta.today && !e.case_cancelled && h('button', { class: 'ottile', onclick: () => scrubPopup(e, reload, l.date) }, (e.scrub || []).length ? `Scrub team: ${e.scrub.join('/')}` : '+ Add scrub team'),
    oversBtn(e, reload));
}

// OT cancelled for the day: put the patient on another day's (or another OT's) list.
// Pick an OT (tiles) and a day, in place on the page (no pop-up). Used to shift one patient or a whole list.
function otMoveForm(l, opts) {
  let pick = null;
  const date = h('input', { type: 'date', value: l.date, min: S.meta.today, onchange: () => draw() });
  const reason = opts.reason ? h('input', { placeholder: 'Reason (optional), e.g. OT time over' }) : null;
  const seg = h('div', { class: 'seg otseg' });
  const btns = h('div', { class: 'btns' });
  const draw = () => {
    seg.replaceChildren(...OT_ROOMS.map(([o]) => h('button', { type: 'button', class: o === pick ? 'on' : '', disabled: otBlocked(o) || (o === l.ot && date.value === l.date), title: otBlocked(o) ? `${otName(o)} is blocked` : '', onclick: () => { pick = o; draw(); } }, o)));
    const to = pick ? `${otName(pick)}${date.value !== l.date ? `, ${fmtDate(date.value)}` : ''}` : '';
    btns.replaceChildren(...opts.actions.map((a) => h('button', { type: 'button', class: a.cls || 'ghost small', disabled: !pick || (pick === l.ot && date.value === l.date),
      onclick: async () => { try { await a.run(pick, date.value, reason ? reason.value : ''); } catch (x) { toast(x.message, true); } } }, pick ? a.label(to) : a.label('…'))));
  };
  draw();
  return h('div', { class: 'otmove' }, h('div', { class: 'small b' }, opts.title),
    h('div', { class: 'otmoverow' }, seg, h('label', { class: 'small' }, 'Day', date)), reason, btns);
}
function repostForm(l, e) {
  const go = async (ot, date, reason, keep) => {
    const r = await api('POST', `/api/otentries/${encodeURIComponent(e.id)}/repost`, { ot, date, reason, keep });
    toast(keep ? `${e.name} is now on ${otName(ot)} too` : `${e.name} shifted to ${otName(ot)}, ${fmtDate(date)}`);
    location.hash = 'otlist/' + encodeURIComponent(r.list_id);
  };
  return otMoveForm(l, { title: `Repost ${e.name} to:`, reason: true, actions: [
    { label: (to) => `Shift to ${to}`, cls: 'primary small', run: (o, d, r) => go(o, d, r, false) },
    { label: (to) => `Keep here and add to ${to}`, run: (o, d, r) => go(o, d, r, true) }] });
}

// A day-care patient who needs to stay: the admit form opens filled in from the OT list, and the list then shows the new bed.
function admitFromOt(e, onDone) {
  const first = fullNames(e.consultant).split('/')[0];
  const unit = (SURGEONS.find(([, n]) => n === first) || [])[0] || '';
  admitModal(null, null, {
    prefill: { name: e.name, ip_no: e.uhid, age: e.age, sex: e.sex, diagnosis: e.diagnosis, procedure_done: e.surgery, unit },
    onAdmitted: async (res, payload) => { await api('PUT', '/api/otentries/' + encodeURIComponent(e.id), { bed: payload.bed, admission_id: res.id }); },
  });
}

// ---------- OT Log: each person's logbook from the scrub teams added on OT lists ----------
async function otLogView(main, who) {
  // Everyone sees only their own logbook; admins can open anyone's.
  const own = S.user.role !== 'admin';
  if (own) {
    who = myInitials();
    if (!who) return main.append(h('h2', {}, 'Logbook'), h('p', { class: 'muted' }, 'Your initials are not set yet. Ask the admin to add them in Admin > Users, then your logbook shows here.'));
  }
  who = who || myInitials() || SURGEONS[0][0];
  const [counts, rows] = await Promise.all([api('GET', '/api/otpeople'), api('GET', '/api/otlog?who=' + encodeURIComponent(who))]);
  const people = Object.keys(counts);
  const known = new Set(allPeople().map(([i]) => i));
  const builtIn = new Set([...SURGEONS, ...SR_INITIALS].map(([i]) => i));
  const extraCons = userPeople(true).filter(([i]) => !builtIn.has(i)), extraRes = userPeople(false).filter(([i]) => !builtIn.has(i) && !extraCons.some(([c]) => c === i));
  const others = people.filter((p) => !known.has(p));
  if (!known.has(who) && !others.includes(who)) others.push(who);
  const opt = ([i, n]) => h('option', { value: i, selected: i === who }, n ? `${i} · ${n}` : i);
  const sel = h('select', { onchange: (ev) => { location.hash = 'otlog/' + encodeURIComponent(ev.target.value); } },
    h('optgroup', { label: 'Consultants' }, SURGEONS.map(opt)), h('optgroup', { label: 'Residents' }, SR_INITIALS.map(opt)),
    others.length ? h('optgroup', { label: 'Others' }, others.map((o) => opt([o]))) : null);
  const byRole = {};
  for (const r of rows) byRole[r.role] = (byRole[r.role] || 0) + 1;
  const title = `Logbook · ${personName(who)}${personName(who) !== who ? ` (${who})` : ''}`;
  main.append(
    h('div', { class: 'toolbar' }, h('a', { class: 'button ghost noprint', href: '#ot' }, '‹ OT Lists'), h('h2', {}, 'Logbook'),
      h('div', { class: 'actions' }, own ? h('span', {}, `Your logbook · ${personName(who)}`) : h('label', { class: 'inline' }, 'Logbook of ', sel), h('button', { class: 'ghost', onclick: () => window.print() }, 'Print'))),
    h('h2', { class: 'printonly' }, title),
    h('p', { class: 'muted' }, rows.length ? `${rows.length} operation${rows.length === 1 ? '' : 's'}: ` + Object.keys(byRole).sort((a, b) => a - b).map((k) => `${roleName(+k).toLowerCase()} ${byRole[k]}`).join(', ') : `No operations logged for ${who} yet. A log fills when ${who} is in a scrub team on an OT list.`),
    rows.length ? h('input', { type: 'search', class: 'otlogsearch noprint', placeholder: 'Search name, UHID, diagnosis or surgery', oninput: (ev) => {
      const q = ev.target.value.trim().toLowerCase();
      main.querySelectorAll('table.otlog tbody tr').forEach((tr) => { tr.hidden = !!q && !tr.textContent.toLowerCase().includes(q); });
    } }) : null,
    rows.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'list print otlog' },
      h('thead', {}, h('tr', {}, ['#', 'Date', 'Name', 'UHID', 'Age / Sex', 'Diagnosis', 'Surgery', 'Role', 'Team'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((r, i) => h('tr', { class: 'clickable', onclick: () => { location.hash = r.list_id ? 'otlist/' + encodeURIComponent(r.list_id) : 'patient/' + r.admission_id; } },
        h('td', {}, i + 1), h('td', {}, fmtDate(r.date)), h('td', {}, h('b', {}, r.name)), h('td', {}, r.uhid || ''), h('td', {}, ageSex(r, r.date)),
        h('td', {}, r.diagnosis), h('td', {}, r.surgery), h('td', {}, roleName(r.role)), h('td', { class: 'muted' }, r.team.join('/'))))))) : null);
}

// Add or edit one patient on a list. Typing a UHID that has been seen before fills in the rest (all of it can still be changed).
function otEntryModal(l, e, onSaved) {
  const v = e || {};
  const input = (label, name, attrs = {}) => h('label', {}, label, h('input', { name, value: v[name] || '', ...attrs }));
  const found = h('p', { class: 'small muted' });
  const lookup = async (form) => {
    const u = form.uhid.value.trim();
    if (!u || (e && u === e.uhid)) return;
    const r = await api('GET', `/api/uhid/${encodeURIComponent(u)}?date=${l.date}`).catch(() => ({}));
    if (!r || !r.name) { found.textContent = 'New UHID: fill in the details.'; return; }
    for (const k of ['name', 'age', 'sex', 'bed', 'diagnosis', 'surgery', 'blood', 'special']) if (r[k] && !form[k].value.trim()) form[k].value = r[k];
    if (r.consultant && !form.consultant.value) {
      const [n1, n2] = fullNames(r.consultant).split('/');
      const put = (sel, n) => { if (!n) return; if (![...sel.options].some((o) => o.value === n)) sel.append(h('option', { value: n }, n)); sel.value = n; };
      put(form.consultant, n1); if (!form.consultant2.value) put(form.consultant2, n2);
    }
    if (r.admission_id) form.admission_id.value = r.admission_id;
    found.textContent = `Found ${r.name}: details filled in${r.bed ? `, now in ${r.bed}` : ''}. Check and change anything needed.`;
  };
  const beds = h('datalist', { id: 'otbeds' }, h('option', { value: DAY_CARE }, 'Day care'), S.meta.sections.flatMap((x) => x.beds).map((b) => h('option', { value: b })));
  // The consultant starts as the OT's surgeon(s) and can be changed, e.g. Dr Ajay Verma operating in Dr Anjan Dhua's OT.
  // A second consultant can join any case (common in the Em OT, which has no single surgeon).
  const [c1, c2] = (e ? fullNames(v.consultant) : fullNames(l.surgeon)).split('/');
  const consultant = surgeonSelect(c1 || '', '—', [], { name: 'consultant' });
  const consultant2 = surgeonSelect(c2 || '', 'None', [], { name: 'consultant2' });
  const form = modal(e ? `Edit · ${e.name}` : `Add patient · ${otName(l.ot)} ${fmtDate(l.date)}`, h('div', { class: 'grid2 otform' },
    h('label', { class: 'span2' }, 'UHID', h('input', { name: 'uhid', value: v.uhid || '', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Type the UHID first',
      onchange: () => lookup(form), onkeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); lookup(form); } } }), found),
    h('label', { class: 'span2' }, 'Name', h('input', { name: 'name', value: v.name || '', required: true })),
    input('Age', 'age', { placeholder: 'e.g. 2m, 12y' }),
    h('label', {}, 'Sex', h('select', { name: 'sex' }, ['', 'M', 'F', 'Other'].map((x) => h('option', { value: x, selected: x === (v.sex || '') }, x || '—')))),
    h('label', { class: 'span2' }, 'Bed', h('input', { name: 'bed', value: v.bed || '', list: 'otbeds', autocomplete: 'off', placeholder: 'e.g. 6B/15' }),
      h('small', { class: 'muted' }, 'A ward bed admits the child to that bed today (shows on the register and in Rounds). Leave blank if being admitted later. MCH2/PAR = day care.'), beds),
    h('label', { class: 'span2' }, 'Diagnosis', h('textarea', { name: 'diagnosis', rows: 2 }, v.diagnosis || '')),
    h('label', { class: 'span2' }, 'Surgery', h('textarea', { name: 'surgery', rows: 2 }, v.surgery || '')),
    h('label', {}, 'Consultant', consultant),
    h('label', {}, 'Second consultant (optional)', consultant2),
    input('Blood arrangement', 'blood', { placeholder: 'e.g. 1-1-1' }),
    h('label', { class: 'span2' }, 'Special requirements', h('textarea', { name: 'special', rows: 3, placeholder: 'Ports, instruments, positioning, ventilation…' }, v.special || '')),
    h('input', { type: 'hidden', name: 'admission_id', value: v.admission_id || '' })),
  async (f) => {
    const body = Object.fromEntries(['uhid', 'name', 'age', 'sex', 'bed', 'diagnosis', 'surgery', 'consultant', 'blood', 'special', 'admission_id'].map((k) => [k, f[k].value]));
    body.consultant = [f.consultant.value, f.consultant2.value].filter((n, i, a) => n && a.indexOf(n) === i).join('/');
    const r = e ? await api('PUT', '/api/otentries/' + encodeURIComponent(e.id), body) : await api('POST', `/api/otlists/${encodeURIComponent(l.id)}/entries`, body);
    if (r.warning) toast(r.warning, true);
    else toast((e ? 'Saved' : `${body.name} added`) + (r.admitted ? `, and admitted to ${r.admitted} today` : ''));
    onSaved();
  }, e ? 'Save' : 'Add to list');
  return form;
}

// Tap admitted patients (ward or ICU) to add them to this list; their details come from the register.
async function fromWardModal(l, onDone) {
  const root = document.getElementById('modal-root');
  const close = () => { root.replaceChildren(); onDone(); };
  const reg = await api('GET', '/api/register?date=' + S.meta.today);
  const order = S.meta.sections.flatMap((x) => x.beds);
  const pts = reg.admissions.filter((a) => !a.discharge_date).sort((x, y) => order.indexOf(x.bed_on_date) - order.indexOf(y.bed_on_date));
  const added = new Set(l.entries.map((e) => e.admission_id).filter(Boolean));
  const q = h('input', { type: 'search', placeholder: 'Find bed, name, UHID…', oninput: () => draw() });
  const list = h('div', { class: 'pickl' });
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    list.replaceChildren(...pts.filter((a) => !t || [a.bed_on_date, a.name, a.ip_no].some((x) => (x || '').toLowerCase().includes(t))).map((a) =>
      h('button', { type: 'button', class: 'pick' + (added.has(a.id) ? ' done' : ''), disabled: added.has(a.id), onclick: async () => {
        try { await api('POST', `/api/otlists/${encodeURIComponent(l.id)}/entries`, { admission_id: a.id }); added.add(a.id); toast(`${a.name} added`); draw(); } catch (x) { toast(x.message, true); }
      } }, h('span', { class: 'bedno' }, a.bed_on_date), h('span', { class: 'grow' }, h('b', {}, a.name), h('small', { class: 'muted' }, ' ', [ageSex(a, S.meta.today), a.unit, a.diagnosis].filter(Boolean).join(' · '))),
      h('span', { class: 'tick' }, added.has(a.id) ? '✓ Added' : '+'))));
  };
  draw();
  root.replaceChildren(h('div', { class: 'backdrop', onclick: (ev) => ev.target === ev.currentTarget && close() },
    h('div', { class: 'modal card panel' },
      h('div', { class: 'mhead' }, h('h2', {}, `Add from ward / ICU · ${otName(l.ot)} ${fmtDate(l.date)}`), h('div', { class: 'btns' }, h('button', { type: 'button', class: 'primary small', onclick: close }, 'Done'))),
      h('p', { class: 'muted small' }, 'Tap each patient to add. Fill in the surgery and special requirements afterwards with Edit.'),
      q, list)));
  q.focus();
}

// From a bed: put this patient on an OT list (an upcoming one, or a new one).
async function addToOtModal(a) {
  const lists = (await api('GET', '/api/otlists?from=' + S.meta.today)).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.ot < y.ot ? -1 : 1));
  const root = document.getElementById('modal-root');
  const close = () => root.replaceChildren();
  const add = async (l) => {
    try {
      await api('POST', `/api/otlists/${encodeURIComponent(l.id)}/entries`, { admission_id: a.id });
      close();
      toast(`${a.name} added to ${otName(l.ot)} · ${fmtDate(l.date)}. Fill in surgery details in OT Lists.`);
    } catch (x) { toast(x.message, true); }
  };
  root.replaceChildren(h('div', { class: 'backdrop', onclick: (ev) => ev.target === ev.currentTarget && close() },
    h('div', { class: 'modal card panel' },
      h('div', { class: 'mhead' }, h('h2', {}, `Add ${a.name} to an OT list`), h('div', { class: 'btns' }, h('button', { type: 'button', class: 'ghost small', onclick: close }, 'Close'))),
      lists.length ? h('div', { class: 'otcards' }, lists.map((l) => h('button', { type: 'button', class: 'otcard', onclick: () => add(l) },
        h('b', {}, `${otName(l.ot)} · `, fmtDay(l.date)), h('span', { class: 'muted small' }, `${l.count} patient${l.count === 1 ? '' : 's'}`)))) : h('p', { class: 'muted' }, 'No upcoming lists yet.'),
      h('button', { class: 'primary', onclick: () => createOtListModal('11', (l) => add(l)) }, '+ New list'))));
}

// ---------- Bed Occupancy (6B and 6A beds per consultant against their allotment) ----------

async function censusView(main) {
  const date = S.date;
  const data = await api('GET', '/api/register?date=' + date);
  const inWard = data.admissions.filter((a) => a.discharge_date !== date);
  const emergency = new Set(S.meta.emergencyBeds);
  const order = S.meta.sections.flatMap((s) => s.beds);
  const byOrder = (x, y) => order.indexOf(x.bed_on_date) - order.indexOf(y.bed_on_date);
  const ward = inWard.filter((a) => !isIcu(a.bed_on_date)).sort(byOrder);
  const icu = inWard.filter((a) => isIcu(a.bed_on_date)).sort(byOrder);
  const known = new Set(S.meta.units.map((u) => u.name));
  const emerg = ward.filter((a) => emergency.has(a.bed_on_date));
  const noUnit = ward.filter((a) => !known.has(a.unit) && !emergency.has(a.bed_on_date));
  const wardBeds = order.filter((b) => !isIcu(b));

  const box = (title, n, of, onclick, cls = '') => h('button', { class: 'cbox ' + cls + (of && n > of ? ' over' : ''), onclick },
    h('b', { class: 'cname' }, title),
    h('span', { class: 'ccount' }, of ? `${n} / ${of}` : String(n)),
    h('small', { class: 'muted' }, of ? 'beds occupied / allotted' : 'beds occupied'));

  // Print sheet: one column of beds per consultant with occupied / allotted, then one consultant's patients with space for instructions.
  const units = S.meta.units;
  let listUnit = units.some((u) => u.name === 'SA') ? 'SA' : (units[0] && units[0].name) || '';
  const sheet = h('div', { class: 'printonly occsheet' });
  const drawSheet = () => {
    const cols = units.map((u) => ({ title: u.name, beds: ward.filter((a) => a.unit === u.name && !emergency.has(a.bed_on_date)).map((a) => a.bed_on_date), of: u.beds }));
    const emBeds = S.meta.emergencyBeds.map((b) => { const a = emerg.find((x) => x.bed_on_date === b); return `${b} - ${a ? a.unit || '?' : ''}`; });
    cols.push({ title: 'Emergency', beds: emBeds, n: emerg.length, of: S.meta.emergencyBeds.length });
    const rows = Math.max(1, ...cols.map((c) => c.beds.length));
    const mine = ward.filter((a) => a.unit === listUnit && !emergency.has(a.bed_on_date));
    const mineEm = emerg.filter((a) => a.unit === listUnit);
    const mineIcu = icu.filter((a) => a.unit === listUnit);
    // Instructions is the widest column (space to write on the round); name, age/sex and POD share one box.
    const list = (pts, head) => pts.length ? h('div', {}, head && h('h3', {}, head), h('table', { class: 'list print occlist' },
      h('colgroup', {}, ['7%', '21%', '32%', '40%'].map((w) => h('col', { style: `width:${w}` }))),
      h('thead', {}, h('tr', {}, ['Bed', 'Patient · POD', 'Diagnosis / Surgery', 'Instructions'].map((t) => h('th', {}, t)))),
      h('tbody', {}, pts.map((a) => { const pod = podText(a, date); return h('tr', {},
        h('td', {}, h('b', {}, a.bed_on_date)),
        h('td', {}, h('b', {}, a.name), h('div', {}, ageSex(a, date)), pod ? h('div', {}, pod) : null),
        h('td', {}, a.diagnosis, a.procedure_done ? h('div', { class: 'occsx' }, a.procedure_done) : null),
        h('td', { class: 'blank' })); })))) : null;
    sheet.replaceChildren(
      h('h2', {}, 'Bed Occupancy'),
      h('table', { class: 'print occgrid' },
        h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c.title)))),
        h('tbody', {},
          Array.from({ length: rows }, (_, i) => h('tr', {}, cols.map((c) => h('td', {}, c.beds[i] || '')))),
          h('tr', { class: 'occcount' }, cols.map((c) => { const n = c.n ?? c.beds.length; return h('td', {}, c.of ? `${n > c.of ? '⚠ ' : ''}${n}/${c.of}` : String(n)); })))),
      listUnit && h('h2', { class: 'occlisthead' }, `${listUnit} · ${mine.length + mineEm.length + mineIcu.length} patients`),
      listUnit && (mine.length + mineEm.length + mineIcu.length ? h('div', {}, list(mine), list(mineEm, 'In emergency beds'), list(mineIcu, 'ICU (6C)')) : h('p', {}, 'No patients.')));
  };
  drawSheet();
  const pick = h('select', { onchange: (e) => { listUnit = e.target.value; drawSheet(); } },
    units.map((u) => h('option', { value: u.name, selected: u.name === listUnit }, u.name)));

  main.append(
    h('div', { class: 'toolbar' }, h('h2', {}, 'Bed Occupancy · ', fmtDay(date)),
      h('div', { class: 'actions' }, h('label', { class: 'inline' }, 'Print list for ', pick), h('button', { class: 'primary', onclick: () => window.print() }, 'Print'))),
    sheet,
    h('p', { class: 'muted' }, `6B and 6A: ${ward.length} of ${wardBeds.length} beds occupied. Emergency beds (${S.meta.emergencyBeds.join(', ')}) are counted separately. Click a box to see the patients.`),
    h('div', { class: 'cgrid' },
      S.meta.units.map((u) => {
        const pts = ward.filter((a) => a.unit === u.name && !emergency.has(a.bed_on_date));
        return box(u.name, pts.length, u.beds, () => occupancyPanel(u.name, pts, icu.filter((a) => a.unit === u.name), date, true));
      }),
      box('Emergency', emerg.length, S.meta.emergencyBeds.length, () => occupancyPanel('Emergency beds', emerg, [], date), 'emerg'),
      noUnit.length ? box('No consultant set', noUnit.length, 0, () => occupancyPanel('No consultant set', noUnit, [], date)) : null));
  main.querySelectorAll(':scope > :not(.occsheet)').forEach((el) => el.classList.add('noprint'));
}

// Details of every patient in one consultant's beds (or the emergency beds), with their ICU babies listed separately below.
function occupancyPanel(title, pts, icuPts, date, isUnit) {
  const root = document.getElementById('modal-root');
  const close = () => root.replaceChildren();
  const table = (rows, icuTable) => rows.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'list' },
    h('thead', {}, h('tr', {}, ['Bed', 'Name', 'UHID', 'Age / Sex', !isUnit && 'Consultant', 'Diagnosis', 'Surgery', 'POD', 'Day'].filter(Boolean).map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((a) => h('tr', { class: 'clickable', onclick: () => { close(); location.hash = 'patient/' + a.id; } },
      h('td', {}, h('span', { class: 'bedno' }, a.bed_on_date)), h('td', {}, h('b', {}, a.name)), h('td', {}, a.ip_no),
      h('td', {}, ageSex(a, date)), !isUnit && h('td', {}, a.unit), h('td', {}, a.diagnosis), h('td', {}, a.procedure_done),
      h('td', {}, podText(a, date).replace('POD ', '')), h('td', {}, dayNo(a, date))))))) :
    h('p', { class: 'muted' }, icuTable ? 'No ICU babies.' : 'No patients.');
  root.replaceChildren(h('div', { class: 'backdrop', onclick: (e) => e.target === e.currentTarget && close() },
    h('div', { class: 'modal card panel' },
      h('div', { class: 'mhead' }, h('h2', {}, `${title} · ${pts.length} patient${pts.length === 1 ? '' : 's'}`),
        h('div', { class: 'btns' },
          isUnit && !isViewer() && h('a', { class: 'button ghost small', href: '#notes/' + encodeURIComponent(title), onclick: close }, 'Round notes'),
          isUnit && S.user.role === 'admin' && h('a', { class: 'button ghost small', href: '#otlog/' + encodeURIComponent(title), onclick: close }, 'Logbook'),
          h('button', { type: 'button', class: 'ghost small', onclick: close }, 'Close'))),
      table(pts),
      isUnit && [h('h3', { class: 'icuhead' }, `ICU (6C) · ${icuPts.length}`), table(icuPts, true)])));
}

// ---------- One consultant's round notes (e.g. SA's instructions per patient) ----------

async function notesView(main, unit) {
  const date = S.date;
  const go = (d) => { S.date = d; render(); };
  const data = await api('GET', '/api/register?date=' + date);
  const emergency = new Set(S.meta.emergencyBeds);
  const order = S.meta.sections.flatMap((s) => s.beds);
  const pts = data.admissions.filter((a) => a.unit === unit && a.discharge_date !== date)
    .sort((x, y) => order.indexOf(x.bed_on_date) - order.indexOf(y.bed_on_date));
  const boxes = new Map();

  const saveAll = async () => {
    try {
      for (const a of pts) {
        const v = boxes.get(a.id).value.trim();
        if (v !== (a.unit_note || '')) await api('PUT', `/api/notes/${a.id}/${date}`, { note: v });
      }
      toast('Round notes saved');
      render();
    } catch (e) { toast(e.message, true); }
  };

  main.append(
    h('div', { class: 'toolbar' },
      h('a', { href: '#census', class: 'button ghost' }, '‹ Bed Occupancy'),
      h('div', { class: 'datenav' },
        h('button', { class: 'ghost', onclick: () => go(addDays(date, -1)), 'aria-label': 'Previous day' }, '‹'),
        h('input', { type: 'date', value: date, onchange: (e) => e.target.value && go(e.target.value) }),
        h('button', { class: 'ghost', onclick: () => go(addDays(date, 1)), 'aria-label': 'Next day' }, '›')),
      h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: () => window.print() }, 'Print'), h('button', { class: 'primary', onclick: saveAll }, 'Save all'))),
    h('h2', {}, `${unit} round notes · ${fmtDay(date)}`),
    h('p', { class: 'muted noprint' }, `Instructions ${unit} gives for each patient on the morning round. They also show on each patient's card in the register.`),
    pts.length ? h('div', { class: 'notes' }, pts.map((a) => {
      const box = h('textarea', { rows: 2, placeholder: 'Instructions for this patient' }, a.unit_note || '');
      boxes.set(a.id, box);
      return h('div', { class: 'card note' },
        h('div', { class: 'head' },
          h('span', { class: 'bedno' }, a.bed_on_date),
          h('div', { class: 'who' }, h('a', { href: '#patient/' + a.id, class: 'pname' }, a.name),
            h('span', { class: 'muted' }, [a.diagnosis, a.procedure_done].filter(Boolean).join(' · '))),
          h('div', { class: 'badges' }, stayBadges(a, date), emergency.has(a.bed_on_date) && h('span', { class: 'badge out' }, 'Emergency bed'))),
        box,
        a.prev_unit_note ? h('p', { class: 'prev' }, 'Yesterday: ' + a.prev_unit_note) : null);
    })) : h('p', { class: 'muted' }, `No ${unit} patients in the ward on this date.`));
}

// ---------- Admin ----------

function adminView(main, tab) {
  const tabs = { users: 'Users', params: 'Round fields', beds: 'Beds & units', import: 'Import', archive: 'Archive', look: 'Appearance', log: 'Activity log' };
  main.append(h('h2', {}, 'Admin'), h('div', { class: 'tabs' }, Object.entries(tabs).map(([k, v]) => h('a', { href: '#admin/' + k, class: k === tab ? 'active' : '' }, v))));
  const body = h('div', {});
  main.append(body);
  ({ users: adminUsers, params: adminParams, beds: adminBeds, import: adminImport, archive: adminArchive, look: adminLook, log: adminLog })[tab](body);
}

// Once a year: patients discharged more than a year ago move to the archive tab of the Google Sheet.
async function adminArchive(body) {
  const plan = await api('GET', '/api/archive/plan');
  const btn = plan.patients ? h('button', { class: 'primary', onclick: async () => {
    if (!confirm(`Move ${plan.patients} patient${plan.patients === 1 ? '' : 's'} discharged before ${fmtDate(plan.cutoff)} to the archive?`)) return;
    btn.disabled = true; btn.textContent = 'Archiving…';
    try { const n = await Sync.archive(plan.ids); toast(`Archived ${plan.patients} patient${plan.patients === 1 ? '' : 's'} (${n} entries)`); render(); }
    catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Move to archive'; }
  } }, 'Move to archive') : null;
  body.append(h('div', { class: 'card' },
    h('h3', {}, 'Archive old patients'),
    h('p', {}, `This moves patients discharged before ${fmtDate(plan.cutoff)} (more than a year ago), with their rounds, notes and OT findings, to an "archive" tab in your Google Sheet. Phones and laptops then stop carrying them, which keeps the app quick. OT lists and the Logbook are not affected.`),
    h('p', {}, 'Archived patients can still be found with "Search the archive" at the bottom of the Status tab.'),
    h('p', {}, h('b', {}, plan.patients ? `${plan.patients} patient${plan.patients === 1 ? '' : 's'} can be archived now.` : 'No one was discharged more than a year ago, so there is nothing to archive yet.')),
    btn,
    h('p', { class: 'muted small' }, 'Needs internet, and the updated Code.gs in your Google Apps Script.')));
}

async function adminUsers(body) {
  const users = await api('GET', '/api/users');
  const err = h('p', { class: 'error' });
  const form = h('form', { class: 'card grid4', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/users', { name: form.fullname.value, username: form.username.value, initials: form.initials.value, role: form.role.value, password: form.password.value });
      S.meta = await api('GET', '/api/meta');
      toast('User added'); render();
    } catch (x) { err.textContent = x.message; }
  } },
  h('h3', { class: 'span4' }, 'Add a user'),
  h('label', {}, 'Name', h('input', { name: 'fullname', required: true, placeholder: 'Dr A. Sharma' })),
  h('label', {}, 'Username', h('input', { name: 'username', required: true, autocapitalize: 'none' })),
  h('label', {}, 'Initials (for scrub team)', h('input', { name: 'initials', maxlength: 4, placeholder: 'NP', autocapitalize: 'characters', style: 'text-transform: uppercase' })),
  h('label', {}, 'Role', h('select', { name: 'role' }, Object.entries(ROLE_NAMES).map(([k, v]) => h('option', { value: k, selected: k === 'jr' }, v)))),
  h('label', {}, 'Starting password', h('input', { name: 'password', required: true, minlength: 6 })),
  err, h('button', { class: 'primary span4' }, 'Add user'));

  body.append(
    h('p', { class: 'muted' }, 'SR and JR: admit, edit, move and discharge patients, fill rounds and post OT notes. Consultant: sees the registers, Bed Occupancy and Status, and adds their own round notes (Bed Occupancy > their box > Round notes). Admin (SR): everything, plus this page.'),
    h('div', { class: 'tablewrap' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, ['Name', 'Initials', 'Username', 'Role', 'Active', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, users.map((u) => {
        const role = h('select', { onchange: async () => { await update(u, { role: role.value }); } },
          Object.entries(ROLE_NAMES).map(([k, v]) => h('option', { value: k, selected: k === u.role }, v)));
        return h('tr', { class: u.active ? '' : 'inactive' },
          h('td', {}, u.name),
          h('td', {}, h('input', { class: 'initin', value: u.initials || '', maxlength: 4, placeholder: '—', style: 'text-transform: uppercase', onchange: async (e) => { await update(u, { initials: e.target.value }); S.meta = await api('GET', '/api/meta'); } })),
          h('td', {}, u.username), h('td', {}, role),
          h('td', {}, h('input', { type: 'checkbox', checked: !!u.active, onchange: (e) => update(u, { active: e.target.checked }) })),
          h('td', {}, h('button', { class: 'ghost small', onclick: async () => {
            const p = prompt(`New password for ${u.name} (at least 6 characters):`);
            if (p) { await update(u, { password: p }); toast('Password reset'); }
          } }, 'Reset password')));
      })))),
    form);

  async function update(u, changes) {
    try { await api('PUT', '/api/users/' + u.id, changes); toast('Saved'); } catch (e) { toast(e.message, true); render(); }
  }
}

async function adminParams(body) {
  S.meta = await api('GET', '/api/meta');
  const err = h('p', { class: 'error' });
  const form = h('form', { class: 'card grid4', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/params', { label: form.label.value, group: form.group.value, type: form.type.value, unit: form.unit.value, options: form.options.value });
      S.meta = await api('GET', '/api/meta'); toast('Field added'); render();
    } catch (x) { err.textContent = x.message; }
  } },
  h('h3', { class: 'span4' }, 'Add a round field for everyone'),
  h('label', {}, 'Name', h('input', { name: 'label', required: true, placeholder: 'e.g. Abdominal girth' })),
  h('label', {}, 'For', h('select', { name: 'group' }, h('option', { value: 'ward' }, 'Ward patients'), h('option', { value: 'icu' }, 'ICU babies'))),
  h('label', {}, 'Type', h('select', { name: 'type' }, h('option', { value: 'number' }, 'Number'), h('option', { value: 'yesno' }, 'Yes / No'), h('option', { value: 'choice' }, 'Pick from list'), h('option', { value: 'text' }, 'Free text'))),
  h('label', {}, 'Unit', h('input', { name: 'unit', placeholder: 'ml, cm, °F' })),
  h('label', {}, 'List choices (comma separated)', h('input', { name: 'options', placeholder: 'Only for "Pick from list"' })),
  err, h('button', { class: 'primary span4' }, 'Add field'));

  body.append(
    h('p', { class: 'muted' }, 'The standard round fields. Each patient starts with all the fields for their ward or the ICU switched on, and the Ward SR switches off the ones not needed (Rounds > Edit details / fields). Turning a field off here hides it for new patients but keeps old entries.'),
    h('div', { class: 'tablewrap' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, ['Order', 'Name', 'For', 'Type', 'Unit', 'Choices', 'In use'].map((t) => h('th', {}, t)))),
      h('tbody', {}, [...S.meta.params].sort((x, y) => !x.group - !y.group || x.sort - y.sort).map((p) => {
        const save = async (changes) => { try { await api('PUT', '/api/params/' + p.key, changes); toast('Saved'); S.meta = await api('GET', '/api/meta'); } catch (e) { toast(e.message, true); } };
        return h('tr', { class: p.active ? '' : 'inactive' },
          h('td', {}, h('input', { class: 'narrow', value: p.sort, onchange: (e) => save({ sort: e.target.value }) })),
          h('td', {}, h('input', { value: p.label, onchange: (e) => save({ label: e.target.value }) })),
          h('td', {}, { ward: 'Ward', icu: 'ICU' }[p.group] || 'Old list'),
          h('td', {}, { number: 'Number', yesno: 'Yes / No', choice: 'Pick from list', text: 'Free text' }[p.type]),
          h('td', {}, h('input', { class: 'narrow', value: p.unit, onchange: (e) => save({ unit: e.target.value }) })),
          h('td', {}, p.type === 'choice' ? h('input', { value: p.options, onchange: (e) => save({ options: e.target.value }) }) : ''),
          h('td', {}, h('input', { type: 'checkbox', checked: !!p.active, onchange: (e) => save({ active: e.target.checked }) })));
      })))),
    form);
}

function adminBeds(body) {
  const ta = h('textarea', { rows: 24, class: 'mono' }, S.meta.bedsText);
  const units = h('textarea', { rows: 10, class: 'mono' }, S.meta.unitsText);
  const emerg = h('input', { value: S.meta.emergencyBeds.join(', ') });
  body.append(
    h('div', { class: 'card grid2' },
      h('label', {}, 'Consultant units and beds allotted (one per line, e.g. "SA 12")', units),
      h('div', {}, h('label', {}, 'Emergency beds (comma separated)', emerg),
        h('button', { class: 'primary', onclick: async () => {
          try { await api('PUT', '/api/units', { units: units.value, emergency_beds: emerg.value }); S.meta = await api('GET', '/api/meta'); toast('Units saved'); } catch (e) { toast(e.message, true); }
        } }, 'Save units'))),
    h('h3', {}, 'Bed list'),
    h('p', { class: 'muted' }, 'One bed per line, in the order you want them shown. A line starting with # begins a new section. To open a blocked bed, add it here.'),
    ta,
    h('div', { class: 'actions' },
      h('button', { class: 'primary', onclick: async () => {
        try { await api('PUT', '/api/beds', { text: ta.value }); S.meta = await api('GET', '/api/meta'); toast('Bed list saved'); } catch (e) { toast(e.message, true); }
      } }, 'Save bed list'),
      h('button', { class: 'ghost', onclick: downloadBackup }, 'Download a backup file')));
}

async function downloadBackup() {
  const data = await api('GET', '/api/export');
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `ward-register-backup-${S.meta.today}.json` });
  document.body.append(a); a.click(); a.remove();
  toast('Backup downloaded. It is not encrypted, so keep it safe.');
}

// ---------- Duty roster strip on the Ward Register ----------
// Rows: WIC, ICU · SR on call, Consultant on call · OT 11/14, OT 12/15, SR Assist. Initials become full names.
const ROSTER_ROWS = [[['wic', 'WIC'], ['icu', 'ICU']], [['call', 'SR on call'], ['cons_call', 'Consultant on call']], [['ot1', 'OT 11/14'], ['ot2', 'OT 12/15'], ['assist', 'SR Assist']]];
function rosterName(x, names) {
  x = (x || '').trim();
  if (!x) return '';
  return x.split('/').map((p) => p.trim()).filter(Boolean).map((p) => {
    const up = p.toUpperCase();
    const c = SURGEONS.find(([i]) => i === up);
    if (c) return c[1];
    const u = ((S.meta && S.meta.people) || []).find((q) => q.initials === up);
    const n = (u && u.name) || names[up] || (/^[A-Z]{1,4}$/.test(p) ? (SR_INITIALS.find(([i]) => i === up) || [])[1] : p) || p;
    return /^dr\.?\s/i.test(n) ? n : 'Dr ' + n;
  }).join(' / ');
}
// Duties run 8 am to 8 am: before 8 am today, the strip still shows yesterday's team.
const rosterDay = (date) => (date === localStamp(new Date()).slice(0, 10) && new Date().getHours() < 8 ? addDays(date, -1) : date);
const GRID_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
const iconBtn = (svg, title, onclick, cls = 'pencil') => { const b = h('button', { type: 'button', class: cls, title, 'aria-label': title, onclick }); b.innerHTML = svg; return b; };
function rosterStrip(regDate) {
  const date = rosterDay(regDate);
  let view = date; // the day being looked at; the arrows move it
  const box = h('div', { class: 'roster' });
  const dayLabel = (d) => d === date ? (date !== regDate ? 'On duty until 8 am' : 'On duty today') : d === addDays(date, 1) ? 'Tomorrow' : d === addDays(date, -1) ? 'Yesterday' : 'On duty';
  const go = (k) => { view = addDays(view, k); load(); };
  const head = (names) => h('div', { class: 'rosterhead' },
    h('button', { type: 'button', class: 'ghost small rarrow', title: 'Previous day', onclick: () => go(-1) }, '‹'),
    h('div', { class: 'rday' }, h('b', {}, dayLabel(view)), h('span', { class: 'muted small' }, fmtDay(view))),
    h('button', { type: 'button', class: 'ghost small rarrow', title: 'Next day', onclick: () => go(1) }, '›'),
    view !== date && h('button', { type: 'button', class: 'ghost small', onclick: () => { view = date; load(); } }, 'Today'),
    h('span', { class: 'grow' }),
    iconBtn(GRID_SVG, 'Whole month', () => rosterMonth(view.slice(0, 7), date, (d) => { view = d; load(); })),
    canEdit() && iconBtn(PENCIL_SVG, 'Edit duties for this day', () => edit(cur, names)));
  let cur = null;
  const draw = (day, names) => {
    cur = day;
    if (!day && view === date && !canEdit()) { box.hidden = true; return; }
    box.hidden = false;
    box.replaceChildren(head(names), day
      ? h('div', { class: 'rosterrows' }, ...ROSTER_ROWS.map((row) => h('div', { class: 'rosterrow', style: `grid-template-columns: repeat(${row.length}, minmax(0, 1fr))` },
        row.map(([k, label]) => h('div', { class: 'rcell' }, h('span', { class: 'rlabel' }, label), h('b', {}, rosterName(day[k], names) || '—'))))))
      : h('p', { class: 'muted small' }, canEdit() ? 'No duty roster for this day. Import the month in Admin > Import, or tap the pencil to fill it in.' : 'No duty roster for this day.'));
  };
  const edit = (day, names) => {
    const d = day || {};
    const inputs = {};
    box.replaceChildren(h('div', { class: 'grow' },
      h('p', { class: 'small muted' }, h('b', {}, fmtDay(view)), ' · Type initials (NP, PG/SN) or names. For leave or swaps.'),
      h('div', { class: 'rosteredit' }, ROSTER_ROWS.flat().map(([k, label]) => h('label', {}, label, (inputs[k] = h('input', { value: d[k] || '', autocapitalize: 'characters' }))))),
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'ghost small', onclick: () => draw(day, names) }, 'Cancel'),
        h('button', { type: 'button', class: 'primary small', onclick: async () => {
          const out = {}; for (const k in inputs) out[k] = inputs[k].value.trim();
          try { await api('PUT', '/api/roster/' + view, out); toast('Duties saved'); load(); } catch (e) { toast(e.message, true); }
        } }, 'Save'))));
  };
  const load = () => api('GET', '/api/roster/' + view).then((r) => draw(r.day, r.names)).catch(() => { box.hidden = true; });
  box.hidden = true;
  load();
  return box;
}
// The whole month's roster as a table (initials; full names listed underneath). Tapping a day shows it on the strip.
async function rosterMonth(month, today, pick) {
  const root = document.getElementById('modal-root');
  const close = () => root.replaceChildren();
  const card = h('div', { class: 'modal card rmonth' });
  root.replaceChildren(h('div', { class: 'backdrop', onclick: (e) => e.target === e.currentTarget && close() }, card));
  const shiftM = (m, k) => { const x = new Date(+m.slice(0, 4), +m.slice(5, 7) - 1 + k, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; };
  const draw = async (m) => {
    let r; try { r = await api('GET', '/api/rostermonth/' + m); } catch (e) { toast(e.message, true); return; }
    const byDate = Object.fromEntries(r.days.map((d) => [d.date, d]));
    const cols = ROSTER_ROWS.flat();
    const used = new Set();
    const days = []; for (let d = m + '-01'; d.slice(0, 7) === m; d = addDays(d, 1)) days.push(d);
    const cell = (v) => { v = (v || '').trim(); v.split('/').map((x) => x.trim().toUpperCase()).filter(Boolean).forEach((x) => used.add(x)); return h('td', { title: rosterName(v, r.names) }, v || '—'); };
    const rows = days.map((d) => { const x = byDate[d]; const wd = new Date(d + 'T00:00').toLocaleDateString('en-GB', { weekday: 'short' });
      return h('tr', { class: (d === today ? 'today ' : '') + (wd === 'Sun' || wd === 'Sat' ? 'wkend' : ''), onclick: () => { close(); pick(d); } },
        h('th', {}, `${+d.slice(8)} ${wd}`), x ? cols.map(([k]) => cell(x[k])) : h('td', { colspan: cols.length, class: 'muted' }, 'No roster')); });
    const legend = [...used].sort().map((i) => [i, rosterName(i, r.names)]).filter(([i, n]) => n && n.replace(/^Dr\s*/, '').toUpperCase() !== i);
    const monthName = new Date(+m.slice(0, 4), +m.slice(5, 7) - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    card.replaceChildren(
      h('div', { class: 'mhead' },
        h('div', { class: 'rosterhead' }, h('button', { type: 'button', class: 'ghost small rarrow', onclick: () => draw(shiftM(m, -1)) }, '‹'), h('h2', {}, 'Duty roster · ', monthName), h('button', { type: 'button', class: 'ghost small rarrow', onclick: () => draw(shiftM(m, 1)) }, '›')),
        h('button', { type: 'button', class: 'ghost small', onclick: close }, 'Close')),
      h('p', { class: 'muted small' }, 'Tap a day to show it on the Ward Register.'),
      h('div', { class: 'tablewrap' }, h('table', { class: 'list rmtable' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Day'), cols.map(([, label]) => h('th', {}, label)))),
        h('tbody', {}, rows))),
      legend.length ? h('p', { class: 'small rlegend' }, legend.map(([i, n], k) => [k ? ' · ' : '', h('b', {}, i), ' ', n.replace(/^Dr\s*/, '')])) : '');
    const t = card.querySelector('tr.today'); if (t) t.scrollIntoView({ block: 'center' });
  };
  draw(month);
}
// Import the month's duty roster (a file Claude makes from the roster PDFs).
function rosterImportCard() {
  const result = h('div', {});
  let data = null;
  const go = h('button', { class: 'primary', disabled: true, onclick: async () => {
    go.disabled = true;
    try { const r = await api('POST', '/api/roster/import', data); result.replaceChildren(h('p', {}, h('b', {}, `${r.days} days imported.`), ' They show on the Ward Register under the search bar.')); toast('Roster imported'); } catch (e) { toast(e.message, true); go.disabled = false; }
  } }, 'Import roster');
  const file = h('input', { type: 'file', accept: '.json,application/json', onchange: async () => {
    result.replaceChildren(); data = null; go.disabled = true;
    try {
      const d = JSON.parse(await file.files[0].text());
      if (!d || d.kind !== 'register-roster' || !Array.isArray(d.days)) throw new Error('This is not a duty roster file.');
      data = d;
      result.replaceChildren(h('p', {}, `${d.days.length} days found (${fmtDate(d.days[0].date)} to ${fmtDate(d.days[d.days.length - 1].date)}). Duties in this file replace those days' entries; anything not in the file is kept.`));
      go.disabled = false;
    } catch (e) { result.replaceChildren(h('p', { class: 'error' }, e.message)); }
  } });
  return h('div', { class: 'card' }, h('h3', {}, 'Import duty roster'),
    h('p', { class: 'muted' }, 'Choose the roster file for the month (roster-YYYY-MM.json). Edits made with the pencil on the Ward Register are replaced for those days.'),
    file, go, result);
}

// Import file: patients converted from the department's Google Sheet.
function adminImport(body) {
  const result = h('div', {});
  let patients = null;
  const go = h('button', { class: 'primary', disabled: true, onclick: async () => {
    go.disabled = true;
    try {
      const replace = mode.querySelector('input:checked').value === 'replace';
      if (replace && !confirm('This erases every patient now in the app, with their rounds, notes and OT entries, on every device. Then it imports the file. Continue?')) { go.disabled = false; return; }
      const r = await api('POST', '/api/import', { patients, replace });
      S.meta = await api('GET', '/api/meta');
      result.replaceChildren(h('div', {},
        h('p', {}, r.removed ? `${r.removed} old patients erased. ` : '', h('b', {}, `${r.added.length} patients added.`), r.skipped.length ? ` ${r.skipped.length} skipped:` : ''),
        r.skipped.length ? h('ul', { class: 'small' }, r.skipped.map((s) => h('li', {}, s))) : null,
        h('a', { class: 'button ghost', href: '#register' }, 'Open the Ward Register')));
      toast('Import finished');
    } catch (e) { toast(e.message, true); go.disabled = false; }
  } }, 'Import patients');
  const mode = h('div', { class: 'grid1' },
    h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'impmode', value: 'add', checked: true }), 'Add to the patients already in the app (beds already taken are skipped)'),
    h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'impmode', value: 'replace' }), h('span', {}, h('b', {}, 'Replace: '), 'erase all patients now in the app, then import this file')));
  const file = h('input', { type: 'file', accept: '.json,application/json', onchange: async () => {
    result.replaceChildren(); patients = null; go.disabled = true;
    try {
      const data = JSON.parse(await file.files[0].text());
      if (!data || data.kind !== 'ward-register-import' || !Array.isArray(data.patients)) throw new Error('This is not a Register import file.');
      patients = data.patients;
      result.replaceChildren(h('p', {}, `${patients.length} patients found in this file: `, patients.map((p) => p.bed).join(', ')));
      go.disabled = false;
    } catch (e) { result.replaceChildren(h('p', { class: 'error' }, e.message)); }
  } });
  body.append(h('div', { class: 'card grid1 look' },
    h('h3', {}, 'Import patients'),
    h('p', { class: 'muted' }, 'Choose the import file (ward-register-import.json) made from your Google Sheet. Each patient goes into their bed. Choose whether to add to the patients already here or replace them.'),
    file, mode, go, result), rosterImportCard());
}

function adminLook(body) {
  const choices = [['light', 'Light'], ['dark', 'Dark'], ['auto', 'Follow each device']];
  const set = async (theme) => {
    try { await api('PUT', '/api/theme', { theme }); S.meta = await api('GET', '/api/meta'); toast('Appearance saved'); render(); } catch (e) { toast(e.message, true); }
  };
  body.append(h('div', { class: 'card look' },
    h('h3', {}, 'Light or dark'),
    h('p', { class: 'muted' }, 'This sets the look of the app on every phone and laptop in the ward. Other devices change the next time they sync.'),
    h('div', { class: 'seg seg3' }, choices.map(([k, v]) => h('button', { type: 'button', class: S.meta.theme === k ? 'on' : '', onclick: () => set(k) }, v)))));
}

async function adminLog(body) {
  const rows = await api('GET', '/api/audit');
  body.append(h('div', { class: 'tablewrap' }, h('table', { class: 'list' },
    h('thead', {}, h('tr', {}, ['When', 'Who', 'What', 'Details'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.at), h('td', {}, r.name || ''), h('td', {}, r.action), h('td', {}, r.detail)))))));
}

// ---------- Census: monthly totals for the department, then 6A / 6B / 6C. Each tile opens its list of patients. ----------
const OUTCOME_TILES = [['Discharged', 'Discharged'], ['Expired', 'Death'], ['LAMA', 'LAMA'], ['Referred', 'Referred'], ['Transferred to other unit', 'Transfer']];
function censusTable(kind, rows) {
  if (!rows.length) return h('p', { class: 'muted' }, 'No patients.');
  const name = (r) => h('td', {}, r.id ? h('a', { href: '#patient/' + r.id, class: 'pname' }, r.name) : h('b', {}, r.name), h('div', { class: 'muted small' }, [r.uhid, [r.age, r.sex].filter(Boolean).join('/')].filter(Boolean).join(' · ')));
  if (kind === 'ot') {
    rows = [...rows].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    return h('div', { class: 'tablewrap' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, ['Date', 'OT', 'Patient', 'Bed', 'Consultant', 'Diagnosis', 'Procedure'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, fmtDate(r.date)), h('td', {}, r.ot), name(r), h('td', {}, r.bed), h('td', {}, r.unit), h('td', {}, r.diagnosis),
        h('td', {}, r.procedure, r.reason ? h('div', { class: 'small outcome-bad' }, 'Cancelled: ' + r.reason) : null))))));
  }
  const by = kind === 'out' ? 'discharge_date' : 'admit_date';
  rows = [...rows].sort((x, y) => ((x[by] || '') < (y[by] || '') ? -1 : 1));
  return h('div', { class: 'tablewrap' }, h('table', { class: 'list' },
    h('thead', {}, h('tr', {}, ['Patient', 'Bed', 'Unit', 'Diagnosis', 'Procedure', 'Admitted', 'Discharged'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, name(r), h('td', {}, r.bed), h('td', {}, r.unit), h('td', {}, r.diagnosis), h('td', {}, r.procedure),
      h('td', {}, r.admit_date ? fmtDate(r.admit_date) : ''),
      h('td', {}, r.discharge_date ? fmtDate(r.discharge_date) : h('span', { class: 'badge new' }, 'In ward'),
        r.outcome && r.outcome !== 'Discharged' ? h('div', { class: 'small outcome-bad' }, r.outcome) : null))))));
}

async function monthlyView(main, arg) {
  const m = /^\d{4}-\d{2}$/.test(arg || '') ? arg : S.meta.today.slice(0, 7);
  const d = await api('GET', '/api/monthly?month=' + m);
  const monthName = (mm, short) => new Date(+mm.slice(0, 4), +mm.slice(5, 7) - 1, 1).toLocaleDateString('en-GB', short ? { month: 'short' } : { month: 'long', year: 'numeric' });
  const shiftM = (k) => { const x = new Date(+m.slice(0, 4), +m.slice(5, 7) - 1 + k, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; };
  const next = shiftM(1), thisM = S.meta.today.slice(0, 7);
  const W = d.wards, ot = d.ot, WARDS = ['6A', '6B', '6C'];
  const join = (ws, k) => ws.flatMap((w) => W[w].lists[k]);

  // A row of tiles; clicking one shows its list underneath (click again to close).
  const tileSet = (tiles) => {
    let open = null;
    const grid = h('div', { class: 'summary census' }), panel = h('div', { class: 'censuslist' });
    const draw = () => {
      grid.replaceChildren(...tiles.map((t) => t.rows
        ? h('button', { class: 'stat ctile' + (open === t ? ' on' : '') + (t.cls ? ' ' + t.cls : ''), onclick: () => { open = open === t ? null : t; draw(); } },
          h('b', {}, t.n), h('span', {}, t.label), t.sub && h('small', { class: 'muted' }, t.sub))
        : h('div', { class: 'stat' + (t.cls ? ' ' + t.cls : '') }, h('b', {}, t.n), h('span', {}, t.label), t.sub && h('small', { class: 'muted' }, t.sub))));
      panel.replaceChildren(...(open ? [h('h4', {}, `${open.label} · ${open.rows.length}`), censusTable(open.kind, open.rows)] : []));
    };
    draw();
    return h('div', {}, grid, panel);
  };
  const outcomeTiles = (ws) => {
    const out = join(ws, 'discharged'), of = (o) => out.filter((r) => r.outcome === o);
    const deaths = of('Expired').length;
    return [
      ...OUTCOME_TILES.map(([o, label]) => ({ n: of(o).length, label, rows: of(o), kind: 'out', cls: o === 'Expired' && deaths ? 'warn' : '' })),
      { n: out.length ? (Math.round((deaths / out.length) * 1000) / 10) + '%' : '—', label: 'Mortality', sub: `${deaths} of ${out.length} discharged`, rows: of('Expired'), kind: 'out' },
    ];
  };

  const dept = tileSet([
    { n: join(WARDS, 'admitted').length, label: 'Admissions', sub: WARDS.map((w) => `${w} ${W[w].admissions}`).join(' · '), rows: join(WARDS, 'admitted'), kind: 'in' },
    { n: join(WARDS, 'discharged').length, label: 'Discharges', sub: WARDS.map((w) => `${w} ${W[w].discharges}`).join(' · '), rows: join(WARDS, 'discharged'), kind: 'out' },
    { n: ot.cases, label: 'Operations done', sub: `${ot.patients} patients · ${ot.planned} listed`, rows: ot.lists.operated, kind: 'ot' },
    { n: W['6A'].admissions + W['6B'].admissions, label: 'Ward admissions', sub: '6A + 6B', rows: join(['6A', '6B'], 'admitted'), kind: 'in' },
    { n: ot.daycare, label: 'Day care cases', sub: 'MCH2 / PAR', rows: ot.lists.daycare, kind: 'ot' },
    { n: ot.daycareConverted, label: 'Day care → ward', sub: 'admitted after surgery', rows: ot.lists.converted, kind: 'ot' },
    { n: ot.cancelled, label: 'Cases cancelled', sub: 'on the day', rows: ot.lists.cancelled, kind: 'ot', cls: ot.cancelled ? 'warn' : '' },
  ]);

  let ward = S.censusWard || '6B';
  const wardBox = h('div');
  const tabs = h('div', { class: 'seg seg3 wardtabs' });
  const drawWard = () => {
    tabs.replaceChildren(...WARDS.map((w) => h('button', { class: w === ward ? 'on' : '', onclick: () => { ward = S.censusWard = w; drawWard(); } }, w === '6C' ? '6C · ICU' : w)));
    const x = W[ward], occToday = m === thisM && x.occupancy.length ? x.occupancy[x.occupancy.length - 1] : null;
    wardBox.replaceChildren(
      tileSet([
        { n: x.admissions, label: 'Admissions', rows: x.lists.admitted, kind: 'in' },
        { n: x.discharges, label: 'Discharges', rows: x.lists.discharged, kind: 'out' },
        { n: x.operated, label: 'Operated', sub: 'patients in this ward', rows: x.lists.operated, kind: 'ot' },
        { n: occToday == null ? x.beds : `${occToday} / ${x.beds}`, label: occToday == null ? 'Beds' : 'Beds occupied today' },
        { n: x.avgOccupied ?? '—', label: 'Average beds occupied', sub: x.occupancyPct != null ? `${x.occupancyPct}% occupancy` : '' },
        { n: x.avgStay ?? '—', label: 'Average stay (days)', sub: 'of those discharged' },
      ]),
      h('h4', { class: 'censussub' }, 'Outcomes'),
      tileSet(outcomeTiles([ward])));
  };
  drawWard();

  main.append(
    h('div', { class: 'toolbar' }, h('h2', {}, 'Census · ', monthName(m)),
      h('div', { class: 'actions otdaynav' },
        h('a', { class: 'button', href: '#monthly/' + shiftM(-1) }, '‹ ', monthName(shiftM(-1), true)),
        m !== thisM && h('a', { class: 'button', href: '#monthly/' + thisM }, 'This month'),
        next <= thisM && h('a', { class: 'button', href: '#monthly/' + next }, monthName(next, true), ' ›'))),
    h('p', { class: 'muted' }, (m === thisM ? `Up to today, ${fmtDay(S.meta.today)}. ` : '') + 'Click a box to see the patients. Patients imported without an admission date are not counted as admissions.'),
    dept,
    h('h3', { class: 'censushead' }, 'Outcomes'), tileSet(outcomeTiles(WARDS)),
    h('h3', { class: 'censushead' }, 'Wards'), tabs, wardBox);
}

boot().catch((e) => { document.getElementById('app').replaceChildren(h('p', { class: 'error center' }, 'The app could not start on this browser. ' + e.message)); });
