import { bootApp, assert } from './harness.mjs';
const member = { role: 'class2_member', grade: '1', ban: '2', number: '04', email: '20261204@hanilgo.cnehs.kr', nickname: 'A' };
const admin = { role: 'class2_member', grade: '1', ban: '2', number: '30', email: '20261230@hanilgo.cnehs.kr', nickname: 'Adm' };
const which = process.argv[2] || 'settings';
const calls = []; let state = { email: null, verified: false, notifyComments: true, notifyNotices: true }; let wrongOnce = true;
const mock = async (route, url) => {
  if (!url.includes('/functions/v1/mail-notify')) return false;
  const req = route.request(); const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method() === 'OPTIONS') { await route.fulfill({ status: 200, headers: cors }); return true; }
  const body = JSON.parse(req.postData() || '{}'); const auth = req.headers()['authorization'];
  calls.push({ ...body, auth });
  const ok = (j, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(j) });
  if (body.action === 'get') await ok(state);
  else if (body.action === 'request_code') { state = { ...state, email: body.email.toLowerCase(), verified: false }; await ok({ sent: true }); }
  else if (body.action === 'verify_code') { if (body.code !== '123456') await ok({ error: '코드가 달라요. 다시 확인해 주세요.' }, 400); else { state = { ...state, verified: true }; await ok(state); } }
  else if (body.action === 'update_prefs') { state = { ...state, ...('notifyComments' in body ? { notifyComments: body.notifyComments } : {}), ...('notifyNotices' in body ? { notifyNotices: body.notifyNotices } : {}) }; await ok(state); }
  else if (body.action === 'remove') { state = { email: null, verified: false, notifyComments: true, notifyNotices: true }; await ok(state); }
  else await ok({ sent: 1 });
  return true;
};
const opts = which === 'notice-new' ? { userData: admin, uid: 'userAdm', userEmail: admin.email } : { userData: member, uid: 'userA', userEmail: member.email };
const b = await bootApp({ ...opts, waitMs: 2500, extraRoutes: mock, fsData: {
  'posts/p1': { title: '남의 글', content: 'x', authorId: 'userB', authorName: 'B', authorOriginal: '20261205@hanilgo.cnehs.kr', createdAt: Date.now() - 100000, likeCount: 0 },
  'posts/p2': { title: '내 글', content: 'y', authorId: 'userA', authorName: 'A', authorOriginal: member.email, createdAt: Date.now() - 90000, likeCount: 0 },
  'notices/n1': { title: '남이 올린 공지', content: 'c', category: 'class', authorUid: 'userB', authorName: '반장', authorOriginal: '20261201@hanilgo.cnehs.kr', createdAt: Date.now() - 3600000, showInPopup: false },
  'notices/n2': { title: '내가 올린 공지', content: 'c', category: 'class', authorUid: 'userA', authorName: 'A', authorOriginal: member.email, createdAt: Date.now() - 3600000, showInPopup: false },
} });
const p = b.page;
const msg = () => p.innerText('#mail-settings-msg');
try {
  if (which === 'settings') {
    await p.click('#btn-open-settings'); await p.waitForTimeout(800);
    assert(await p.isVisible('#mail-email-input'), '설정 창에 이메일 알림: 주소 입력칸이 보임');
    assert(calls[0] && calls[0].action === 'get' && /^Bearer /.test(calls[0].auth), '열 때 내 구독 상태를 불러옴(Firebase 토큰 첨부)');
    await p.fill('#mail-email-input', 'name@naver.com'); await p.click('#mail-request-btn'); await p.waitForTimeout(300);
    assert((await msg()).includes('Gmail') && !calls.some(c => c.action === 'request_code'), 'Gmail 이 아니면 서버에 보내지 않고 안내');
    await p.fill('#mail-email-input', 'Student@Gmail.com'); await p.click('#mail-request-btn'); await p.waitForTimeout(600);
    assert(calls.some(c => c.action === 'request_code' && c.email === 'Student@Gmail.com'), '인증 코드 요청이 서버로 감');
    assert(await p.isVisible('#mail-code-input') && (await p.innerText('#mail-settings-body')).includes('student@gmail.com'), '코드 입력 화면으로 바뀜(주소 표시)');
    await p.fill('#mail-code-input', '12ab'); await p.click('#mail-verify-btn'); await p.waitForTimeout(200);
    assert((await msg()).includes('6자리') && !calls.some(c => c.action === 'verify_code'), '6자리 숫자가 아니면 서버에 보내지 않음');
    await p.fill('#mail-code-input', '000000'); await p.click('#mail-verify-btn'); await p.waitForTimeout(500);
    assert((await msg()).includes('코드가 달라요') && await p.isVisible('#mail-code-input'), '틀린 코드 → 서버 메시지를 그대로 안내, 입력 화면 유지');
    await p.fill('#mail-code-input', '123456'); await p.press('#mail-code-input', 'Enter'); await p.waitForTimeout(600);
    assert(await p.isVisible('#mail-pref-comments') && (await p.innerText('#mail-settings-body')).includes('student@gmail.com') && (await msg()).includes('켜졌어요'), '인증 성공 → 알림 종류 스위치 화면');
    await p.click('#mail-pref-notices', { force: true }); await p.waitForTimeout(500);
    assert(calls.some(c => c.action === 'update_prefs' && c.notifyNotices === false), '"새 공지" 스위치를 끄면 서버에 저장');
    assert(await p.evaluate(() => !document.getElementById('mail-pref-notices').checked && document.getElementById('mail-pref-comments').checked), '화면 스위치가 서버 값과 일치');
    p.once('dialog', d => d.accept());
    await p.click('#mail-remove-btn'); await p.waitForTimeout(600);
    assert(calls.some(c => c.action === 'remove') && await p.isVisible('#mail-email-input'), '알림 끄기 → 주소 삭제, 다시 입력 화면');
    // 서버에 함수가 없을 때(404)
    state = null;
  } else if (which === 'triggers') {
    // 남의 글에 댓글 → 서버에 알림 요청 (글/댓글 ID 포함)
    await p.evaluate(() => { switchTab('community'); openPostDetail('p1'); }); await p.waitForTimeout(600);
    await p.fill('#reply-p1', '좋은 글이네요'); await p.evaluate(() => addComment('p1')); await p.waitForTimeout(800);
    const cid = await p.evaluate(() => Object.keys(window.__fb.fs).find(k => k.startsWith('posts/p1/comments/')).split('/').pop());
    const c1 = calls.find(c => c.action === 'notify_comment' && c.kind === 'post');
    assert(c1 && c1.parentId === 'p1' && c1.commentId === cid && /^Bearer /.test(c1.auth), '남의 글에 댓글 → notify_comment(kind=post, 글ID, 댓글ID)를 서버에 요청');
    // 내 글에 댓글 → 요청 없음
    const n0 = calls.length;
    await p.evaluate(() => { closePostDetail && closePostDetail(); openPostDetail('p2'); }).catch(() => {}); await p.waitForTimeout(500);
    await p.fill('#reply-p2', '내 글에 내가'); await p.evaluate(() => addComment('p2')); await p.waitForTimeout(600);
    assert(calls.length === n0, '내 글에 내가 단 댓글은 알림 요청을 보내지 않음');
    // 공지 댓글
    await p.evaluate(() => { switchTab('notice'); showNoticeDetail('n1'); }); await p.waitForTimeout(500);
    await p.fill('#notice-reply', '확인했어요'); await p.click('#notice-reply-btn'); await p.waitForTimeout(800);
    const c2 = calls.find(c => c.action === 'notify_comment' && c.kind === 'notice');
    assert(c2 && c2.parentId === 'n1' && /^[A-Za-z0-9]+$/.test(c2.commentId), '남이 올린 공지에 댓글 → notify_comment(kind=notice)');
    const n1 = calls.length;
    await p.evaluate(() => showNoticeDetail('n2')); await p.waitForTimeout(400);
    await p.fill('#notice-reply', '내 공지에'); await p.click('#notice-reply-btn'); await p.waitForTimeout(600);
    assert(calls.length === n1, '내가 올린 공지에 내가 단 댓글은 요청 없음');
    // 서버가 오류여도 댓글 저장은 그대로(조용히 무시)
    assert(await p.evaluate(() => Object.keys(window.__fb.fs).filter(k => k.startsWith('notices/n1/comments/')).length) === 1, '댓글 자체는 저장됨');
  } else {
    // 새 공지 → notify_notice
    await p.evaluate(() => { switchTab('notice'); openNoticeComposer(); }); await p.waitForTimeout(500);
    await p.fill('#notice-form-title', '내일 소풍'); await p.evaluate(() => { document.getElementById('notice-form-content').innerHTML = '도시락을 챙기세요'; });
    await p.evaluate(() => submitNoticeForm()); await p.waitForTimeout(900);
    const nid = await p.evaluate(() => Object.keys(window.__fb.fs).find(k => /^notices\/[^/]+$/.test(k) && window.__fb.fs[k].title === '내일 소풍').split('/')[1]);
    const c = calls.find(c => c.action === 'notify_notice');
    assert(c && c.noticeId === nid, '새 공지를 올리면 notify_notice(공지ID)를 서버에 요청');
    // 수정은 알림 안 함
    const n = calls.length;
    await p.evaluate((id) => { openNoticeComposer(id); }, nid); await p.waitForTimeout(400);
    await p.evaluate(() => submitNoticeForm()); await p.waitForTimeout(700);
    assert(calls.length === n, '공지를 수정할 때는 알림 요청을 보내지 않음');
  }
  assert(!b.errors.some(e => /PAGEERROR/.test(e)), '페이지 오류 없음 ' + b.errors.filter(e => /PAGEERROR/.test(e)).join('|'));
  console.log('\nMAIL SETTINGS TEST PASSED (' + which + ')');
} finally { await b.close(); }
