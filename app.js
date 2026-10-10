// Ward Register front end. Plain JavaScript, no libraries, works offline.
'use strict';

const ROLE_NAMES = { admin: 'Admin (SR)', sr: 'SR', jr: 'JR', consultant: 'Consultant' };
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
  const pods = [a.surgery_date, a.surgery_date2, a.surgery_date3].filter((d) => d && d <= date).map((d) => daysBetween(d, date));
  if (!pods.length) return '';
  return pods.length === 1 && pods[0] === 0 ? 'Op day' : 'POD ' + pods.join('/');
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

function render() {
  applyTheme();
  const app = document.getElementById('app');
  app.replaceChildren();
  if (!Sync.configured()) return app.append(connectView());
  if (S.setupNeeded) return app.append(setupView());
  if (!S.user) return app.append(loginView());
  const [route, arg] = location.hash.replace(/^#\/?/, '').split('/');
  app.append(topBar(route || 'register'));
  drawSyncChip(Sync.status());
  const main = h('main', {});
  app.append(main);
  if (route === 'patients') statusView(main);
  else if (route === 'patient') patientView(main, arg);
  else if (route === 'print') printView(main, arg || S.date, location.hash.split('/')[2] || '');
  else if (route === 'census') censusView(main);
  else if (route === 'ot') arg ? otDatesView(main, arg) : otHomeView(main);
  else if (route === 'otlist') otListView(main, decodeURIComponent(arg || ''));
  else if (route === 'otlog') otLogView(main, decodeURIComponent(arg || ''));
  else if (route === 'rounds' && canEdit()) roundsView(main);
  else if (route === 'notes') notesView(main, decodeURIComponent(arg || ''));
  else if (route === 'admin' && S.user.role === 'admin') adminView(main, arg || 'users');
  else if (route === 'icu') registerView(main, 'icu');
  else registerView(main, 'ward');
}

function topBar(route) {
  const link = (r, label) => h('a', { href: '#' + r, class: route === r || (r === 'ot' && route === 'otlist') ? 'active' : '' }, label);
  return h('header', { class: 'top' },
    h('div', { class: 'brand' }, h('img', { src: 'icon.svg', alt: '' }), h('div', {}, h('b', {}, 'Register'), h('small', {}, 'Department of Pediatric Surgery'))),
    h('nav', {}, link('register', 'Ward Register'), link('icu', 'ICU Register'), canEdit() && link('rounds', 'Rounds'), link('census', 'Bed Occupancy'), link('ot', 'OT Lists'), link('otlog', 'OT Log'), link('patients', 'Status'), S.user.role === 'admin' && link('admin', 'Admin')),
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
    alerts,
    h('h2', { class: 'daytitle' }, icuMode ? 'ICU Register · ' : 'Ward Register · ', fmtDay(date)));

  const summary = h('div', { class: 'summary' });
  const grid = h('div', { class: 'register' }, h('p', { class: 'loading' }, 'Loading…'));
  main.append(summary, grid);

  let data;
  try { data = await api('GET', '/api/register?date=' + date); } catch (e) { grid.replaceChildren(h('p', { class: 'error' }, e.message)); return; }
  S.dirty.clear();

  const inBed = (bed) => data.admissions.filter((a) => a.bed_on_date === bed && a.discharge_date !== date);
  drawOtAlerts(alerts, data.admissions, (a) => bedPanel(a.bed_on_date));

  function drawGrid() {
    const allBeds = sections.flatMap((s) => s.beds);
    const here = data.admissions.filter((a) => mine(a.bed_on_date));
    summary.replaceChildren(
      stat('Patients', here.filter((a) => a.discharge_date !== date).length),
      (() => { const empty = allBeds.filter((b) => !inBed(b).length); const el = stat('Empty beds', empty.length); el.classList.add('clickable'); el.title = 'Show the empty beds'; el.onclick = () => emptyBedsPanel(empty, date); return el; })(),
      stat('Admitted today', here.filter((a) => a.admit_date === date).length),
      stat('Discharged today', here.filter((a) => a.discharge_date === date).length));

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
function drawOtAlerts(box, admissions, open) {
  const since = otSeen() || localStamp(new Date(Date.now() - 24 * 3600e3)); // first time on this device: the last day
  const fresh = admissions.filter((a) => !a.discharge_date)
    .flatMap((a) => (a.ot || []).filter((o) => !o.mine && o.at > since).map((o) => ({ a, o })))
    .sort((x, y) => (x.o.at < y.o.at ? 1 : -1));
  if (!fresh.length) return box.replaceChildren();
  // A small bar with a bell; opening it shows every new entry and marks them all as read.
  const openList = () => {
    try { localStorage.setItem(otSeenKey(), fresh[0].o.at); } catch {}
    box.replaceChildren();
    const root = document.getElementById('modal-root');
    const close = () => root.replaceChildren();
    root.replaceChildren(h('div', { class: 'backdrop', onclick: (e) => e.target === e.currentTarget && close() },
      h('div', { class: 'modal card panel' },
        h('div', { class: 'mhead' }, h('h2', {}, `🔔 OT findings & instructions · ${fresh.length}`), h('div', { class: 'btns' }, h('button', { type: 'button', class: 'ghost small', onclick: close }, 'Close'))),
        h('ul', { class: 'otnotes' }, fresh.map(({ a, o }) => h('li', {},
          h('a', { href: 'javascript:void 0', onclick: () => { close(); open(a); } }, h('b', {}, a.bed_on_date), ` ${a.name}`),
          h('span', { class: 'muted small' }, ` · ${o.by || ''} · ${fmtDate(o.at.slice(0, 10))} ${o.at.slice(11, 16)}`),
          h('div', { class: 'otalert-text' }, o.text)))))));
  };
  box.replaceChildren(h('button', { type: 'button', class: 'otbar', onclick: openList },
    h('span', { class: 'bell', 'aria-hidden': 'true' }, '🔔'),
    h('b', {}, `${fresh.length} new OT finding${fresh.length === 1 ? '' : 's'} & instructions`),
    h('span', { class: 'muted small' }, 'Tap to view')));
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
  return h('ul', { class: 'otlist' }, entries.map((o) => h('li', {},
    h('small', { class: 'muted' }, `${fmtDate(o.at.slice(0, 10))} ${o.at.slice(11, 16)} · ${o.by || ''}`),
    onChanged && o.mine && h('button', { type: 'button', class: 'link small del', onclick: async () => {
      if (!confirm('Delete this entry?')) return;
      try { await api('DELETE', '/api/ot/' + encodeURIComponent(o.id)); toast('Deleted'); onChanged(); } catch (e) { toast(e.message, true); }
    } }, 'Delete'),
    o.text && h('div', {}, o.text),
    (o.scrub || []).length ? h('div', { class: 'team small' }, h('b', {}, 'Scrubbed: '), o.scrub.join('/'), o.surgery ? h('div', { class: 'muted' }, o.surgery) : null) : null)));
}

// Scrub-team initials. Consultants as in SURGEONS (SN is Dr Sachit Anand, SA is Dr Sandeep Agarwala), then the residents.
const SR_INITIALS = [['KI', 'Kiran'], ['JD', 'Jagadish'], ['SY', 'Shreya'], ['PA', 'Priyanjali'], ['DC', 'Deepak'], ['VN', 'Vinanti'], ['NN', 'Nikunj'], ['PS', 'Prateek'], ['TE', 'Tirth'], ['NP', 'Nidhi'],
  ['SG', 'Sugandha'], ['AR', 'Aranya'], ['VG', 'Vivek'], ['SD', 'Sakthi'], ['PD', 'Pratisruti'], ['KG', 'Kartavya'], ['NC', 'Nitin'], ['DV', 'Digvijay'], ['AM', 'Archisman'], ['SJ', 'Sarthak Jain']];
const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth'];
const roleName = (n) => (n === 1 ? 'Operating surgeon' : `${ORDINALS[n - 2] || n - 1 + 'th'} assistant`);
const roleShort = (n) => (n === 1 ? 'operating' : `${['1st', '2nd', '3rd'][n - 2] || n - 1 + 'th'} asst`);
const personName = (i) => { const p = [...SURGEONS, ...SR_INITIALS].find(([x]) => x === i); return p ? p[1] : i; };
function myInitials() {
  const name = (S.user && S.user.name || '').trim().replace(/^dr\.?\s+/i, ''), first = name.split(/\s+/)[0] || '';
  const c = SURGEONS.find(([, n]) => squash(n).replace(/^dr/, '') === squash(name).replace(/^dr/, ''));
  if (c) return c[0];
  const r = SR_INITIALS.find(([, n]) => n.toLowerCase() === name.toLowerCase()) || SR_INITIALS.find(([, n]) => !n.includes(' ') && n.toLowerCase() === first.toLowerCase());
  return r ? r[0] : '';
}

// Tap the people who scrubbed in, in order: 1 operating surgeon, 2 first assistant, 3 second assistant… Opens in place, no pop-up.
function scrubPicker(initial, onSave) {
  let team = [...(initial || [])];
  const known = new Set([...SURGEONS, ...SR_INITIALS].map(([i]) => i));
  const addIn = h('input', { placeholder: 'Name of the person', onkeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } } });
  const add = () => { const v = addIn.value.trim(); if (v && !team.includes(v)) team.push(v); addIn.value = ''; addRow.hidden = true; draw(); };
  const addRow = h('div', { class: 'saddrow' }, addIn, h('button', { type: 'button', class: 'ghost small', onclick: add }, 'Add'));
  addRow.hidden = true;
  const grid = h('div', { class: 'scrubgrid' });
  const tile = (i) => { const n = team.indexOf(i) + 1; return h('button', { type: 'button', class: 'stile' + (n ? ' on' : ''), title: personName(i), onclick: () => { if (n) team.splice(n - 1, 1); else team.push(i); draw(); } },
    n ? h('span', { class: 'snum' }, n) : null, i); };
  const draw = () => grid.replaceChildren(
    h('small', { class: 'muted' }, 'Tap in order: 1 operating surgeon, 2 first assistant, 3 second assistant… Tap again to remove.'),
    h('div', { class: 'slabel' }, 'Consultants'), h('div', { class: 'stiles' }, SURGEONS.map(([i]) => tile(i))),
    h('div', { class: 'slabel' }, 'Residents'), h('div', { class: 'stiles' }, SR_INITIALS.map(([i]) => tile(i)), team.filter((x) => !known.has(x)).map(tile),
      h('button', { type: 'button', class: 'stile add', title: 'Someone else', onclick: () => { addRow.hidden = false; addIn.focus(); } }, '+')),
    addRow,
    h('div', { class: 'btns' }, h('span', { class: 'small grow' }, team.length ? team.map((x, k) => `${k + 1} ${x}`).join(' · ') : 'No one chosen'),
      h('button', { type: 'button', class: 'primary small', onclick: () => onSave(team.slice()) }, 'Save team')));
  draw();
  return grid;
}

const postedText = (r) => { const s = r && r.surgery; return !s || s.already ? 'Posted' : s.full ? 'Posted. Three surgery dates are already filled, so this one was not added.' : `Posted. ${fmtDate(s.date)} saved as surgery ${s.n} because the patient was on that day's OT list. POD counts from it.`; };
function otBox(a, onChanged) {
  const ta = h('textarea', { rows: 2, placeholder: 'Type OT findings or instructions for the ward…' });
  const post = async () => {
    if (!ta.value.trim()) return;
    try {
      const r = await api('POST', '/api/ot/' + a.id, { text: ta.value });
      toast(postedText(r));
      onChanged();
    } catch (e) { toast(e.message, true); }
  };
  return h('div', { class: 'ot' },
    h('div', { class: 'othead' }, 'OT findings & instructions'),
    (a.otprocs || []).map((x) => h('p', { class: 'otproc small' }, h('b', {}, `${otName(x.ot)} · ${fmtDate(x.date)}: `), x.done || 'Procedure not noted yet', x.scrub.length ? h('span', { class: 'muted' }, ` · ${x.scrub.join('/')}`) : null)),
    a.ot.length ? otList(a.ot, onChanged) : null,
    h('div', { class: 'otadd' }, ta, h('button', { type: 'button', class: 'ghost small', onclick: post }, 'Post')));
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
        h('div', { class: 'muted small' }, [a.ip_no && `UHID ${a.ip_no}`, a.unit, dayNo(a, date) && `Day ${dayNo(a, date)} of admission`,
          icu && a.birth_weight && `BW ${a.birth_weight} g`, icu && a.gestation && `GA ${a.gestation} wk`, icu && a.current_weight && `Wt ${a.current_weight} g`,
          !icu && a.weight && `Wt ${a.weight} kg`].filter(Boolean).join(' · ')),
        a.diagnosis && h('div', { class: 'rdx' }, h('span', {}, 'Diagnosis'), a.diagnosis),
        a.procedure_done && h('div', { class: 'rsx' }, h('span', {}, 'Surgery'), a.procedure_done, surgeries.length ? h('small', {}, ' on ' + surgeries.map(fmtDate).join(', ')) : null)),
      h('div', { class: 'rcorner' },
        h('div', { class: 'cfact' }, h('span', {}, 'Age / Sex'), h('b', {}, ageSex(a, date) || '—')),
        h('div', { class: 'cfact pod' }, h('span', {}, 'POD'), h('b', {}, pod ? pod.replace('POD ', '') : '—')))),
    a.instructions && h('p', { class: 'instr' }, h('b', {}, 'Short notes: '), a.instructions),
    a.unit_note && h('p', { class: 'instr unitnote' }, h('b', {}, `${a.unit || 'Consultant'} round: `), a.unit_note),
    otBox(a, () => refresh(id)));

  if (!discharged && a.discharge_date !== date) {
    add(
      checks.length && h('div', { class: 'fields checks' }, checks.map(box)),
      values.length && h('div', { class: 'fields' }, values.map(box)),
      !checks.length && !values.length && h('p', { class: 'muted small' }, 'No round fields chosen. Use Edit details / fields to pick some.'),
      h('label', { class: 'field remarks' }, h('span', { class: 'flabel' }, 'Other findings / remarks'), remarks),
      a.prev_round && a.prev_round.remarks ? h('p', { class: 'prev' }, 'Yesterday: ' + a.prev_round.remarks) : null,
      h('div', { class: 'foot' }, status,
        h('div', { class: 'btns' },
          canEdit() && h('button', { class: 'ghost small', onclick: () => admitModal(null, a) }, 'Edit details / fields'),
          h('button', { class: 'primary small', onclick: save }, 'Save'))));
    setStatus();
    updateCalc();
  } else if (a.round) {
    add(h('p', { class: 'small' }, summariseVals(a.round.vals, a.monitor, a)), a.round.remarks && h('p', { class: 'small' }, a.round.remarks));
  }
  return card;
}

