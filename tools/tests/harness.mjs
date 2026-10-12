// 브라우저 시험용 도구: 실제 index.html + js/css 를 로컬 서버로 열고, Firebase(Auth/RTDB/Firestore)와 Supabase 모듈을
// 메모리 안의 가짜로 바꿔 끼워서 로그인/게스트 상태의 앱 화면을 인터넷 없이 시험한다.
//   const b = await bootApp({ uid, userEmail, userData, rtdb, fsData, guest, noAuth, viewport, rtdbDeny });
//   b.page / b.errors / b.logs / b.close()
//   페이지 안에서는 window.__fb.rtdb (중첩 객체) / window.__fb.fs (경로→문서 데이터) 로 저장된 내용을 직접 볼 수 있다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };

// ---------- 페이지 안에서 도는 가짜 Firebase ----------
const FB_CORE = String.raw`
(function () {
  if (window.__fb) return;
  const cfg = window.__FB_CFG || {};
  const fb = window.__fb = { rtdb: {}, fs: {}, rtdbLis: [], fsLis: [], authLis: [], user: null, seq: 0, cfg };
  const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const segs = (p) => String(p || '').split('/').filter(Boolean);
  // --- RTDB ---
  const rGet = (p) => { let n = fb.rtdb; for (const s of segs(p)) { if (n == null || typeof n !== 'object') return null; n = n[s]; } return n === undefined ? null : n; };
  const rSet = (p, v) => {
    const s = segs(p); if (!s.length) { fb.rtdb = v || {}; return; }
    let n = fb.rtdb; for (let i = 0; i < s.length - 1; i++) { if (n[s[i]] == null || typeof n[s[i]] !== 'object') n[s[i]] = {}; n = n[s[i]]; }
    if (v === null || v === undefined) delete n[s[s.length - 1]]; else n[s[s.length - 1]] = clone(v);
  };
  const rSnap = (p) => { const v = rGet(p); const key = segs(p).pop() || null;
    return { key, val: () => clone(v), exists: () => v != null, forEach(cb) { if (v && typeof v === 'object') for (const k of Object.keys(v)) { if (cb(rSnap(p + '/' + k)) === true) return true; } return false; }, child: (c) => rSnap(p + '/' + c) }; };
  let rLast = '{}'; const rChanged = () => { const now = JSON.stringify(fb.rtdb); const c = now !== rLast; rLast = now; return c; };
  const rNotify = (changed) => { if (!rChanged()) return; for (const l of fb.rtdbLis.slice()) { const a = segs(l.path).join('/'), b = segs(changed).join('/'); if (a.startsWith(b) || b.startsWith(a)) setTimeout(() => l.cb(rSnap(l.path)), 0); } };
  fb.rtdbApi = {
    ref: (db, p) => ({ path: segs(p).join('/'), key: segs(p).pop() || null }),
    onValue: (r, cb, err) => {
      const l = { path: r.path, cb };
      if (cfg.rtdbDeny && new RegExp(cfg.rtdbDeny).test(r.path)) { if (err) setTimeout(() => err(new Error('permission_denied')), 0); return () => {}; }
      fb.rtdbLis.push(l); setTimeout(() => cb(rSnap(r.path)), 0); return () => { fb.rtdbLis = fb.rtdbLis.filter(x => x !== l); };
    },
    get: async (r) => rSnap(r.path),
    set: async (r, v) => { rSet(r.path, v); rNotify(r.path); },
    update: async (r, obj) => { for (const [k, v] of Object.entries(obj || {})) rSet(r.path + '/' + k, v); rNotify(r.path); },
    push: (r, v) => { const key = '-N' + (++fb.seq).toString(36); const nr = { path: r.path + '/' + key, key }; const p = Promise.resolve(nr); if (v !== undefined) { rSet(nr.path, v); rNotify(nr.path); } nr.then = p.then.bind(p); nr.catch = p.catch.bind(p); return nr; },
    remove: async (r) => { rSet(r.path, null); rNotify(r.path); },
    runTransaction: async (r, fn) => { const next = fn(rGet(r.path)); if (next === undefined) return { committed: false, snapshot: rSnap(r.path) }; rSet(r.path, next); rNotify(r.path); return { committed: true, snapshot: rSnap(r.path) }; },
    onDisconnect: () => ({ set: async () => {}, remove: async () => {}, update: async () => {}, cancel: async () => {} }),
    getDatabase: () => ({ __rtdb: true }),
  };
  // --- Firestore ---
  const idOf = (key) => key.split('/').pop();
  const collDocs = (cpath) => Object.keys(fb.fs).filter(k => k.startsWith(cpath + '/') && !k.slice(cpath.length + 1).includes('/')).sort();
  const dSnap = (key) => ({ id: idOf(key), exists: () => fb.fs[key] !== undefined, data: () => clone(fb.fs[key]), ref: { path: key, id: idOf(key) } });
  const evalTarget = (t) => {
    if (t.type === 'doc') return dSnap(t.path);
    const coll = t.type === 'query' ? t.coll : t; let keys = collDocs(coll.path);
    if (t.type === 'query') for (const c of t.cons) if (c.w) { const [f, op, v] = c.w; keys = keys.filter(k => { const x = fb.fs[k][f]; return op === '==' ? x === v : op === '!=' ? x !== v : op === '>' ? x > v : op === '>=' ? x >= v : op === '<' ? x < v : op === '<=' ? x <= v : true; }); }
    const docs = keys.map(dSnap);
    return { docs, size: docs.length, empty: docs.length === 0, forEach: (cb) => docs.forEach(cb) };
  };
  let fLast = '{}'; const fNotify = () => { const now = JSON.stringify(fb.fs); if (now === fLast) return; fLast = now; for (const l of fb.fsLis.slice()) setTimeout(() => l.cb(evalTarget(l.t)), 0); };
  const newId = () => 'f' + (++fb.seq).toString(36) + Math.random().toString(36).slice(2, 6);
  fb.fsApi = {
    getFirestore: () => ({ __fs: true }), initializeFirestore: () => ({ __fs: true }), persistentLocalCache: () => ({}), persistentMultipleTabManager: () => ({}),
    collection: (db, ...s) => ({ type: 'collection', path: s.join('/') }),
    doc: (base, ...s) => { if (base && base.type === 'collection') return { type: 'doc', path: base.path + '/' + (s.length ? s.join('/') : newId()) }; return { type: 'doc', path: s.join('/') }; },
    query: (coll, ...cons) => ({ type: 'query', coll, cons }), where: (f, op, v) => ({ w: [f, op, v] }), orderBy: (f) => ({ o: f }),
    getDoc: async (r) => dSnap(r.path), getDocs: async (t) => evalTarget(t),
    setDoc: async (r, data, opts) => { fb.fs[r.path] = opts && opts.merge ? Object.assign({}, fb.fs[r.path] || {}, clone(data)) : clone(data); fNotify(); },
    addDoc: async (c, data) => { const r = { type: 'doc', path: c.path + '/' + newId() }; r.id = idOf(r.path); fb.fs[r.path] = clone(data); fNotify(); return r; },
    updateDoc: async (r, data) => { if (fb.fs[r.path] === undefined) throw new Error('not-found'); Object.assign(fb.fs[r.path], clone(data)); fNotify(); },
    deleteDoc: async (r) => { delete fb.fs[r.path]; fNotify(); },
    onSnapshot: (t, cb, err) => {
      const l = { t, cb }; const p = t.type === 'query' ? t.coll.path : t.path;
      if (cfg.fsDeny && new RegExp(cfg.fsDeny).test(p)) { if (err) setTimeout(() => err(Object.assign(new Error('permission-denied'), { code: 'permission-denied' })), 0); return () => {}; }
      fb.fsLis.push(l); setTimeout(() => cb(evalTarget(t)), 0); return () => { fb.fsLis = fb.fsLis.filter(x => x !== l); };
    },
    runTransaction: async (db, fn) => fn({ get: async (r) => dSnap(r.path), set: (r, d) => { fb.fs[r.path] = clone(d); fNotify(); }, update: (r, d) => { Object.assign(fb.fs[r.path] || (fb.fs[r.path] = {}), clone(d)); fNotify(); } }),
  };
  // --- Auth ---
  const mkUser = (c) => c && ({ uid: c.uid, email: c.email || null, isAnonymous: !!c.anon, displayName: null, getIdToken: async () => 'test-token' });
  fb.user = cfg.noAuth ? null : mkUser(cfg.guest ? { uid: 'anon-1', anon: true } : { uid: cfg.uid, email: cfg.userEmail });
  const fireAuth = () => { for (const cb of fb.authLis.slice()) setTimeout(() => cb(fb.user), 0); };
  fb.authApi = {
    getAuth: () => ({ __auth: true }),
    onAuthStateChanged: (a, cb) => { fb.authLis.push(cb); setTimeout(() => cb(fb.user), cfg.authDelay || 0); return () => { fb.authLis = fb.authLis.filter(x => x !== cb); }; },
    signOut: async () => { fb.user = null; fireAuth(); },
    signInAnonymously: async () => { if (cfg.anonFail) throw new Error('anonymous sign-in disabled'); fb.user = mkUser({ uid: 'anon-1', anon: true }); fireAuth(); return { user: fb.user }; },
    signInWithEmailAndPassword: async (a, email) => { fb.user = mkUser({ uid: cfg.uid || 'userA', email }); fireAuth(); return { user: fb.user }; },
    createUserWithEmailAndPassword: async (a, email) => { fb.user = mkUser({ uid: cfg.uid || 'userA', email }); fireAuth(); return { user: fb.user }; },
    setPersistence: async () => {}, browserLocalPersistence: {}, browserSessionPersistence: {},
  };
  if (cfg.rtdb) for (const [p, v] of Object.entries(cfg.rtdb)) rSet(p, v);
  rLast = JSON.stringify(fb.rtdb);
  if (cfg.fsData) for (const [p, v] of Object.entries(cfg.fsData)) fb.fs[p] = clone(v);
  fLast = JSON.stringify(fb.fs);
})();
`;
const names = (o) => Object.keys(o).filter((k) => !k.startsWith('__'));
const moduleOf = (apiKey, exportsList) => `const a = window.__fb.${apiKey};\n` + exportsList.map((n) => `export const ${n} = a.${n};`).join('\n') + '\n';
const MODULES = {
  'firebase-app.js': `export const initializeApp = (c) => ({ __app: true, c });\n`,
  'firebase-database.js': moduleOf('rtdbApi', ['getDatabase', 'ref', 'onValue', 'get', 'set', 'update', 'push', 'remove', 'runTransaction', 'onDisconnect']),
  'firebase-auth.js': moduleOf('authApi', ['getAuth', 'createUserWithEmailAndPassword', 'signInWithEmailAndPassword', 'onAuthStateChanged', 'signOut', 'setPersistence', 'browserLocalPersistence', 'browserSessionPersistence', 'signInAnonymously']),
  'firebase-firestore.js': moduleOf('fsApi', ['getFirestore', 'initializeFirestore', 'persistentLocalCache', 'persistentMultipleTabManager', 'collection', 'doc', 'getDoc', 'getDocs', 'setDoc', 'addDoc', 'updateDoc', 'deleteDoc', 'query', 'where', 'orderBy', 'onSnapshot', 'runTransaction']),
};
const SUPABASE_STUB = `
const chain = () => new Proxy(function () {}, {
  get: (t, k) => k === 'then' ? (res) => res({ data: [], error: null, count: 0 }) : chain(),
  apply: () => chain(),
});
export const createClient = () => chain();
`;

