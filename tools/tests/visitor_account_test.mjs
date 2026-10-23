// 방문자 계정(hanilianadmin@hanilgo.cnehs.kr): 학번 메일이 아니어도 가입되고, 1-2반 정회원과 같은 권한 + 소속 "방문자"
import { bootApp, assert } from './harness.mjs';
const b = await bootApp({ noAuth: true, uid: 'visitor-1', waitMs: 1500 });
const p = b.page;
const alerts = []; p.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
try {
  await p.evaluate(() => { showLoginScreen(); toggleAuthForm(false); }); await p.waitForTimeout(200);
  // 학번 형식이 아닌 다른 메일은 여전히 막힘
  await p.fill('#signup-email', 'someone@hanilgo.cnehs.kr'); await p.fill('#signup-password', '123456');
  await p.click('#btn-signup'); await p.waitForTimeout(200);
  assert(alerts.pop()?.includes('가입 불가'), '학번 없는 다른 학교 메일은 그대로 가입 불가');
  // 방문자 메일은 가입됨
  await p.fill('#signup-email', ' HanilianAdmin@hanilgo.cnehs.kr '); await p.fill('#signup-password', '123456');
  await p.click('#btn-signup'); await p.waitForTimeout(1500);
  assert(alerts.includes('가입 성공!'), '방문자 메일로 가입 성공 ' + alerts.join('|'));
  const u = await p.evaluate(() => window.__fb.rtdb.users && window.__fb.rtdb.users['visitor-1']);
  assert(u && u.grade === '1' && u.ban === '2' && u.number === '99' && u.role === 'class2_member', '1-2반 정회원 권한(번호 99)으로 등록 ' + JSON.stringify(u));
  const mirror = await p.evaluate(() => window.__fb.fs['users/visitor-1']);
  assert(mirror && mirror.role === 'class2_member' && mirror.number === 99, 'Firestore 규칙용 거울도 정회원 ' + JSON.stringify(mirror));
  await p.waitForTimeout(800);
  const side = await p.evaluate(() => ({ role: document.getElementById('profile-role-text').textContent, nick: document.getElementById('profile-nick-text').textContent }));
  assert(side.role.includes('방문자') && !side.role.includes('정회원'), '사이드바 소속: 방문자 ' + JSON.stringify(side));
  assert(side.nick.includes('방문자'), '이름도 "2반 99번" 대신 방문자');
  assert(await p.evaluate(() => window.__fb.rtdb.users['visitor-1'].nickname === '방문자'), '닉네임을 방문자로 한 번 정해 둠(글쓴이 이름 등)');
  // 정회원과 같은 권한: 커뮤니티 메뉴가 보이고 제한 열람이 아님
  assert(await p.evaluate(() => { const el = document.getElementById('nav-community') || document.querySelector('[data-tab="community"]'); return !!el && getComputedStyle(el).display !== 'none'; }), '커뮤니티 메뉴가 보임(정회원과 같은 권한)');
  assert(!b.errors.some((e) => /PAGEERROR/.test(e)), '페이지 오류 없음 ' + b.errors.filter((e) => /PAGEERROR/.test(e)).join('|'));
  console.log('\nVISITOR ACCOUNT TEST PASSED');
} finally { await b.close(); }

// 콘솔에서 미리 만든 방문자 계정: 회원가입 없이 아이디·비밀번호로 로그인만 해도 정회원 권한으로 열림(담임선생님 계정도 같은 방식)
{
  const b2 = await bootApp({ uid: 'visitor-2', userEmail: 'hanilianadmin@hanilgo.cnehs.kr', waitMs: 2000 });
  try {
    const u = await b2.page.evaluate(() => window.__fb.rtdb.users && window.__fb.rtdb.users['visitor-2']);
    assert(u && u.role === 'class2_member' && u.number === '99', '로그인만 해도 사용자 정보가 자동으로 만들어짐 ' + JSON.stringify(u));
    assert((await b2.page.innerText('#profile-role-text')).includes('방문자'), '바로 방문자로 로그인된 화면');
  } finally { await b2.close(); }
  const b3 = await bootApp({ uid: 'stranger', userEmail: 'stranger@gmail.com', waitMs: 1500 });
  try {
    assert(await b3.page.evaluate(() => !(window.__fb.rtdb.users || {}).stranger), '가입할 수 없는 메일은 자동으로 만들지 않음');
  } finally { await b3.close(); }
  console.log('VISITOR AUTO-PROVISION TEST PASSED');
}