// Rounds: every patient, ward by ward and then the ICU, in bed order, with the fields chosen for them.
async function roundsView(main) {
  const date = S.date;
  const go = (d) => { if (confirmLeave()) { S.date = d; render(); } };
  const wards = [...new Set(S.meta.sections.flatMap((s) => s.beds).map(wardOf))];
  const wardSel = h('select', { onchange: (e) => { S.filters.ward = e.target.value; draw(); } },
    h('option', { value: '' }, 'All wards'), wards.map((w) => h('option', { value: w }, wardTitle(w))));
  wardSel.value = S.filters.ward || '';
  const search = h('input', { type: 'search', placeholder: 'Find bed, name, UHID…', value: S.filters.q, oninput: (e) => { S.filters.q = e.target.value; draw(); } });
  main.append(
    h('div', { class: 'toolbar' },
      h('div', { class: 'datenav' },
        h('button', { class: 'ghost', onclick: () => go(addDays(date, -1)), 'aria-label': 'Previous day' }, '‹'),
        h('input', { type: 'date', value: date, onchange: (e) => e.target.value && go(e.target.value) }),
        h('button', { class: 'ghost', onclick: () => go(addDays(date, 1)), 'aria-label': 'Next day' }, '›'),
        date !== S.meta.today && h('button', { class: 'ghost small', onclick: () => go(S.meta.today) }, 'Today')),
      h('div', { class: 'filters' }, wardSel, search)),
    h('h2', { class: 'daytitle' }, 'Rounds · ', fmtDay(date)));
  const list = h('div', { class: 'register' }, h('p', { class: 'loading' }, 'Loading…'));
  main.append(list);
  let data = await api('GET', '/api/register?date=' + date);
  S.dirty.clear();
  const order = S.meta.sections.flatMap((s) => s.beds);
  const cards = new Map();
  const cardFor = (a) => { const c = patientCard(a, date, reloadOne); cards.set(a.id, c); return c; };
  function draw() {
    const q = S.filters.q.trim().toLowerCase();
    const pts = data.admissions.filter((a) => a.discharge_date !== date)
      .filter((a) => !S.filters.ward || wardOf(a.bed_on_date) === S.filters.ward)
      .filter((a) => !q || [a.bed_on_date, a.name, a.ip_no, a.diagnosis].join(' ').toLowerCase().includes(q))
      .sort((x, y) => order.indexOf(x.bed_on_date) - order.indexOf(y.bed_on_date));
    list.replaceChildren();
    for (const w of wards) {
      const here = pts.filter((a) => wardOf(a.bed_on_date) === w);
      if (here.length) list.append(h('section', {}, h('h3', {}, wardTitle(w)), here.map(cardFor)));
    }
    const other = pts.filter((a) => !wards.includes(wardOf(a.bed_on_date)));
    if (other.length) list.append(h('section', {}, h('h3', {}, 'Other beds'), other.map(cardFor)));
    if (!list.childNodes.length) list.append(h('p', { class: 'muted empty-note' }, 'No patients in the ward on this date.'));
  }
  // Redraw only the card that changed, so entries typed in other cards are kept.
  async function reloadOne(id) {
    data = await api('GET', '/api/register?date=' + date);
    const a = data.admissions.find((x) => x.id === id), old = cards.get(id);
    if (a && old && old.isConnected) old.replaceWith(cardFor(a)); else draw();
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
    (a.procedure_done || surgeries.length) && h('div', { class: 'surgery' },
      h('span', {}, 'Surgery'),
      h('b', {}, a.procedure_done || '—'),
      surgeries.length ? h('small', {}, 'on ' + surgeries.map(fmtDate).join(', ')) : null),
    a.instructions && h('p', { class: 'instr' }, h('b', {}, 'Short notes: '), a.instructions),
    a.unit_note && h('p', { class: 'instr unitnote' }, h('b', {}, `${a.unit || 'Consultant'} round: `), a.unit_note),
    a.ot && a.ot.length > 0 && h('div', { class: 'ot' }, h('div', { class: 'othead' }, 'OT findings & instructions'), otList(a.ot)),
    (findings || (a.round && a.round.remarks)) && h('div', { class: 'today' },
      h('span', { class: 'muted small' }, `Today's round · ${a.round.filled_by || ''} ${a.round.filled_at.slice(11, 16)}`),
      findings && h('p', {}, findings), a.round.remarks && h('p', {}, h('b', {}, 'Remarks: '), a.round.remarks)),
    !canEdit() && a.unit && h('div', { class: 'foot' },
      h('div', { class: 'btns' },
        h('a', { class: 'button ghost small', href: '#notes/' + encodeURIComponent(a.unit), onclick: () => document.getElementById('modal-root').replaceChildren() }, `${a.unit} round notes`),
        h('button', { class: 'ghost small', onclick: () => addToOtModal(a) }, 'Add to OT list'))),
    canEdit() && h('div', { class: 'foot' },
      h('div', { class: 'btns' },
        h('a', { class: 'button ghost small', href: '#rounds', onclick: () => document.getElementById('modal-root').replaceChildren() }, 'Go to Rounds'),
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

  const body = h('div', { class: 'grid2' },
    editing ? h('label', {}, 'Bed', h('input', { value: a.bed, disabled: true })) : h('label', {}, 'Bed', bedSelect('bed', bed, (b) => isIcu(b) === icu)),
    input('Admission date', 'admit_date', { type: 'date' }),
    input('Patient name / initials', 'name', { required: true }, 'span2'),
    input('UHID', 'ip_no'),
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
    input('Surgery / procedure', 'procedure_done'),
    input('Surgery date (for POD)', 'surgery_date', { type: 'date' }),
    input('2nd surgery date', 'surgery_date2', { type: 'date' }),
    input('3rd surgery date', 'surgery_date3', { type: 'date' }),
    chooser,
    h('label', { class: 'span2' }, 'Short notes', h('textarea', { name: 'instructions', rows: 3 }, a.instructions || '')));

  modal(editing ? `Edit ${a.name}` : icu ? 'Admit baby to ICU' : 'Admit patient', body, async (form) => {
    const v = (n) => (form.elements.namedItem(n) ? form.elements.namedItem(n).value : '');
    const payload = {
      bed: v('bed') || a.bed,
      name: v('name'), ip_no: v('ip_no'), unit: v('unit'), age: v('age'), sex: v('sex'), weight: v('weight'),
      dob: v('dob'), birth_weight: v('birth_weight'), gestation: v('gestation'), current_weight: v('current_weight'),
      diagnosis: v('diagnosis'), procedure_done: v('procedure_done'), surgery_date: v('surgery_date'),
      surgery_date2: v('surgery_date2'), surgery_date3: v('surgery_date3'),
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
        canEdit() && a.discharge_date && h('button', { class: 'ghost', onclick: async () => {
          if (!confirm('Bring this patient back into the ward register?')) return;
          await api('POST', `/api/admissions/${a.id}/undo-discharge`); toast('Discharge undone'); render();
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
      h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: () => window.print() }, 'Print'))),
    h('h2', { class: 'daytitle' }, 'Status · ', fmtDay(date)));
  const box = h('div', { class: 'register' }, h('p', { class: 'loading' }, 'Loading…'));
  main.append(box);
  const data = await api('GET', '/api/register?date=' + date);
  const order = S.meta.sections.flatMap((s) => s.beds);
  const pts = data.admissions.filter((a) => a.discharge_date !== date).sort((x, y) => order.indexOf(x.bed_on_date) - order.indexOf(y.bed_on_date));
  const filled = pts.filter((a) => a.round).length;
  box.replaceChildren(h('p', { class: 'muted' }, `Round entries filled for ${filled} of ${pts.length} patients. Click a name for their full record.`));
  // Same layout as the printed register: every section in bed order, with the morning round and short notes.
  const byBed = {};
  for (const a of pts) (byBed[a.bed_on_date] = byBed[a.bed_on_date] || []).push(a);
  for (const sec of S.meta.sections) {
    if (!sec.beds.some((b) => byBed[b])) continue;
    box.append(h('section', { class: 'printsec' }, h('h3', {}, sec.name), h('div', { class: 'tablewrap' }, h('table', { class: 'list status print' },
      h('thead', {}, h('tr', {}, ['Bed', 'Patient', 'Consultant', 'Diagnosis / Surgery', 'POD · Day', 'Morning round', 'Short notes'].map((t) => h('th', {}, t)))),
      h('tbody', {}, sec.beds.flatMap((bed) => (byBed[bed] || []).map((a) => h('tr', {},
        h('td', {}, h('span', { class: 'bedno' }, bed)),
        h('td', {}, h('a', { href: '#patient/' + a.id, class: 'pname' }, a.name), h('div', { class: 'muted small' }, ageSex(a, date))),
        h('td', {}, a.unit),
        h('td', {}, a.diagnosis, a.procedure_done ? h('div', { class: 'muted small' }, a.procedure_done) : null),
        h('td', {}, [podText(a, date), dayNo(a, date) && `Day ${dayNo(a, date)}`].filter(Boolean).join(' · ')),
        h('td', {}, a.round ? [summariseVals(a.round.vals, monitorFor(a), a).split(' · ').filter(Boolean).map((t) => h('div', {}, t)), a.round.remarks && h('div', {}, h('b', {}, 'Remarks: '), a.round.remarks)] : h('span', { class: 'muted' }, 'Not filled yet')),
        h('td', {}, a.instructions, a.unit_note ? h('div', {}, h('b', {}, `${a.unit}: `), a.unit_note) : null)))))))));
  }
  if (!pts.length) box.append(h('p', { class: 'muted empty-note' }, 'No patients on this date.'));
  const search = h('section', { class: 'noprint' }, h('h3', {}, 'Find any patient, including discharged'));
  main.append(search);
  patientSearch(search);
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
  for (const a of data.admissions) (byBed[a.bed_on_date] = byBed[a.bed_on_date] || []).push(a);
  main.append(
    h('div', { class: 'toolbar noprint' }, h('a', { href: icuWard ? '#icu' : '#register', class: 'button ghost' }, icuWard ? '‹ ICU Register' : '‹ Ward Register'), h('button', { class: 'primary', onclick: () => window.print() }, 'Print')),
    h('h2', {}, ward ? `${ward} · ` : '', icuWard ? 'ICU register · ' : 'Ward register · ', fmtDay(date)),
    ...S.meta.sections.map((sec) => ({ ...sec, beds: ward ? sec.beds.filter((b) => wardOf(b) === ward) : sec.beds })).filter((sec) => sec.beds.length).map((sec) => h('section', { class: 'printsec' }, h('h3', {}, sec.name),
      h('table', { class: 'print' },
        h('thead', {}, h('tr', {}, ['Bed', 'Patient', 'Unit', 'Diagnosis / procedure', 'POD', 'Morning round', 'Short notes'].map((t) => h('th', {}, t)))),
        h('tbody', {}, sec.beds.map((bed) => {
          const here = byBed[bed] || [];
          if (!here.length) return h('tr', { class: 'emptyrow' }, h('td', {}, bed), h('td', { colspan: 6 }, ''));
          return here.map((a) => h('tr', {},
            h('td', {}, bed),
            h('td', {}, h('b', {}, a.name), h('br'), ageSex(a, date), a.ip_no ? ` · ${a.ip_no}` : ''),
            h('td', {}, a.unit),
            h('td', {}, a.diagnosis, a.procedure_done ? h('div', { class: 'muted' }, a.procedure_done) : null),
            h('td', {}, podText(a, date).replace('POD ', '')),
            h('td', {}, a.round ? summariseVals(a.round.vals, monitorFor(a), a) : '', a.round && a.round.remarks ? h('div', {}, a.round.remarks) : null),
            h('td', {}, a.instructions, a.unit_note ? h('div', {}, h('b', {}, `${a.unit}: `), a.unit_note) : null)));
        }))))));
}

// ---------- OT lists: OT 11 to 16, one list per OT per day ----------

const OT_ROOMS = [['11', 'Routine'], ['12', 'Routine'], ['13', ''], ['14', ''], ['15', ''], ['16', 'Emergency']];
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
const shortDate = (d) => { const [y, m, day] = d.split('-'); return `${day}/${m}/${y.slice(2)}`; };
const listCard = (l, withOt = true) => h('a', { class: 'otcard', href: '#otlist/' + encodeURIComponent(l.id) },
  h('b', {}, withOt ? `${otName(l.ot)} · ` : '', fmtDay(l.date)),
  h('span', { class: 'muted small' }, [fullNames(l.surgeon), `${l.count} patient${l.count === 1 ? '' : 's'}`].filter(Boolean).join(' · ')));

async function otHomeView(main) {
  const today = S.meta.today;
  const [lists, kinds] = await Promise.all([api('GET', '/api/otlists?from=' + today), api('GET', '/api/otrooms')]);
  const todays = lists.filter((l) => l.date === today).sort((x, y) => (x.ot < y.ot ? -1 : 1));
  const later = lists.filter((l) => l.date > today).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.ot < y.ot ? -1 : 1));
  main.append(
    h('div', { class: 'toolbar' }, h('h2', {}, 'OT Lists'),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => createOtListModal() }, '+ Create list'))),
    h('div', { class: 'otgrid' }, OT_ROOMS.map(([ot]) => h('a', { class: 'otroom' + (kinds[ot] === 'Emergency' ? ' emerg' : ''), href: '#ot/' + ot },
      h('b', {}, otName(ot))))),
    otSearchBox(),
    h('h3', {}, 'Today · ', fmtDay(today)),
    todays.length ? h('div', { class: 'otcards' }, todays.map((l) => listCard(l))) : h('p', { class: 'muted' }, 'No lists for today yet.'),
    ...(later.length ? [h('h3', {}, 'Coming up'), h('div', { class: 'otcards' }, later.slice(0, 12).map((l) => listCard(l)))] : []));
}

