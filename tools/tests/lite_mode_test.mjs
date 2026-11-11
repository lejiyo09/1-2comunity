// 저사양 모드: 유리 효과(backdrop-filter 블러)를 끄고 반투명 배경을 불투명하게, 이 기기에 기억
import { bootApp, assert } from './harness.mjs';
const member = { role: 'class2_member', grade: '1', ban: '2', number: '04', email: '20261204@hanilgo.cnehs.kr', nickname: 'A' };
const b = await bootApp({ userData: member, uid: 'userA', userEmail: member.email, waitMs: 1500 });
const p = b.page;
const look = () => p.evaluate(() => {
  const card = document.querySelector('#tab-home .card'), side = document.getElementById('sidebar');
  const cs = getComputedStyle(card), ss = getComputedStyle(side);
  const alpha = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return 1; const v = m[1].split(',').map(Number); return v.length > 3 ? v[3] : 1; };
  return { lite: document.documentElement.classList.contains('gmw-lite'), cardBlur: cs.backdropFilter, sideBlur: ss.backdropFilter, cardAlpha: alpha(cs.backgroundColor), sideAlpha: alpha(ss.backgroundColor), pressed: document.getElementById('settings-lite-toggle').getAttribute('aria-pressed') };
});
try {
  let s = await look();
  assert(!s.lite && s.cardBlur.includes('blur') && s.sideBlur.includes('blur') && s.cardAlpha < 1, '기본: 유리 효과 켜짐 ' + JSON.stringify(s));
  await p.evaluate(() => { document.getElementById('btn-open-settings').click(); }); await p.waitForTimeout(200);
  assert(await p.isVisible('#settings-lite-toggle') && (await p.innerText('#settings-modal')).includes('저사양 모드'), '설정 창에 저사양 모드 스위치');
  await p.click('#settings-lite-toggle'); await p.waitForTimeout(200);
  s = await look();
  assert(s.lite && s.cardBlur === 'none' && s.sideBlur === 'none' && s.cardAlpha === 1 && s.sideAlpha === 1 && s.pressed === 'true', '켜면 블러 없음 + 불투명 배경 ' + JSON.stringify(s));
  const modalBlur = await p.evaluate(() => getComputedStyle(document.querySelector('#settings-modal .modal-card')).backdropFilter);
  assert(modalBlur === 'none', '설정 창(모달)도 블러 없음');
  // 다크 모드에서도
  await p.evaluate(() => document.body.classList.add('gmw-site-dark')); await p.waitForTimeout(100);
  s = await look();
  assert(s.cardAlpha === 1 && s.sideAlpha === 1, '다크 모드에서도 불투명 ' + JSON.stringify(s));
  await p.evaluate(() => document.body.classList.remove('gmw-site-dark'));
  // 새로고침해도 유지 + 첫 화면부터 적용(head 스크립트)
  await p.reload(); await p.waitForTimeout(1500);
  assert(await p.evaluate(() => document.documentElement.classList.contains('gmw-lite')), '새로고침 뒤에도 저사양 모드 유지');
  // 첫 화면부터 적용: 앱 스크립트(theme.js)가 돌기 전, <head> 의 짧은 스크립트가 이미 html 에 붙여 둔다
  const early = await p.evaluate(async () => { const html = await (await fetch('/index.html')).text(); const head = html.slice(0, html.indexOf('</head>')); return head.includes("hanilgo_lite_mode") && head.indexOf('hanilgo_lite_mode') < head.indexOf('main.css'); });
  assert(early, '<head> 에서 CSS 보다 먼저 적용(깜빡임 없음)');
  // 끄면 원래대로
  await p.evaluate(() => { document.getElementById('btn-open-settings').click(); }); await p.waitForTimeout(150);
  await p.click('#settings-lite-toggle'); await p.waitForTimeout(200);
  s = await look();
  assert(!s.lite && s.cardBlur.includes('blur') && s.cardAlpha < 1 && s.pressed === 'false', '끄면 유리 효과 복귀 ' + JSON.stringify(s));
  assert(!b.errors.some((e) => /PAGEERROR/.test(e)), '페이지 오류 없음 ' + b.errors.filter((e) => /PAGEERROR/.test(e)).join('|'));
  console.log('\nLITE MODE TEST PASSED');
} finally { await b.close(); }
