// 떠 있는 학급 공지 팝업을 누르면 공지 탭으로 이동해 그 공지가 열린다
import { bootApp, assert } from './harness.mjs';
const member = { role: 'class2_member', grade: '1', ban: '2', number: '04', email: '20261204@hanilgo.cnehs.kr', nickname: 'A' };
const fsData = {
  'notices/n1': { title: '<긴급> 복도 우산 정리 필요', content: '오전 중에 정리하기 바랍니다.', category: 'class', important: true, createdAt: Date.now(), authorName: '관리자' },
  'notices/n2': { title: '이전 공지', content: '예전 내용', category: 'class', createdAt: Date.now() - 86400000, authorName: '관리자' },
};
const b = await bootApp({ userData: member, uid: 'userA', userEmail: member.email, waitMs: 1800, fsData });
const p = b.page;
try {
  await p.waitForSelector('#gmw-notice-popup.visible', { timeout: 5000 });
  assert((await p.innerText('#gmw-notice-popup-title')).includes('복도 우산'), '팝업에 최신 공지가 뜸');
  assert(await p.evaluate(() => document.getElementById('tab-home').classList.contains('active')), '처음엔 홈 화면');
  await p.click('#gmw-notice-popup-content'); await p.waitForTimeout(400);
  const st = await p.evaluate(() => ({ notice: document.getElementById('tab-notice').classList.contains('active'), home: document.getElementById('tab-home').classList.contains('active'), detail: getComputedStyle(document.getElementById('notice-hub-detail-view')).display, title: (document.querySelector('#notice-hub-detail-view .detail-title') || {}).textContent }));
  assert(st.notice && !st.home && st.detail !== 'none' && st.title.includes('복도 우산'), '팝업을 누르면 공지 탭으로 가서 그 공지가 열림 ' + JSON.stringify(st));
  // 다른 공지로 넘긴 뒤 누르면 그 공지가 열림
  await p.evaluate(() => switchTab('home')); await p.waitForTimeout(200);
  await p.evaluate(() => cycleNoticePopup(null, 1)); await p.waitForTimeout(150);
  assert((await p.innerText('#gmw-notice-popup-title')).includes('이전 공지'), '‹ › 로 다른 공지로 넘김');
  await p.click('#gmw-notice-popup-title'); await p.waitForTimeout(400);
  assert(await p.evaluate(() => document.getElementById('tab-notice').classList.contains('active') && document.querySelector('#notice-hub-detail-view .detail-title').textContent.includes('이전 공지')), '넘긴 공지를 누르면 그 공지가 열림');
  // 확인 버튼·닫기 같은 팝업 안 버튼은 이동하지 않음
  await p.evaluate(() => switchTab('home')); await p.waitForTimeout(200);
  await p.click('#gmw-notice-popup-confirm-btn'); await p.waitForTimeout(300);
  assert(await p.evaluate(() => document.getElementById('tab-home').classList.contains('active')), '"확인했습니다" 버튼은 탭을 바꾸지 않음');
  assert(!b.errors.some((e) => /PAGEERROR/.test(e)), '페이지 오류 없음 ' + b.errors.filter((e) => /PAGEERROR/.test(e)).join('|'));
  console.log('\nNOTICE POPUP TEST PASSED');
} finally { await b.close(); }