async function otDatesView(main, ot) {
  const today = S.meta.today;
  const [lists, kinds] = await Promise.all([api('GET', '/api/otlists?ot=' + encodeURIComponent(ot)), api('GET', '/api/otrooms')]);
  const seg = h('div', { class: 'seg otkind' });
  const drawKind = (kind) => seg.replaceChildren(...['Routine', 'Emergency'].map((k) => h('button', { type: 'button', class: (k === kind ? 'on' : '') + (k === 'Emergency' ? ' em' : ''), onclick: async () => {
    if (k === kind) return;
    try { await api('PUT', '/api/otrooms/' + ot, { kind: k }); drawKind(k); toast(`${otName(ot)} marked ${k}. Today's and later lists follow.`); } catch (e) { toast(e.message, true); }
  } }, k)));
  drawKind(kinds[ot] || 'Routine');
  const up = lists.filter((l) => l.date >= today).reverse(), past = lists.filter((l) => l.date < today);
  main.append(
    h('div', { class: 'toolbar' }, h('a', { class: 'button ghost', href: '#ot' }, '‹ OT Lists'), h('h2', {}, otName(ot)),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => createOtListModal(ot) }, '+ Create list'))),
    h('div', { class: 'field otkindrow' }, h('span', { class: 'flabel' }, 'This OT is'), seg),
    h('h3', {}, 'Today and coming up'),
    up.length ? h('div', { class: 'otcards' }, up.map((l) => listCard(l, false))) : h('p', { class: 'muted' }, 'No lists yet.'),
    ...(lists.length ? [h('h3', {}, 'By month'), monthGroups(lists)] : []));
}

