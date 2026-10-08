// Local data store. Everything lives on this device (IndexedDB) and works with no signal.
// sync.js copies changed records to and from the ward's encrypted Google store.
// The "routes" below keep the same shape as a web server so the screens in app.js stay simple.
'use strict';

const Store = (() => {
  const R = new Map(); // id -> { id, type, data, ts, by, dirty }
  let dbp = null;

  // ---------- IndexedDB ----------
  function idb() {
    if (!dbp) dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('ward-register', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('records', { keyPath: 'id' });
        req.result.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }
  const getMeta = (k) => tx('meta', 'readonly', (s) => s.get(k));
  const setMeta = (k, v) => tx('meta', 'readwrite', (s) => s.put(v, k));
  const delMeta = (k) => tx('meta', 'readwrite', (s) => s.delete(k));

  async function load() {
    const all = await tx('records', 'readonly', (s) => s.getAll());
    R.clear();
    for (const r of all) R.set(r.id, r);
  }
  async function persist(recs) {
    await tx('records', 'readwrite', (s) => recs.forEach((r) => s.put(r)));
  }
  async function wipe() {
    R.clear();
    await tx('records', 'readwrite', (s) => s.clear());
    await tx('meta', 'readwrite', (s) => s.clear());
  }

  // ---------- Records ----------
  let currentUser = null;
  const listeners = new Set();
  const now = () => Date.now();
  const uuid = () => crypto.randomUUID ? crypto.randomUUID() : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));

  function get(id) { const r = R.get(id); return r && r.data ? { id, ...r.data } : null; }
  function all(type) { const out = []; for (const r of R.values()) if (r.type === type && r.data) out.push({ id: r.id, ...r.data }); return out; }

  const pending = [];
  function put(id, type, data) {
    const rec = { id, type, data, ts: now(), by: currentUser ? currentUser.id : null, dirty: true };
    R.set(id, rec);
    pending.push(rec);
    return rec;
  }
  async function commit() {
    const recs = pending.splice(0);
    if (recs.length) { await persist(recs); listeners.forEach((f) => f('local')); }
  }
  // Records arriving from other devices. Newer timestamp wins; our own unsent newer edits are kept.
  async function applyRemote(recs) {
    const changed = [];
    for (const rr of recs) {
      const mine = R.get(rr.id);
      if (mine && mine.ts >= rr.ts) continue;
      const rec = { ...rr, dirty: false };
      R.set(rr.id, rec);
      changed.push(rec);
    }
    if (changed.length) { await persist(changed); listeners.forEach((f) => f('remote')); }
    return changed.length;
  }
  function dirtyRecords() { return [...R.values()].filter((r) => r.dirty); }
  async function markClean(ids, tsById) {
    const recs = [];
    for (const id of ids) {
      const r = R.get(id);
      if (r && r.ts === tsById[id]) { r.dirty = false; recs.push(r); }
    }
    await persist(recs);
  }

  // ---------- Helpers shared with the old server ----------
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  function today() { const d = new Date(); return ymd(d); }
  function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function shiftDate(date, days) { const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() + days); return ymd(d); }
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const str = (v, max = 2000) => (v == null ? '' : String(v).trim().slice(0, max));
  const stamp = () => { const d = new Date(); return `${ymd(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };

  async function hashPassword(password, saltHex) {
    const salt = saltHex || [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 150000 }, key, 256);
    return `${salt}:${[...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  async function checkPassword(password, stored) {
    const [salt] = stored.split(':');
    return (await hashPassword(password, salt)) === stored;
  }

  function range(prefix, from, to, pad = 2) { const o = []; for (let i = from; i <= to; i++) o.push(prefix + String(i).padStart(pad, '0')); return o; }
  const ICU_BEDS = ['# 6C ICU', ...range('6C/', 1, 20)].join('\n');
  const DEFAULT_BEDS = ['# 6B Ward', ...range('6B/', 1, 17), '# 6B Post-Op Cubicle', ...range('6B/PO', 1, 12, 1), '# 6B Chemo Cubicle', ...range('6B/', 18, 23), '# 6A Ward', ...range('6A/', 9, 26), ICU_BEDS].join('\n');
  const DEFAULT_UNITS = ['SA 12', 'VJ 7', 'AD 7', 'DKY 7', 'PG 7', 'AV 4', 'SN 3', 'GD 3'].join('\n');
  const DEFAULT_EMERGENCY = '6B/01, 6B/02, 6B/03, 6B/04';
  // Round fields. Ward and ICU patients each have their own list; the Ward SR picks which ones each patient needs.
  const WARD_PARAMS = [
    ['w_fever', 'Fever', 'yesno'], ['w_flatus', 'Flatus / Stools', 'yesno'], ['w_urine', 'Urine', 'yesno'], ['w_vomiting', 'Vomiting', 'yesno'], ['w_pain', 'Pain', 'yesno'],
    ['w_uo', 'Urine output', 'number', 'ml'], ['w_uo_kg', 'Urine output', 'number', 'ml/kg/hr'], ['w_ag', 'Abdominal girth', 'number', 'cm'],
    ['w_ng', 'NG output', 'number', 'ml'], ['w_ng_colour', 'NG colour / content', 'text'],
  ];
  const ICU_PARAMS = [
    ['i_activity', 'Activity', 'choice', '', 'Good,Decreased,Poor'], ['i_crt', 'CRT', 'choice', '', '<3 s,>3 s'], ['i_periph', 'Peripheries', 'choice', '', 'Warm,Cold'],
    ['i_hr', 'HR', 'number', 'bpm'], ['i_pulses', 'Pulses', 'choice', '', 'Feeble,Good volume,Not palpable'], ['i_ag', 'AG', 'number', 'cm'], ['i_hc', 'HC', 'number', 'cm'],
    ['i_oral', 'Oral intake', 'choice', '', 'Good,Poor'], ['i_vomiting', 'Vomiting', 'yesno'], ['i_stools', 'Stools', 'yesno'], ['i_stoma', 'Stoma', 'choice', '', 'Functional,No'],
    ['i_input', 'Input', 'number', 'ml'], ['i_output', 'Total output', 'number', 'ml'], ['i_uo_kg', 'Urine output', 'number', 'ml/kg/hr'],
  ];
  function seedParams() {
    WARD_PARAMS.forEach(([key, label, type, unit = '', options = ''], i) => put('param:' + key, 'param', { key, label, type, unit, options, group: 'ward', sort: (i + 1) * 10, active: 1 }));
    ICU_PARAMS.forEach(([key, label, type, unit = '', options = ''], i) => put('param:' + key, 'param', { key, label, type, unit, options, group: 'icu', sort: 500 + (i + 1) * 10, active: 1 }));
  }

  // Called once by the admin who sets up the ward.
  function seedDefaults() {
    seedParams();
    put('setting:beds', 'setting', { value: DEFAULT_BEDS });
    put('setting:units', 'setting', { value: DEFAULT_UNITS });
    put('setting:emergency_beds', 'setting', { value: DEFAULT_EMERGENCY });
  }

  // Post-op cubicles are named PO1–PO12, not PO01. Renames beds in wards set up before that change.
  async function fixPostOpNames() {
    const fix = (b) => (b || '').replace(/\/PO0(\d)\b/g, '/PO$1');
    const beds = get('setting:beds');
    if (!beds || fix(beds.value) === beds.value) return;
    put('setting:beds', 'setting', { value: fix(beds.value) });
    for (const a of all('admission')) if (fix(a.bed) !== a.bed) put(a.id, 'admission', { ...strip(a), bed: fix(a.bed) });
    for (const m of all('move')) if (fix(m.from_bed) !== m.from_bed || fix(m.to_bed) !== m.to_bed) put(m.id, 'move', { ...strip(m), from_bed: fix(m.from_bed), to_bed: fix(m.to_bed) });
    await commit();
  }

  // Brings wards set up with an earlier version up to date: new round fields and the 6C ICU beds.
  async function upgrade() {
    if (!get('setting:beds')) return;
    await fixPostOpNames();
    if (!get('param:w_fever')) {
      for (const p of all('param')) if (!p.group && p.active) put(p.id, 'param', { ...strip(p), active: 0 });
      seedParams();
    }
    const beds = getSetting('beds');
    if (!/^6C\//m.test(beds)) put('setting:beds', 'setting', { value: beds.replace(/\s*$/, '') + '\n' + ICU_BEDS });
    // 6A goes up to bed 26 (as in the department's sheet).
    const now = getSetting('beds');
    if (/^6A\/23$/m.test(now) && !/^6A\/24$/m.test(now)) put('setting:beds', 'setting', { value: now.replace(/^6A\/23$/m, ['6A/23', ...range('6A/', 24, 26)].join('\n')) });
    await commit();
  }

  const getSetting = (k) => (get('setting:' + k) || { value: '' }).value;
  function getBedSections() {
    const sections = [];
    for (const raw of getSetting('beds').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#')) sections.push({ name: line.replace(/^#+/, '').trim(), beds: [] });
      else { if (!sections.length) sections.push({ name: 'Beds', beds: [] }); sections[sections.length - 1].beds.push(line); }
    }
    return sections;
  }
  const allBeds = () => getBedSections().flatMap((s) => s.beds);
  function getUnits() {
    return getSetting('units').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^(.*?)\s+(\d+)$/);
      return m ? { name: m[1].trim(), beds: Number(m[2]) } : { name: l, beds: 0 };
    });
  }
  const getIcuBeds = () => getBedSections().filter((s) => /ICU/i.test(s.name)).flatMap((s) => s.beds);
  const getEmergencyBeds = () => getSetting('emergency_beds').split(/[,\n]/).map((b) => b.trim()).filter(Boolean);
  const params = () => all('param').sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label));
  const userName = (id) => { const u = get(id); return u ? u.name : ''; };

  function audit(action, detail = '') {
    put('audit:' + uuid(), 'audit', { at: stamp(), user_id: currentUser ? currentUser.id : null, action, detail });
  }

  function bedOnDate(adm, date, moves) {
    const later = moves.filter((m) => m.admission_id === adm.id && m.move_date > date).sort((a, b) => (a.move_date < b.move_date ? -1 : a.move_date > b.move_date ? 1 : a.at - b.at));
    return later.length ? later[0].from_bed : adm.bed;
  }
  function getAdmission(id) {
    const a = get(id);
    if (!a || !id.startsWith('adm:')) throw new HttpError(404, 'Patient not found');
    return a;
  }
  function occupants(bed, exceptId) {
    return all('admission').filter((a) => a.bed === bed && !a.discharge_date && a.id !== exceptId);
  }
  const defaultMonitor = (bed) => {
    const group = getIcuBeds().includes(bed) ? 'icu' : 'ward';
    return params().filter((p) => p.active && p.group === group).map((p) => p.key);
  };
  function admissionFields(body) {
    const f = {
      name: str(body.name, 120), ip_no: str(body.ip_no, 40), age: str(body.age, 30), sex: str(body.sex, 10),
      diagnosis: str(body.diagnosis, 500), procedure_done: str(body.procedure_done, 500),
      surgery_date: isDate(body.surgery_date) ? body.surgery_date : null,
      surgery_date2: isDate(body.surgery_date2) ? body.surgery_date2 : null,
      surgery_date3: isDate(body.surgery_date3) ? body.surgery_date3 : null,
      unit: str(body.unit, 60), admit_date: isDate(body.admit_date) ? body.admit_date : null, // may be left blank
      monitor: Array.isArray(body.monitor) ? body.monitor.map((k) => str(k, 40)).filter(Boolean) : defaultMonitor(body.bed),
      fields_set: !!body.fields_set,
      extra_fields: Array.isArray(body.extra_fields) ? [...new Set(body.extra_fields.map((k) => str(k, 60)).filter(Boolean))].slice(0, 20) : [],
      instructions: str(body.instructions, 2000), // shown as "Short notes"
      dob: isDate(body.dob) ? body.dob : null, birth_weight: str(body.birth_weight, 20), gestation: str(body.gestation, 20),
      current_weight: str(body.current_weight, 20), weight: str(body.weight, 20),
    };
    if (!f.name) throw new HttpError(400, 'Patient name or initials are required');
    return f;
  }
  const strip = (o, ...keys) => { const c = { ...o }; delete c.id; keys.forEach((k) => delete c[k]); return c; };

  // ---------- Routes ----------
  const routes = [];
  function route(method, pattern, roles, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, roles, handler });
  }
  const ANY = null, PUBLIC = 'public', EDITORS = ['admin', 'ward_sr'], ADMIN = ['admin'];
  const ROLES = ['admin', 'ward_sr', 'night_sr'];
  const failedLogins = new Map();
  const SESSION_HOURS = 12;

  function publicUser(u) { return { id: u.id, username: u.username, name: u.name, role: u.role }; }
  async function startSession(u) {
    currentUser = publicUser(u);
    await setMeta('session', { user_id: u.id, expires: now() + SESSION_HOURS * 3600e3 });
    return currentUser;
  }
  async function restoreSession() {
    const s = await getMeta('session');
    const u = s && s.expires > now() && get(s.user_id);
    currentUser = u && u.active ? publicUser(u) : null;
    return currentUser;
  }

  function validatePassword(p) { if (typeof p !== 'string' || p.length < 6) throw new HttpError(400, 'Password must be at least 6 characters'); }
  async function createUser(body) {
    const username = str(body.username, 50).toLowerCase();
    if (!/^[a-z0-9._-]{3,50}$/.test(username)) throw new HttpError(400, 'Username: 3+ letters/numbers, no spaces');
    if (!ROLES.includes(body.role)) throw new HttpError(400, 'Pick a role');
    const name = str(body.name, 80);
    if (!name) throw new HttpError(400, 'Name is required');
    validatePassword(body.password);
    if (all('user').some((u) => u.username === username)) throw new HttpError(400, 'That username is taken');
    const id = 'user:' + uuid();
    put(id, 'user', { username, name, role: body.role, pass_hash: await hashPassword(body.password), active: 1, created_at: stamp() });
    return { id, username, name, role: body.role };
  }

  route('GET', '/api/state', PUBLIC, () => ({ setupNeeded: !all('user').length, user: currentUser, today: today() }));

  route('POST', '/api/setup', PUBLIC, async ({ body }) => {
    if (all('user').length) throw new HttpError(400, 'Setup is already done');
    seedDefaults();
    const u = await createUser({ ...body, role: 'admin' });
    audit('set up ward');
    return startSession(get(u.id));
  });

  route('POST', '/api/login', PUBLIC, async ({ body }) => {
    const username = str(body.username, 50).toLowerCase();
    const f = failedLogins.get(username);
    if (f && f.until > now()) throw new HttpError(429, 'Too many wrong attempts. Wait 5 minutes and try again.');
    const u = all('user').find((x) => x.username === username);
    if (!u || !u.active || !(await checkPassword(String(body.password || ''), u.pass_hash))) {
      const lockExpired = f && f.until && f.until <= now();
      const count = (f && !lockExpired ? f.count : 0) + 1;
      failedLogins.set(username, { count, until: count >= 5 ? now() + 5 * 60e3 : 0 });
      throw new HttpError(401, u ? 'Wrong username or password' : 'Wrong username or password. If your account was made on another device, wait for it to sync.');
    }
    failedLogins.delete(username);
    const out = await startSession(u);
    audit('login');
    return out;
  });

  route('POST', '/api/logout', ANY, async () => { currentUser = null; await delMeta('session'); return { ok: true }; });

  route('POST', '/api/me/password', ANY, async ({ body }) => {
    const u = get(currentUser.id);
    if (!(await checkPassword(String(body.current || ''), u.pass_hash))) throw new HttpError(400, 'Current password is wrong');
    validatePassword(body.password);
    put(u.id, 'user', { ...strip(u), pass_hash: await hashPassword(body.password) });
    audit('change own password');
    return { ok: true };
  });

  route('GET', '/api/meta', ANY, () => ({
    sections: getBedSections(), params: params(), bedsText: getSetting('beds'),
    units: getUnits(), unitsText: getSetting('units'), emergencyBeds: getEmergencyBeds(), icuBeds: getIcuBeds(), theme: getSetting('theme') || 'auto', today: today(),
  }));

  route('GET', '/api/register', ANY, ({ query }) => {
    const date = isDate(query.date) ? query.date : today();
    const prev = shiftDate(date, -1);
    const adms = all('admission').filter((a) => (!a.admit_date || a.admit_date <= date) && (!a.discharge_date || a.discharge_date >= date))
      .sort((a, b) => ((a.admit_date || '') < (b.admit_date || '') ? -1 : (a.admit_date || '') > (b.admit_date || '') ? 1 : 0));
    const moves = all('move');
    const ot = otByAdmission();
    return {
      date,
      admissions: adms.map((a) => {
        const r = get(`round:${a.id}:${date}`), p = get(`round:${a.id}:${prev}`);
        const n = get(`note:${a.id}:${date}`), pn = get(`note:${a.id}:${prev}`);
        return {
          ...a, bed_on_date: bedOnDate(a, date, moves), ot: ot[a.id] || [],
          round: r ? { vals: r.vals, remarks: r.remarks, filled_by: userName(r.filled_by), filled_at: r.filled_at } : null,
          prev_round: p ? { vals: p.vals, remarks: p.remarks } : null,
          unit_note: n ? n.note : '', unit_note_by: n ? userName(n.updated_by) : '', prev_unit_note: pn ? pn.note : '',
        };
      }),
    };
  });

  route('POST', '/api/admissions', EDITORS, ({ body }) => {
    const bed = str(body.bed, 30);
    if (!allBeds().includes(bed)) throw new HttpError(400, 'Unknown bed');
    const occ = occupants(bed);
    if (occ.length && !body.force) throw new HttpError(409, `Bed ${bed} already has ${occ.map((o) => o.name).join(', ')}`);
    const f = admissionFields(body);
    const id = 'adm:' + uuid();
    put(id, 'admission', { ...f, bed, discharge_date: null, outcome: '', created_by: currentUser.id, updated_at: stamp() });
    audit('admit', `${f.name} to ${bed}`);
    return { id };
  });

  route('PUT', '/api/admissions/:id', EDITORS, ({ body, params: p }) => {
    const a = getAdmission(p.id);
    const f = admissionFields({ ...a, ...body });
    put(a.id, 'admission', { ...strip(a), ...f, updated_at: stamp() });
    audit('edit patient', `${f.name} (${a.bed})`);
    return { ok: true };
  });

  route('POST', '/api/admissions/:id/discharge', EDITORS, ({ body, params: p }) => {
    const a = getAdmission(p.id);
    const date = isDate(body.date) ? body.date : today();
    if (a.admit_date && date < a.admit_date) throw new HttpError(400, 'Discharge date is before the admission date');
    put(a.id, 'admission', { ...strip(a), discharge_date: date, outcome: str(body.outcome, 60) || 'Discharged' });
    audit('discharge', `${a.name} from ${a.bed} on ${date}`);
    return { ok: true };
  });

  route('POST', '/api/admissions/:id/undo-discharge', EDITORS, ({ params: p }) => {
    const a = getAdmission(p.id);
    put(a.id, 'admission', { ...strip(a), discharge_date: null, outcome: '' });
    audit('undo discharge', a.name);
    return { ok: true };
  });

  route('POST', '/api/admissions/:id/transfer', EDITORS, ({ body, params: p }) => {
    const a = getAdmission(p.id);
    const to = str(body.bed, 30);
    if (!allBeds().includes(to)) throw new HttpError(400, 'Unknown bed');
    if (to === a.bed) throw new HttpError(400, 'Patient is already in that bed');
    const occ = occupants(to, a.id);
    if (occ.length && !body.force && !body.swap) throw new HttpError(409, `Bed ${to} already has ${occ.map((o) => o.name).join(', ')}`);
    const date = isDate(body.date) ? body.date : today();
    const move = (adm, from, dest) => {
      put('move:' + uuid(), 'move', { admission_id: adm.id, from_bed: from, to_bed: dest, move_date: date, moved_by: currentUser.id, at: now() });
      put(adm.id, 'admission', { ...strip(adm), bed: dest });
    };
    move(a, a.bed, to);
    // Swap: whoever was in the target bed takes this patient's old bed, like the old sheet did.
    if (body.swap) occ.forEach((o) => move(o, to, a.bed));
    audit(body.swap ? 'swap beds' : 'transfer', `${a.name} ${a.bed} -> ${to}` + (body.swap && occ.length ? `, ${occ.map((o) => o.name).join(', ')} -> ${a.bed}` : ''));
    return { ok: true };
  });

  route('PUT', '/api/rounds/:id/:date', ANY, ({ body, params: p }) => {
    const a = getAdmission(p.id);
    if (!isDate(p.date)) throw new HttpError(400, 'Bad date');
    const vals = {};
    for (const [k, v] of Object.entries(body.vals || {})) { const s = str(v, 500); if (s) vals[str(k, 40)] = s; }
    put(`round:${a.id}:${p.date}`, 'round', { admission_id: a.id, date: p.date, vals, remarks: str(body.remarks, 2000), filled_by: currentUser.id, filled_at: stamp() });
    audit('round entry', `${a.name} ${p.date}`);
    return { ok: true };
  });

  // OT findings and instructions: short posts anyone can add, like the WhatsApp group.
  function otByAdmission() {
    const out = {};
    for (const o of all('ot').sort((x, y) => (x.at < y.at ? -1 : 1))) {
      (out[o.admission_id] = out[o.admission_id] || []).push({ id: o.id, text: o.text, at: o.at, by: userName(o.by), mine: !!currentUser && o.by === currentUser.id });
    }
    return out;
  }
  route('POST', '/api/ot/:id', ANY, ({ body, params: p }) => {
    const a = getAdmission(p.id);
    const text = str(body.text, 3000);
    if (!text) throw new HttpError(400, 'Type something first');
    put('ot:' + uuid(), 'ot', { admission_id: a.id, text, by: currentUser.id, at: stamp() });
    audit('OT note', a.name);
    return { ok: true };
  });
  route('DELETE', '/api/ot/:oid', ANY, ({ params: p }) => {
    const o = get(p.oid);
    if (!o || !p.oid.startsWith('ot:')) throw new HttpError(404, 'Entry not found');
    if (o.by !== currentUser.id && currentUser.role !== 'admin') throw new HttpError(403, 'Only the person who posted this can delete it');
    put(p.oid, 'ot', null);
    audit('delete OT note', userName(o.by));
    return { ok: true };
  });

  route('PUT', '/api/notes/:id/:date', ANY, ({ body, params: p }) => {
    const a = getAdmission(p.id);
    if (!isDate(p.date)) throw new HttpError(400, 'Bad date');
    const note = str(body.note, 2000);
    const id = `note:${a.id}:${p.date}`;
    if (!note) { if (R.has(id)) put(id, 'note', null); }
    else put(id, 'note', { admission_id: a.id, date: p.date, note, updated_by: currentUser.id, updated_at: stamp() });
    audit('consultant note', `${a.name} ${p.date}`);
    return { ok: true };
  });

  route('GET', '/api/admissions/:id', ANY, ({ params: p }) => {
    const a = getAdmission(p.id);
    const rounds = all('round').filter((r) => r.admission_id === a.id).sort((x, y) => (x.date < y.date ? -1 : 1))
      .map((r) => ({ date: r.date, vals: r.vals, remarks: r.remarks, filled_at: r.filled_at, filled_by: userName(r.filled_by) }));
    const notes = all('note').filter((n) => n.admission_id === a.id).map((n) => ({ date: n.date, note: n.note }));
    const moves = all('move').filter((m) => m.admission_id === a.id).sort((x, y) => (x.move_date < y.move_date ? -1 : x.move_date > y.move_date ? 1 : x.at - y.at));
    return { ...a, rounds, notes, moves, ot: otByAdmission()[a.id] || [] };
  });

  route('GET', '/api/patients', ANY, ({ query }) => {
    const q = str(query.q, 60).toLowerCase();
    const from = isDate(query.from) ? query.from : '0000-00-00';
    const to = isDate(query.to) ? query.to : '9999-12-31';
    return all('admission')
      .filter((a) => (!q || [a.name, a.ip_no, a.diagnosis, a.bed].join(' ').toLowerCase().includes(q)) && (!a.admit_date || a.admit_date <= to) && (!a.discharge_date || a.discharge_date >= from))
      .sort((a, b) => ((a.admit_date || '') < (b.admit_date || '') ? 1 : -1)).slice(0, 300);
  });

  route('GET', '/api/users', ADMIN, () => all('user').map((u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active, created_at: u.created_at }))
    .sort((a, b) => b.active - a.active || a.name.localeCompare(b.name)));

  route('POST', '/api/users', ADMIN, async ({ body }) => { const u = await createUser(body); audit('create user', u.username); return u; });

  route('PUT', '/api/users/:id', ADMIN, async ({ body, params: p }) => {
    const u = get(p.id);
    if (!u || !p.id.startsWith('user:')) throw new HttpError(404, 'User not found');
    const role = ROLES.includes(body.role) ? body.role : u.role;
    const active = body.active === undefined ? u.active : (body.active ? 1 : 0);
    if (u.id === currentUser.id && (role !== 'admin' || !active)) throw new HttpError(400, "You can't remove your own admin access");
    const next = { ...strip(u), name: str(body.name, 80) || u.name, role, active };
    if (body.password) { validatePassword(body.password); next.pass_hash = await hashPassword(body.password); }
    put(u.id, 'user', next);
    audit('edit user', u.username);
    return { ok: true };
  });

  route('POST', '/api/params', ADMIN, ({ body }) => {
    const label = str(body.label, 60);
    if (!label) throw new HttpError(400, 'Name is required');
    const type = ['number', 'yesno', 'choice', 'text'].includes(body.type) ? body.type : 'text';
    let key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'param';
    while (R.has('param:' + key)) key += '_x';
    const sort = Math.max(0, ...params().map((x) => x.sort)) + 10;
    const group = body.group === 'icu' ? 'icu' : 'ward';
    put('param:' + key, 'param', { key, label, type, unit: str(body.unit, 20), options: str(body.options, 500), group, sort, active: 1 });
    audit('add parameter', label);
    return { key };
  });

  route('PUT', '/api/params/:key', ADMIN, ({ body, params: p }) => {
    const x = get('param:' + p.key);
    if (!x) throw new HttpError(404, 'Parameter not found');
    put('param:' + p.key, 'param', {
      ...strip(x), label: str(body.label, 60) || x.label,
      unit: body.unit === undefined ? x.unit : str(body.unit, 20), options: body.options === undefined ? x.options : str(body.options, 500),
      sort: Number.isFinite(Number(body.sort)) ? Number(body.sort) : x.sort, active: body.active === undefined ? x.active : (body.active ? 1 : 0),
    });
    audit('edit parameter', x.label);
    return { ok: true };
  });

  route('PUT', '/api/beds', ADMIN, ({ body }) => {
    const text = str(body.text, 20000);
    const beds = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (!beds.length) throw new HttpError(400, 'The bed list is empty');
    if (new Set(beds).size !== beds.length) throw new HttpError(400, 'A bed is listed twice');
    const stranded = all('admission').filter((a) => !a.discharge_date && !beds.includes(a.bed));
    if (stranded.length) throw new HttpError(400, `Move these patients first: ${stranded.map((a) => `${a.name} (${a.bed})`).join(', ')}`);
    put('setting:beds', 'setting', { value: text });
    audit('edit bed list');
    return { ok: true };
  });

  route('PUT', '/api/units', ADMIN, ({ body }) => {
    const units = str(body.units, 5000), emergency = str(body.emergency_beds, 2000);
    const known = allBeds();
    const unknown = emergency.split(/[,\n]/).map((b) => b.trim()).filter((b) => b && !known.includes(b));
    if (unknown.length) throw new HttpError(400, `Not in the bed list: ${unknown.join(', ')}`);
    put('setting:units', 'setting', { value: units });
    put('setting:emergency_beds', 'setting', { value: emergency });
    audit('edit units');
    return { ok: true };
  });

  // Bring in patients from a prepared import file (made from the department's Google Sheet).
  // A bed that already has someone in it is skipped, so importing the same file twice does no harm.
  route('POST', '/api/import', ADMIN, ({ body }) => {
    const list = Array.isArray(body.patients) ? body.patients.slice(0, 500) : [];
    const beds = allBeds();
    const out = { added: [], skipped: [] };
    for (const p of list) {
      const bed = str(p.bed, 30);
      if (!beds.includes(bed)) { out.skipped.push(`${bed} (not in the bed list)`); continue; }
      if (occupants(bed).length) { out.skipped.push(`${bed} (already has a patient)`); continue; }
      let f;
      try { f = admissionFields({ ...p, bed }); } catch (e) { out.skipped.push(`${bed} (${e.message})`); continue; }
      put('adm:' + uuid(), 'admission', { ...f, bed, discharge_date: null, outcome: '', created_by: currentUser.id, updated_at: stamp() });
      out.added.push(bed);
    }
    audit('import patients', `${out.added.length} added, ${out.skipped.length} skipped`);
    return out;
  });

  // Light or dark look for every device in the ward ('auto' follows each device's own setting).
  route('PUT', '/api/theme', ADMIN, ({ body }) => {
    const value = ['light', 'dark'].includes(body.theme) ? body.theme : 'auto';
    put('setting:theme', 'setting', { value });
    audit('change theme', value);
    return { ok: true };
  });

  route('GET', '/api/audit', ADMIN, () => all('audit').sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 500).map((a) => ({ ...a, name: userName(a.user_id) })));

  // A full, unencrypted copy of the ward's data saved as a file on this device.
  route('GET', '/api/export', ADMIN, () => ({ exported_at: stamp(), records: [...R.values()].filter((r) => r.data).map(({ id, type, data, ts }) => ({ id, type, data, ts })) }));

  async function handle(method, url, body) {
    const u = new URL(url, 'http://local');
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = u.pathname.match(r.re);
      if (!m) continue;
      if (r.roles !== PUBLIC) {
        if (!currentUser) throw new HttpError(401, 'Please sign in');
        const fresh = get(currentUser.id);
        if (!fresh || !fresh.active) { currentUser = null; throw new HttpError(401, 'Your account has been turned off'); }
        currentUser.role = fresh.role;
        if (r.roles && !r.roles.includes(currentUser.role)) throw new HttpError(403, "Your role can't do this");
      }
      const p = {};
      r.keys.forEach((k, i) => (p[k] = decodeURIComponent(m[i + 1])));
      try {
        const out = await r.handler({ body: body || {}, params: p, query: Object.fromEntries(u.searchParams) });
        await commit();
        return out;
      } catch (e) { pending.length = 0; await load(); throw e; }
    }
    throw new HttpError(404, 'Not found');
  }

  return { upgrade, load, wipe, getMeta, setMeta, handle, restoreSession, applyRemote, dirtyRecords, markClean, onChange: (f) => listeners.add(f), HttpError };
})();
