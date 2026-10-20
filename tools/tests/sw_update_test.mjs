// 새 버전 알림: 배포로 sw.js 의 APP_VERSION 이 바뀌면 "새 버전이 준비되었습니다 [업데이트]" 가 뜨고, 누르면 새 버전으로 새로고침된다.
// 이미 새 버전 파일로 열린 화면이면 알림 없이 조용히 교체된다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
function assert(c, m) { if (!c) { console.error('FAIL: ' + m); process.exitCode = 1; throw new Error('FAIL: ' + m); } console.log('ok -', m); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const swReal = fs.readFileSync(ROOT + '/sw.js', 'utf8');
assert(/const APP_VERSION = '[0-9a-f]{12}';/.test(swReal) && /<meta name="app-version" content="[0-9a-f]{12}">/.test(fs.readFileSync(ROOT + '/index.html', 'utf8')), '빌드가 sw.js / index.html 에 앱 버전을 넣어 둠');
const ver = { sw: 'aaaaaaaaaaaa', page: 'aaaaaaaaaaaa' };
const page = (v) => `<!doctype html><meta charset=utf-8><meta name="app-version" content="${v}"><link rel="stylesheet" href="/css/pwa-install.css"><title>upd</title><body><p id="v">${v}</p><script src="/js/app-update.js"></script>`;
const server = http.createServer((q, r) => {
  const p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/__upd.html') { r.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' }); return r.end(page(ver.page)); }
  if (p === '/sw.js') { r.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-cache' }); return r.end(swReal.replace(/const APP_VERSION = '[0-9a-f]*';/, `const APP_VERSION = '${ver.sw}';`)); }
  const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('nf'); }
  r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f));
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.route(/^https:\/\/(www\.gstatic\.com|esm\.sh|cdn\.jsdelivr\.net)\//, (route) => route.abort());
const p = await ctx.newPage();
const ctrlVersion = () => p.evaluate(() => new Promise((res) => { const c = navigator.serviceWorker.controller; if (!c) return res(null); const ch = new MessageChannel(); ch.port1.onmessage = (e) => res(e.data); c.postMessage('GET_VERSION', [ch.port2]); setTimeout(() => res('(no answer)'), 1500); }));
const barVisible = () => p.evaluate(() => { const b = document.getElementById('gmw-update-bar'); return !!(b && b.classList.contains('visible')); });
try {
  // 1) 첫 방문: 설치 후 바로 시작, 알림 없음
  await p.goto(base + '/__upd.html');
  await p.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
  await p.waitForTimeout(1200);
  assert(await ctrlVersion() === 'aaaaaaaaaaaa' && !(await barVisible()), '첫 방문: 서비스워커가 바로 시작되고 알림은 안 뜸');
  // 2) 배포로 새 버전(bbbb) - 열려 있는 화면은 옛 버전 → 알림
  ver.sw = 'bbbbbbbbbbbb';
  await p.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await p.waitForFunction(() => { const b = document.getElementById('gmw-update-bar'); return b && b.classList.contains('visible'); }, null, { timeout: 20000 });
  const txt = await p.innerText('#gmw-update-bar');
  assert(txt.includes('새 버전이 준비되었습니다') && txt.includes('업데이트'), '새 버전이 받아지면 "새 버전이 준비되었습니다 [업데이트]" 알림');
  assert(await ctrlVersion() === 'aaaaaaaaaaaa', '누르기 전에는 옛 버전 그대로(쓰던 화면이 갑자기 바뀌지 않음)');
  await p.screenshot({ path: path.join(process.env.SHOT_DIR || '/tmp', 'update-bar.png'), clip: { x: 340, y: 0, width: 600, height: 90 } }).catch(() => {});
  ver.page = 'bbbbbbbbbbbb';
  const nav = p.waitForNavigation({ timeout: 20000 });
  await p.click('#gmw-update-bar button'); await nav;
  await p.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 }); await p.waitForTimeout(800);
  assert(await ctrlVersion() === 'bbbbbbbbbbbb' && (await p.innerText('#v')) === 'bbbbbbbbbbbb' && !(await barVisible()), '"업데이트"를 누르면 새 버전으로 바뀌고 새로고침됨');
  const keys = await p.evaluate(() => caches.keys());
  assert(keys.includes('appshell-bbbbbbbbbbbb') && !keys.includes('appshell-aaaaaaaaaaaa'), '옛 버전 앱 캐시는 지워지고 새 버전으로 저장됨 ' + keys.join(','));
  // 3) 새 버전(cccc) 배포 후 새로고침해서 이미 새 파일로 열린 화면 → 알림 없이 조용히 교체
  ver.sw = 'cccccccccccc'; ver.page = 'cccccccccccc';
  await p.reload();
  await p.waitForFunction(() => new Promise((res) => { const c = navigator.serviceWorker.controller; if (!c) return res(false); const ch = new MessageChannel(); ch.port1.onmessage = (e) => res(e.data === 'cccccccccccc'); c.postMessage('GET_VERSION', [ch.port2]); setTimeout(() => res(false), 500); }), null, { timeout: 20000, polling: 700 });
  await p.waitForTimeout(500);
  assert(!(await barVisible()) && (await p.innerText('#v')) === 'cccccccccccc', '이미 새 버전으로 열린 화면이면 알림 없이 서비스워커만 교체');
  // 4) 휴대폰 화면: 아래 메뉴 위에 뜨고 화면 밖으로 나가지 않음
  await p.setViewportSize({ width: 390, height: 844 });
  ver.sw = 'dddddddddddd';
  await p.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await p.waitForFunction(() => { const b = document.getElementById('gmw-update-bar'); return b && b.classList.contains('visible'); }, null, { timeout: 20000 });
  await p.waitForTimeout(400);
  const r = await p.evaluate(() => { const x = document.getElementById('gmw-update-bar').getBoundingClientRect(); return { l: x.left, r: x.right, t: x.top, b: x.bottom }; });
  assert(r.l >= 0 && r.r <= 390 && r.b <= 844 - 70 && r.t > 600, '휴대폰: 알림이 화면 안, 아래 메뉴 바로 위 ' + JSON.stringify(r));
  console.log('\nSW UPDATE TEST PASSED');
} finally { await browser.close(); server.close(); }