// Find a patient by UHID or name: every OT list they were posted on, newest first.
function otSearchBox() {
  const out = h('div', { class: 'otfound' });
  let timer;
  const run = async (q) => {
    if (q.trim().length < 2) { out.replaceChildren(); return; }
    const rows = await api('GET', '/api/otsearch?q=' + encodeURIComponent(q.trim())).catch(() => []);
    out.replaceChildren(rows.length ? h('div', { class: 'otcards' }, rows.map((r) => h('a', { class: 'otcard', href: '#otlist/' + encodeURIComponent(r.list_id) },
      h('b', {}, r.name), h('span', { class: 'muted small' }, [[r.age, r.sex].filter(Boolean).join('/'), r.uhid && `UHID ${r.uhid}`].filter(Boolean).join(' · ')),
      h('span', {}, `${otName(r.ot)} · ${fmtDay(r.date)}`),
      h('span', { class: 'muted small' }, [r.surgery, fullNames(r.consultant)].filter(Boolean).join(' · '))))) : h('p', { class: 'muted' }, 'Not found on any OT list.'));
  };
  return h('div', { class: 'otsearch' },
    h('input', { type: 'search', placeholder: 'Search a patient by UHID or name', autocomplete: 'off', oninput: (ev) => { clearTimeout(timer); timer = setTimeout(() => run(ev.target.value), 250); } }),
    out);
}

