// Google 학교 계정 로그인/가입 + 비밀번호 재설정
import { bootApp, assert } from './harness.mjs';
const errs = (b) => b.errors.filter((e) => /PAGEERROR/.test(e));
async function open(opts) {
  const b = await bootApp({ noAuth: true, waitMs: 1500, ...opts });
  b.alerts = []; b.prompts = [];
  b.page.on('dialog', (d) => {
    if (d.type() === 'prompt') { b.prompts.push(d.message()); d.accept(b.promptAnswer !== undefined ? b.promptAnswer : d.defaultValue()); }
    else { b.alerts.push(d.message()); d.accept(); }
  });
  await b.page.evaluate(() => showLoginScreen()); await b.page.waitForTimeout(200);
  return b;
}

// 1) 처음 들어온 학교 Google 계정 → 이메일 가입과 같은 규칙으로 사용자 정보 생성
{
  const b = await open({ google: { uid: 'g-new', email: '20261205@hanilgo.cnehs.kr' } });
  try {
    assert(await b.page.isVisible('#btn-google-login') && await b.page.isVisible('#btn-forgot-password'), '로그인 화면에 Google 버튼 + 비밀번호 재설정 링크');
    await b.page.click('#btn-google-login'); await b.page.waitForTimeout(1500);
    const u = await b.page.evaluate(() => window.__fb.rtdb.users && window.__fb.rtdb.users['g-new']);
    assert(u && u.grade === '1' && u.ban === '2' && u.number === '05' && u.role === 'class2_member', '새 Google 계정: 학번으로 1-2반 5번 정회원 등록 ' + JSON.stringify(u));
    assert(await b.page.evaluate(() => window.__fb.fs['users/g-new'] && window.__fb.fs['users/g-new'].number === 5), 'Firestore 규칙용 거울도 생성');
    assert((await b.page.innerText('#profile-role-text')).includes('정회원'), '바로 정회원으로 로그인됨');
    assert(!errs(b).length, '페이지 오류 없음 ' + errs(b).join('|'));
  } finally { await b.close(); }
}
// 2) 이미 가입한 계정(같은 uid)으로 Google 로그인 → 기존 정보 그대로
{
  const old = { email: '20261207@hanilgo.cnehs.kr', grade: '1', ban: '2', number: '07', role: 'class2_member', nickname: '원래닉' };
  const b = await open({ google: { uid: 'u7', email: '20261207@hanilgo.cnehs.kr' }, rtdb: { 'users/u7': old } });
  try {
    await b.page.evaluate(() => toggleAuthForm(false));
    assert(await b.page.isVisible('#btn-google-signup'), '회원가입 화면에도 Google 버튼');
    await b.page.click('#btn-google-signup'); await b.page.waitForTimeout(1500);
    const u = await b.page.evaluate(() => window.__fb.rtdb.users.u7);
    assert(u.nickname === '원래닉' && u.number === '07', '기존 회원 정보는 덮어쓰지 않음');
    assert((await b.page.innerText('#profile-nick-text')).includes('원래닉'), '기존 계정으로 로그인');
  } finally { await b.close(); }
}
// 3) 학교 메일이 아닌 Google 계정 → 막고 방금 생긴 계정 삭제 + 로그아웃
{
  const b = await open({ google: { uid: 'g-bad', email: 'someone@gmail.com' } });
  try {
    await b.page.click('#btn-google-login'); await b.page.waitForTimeout(1500);
    assert(b.alerts.some((a) => a.includes('가입 불가') && a.includes('someone@gmail.com')), '학교 메일이 아니면 안내 ' + b.alerts.join('|'));
    const st = await b.page.evaluate(() => ({ del: window.__fb.deletedUsers || [], users: Object.keys(window.__fb.rtdb.users || {}), cur: window.__fb.user && window.__fb.user.uid }));
    assert(st.del.includes('g-bad') && !st.users.includes('g-bad') && st.cur !== 'g-bad', '빈 계정은 지우고 로그아웃 ' + JSON.stringify(st));
  } finally { await b.close(); }
}
// 4) 같은 메일이 비밀번호 계정으로 따로 있을 때 → 비밀번호로 한 번 로그인 후 Google 연결
{
  const b = await open({ uid: 'u9', googleError: 'auth/account-exists-with-different-credential', google: { email: '20261209@hanilgo.cnehs.kr' }, rtdb: { 'users/u9': { email: '20261209@hanilgo.cnehs.kr', grade: '1', ban: '2', number: '09', role: 'class2_member' } } });
  b.promptAnswer = 'pw123456';
  try {
    await b.page.click('#btn-google-login'); await b.page.waitForTimeout(1500);
    assert(b.prompts.some((m) => m.includes('20261209@hanilgo.cnehs.kr') && m.includes('비밀번호')), '비밀번호를 한 번 물어봄');
    assert(await b.page.evaluate(() => window.__fb.linked === 1) && b.alerts.some((a) => a.includes('연결했어요')), 'Google 로그인을 기존 계정에 연결');
  } finally { await b.close(); }
}
// 5) 팝업이 막히면 페이지 이동 방식으로
{
  const b = await open({ googleError: 'auth/popup-blocked' });
  try {
    await b.page.click('#btn-google-login'); await b.page.waitForTimeout(500);
    assert(await b.page.evaluate(() => window.__fb.redirected === true), '팝업 차단 시 리다이렉트 로그인');
  } finally { await b.close(); }
}
// 6) 비밀번호 재설정 메일
{
  const b = await open({});
  try {
    await b.page.fill('#login-email', '20261205@hanilgo.cnehs.kr');
    await b.page.click('#btn-forgot-password'); await b.page.waitForTimeout(400);
    assert(await b.page.evaluate(() => (window.__fb.resetEmails || []).includes('20261205@hanilgo.cnehs.kr')), '입력해 둔 메일로 재설정 메일 발송');
    assert(b.alerts.some((a) => a.includes('재설정 메일을 보냈어요')), '보냈다는 안내');
    assert(!errs(b).length, '페이지 오류 없음 ' + errs(b).join('|'));
  } finally { await b.close(); }
}
{
  const b = await open({ resetError: 'auth/user-not-found' });
  try {
    await b.page.fill('#login-email', '20261299@hanilgo.cnehs.kr');
    await b.page.click('#btn-forgot-password'); await b.page.waitForTimeout(400);
    assert(b.alerts.some((a) => a.includes('가입되지 않은 메일')), '가입 안 된 메일이면 안내');
  } finally { await b.close(); }
}
console.log('\nGOOGLE AUTH TEST PASSED');
