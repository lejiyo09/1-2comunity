import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
function assert(c, m) { if (!c) { console.error('FAIL: ' + m); process.exitCode = 1; throw new Error('FAIL: ' + m); } console.log('ok -', m); }
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
let delayMs = 0;
const server = http.createServer((q, r) => {
  const p = decodeURIComponent(q.url.split('?')[0]);
  let f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('nf'); }
  setTimeout(() => { r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' }); r.end(fs.readFileSync(f)); }, delayMs);
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
try {
  // B) 외부 모듈을 못 받아 app.js 가 시작되지 못하면: "불러오는 중…"에서 멈추지 않고 안내 + 다시 시도
  {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.route(/^https:\/\/(www\.gstatic\.com|esm\.sh|cdn\.jsdelivr\.net)\//, (route) => route.abort('internetdisconnected'));
    const page = await ctx.newPage();
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    assert(await page.innerText('#gmw-boot-splash').then(t => t.includes('불러오는 중')), '처음엔 "불러오는 중…"');
    await page.waitForFunction(() => document.getElementById('gmw-boot-splash').innerText.includes('불러오지 못했어요'), null, { timeout: 15000 });
    assert(await page.evaluate(() => !window.__gmwBooted), '앱 코드는 시작되지 못한 상태');
    assert(await page.evaluate(() => !!document.querySelector('#gmw-boot-splash button')), '"다시 시도" 버튼이 보임');
    await ctx.close();
  }
  // C) 연결은 됐지만 인터넷이 안 되는 상태(응답이 한참 안 옴): 저장해 둔 앱으로 먼저 열림
  {
    const ctx = await browser.newContext();
    await ctx.route(/^https:\/\/(www\.gstatic\.com|esm\.sh|cdn\.jsdelivr\.net)\//, (route) => route.abort('internetdisconnected'));
    const page = await ctx.newPage();
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready));
    await page.waitForFunction(async () => (await caches.keys()).includes('appshell-v6') && (await (await caches.open('appshell-v6')).keys()).length > 10, null, { timeout: 20000 });
    delayMs = 12000; // 서버가 12초 뒤에야 응답
    const t0 = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    const took = Date.now() - t0;
    assert(took < 7000 && took >= 3500, `응답이 12초 걸려도 약 4초 뒤 저장해 둔 화면으로 열림 (${took}ms)`);
    assert(await page.evaluate(() => !!document.getElementById('gmw-boot-splash')), '저장해 둔 index.html 이 열림');
    await ctx.close();
  }
  console.log('\nBOOT FALLBACK TESTS DONE');
} finally { await browser.close(); server.close(); }