// Every list of one OT grouped by month and year; tapping a month opens its dates right there.
function monthGroups(lists) {
  const groups = new Map();
  for (const l of lists) { const k = l.date.slice(0, 7); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
  const thisMonth = S.meta.today.slice(0, 7);
  return h('div', { class: 'otmonths' }, [...groups.keys()].sort().reverse().map((k) => {
    const ls = groups.get(k).sort((x, y) => (x.date < y.date ? -1 : 1));
    const [y, m] = k.split('-');
    const title = new Date(+y, +m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    return h('details', { class: 'otmonth', open: k === thisMonth || null },
      h('summary', {}, h('b', {}, title), h('span', { class: 'muted small' }, ` · ${ls.length} list${ls.length === 1 ? '' : 's'}`)),
      h('div', { class: 'otcards' }, ls.map((l) => listCard(l, false))));
  }));
}

// Pick an OT and a date. Opens the list (an existing one if that OT already has a list that day).
function createOtListModal(ot = '11', onCreated) {
  let pick = ot;
  const seg = h('div', { class: 'seg otseg' });
  const drawSeg = () => seg.replaceChildren(...OT_ROOMS.map(([o]) => h('button', { type: 'button', class: o === pick ? 'on' : '', onclick: () => { pick = o; drawSeg(); } }, o)));
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
  const reload = () => { if (location.hash === '#otlist/' + encodeURIComponent(id)) render(); };
  // Cancelled entries stay on the day's list (greyed, not printed) with where they were reposted to.
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
      h('tbody', {}, live.map((e, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}, wardCol(e.bed)), h('td', {}, (e.name || '').toUpperCase()), h('td', {}, [e.age, e.sex].filter(Boolean).join('/')),
        h('td', {}, e.uhid), h('td', {}, e.diagnosis), h('td', {}, e.surgery), h('td', {}, fullNames(e.consultant)), h('td', {}, e.blood), h('td', {}, e.special))))),
    h('div', { class: 'otfoot' }, h('b', {}, `DATE: ${fmtDate(S.meta.today)}`), h('b', {}, 'SIGNATURE')));
  drawSheet();
  const doPrint = () => { const st = h('style', {}, '@page { size: A4 landscape; margin: 16mm 15mm; }'); document.head.append(st); window.print(); st.remove(); };
  const move = async (e, dir) => { try { await api('POST', `/api/otentries/${encodeURIComponent(e.id)}/move`, { dir }); reload(); } catch (x) { toast(x.message, true); } };
  const card = (e, i) => h('div', { class: 'card otentry' },
    h('div', { class: 'othead2' }, h('span', { class: 'slno' }, i + 1), h('div', { class: 'grow' }, h('b', { class: 'big' }, e.name), h('div', { class: 'muted small' }, [[e.age, e.sex].filter(Boolean).join(' / '), e.uhid && `UHID ${e.uhid}`].filter(Boolean).join(' · '))),
      h('span', { class: 'bedno' + (e.bed ? '' : ' nobed') }, bedLabel(e.bed))),
    e.reposted_from && h('p', { class: 'small reposted' }, `Reposted from ${otName(e.reposted_from.ot)}, ${fmtDate(e.reposted_from.date)}${e.reposted_from.reason ? ` (${e.reposted_from.reason})` : ''}`),
    h('dl', { class: 'otfacts' },
      e.diagnosis && [h('dt', {}, 'Diagnosis'), h('dd', {}, e.diagnosis)],
      [h('dt', {}, 'Surgery'), h('dd', {}, e.surgery || h('span', { class: 'warntext' }, 'Not filled yet'))],
      e.consultant && [h('dt', {}, 'Consultant'), h('dd', {}, fullNames(e.consultant))],
      e.blood && [h('dt', {}, 'Blood'), h('dd', {}, e.blood)],
      e.special && [h('dt', {}, 'Special req'), h('dd', { class: 'instr' }, e.special)],
      e.done && [h('dt', {}, 'Done'), h('dd', {}, h('b', {}, e.done))],
      (e.scrub || []).length ? [h('dt', {}, 'Scrub team'), h('dd', {}, h('b', {}, e.scrub.join('/')))] : null),
    e.findings.length ? h('div', { class: 'ot' }, h('div', { class: 'othead' }, 'OT findings & instructions'), otList(e.findings, reload)) : null,
    otExtras(l, e, reload),
    h('div', { class: 'btns' },
      h('button', { class: 'ghost small', onclick: () => otEntryModal(l, e, reload) }, 'Edit'),
      h('button', { class: 'ghost small', disabled: i === 0, onclick: () => move(e, 'up'), 'aria-label': 'Move up' }, '↑'),
      h('button', { class: 'ghost small', disabled: i === live.length - 1, onclick: () => move(e, 'down'), 'aria-label': 'Move down' }, '↓'),
      h('button', { class: 'ghost small', onclick: () => repostModal(l, e) }, 'Repost'),
      !e.admission_id && (!e.bed || e.bed.toUpperCase() === DAY_CARE) && h('button', { class: 'ghost small', onclick: () => admitFromOt(e, reload) }, 'Admit to ward'),
      h('button', { class: 'ghost small danger', onclick: async () => {
        if (!confirm(`Remove ${e.name} from this list?`)) return;
        try { await api('DELETE', '/api/otentries/' + encodeURIComponent(e.id)); toast('Removed'); reload(); } catch (x) { toast(x.message, true); }
      } }, 'Remove')));
  main.append(
    h('div', { class: 'toolbar noprint' }, h('a', { class: 'button ghost', href: '#ot/' + l.ot }, '‹ ' + otName(l.ot)),
      h('h2', {}, `${otName(l.ot)} · `, fmtDay(l.date)),
      h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: doPrint }, 'Print'))),
    h('div', { class: 'noprint' },
      h('div', { class: 'card othdr' }, h('label', {}, 'Surgeon', surgeon), h('label', {}, 'Second surgeon (if two run the OT)', surgeon2),
        h('label', {}, 'Extra note (optional)', note, h('small', { class: 'muted' }, 'KEEP OT WARM is always printed.'))),
      h('div', { class: 'otadd' },
        h('button', { class: 'primary', onclick: () => otEntryModal(l, null, reload) }, '+ Add patient'),
        h('button', { class: 'ghost', onclick: () => fromWardModal(l, reload) }, '+ From ward / ICU')),
      live.length ? h('div', { class: 'otentries' }, live.map(card)) : h('p', { class: 'muted' }, 'No patients on this list yet.'),
      ...(cancelled.length ? [h('h3', {}, 'Cancelled on this day'), h('div', { class: 'otentries' }, cancelled.map((e) => h('div', { class: 'card otentry cancelled' },
        h('b', {}, e.name), h('span', { class: 'muted small' }, e.uhid ? ` · UHID ${e.uhid}` : ''),
        h('p', { class: 'small' }, 'Reposted to ', h('a', { href: '#otlist/' + encodeURIComponent(e.reposted_to.list_id) }, `${otName(e.reposted_to.ot)}, ${fmtDay(e.reposted_to.date)}`), e.cancel_reason ? ` · ${e.cancel_reason}` : ''))))] : []),
      h('div', { class: 'otmeta' },
        h('p', {}, `Created by ${l.created_by || '—'}${l.created_at ? ` on ${stampText(l.created_at)}` : ''}`),
        (l.edits || []).length ? h('p', {}, 'Recent edits:') : null,
        (l.edits || []).map((x) => h('p', {}, `${x.by} ${x.what} · ${stampText(x.at)}`))),
      h('p', { class: 'muted small' },
        h('button', { class: 'link small danger', onclick: async () => {
          if (!confirm(`Delete the whole ${otName(l.ot)} list for ${fmtDate(l.date)}${live.length ? ` with its ${live.length} patients` : ''}?`)) return;
          try { await api('DELETE', '/api/otlists/' + encodeURIComponent(id)); toast('List deleted'); location.hash = 'ot/' + l.ot; } catch (x) { toast(x.message, true); }
        } }, 'Delete this list'))),
    sheet);
}

