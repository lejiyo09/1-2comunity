import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright-core';
function assert(c, m) { if (!c) { console.error('FAIL: ' + m); process.exitCode = 1; throw new Error('FAIL: ' + m); } console.log('ok -', m); }
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const useOld = process.argv[2] === 'old'; // `old <git-ref>`: 그 시점의 sw.js 로 같은 시험을 해서(실패해야 정상) 시험이 문제를 재현하는지 확인
const swSource = useOld ? execSync(`git show ${process.argv[3] || 'HEAD~1'}:sw.js`, { cwd: ROOT, encoding: 'utf8' }) : fs.readFileSync(ROOT + '/sw.js', 'utf8');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const TEST_PAGE = `<!doctype html><meta charset=utf-8><title>sw test</title><body>
<script type="module">
  window.__r = { ok: false, err: null };
  try {
    const sw = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
    window.__regDone = true;
  } catch (e) { window.__r.err = 'sw:' + e.message; }
  try {
    const a = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js');
    const b = await import('https://esm.sh/@supabase/supabase-js@2');
    window.__r = { ok: a.dbName === 'database' && a.appName === 'app' && b.createClient() === 'client:auth', err: null };
  } catch (e) { window.__r = { ok: false, err: String(e && e.message || e) }; }
  window.__done = true;
</script>`;
const server = http.createServer((q, r) => {
  const p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/__sw_test.html') { r.writeHead(200, { 'content-type': MIME['.html'] }); return r.end(TEST_PAGE); }
  if (p === '/sw.js') { r.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-cache' }); return r.end(swSource); }
  let f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('nf'); }
  r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
const ctx = await browser.newContext();
const hits = { gstatic: 0, esm: 0 }; let cdnDown = false; // 오프라인: 외부 서버에 닿지 않음(Playwright 의 route 는 setOffline 이어도 응답해 주므로 직접 끊는다)
const js = (body) => ({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body });
await ctx.route('https://www.gstatic.com/firebasejs/10.7.1/*', async (route) => {
  hits.gstatic++; if (cdnDown) return route.abort('internetdisconnected');
  const f = new URL(route.request().url()).pathname.split('/').pop();
  if (f === 'firebase-app.js') return route.fulfill(js(`export const appName='app';`));
  if (f === 'firebase-database.js') return route.fulfill(js(`import { appName } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js"; export { appName }; export const dbName='database';`));
  return route.fulfill(js(`export const x='${f}';`));
});
await ctx.route('https://esm.sh/**', async (route) => {
  hits.esm++; if (cdnDown) return route.abort('internetdisconnected');
  const u = new URL(route.request().url());
  if (u.pathname === '/@supabase/supabase-js@2') return route.fulfill(js(`export * from "/@supabase/supabase-js@2.99.0/es2022/supabase-js.mjs";`)); // esm.sh 는 이런 재수출 한 줄짜리 파일을 준다
  if (u.pathname === '/@supabase/supabase-js@2.99.0/es2022/supabase-js.mjs') return route.fulfill(js(`import { auth } from "/@supabase/auth-js@2.1.0/es2022/auth-js.mjs"; export const createClient = () => 'client:' + auth;`));
  if (u.pathname === '/@supabase/auth-js@2.1.0/es2022/auth-js.mjs') return route.fulfill(js(`export const auth='auth';`));
  return route.fulfill({ status: 404, body: 'nf' });
});
const page = await ctx.newPage();
try {
  await page.goto(base + '/__sw_test.html'); await page.waitForFunction(() => window.__done === true, null, { timeout: 20000 });
  assert(await page.evaluate(() => window.__r.ok), '온라인 첫 방문: 외부 모듈(Firebase/Supabase) 로딩 성공 ' + JSON.stringify(await page.evaluate(() => window.__r)));
  const cached = await page.evaluate(async () => { const out = {}; for (const n of await caches.keys()) out[n] = (await (await caches.open(n)).keys()).map(r => r.url.replace(location.origin, '')); return out; });
  console.log('캐시 이름:', Object.keys(cached).join(', '));
  if (!useOld) {
    const cdn = cached['appcdn-v1'] || [];
    assert(cdn.some(u => u.endsWith('firebase-app.js')) && cdn.some(u => u.endsWith('firebase-firestore.js')) && cdn.some(u => u.includes('supabase-js@2')), '설치 때 외부 모듈을 미리 저장함 ' + cdn.length + '개');
    assert(cdn.some(u => u.includes('auth-js@2.1.0')), 'import 로 따라가며 하위 모듈(auth-js)까지 저장함');
  }
  // 오프라인으로 전환하고 다시 열기
  await page.reload(); await page.waitForFunction(() => window.__done === true, null, { timeout: 20000 });  // SW 가 페이지를 맡은 상태(캐시 갱신)
  await ctx.setOffline(true); cdnDown = true;
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  const offlineOk = await page.waitForFunction(() => window.__done === true, null, { timeout: 15000 }).then(() => true).catch(() => false);
  const r = offlineOk ? await page.evaluate(() => window.__r) : { ok: false, err: '페이지가 열리지 않음' };
  if (useOld) { assert(!r.ok, '(수정 전 sw.js) 오프라인에서 외부 모듈을 못 받아 실패함 → 시험이 문제를 재현함: ' + r.err); }
  else assert(r.ok, '오프라인 재방문: 외부 모듈을 저장분으로 받아 앱 코드가 실행됨 ' + JSON.stringify(r));
  console.log('\nOFFLINE SW TEST DONE (' + (useOld ? 'old' : 'new') + ')');
} finally { await browser.close(); server.close(); }
