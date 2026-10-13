import { bootApp, assert } from './harness.mjs';
const member = { role: 'class2_member', grade: '1', ban: '2', number: '04', email: '20261204@hanilgo.cnehs.kr', nickname: 'A' };
const which = process.argv[2] || 'denied';
const labels = (p) => p.evaluate(() => [...document.querySelectorAll('#shortcuts-grid button')].map(b => b.textContent.trim()));
let opts;
if (which === 'denied') opts = { guest: true, uid: 'x', rtdbDeny: '^dashboard/shortcuts' };                      // 게스트: 읽기 권한 없음 → 기본값
else if (which === 'empty') opts = { guest: true, uid: 'x' };                                                   // 게스트: 읽을 수는 있는데 비어 있음 → 기본값
else if (which === 'shared') opts = { guest: true, uid: 'x', rtdb: { 'dashboard/shortcuts': { a: { label: '🍱 급식 바로가기', url: 'https://example.com/a', order: 0 } } } }; // 반 공용이 있으면 그것
else if (which === 'noauth') opts = { noAuth: true, uid: 'x', anonFail: true };                                   // 익명 로그인도 안 되는 환경
else opts = { userData: member, uid: 'userA', userEmail: member.email };                                         // 회원
const b = await bootApp({ ...opts, waitMs: 2500 });
const p = b.page;
try {
  const l = await labels(p);
  console.log('버튼:', l.join(' | '));
  if (['denied', 'empty', 'noauth'].includes(which)) {
    assert(l.length === 5 && l.some(t => t.includes('클래스룸')) && l.some(t => t.includes('기상송')), '로그아웃: 기본 바로가기 5개가 보임');
    assert(await p.evaluate(() => getComputedStyle(document.getElementById('btn-add-shortcut-personal')).display === 'none'), '로그아웃: "내 바로가기 추가"는 없음');
    const w = await p.evaluate(() => { const g = document.getElementById('shortcuts-grid'); const r = g.getBoundingClientRect(); return { w: r.width, h: r.height }; });
    assert(w.w > 100 && w.h > 20, '바로가기 영역이 실제로 화면에 보임 ' + JSON.stringify(w));
    // 눌렀을 때 새 창으로 열리는 기본 동작
    const href = await p.evaluate(() => document.querySelector('#shortcuts-grid button').getAttribute('onclick'));
    assert(/window\.open/.test(href) && /classroom\.google\.com/.test(href), '바로가기는 그 주소를 새 창으로 엶');
  } else if (which === 'shared') {
    assert(l.length === 1 && l[0].includes('급식 바로가기'), '게스트도 반 공용 바로가기를 읽을 수 있으면 그것을 보여줌(기본값으로 덮지 않음)');
  } else {
    assert(l.length === 0, '(기존 동작 유지) 회원인데 공용 바로가기가 비어 있고 편집 권한도 없으면 비어 있음');
  }
  assert(!b.errors.some(e => /PAGEERROR/.test(e)), '페이지 오류 없음 ' + b.errors.filter(e => /PAGEERROR/.test(e)).join('|'));
  console.log('\nGUEST SHORTCUTS TEST PASSED (' + which + ')');
} finally { await b.close(); }