// OT findings go on the current day's list only (and on yesterday's until 6 AM, for OTs that run late).
const findingsDay = (date) => date === S.meta.today || (new Date().getHours() < 6 && date === addDays(S.meta.today, -1));
// Scrub team and OT findings for one patient on the list; each opens in place under the card.
function otExtras(l, e, reload) {
  const box = h('div', { class: 'otextra' });
  const open = (what) => {
    if (box.dataset.open === what) { box.dataset.open = ''; box.replaceChildren(); return; }
    box.dataset.open = what;
    if (what === 'scrub') box.replaceChildren(scrubPicker(e.scrub, async (team) => {
      try { await api('PUT', `/api/otentries/${encodeURIComponent(e.id)}/scrub`, { scrub: team }); toast('Scrub team saved'); reload(); } catch (x) { toast(x.message, true); }
    }));
    else {
      // Two parts: the surgery / procedure actually done (shown in Rounds and the OT Log), and findings & instructions for the ward.
      const done = h('input', { value: e.done || e.surgery || '', placeholder: 'e.g. Laparoscopic pyeloplasty' });
      const ta = h('textarea', { rows: 3, placeholder: 'Type OT findings or instructions for the ward…' });
      box.replaceChildren(h('div', { class: 'otfind' },
        h('label', {}, 'Surgery / procedure done', done, h('small', { class: 'muted' }, 'Starts as the planned surgery. Change it if something else was done.')),
        h('label', {}, 'OT findings & instructions', ta),
        h('div', { class: 'btns' }, h('button', { type: 'button', class: 'primary small', onclick: async () => {
          if (!ta.value.trim() && !done.value.trim()) return;
          try { const r = await api('POST', `/api/otentries/${encodeURIComponent(e.id)}/findings`, { text: ta.value, done: done.value }); toast(ta.value.trim() ? postedText(r) : 'Saved'); reload(); } catch (x) { toast(x.message, true); }
        } }, 'Save'))));
      ta.focus();
    }
  };
  return h('div', {},
    h('div', { class: 'ottiles' },
      h('button', { class: 'ottile', onclick: () => open('scrub') }, (e.scrub || []).length ? 'Edit scrub team' : '+ Add scrub team'),
      canEdit() && findingsDay(l.date) && h('button', { class: 'ottile', onclick: () => open('findings') }, '+ Add OT findings & instructions')),
    box);
}

