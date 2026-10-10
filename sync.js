// Sharing between devices. Each change is encrypted on this device with a key made from the
// ward passcode, then sent to the ward's own Google Apps Script, which only ever sees scrambled text.
'use strict';

const Sync = (() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const b64 = (buf) => { let s = ''; new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b))); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  let cfg = null; // { url, token, key (CryptoKey), lastSeq }
  let running = null;
  let timer = null;
  const status = { state: 'idle', lastOk: 0, waiting: 0, error: '' };
  const listeners = new Set();
  const emit = () => { status.waiting = Store.dirtyRecords().length; listeners.forEach((f) => f({ ...status })); };

  async function call(url, payload) {
    // text/plain keeps this a "simple" request, which Apps Script accepts from any page.
    const res = await fetch(url, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow' });
    if (!res.ok) throw new Error('The sync service answered ' + res.status);
    let data;
    try { data = await res.json(); } catch { throw new Error('That address did not answer like the Ward Register script. Check the Web app URL.'); }
    if (data.error) throw new Error(data.error);
    return data;
  }

  // Turn the passcode into an encryption key and a separate access token.
  async function deriveKeys(passcode, salt) {
    const base = await crypto.subtle.importKey('raw', enc.encode(passcode), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 310000 }, base, 512);
    const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { key, token: hex(bits.slice(32)) };
  }

  async function sealedId(id) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(cfg.token + '|' + id))).slice(0, 40); }

  async function seal(rec) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const body = enc.encode(JSON.stringify({ id: rec.id, type: rec.type, data: rec.data, by: rec.by }));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cfg.key, body);
    return b64(iv) + '.' + b64(ct);
  }
  async function open(blob) {
    const [iv, ct] = blob.split('.');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, cfg.key, unb64(ct));
    return JSON.parse(dec.decode(pt));
  }

  async function connect(url, passcode, { create }) {
    url = url.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) throw new Error('Paste the Web app URL from Apps Script. It starts with https://script.google.com/');
    if (!passcode || passcode.length < 8) throw new Error('The ward passcode must be at least 8 characters');
    let hello;
    try { hello = await call(url, { action: 'hello' }); }
    catch (e) { throw new Error(navigator.onLine ? e.message : 'This device is offline. Connect to the internet once to set it up.'); }
    if (create && hello.initialised) throw new Error('This script is already set up for a ward. Choose "Join the ward" instead.');
    if (!create && !hello.initialised) throw new Error('This script has not been set up yet. The admin should choose "Set up a new ward" first.');
    const { key, token } = await deriveKeys(passcode, hello.salt);
    if (create) await call(url, { action: 'init', token });
    else await call(url, { action: 'pull', token, since: 0, limit: 1 }); // fails if the passcode is wrong
    cfg = { url, token, key, lastSeq: 0 };
    await Store.setMeta('sync', cfg);
  }

  async function restore() {
    cfg = (await Store.getMeta('sync')) || null;
    return !!cfg;
  }

  async function syncNow() {
    if (!cfg) return;
    if (running) return running;
    running = (async () => {
      status.state = 'syncing'; status.error = ''; emit();
      try {
        // Send our changes.
        let dirty = Store.dirtyRecords();
        while (dirty.length) {
          const batch = dirty.splice(0, 150);
          const tsById = {};
          const records = [];
          for (const r of batch) { tsById[r.id] = r.ts; records.push({ rid: await sealedId(r.id), ts: r.ts, blob: await seal(r) }); }
          await call(cfg.url, { action: 'push', token: cfg.token, records });
          await Store.markClean(batch.map((r) => r.id), tsById);
        }
        // Fetch everyone else's.
        let more = true;
        while (more) {
          const out = await call(cfg.url, { action: 'pull', token: cfg.token, since: cfg.lastSeq, limit: 500 });
          const recs = [], gone = [];
          for (const x of out.records) {
            if (x.blob === '') { gone.push(x.rid); continue; } // moved to the archive
            try { const o = await open(x.blob); recs.push({ id: o.id, type: o.type, data: o.data, by: o.by, ts: x.ts }); }
            catch { console.warn('Skipped a record that could not be decrypted'); }
          }
          await Store.applyRemote(recs);
          if (gone.length) await Store.dropLocal(await localIds(gone));
          cfg.lastSeq = out.seq;
          await Store.setMeta('sync', cfg);
          more = out.more;
        }
        status.state = 'ok'; status.lastOk = Date.now();
      } catch (e) {
        status.state = navigator.onLine ? 'error' : 'offline';
        status.error = e.message;
      } finally {
        running = null;
        emit();
      }
    })();
    return running;
  }

  // Which local records these sealed ids belong to.
  async function localIds(rids) {
    const want = new Set(rids), out = [];
    for (const id of Store.allIds()) if (want.has(await sealedId(id))) out.push(id);
    return out;
  }
  async function serverVersion() { const h = await call(cfg.url, { action: 'hello' }); return h.version || 1; }
  const needUpdate = () => new Error('The Google Apps Script needs the new Code.gs first (see the archive steps).');

  // Move old records to the sheet's archive tab, then off this device.
  async function archive(ids) {
    if (!cfg) throw new Error('This device is not connected to the ward');
    if (await serverVersion() < 2) throw needUpdate();
    await syncNow();
    if (Store.dirtyRecords().length) throw new Error('Some changes have not been sent yet. Check the internet and try again.');
    let moved = 0;
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400), rids = [];
      for (const id of part) rids.push(await sealedId(id));
      const out = await call(cfg.url, { action: 'archive', token: cfg.token, rids });
      moved += out.moved;
      await Store.dropLocal(part);
    }
    await syncNow();
    return moved;
  }
  // Every archived record, decrypted here; kept in memory only while the page is open.
  let archiveCache = null;
  async function readArchive() {
    if (archiveCache) return archiveCache;
    if (!cfg) throw new Error('This device is not connected to the ward');
    if (await serverVersion() < 2) throw needUpdate();
    const out = [];
    let offset = 0, more = true;
    while (more) {
      const page = await call(cfg.url, { action: 'readArchive', token: cfg.token, offset, limit: 500 });
      for (const x of page.records) { try { out.push(await open(x.blob)); } catch { /* not readable with this passcode */ } }
      offset += page.records.length;
      more = page.more && page.records.length > 0;
    }
    archiveCache = out;
    return out;
  }

  // Sync soon after a change, every 2 minutes, and whenever the device comes back online.
  function schedule() { clearTimeout(timer); timer = setTimeout(syncNow, 1500); }
  function start() {
    Store.onChange((src) => { if (src === 'local') { emit(); schedule(); } });
    window.addEventListener('online', syncNow);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && syncNow());
    setInterval(syncNow, 120e3);
    syncNow();
  }

  return { connect, restore, start, syncNow, archive, readArchive, status: () => ({ ...status, waiting: Store.dirtyRecords().length }), onStatus: (f) => listeners.add(f), configured: () => !!cfg, url: () => cfg && cfg.url };
})();
