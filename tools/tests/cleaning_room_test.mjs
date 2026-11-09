// 호실별 청소: 날짜별 담당 호실(홈 위젯 "오늘 청소" + 청소 탭 순번표)
import { bootApp, assert } from './harness.mjs';
const member = { role: 'class2_member', grade: '1', ban: '2', number: '04', email: '20261204@hanilgo.cnehs.kr', nickname: 'A' };
const cases = [
  ['2026-11-09T09:00:00', null, '11/10부터 201호'],   // 순번표 시작 전날
  ['2026-11-10T09:00:00', '201호', '11/10 ~ 11/16'],
  ['2026-11-16T20:00:00', '201호', '11/10 ~ 11/16'],
  ['2026-11-17T08:00:00', '106호', '11/17 ~ 11/23'],
  ['2026-11-28T12:00:00', '202호', '11/24 ~ 11/30'],
  ['2026-12-07T12:00:00', '105호', '12/1 ~ 12/7'],
  ['2026-12-08T12:00:00', '201호', '12/8 ~ 12/14'],   // 순번표가 끝나면 같은 순서로 반복
  ['2026-12-20T12:00:00', '106호', '12/15 ~ 12/21'],
  ['2026-12-23T12:00:00', '202호', '12/22 ~ 12/28'],
];
for (const [now, room, range] of cases) {
  const b = await bootApp({ userData: member, uid: 'userA', userEmail: member.email, waitMs: 300 });
  const p = b.page;
  try {
    await p.clock.setFixedTime(new Date(now)); await p.reload(); await p.waitForTimeout(1800);
    const home = (await p.innerText('#home-cleaning-summary')).replace(/\s+/g, ' ');
    if (room) assert(home.includes('오늘 청소') && home.includes(room) && home.includes(range), `${now.slice(0, 10)} 홈 위젯: 오늘 청소 ${room} (${home})`);
    else assert(home.includes('없음') && home.includes(range), `${now.slice(0, 10)} 시작 전: 다음 담당 안내 (${home})`);
    await p.evaluate(() => switchTab('cleaning')); await p.waitForTimeout(200);
    const cur = (await p.innerText('#cleaning-room-current')).replace(/\s+/g, ' ');
    assert(cur.includes(room || '201호'), `${now.slice(0, 10)} 청소 탭 이번 주 표시 (${cur})`);
    if (room) assert(await p.evaluate((r) => { const tr = document.querySelector('#cleaning-room-tbody tr.duty-today'); return !!tr && tr.innerText.includes(r) && tr.innerText.includes('이번 주'); }, room), `${now.slice(0, 10)} 순번표에서 이번 주 줄 강조`);
    assert(!b.errors.some((e) => /PAGEERROR/.test(e)), '페이지 오류 없음');
  } finally { await b.close(); }
}
console.log('\nCLEANING ROOM TEST PASSED');