export async function bootApp(opts = {}) {
  const { viewport = { width: 1280, height: 900 }, waitMs = 1500, extraRoutes = null } = opts;
  const server = http.createServer((q, r) => {
    const p = decodeURIComponent(q.url.split('?')[0]);
    const spa = p === '/' || p === '/index.html' || /^\/app\//.test(p);
    const f = path.join(ROOT, spa ? 'index.html' : p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('nf'); }
    r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); r.end(fs.readFileSync(f));
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const cfg = { uid: opts.uid || 'userA', userEmail: opts.userEmail, guest: !!opts.guest, noAuth: !!opts.noAuth, anonFail: !!opts.anonFail, authDelay: opts.authDelay || 0, rtdbDeny: opts.rtdbDeny || null, fsDeny: opts.fsDeny || null,
    rtdb: Object.assign(opts.userData ? { [`users/${opts.uid || 'userA'}`]: opts.userData } : {}, opts.rtdb || {}), fsData: opts.fsData || {} };
  await ctx.addInitScript(`window.__FB_CFG = ${JSON.stringify(cfg)};\n${FB_CORE}`);
  const js = (body) => ({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body });
  await ctx.route(/^https:\/\/www\.gstatic\.com\/firebasejs\//, (route) => route.fulfill(js(MODULES[new URL(route.request().url()).pathname.split('/').pop()] || 'export {};')));
  await ctx.route(/^https:\/\/esm\.sh\//, (route) => route.fulfill(js(SUPABASE_STUB)));
  await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|cdn\.weatherapi\.com|via\.placeholder\.com)\//, (route) => route.abort());
  await ctx.route(/^https:\/\/open\.neis\.go\.kr\//, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ RESULT: { CODE: 'INFO-200', MESSAGE: 'none' } }) }));
  await ctx.route(/\.supabase\.co\//, async (route) => { if (extraRoutes && await extraRoutes(route, route.request().url()) === true) return; await route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"code":"NOT_FOUND"}' }); });
  if (extraRoutes) await ctx.route(/^https:\/\/open\.neis\.go\.kr\//, async (route) => { if (await extraRoutes(route, route.request().url()) === true) return; await route.fallback(); });
  const page = await ctx.newPage();
  const errors = [], logs = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { logs.push(m.type() + ': ' + m.text()); if (m.type() === 'error' && !/Failed to load resource|net::ERR|ERR_FAILED|NOT_FOUND/.test(m.text())) errors.push('CONSOLE ' + m.text().slice(0, 200)); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForTimeout(waitMs);
  return { page, browser, server, errors, logs, ctx, close: async () => { await browser.close(); server.close(); } };
}

export function assert(c, m) { if (!c) { console.error('FAIL: ' + m); process.exitCode = 1; throw new Error('FAIL: ' + m); } console.log('ok -', m); }