// OT cancelled for the day: put the patient on another day's (or another OT's) list.
function repostModal(l, e) {
  let pick = l.ot;
  const seg = h('div', { class: 'seg otseg' });
  const drawSeg = () => seg.replaceChildren(...OT_ROOMS.map(([o]) => h('button', { type: 'button', class: o === pick ? 'on' : '', onclick: () => { pick = o; drawSeg(); } }, o)));
  drawSeg();
  modal(`Repost ${e.name}`, h('div', { class: 'grid1' },
    h('p', { class: 'muted small' }, `${e.name} stays on this list marked as cancelled, and goes on the new list with the same details.`),
    h('div', { class: 'field' }, h('span', { class: 'flabel' }, 'OT'), seg),
    h('label', {}, 'New date', h('input', { type: 'date', name: 'date', value: addDays(l.date, 1), required: true })),
    h('label', {}, 'Reason (optional)', h('input', { name: 'reason', placeholder: 'e.g. OT time over, blood not arranged' }))),
  async (form) => {
    const r = await api('POST', `/api/otentries/${encodeURIComponent(e.id)}/repost`, { ot: pick, date: form.date.value, reason: form.reason.value });
    toast(`${e.name} reposted to ${otName(pick)}, ${fmtDate(form.date.value)}`);
    location.hash = 'otlist/' + encodeURIComponent(r.list_id);
  }, 'Repost');
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
  who = who || myInitials() || SURGEONS[0][0];
  const [counts, rows] = await Promise.all([api('GET', '/api/otpeople'), api('GET', '/api/otlog?who=' + encodeURIComponent(who))]);
  const people = Object.keys(counts);
  const known = new Set([...SURGEONS, ...SR_INITIALS].map(([i]) => i));
  const others = people.filter((p) => !known.has(p));
  if (!known.has(who) && !others.includes(who)) others.push(who);
  const opt = ([i, n]) => h('option', { value: i, selected: i === who }, n ? `${i} · ${n}` : i);
  const sel = h('select', { onchange: (ev) => { location.hash = 'otlog/' + encodeURIComponent(ev.target.value); } },
    h('optgroup', { label: 'Consultants' }, SURGEONS.map(opt)), h('optgroup', { label: 'Residents' }, SR_INITIALS.map(opt)),
    others.length ? h('optgroup', { label: 'Others' }, others.map((o) => opt([o]))) : null);
  const byRole = {};
  for (const r of rows) byRole[r.role] = (byRole[r.role] || 0) + 1;
  const title = `OT Log · ${personName(who)}${personName(who) !== who ? ` (${who})` : ''}`;
  main.append(
    h('div', { class: 'toolbar' }, h('h2', {}, 'OT Log'),
      h('div', { class: 'actions' }, h('label', { class: 'inline' }, 'Logbook of ', sel), h('button', { class: 'ghost', onclick: () => window.print() }, 'Print'))),
    h('h2', { class: 'printonly' }, title),
    h('p', { class: 'muted' }, rows.length ? `${rows.length} operation${rows.length === 1 ? '' : 's'}: ` + Object.keys(byRole).sort((a, b) => a - b).map((k) => `${roleName(+k).toLowerCase()} ${byRole[k]}`).join(', ') : `No operations logged for ${who} yet. A log fills when ${who} is in a scrub team on an OT list.`),
    !rows.length && people.length ? h('p', { class: 'small' }, 'Logged so far: ', people.sort((a, b) => counts[b] - counts[a]).map((p, k) => [k ? ', ' : '', h('a', { href: '#otlog/' + encodeURIComponent(p) }, `${p} (${counts[p]})`)])) : null,
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
    if (r.consultant && !form.consultant.value) { const n = fullNames(r.consultant); if (![...form.consultant.options].some((o) => o.value === n)) form.consultant.append(h('option', { value: n }, n)); form.consultant.value = n; }
    if (r.admission_id) form.admission_id.value = r.admission_id;
    found.textContent = `Found ${r.name}: details filled in${r.bed ? `, now in ${r.bed}` : ''}. Check and change anything needed.`;
  };
  const beds = h('datalist', { id: 'otbeds' }, h('option', { value: DAY_CARE }, 'Day care'), S.meta.sections.flatMap((x) => x.beds).map((b) => h('option', { value: b })));
  // The consultant starts as the OT's surgeon(s) and can be changed, e.g. Dr Ajay Verma operating in Dr Anjan Dhua's OT.
  const listSurgeon = fullNames(l.surgeon);
  const consultant = surgeonSelect(e ? fullNames(v.consultant) : listSurgeon, '—', listSurgeon.includes('/') ? [listSurgeon] : [], { name: 'consultant' });
  const form = modal(e ? `Edit · ${e.name}` : `Add patient · ${otName(l.ot)} ${fmtDate(l.date)}`, h('div', { class: 'grid2 otform' },
    h('label', { class: 'span2' }, 'UHID', h('input', { name: 'uhid', value: v.uhid || '', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Type the UHID first',
      onchange: () => lookup(form), onkeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); lookup(form); } } }), found),
    h('label', { class: 'span2' }, 'Name', h('input', { name: 'name', value: v.name || '', required: true })),
    input('Age', 'age', { placeholder: 'e.g. 2m, 12y' }),
    h('label', {}, 'Sex', h('select', { name: 'sex' }, ['', 'M', 'F', 'Other'].map((x) => h('option', { value: x, selected: x === (v.sex || '') }, x || '—')))),
    h('label', { class: 'span2' }, 'Bed', h('input', { name: 'bed', value: v.bed || '', list: 'otbeds', autocomplete: 'off', placeholder: 'e.g. 6B/15' }),
      h('small', { class: 'muted' }, 'Leave blank if being admitted later. MCH2/PAR = day care.'), beds),
    h('label', { class: 'span2' }, 'Diagnosis', h('textarea', { name: 'diagnosis', rows: 2 }, v.diagnosis || '')),
    h('label', { class: 'span2' }, 'Surgery', h('textarea', { name: 'surgery', rows: 2 }, v.surgery || '')),
    h('label', {}, 'Consultant', consultant),
    input('Blood arrangement', 'blood', { placeholder: 'e.g. 1-1-1' }),
    h('label', { class: 'span2' }, 'Special requirements', h('textarea', { name: 'special', rows: 3, placeholder: 'Ports, instruments, positioning, ventilation…' }, v.special || '')),
    h('input', { type: 'hidden', name: 'admission_id', value: v.admission_id || '' })),
  async (f) => {
    const body = Object.fromEntries(['uhid', 'name', 'age', 'sex', 'bed', 'diagnosis', 'surgery', 'consultant', 'blood', 'special', 'admission_id'].map((k) => [k, f[k].value]));
    if (e) await api('PUT', '/api/otentries/' + encodeURIComponent(e.id), body);
    else await api('POST', `/api/otlists/${encodeURIComponent(l.id)}/entries`, body);
    toast(e ? 'Saved' : `${body.name} added`);
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
    const list = (pts, head) => pts.length ? h('div', {}, head && h('h3', {}, head), h('table', { class: 'list print occlist' },
      h('thead', {}, h('tr', {}, ['Bed', 'Name', 'Age / Sex', 'Diagnosis', 'Surgery', 'POD', 'Instructions'].map((t) => h('th', {}, t)))),
      h('tbody', {}, pts.map((a) => h('tr', {},
        h('td', {}, h('b', {}, a.bed_on_date)), h('td', {}, a.name), h('td', {}, ageSex(a, date)), h('td', {}, a.diagnosis),
        h('td', {}, a.procedure_done), h('td', {}, podText(a, date).replace('POD ', '')), h('td', { class: 'blank' })))))) : null;
    sheet.replaceChildren(
      h('h2', {}, 'Bed Occupancy · ', fmtDay(date)),
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
          isUnit && h('a', { class: 'button ghost small', href: '#notes/' + encodeURIComponent(title), onclick: close }, 'Round notes'),
          isUnit && h('a', { class: 'button ghost small', href: '#otlog/' + encodeURIComponent(title), onclick: close }, 'OT log'),
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
  const tabs = { users: 'Users', params: 'Round fields', beds: 'Beds & units', import: 'Import', look: 'Appearance', log: 'Activity log' };
  main.append(h('h2', {}, 'Admin'), h('div', { class: 'tabs' }, Object.entries(tabs).map(([k, v]) => h('a', { href: '#admin/' + k, class: k === tab ? 'active' : '' }, v))));
  const body = h('div', {});
  main.append(body);
  ({ users: adminUsers, params: adminParams, beds: adminBeds, import: adminImport, look: adminLook, log: adminLog })[tab](body);
}

async function adminUsers(body) {
  const users = await api('GET', '/api/users');
  const err = h('p', { class: 'error' });
  const form = h('form', { class: 'card grid4', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/users', { name: form.fullname.value, username: form.username.value, role: form.role.value, password: form.password.value });
      toast('User added'); render();
    } catch (x) { err.textContent = x.message; }
  } },
  h('h3', { class: 'span4' }, 'Add a user'),
  h('label', {}, 'Name', h('input', { name: 'fullname', required: true, placeholder: 'Dr A. Sharma' })),
  h('label', {}, 'Username', h('input', { name: 'username', required: true, autocapitalize: 'none' })),
  h('label', {}, 'Role', h('select', { name: 'role' }, Object.entries(ROLE_NAMES).map(([k, v]) => h('option', { value: k, selected: k === 'jr' }, v)))),
  h('label', {}, 'Starting password', h('input', { name: 'password', required: true, minlength: 6 })),
  err, h('button', { class: 'primary span4' }, 'Add user'));

  body.append(
    h('p', { class: 'muted' }, 'SR and JR: admit, edit, move and discharge patients, fill rounds and post OT notes. Consultant: sees the registers, Bed Occupancy and Status, and adds their own round notes (Bed Occupancy > their box > Round notes). Admin (SR): everything, plus this page.'),
    h('div', { class: 'tablewrap' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, ['Name', 'Username', 'Role', 'Active', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, users.map((u) => {
        const role = h('select', { onchange: async () => { await update(u, { role: role.value }); } },
          Object.entries(ROLE_NAMES).map(([k, v]) => h('option', { value: k, selected: k === u.role }, v)));
        return h('tr', { class: u.active ? '' : 'inactive' },
          h('td', {}, u.name), h('td', {}, u.username), h('td', {}, role),
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
    file, mode, go, result));
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

boot().catch((e) => { document.getElementById('app').replaceChildren(h('p', { class: 'error center' }, 'The app could not start on this browser. ' + e.message)); });
