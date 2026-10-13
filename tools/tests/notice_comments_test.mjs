import { bootApp, assert } from './harness.mjs';
const member = { role: 'class2_member', grade: '1', ban: '2', number: '04', email: '20261204@hanilgo.cnehs.kr', nickname: 'A' };
const admin = { role: 'class2_member', grade: '1', ban: '2', number: '30', email: '20261230@hanilgo.cnehs.kr', nickname: 'Adm' };
const notice = { title: '시험 일정 안내', content: '다음 주 월요일부터 시험입니다.', category: 'class', authorName: '반장', authorOriginal: '20261201@hanilgo.cnehs.kr', createdAt: Date.now() - 3600000, showInPopup: false };
const other = { authorId: 'userB', authorName: 'B', authorOriginal: '20261205@hanilgo.cnehs.kr', content: '다른 사람 댓글', createdAt: Date.now() - 60000 };
const which = process.argv[2] || 'member';
const opts = which === 'guest' ? { guest: true, uid: 'x' } : { userData: which === 'admin' ? admin : member, uid: which === 'admin' ? 'userAdm' : 'userA', userEmail: (which === 'admin' ? admin : member).email };
const b = await bootApp({ ...opts, waitMs: 2500, fsData: { 'notices/n1': notice, 'notices/n1/comments/c0': other } });
const p = b.page;
const store = () => p.evaluate(() => Object.fromEntries(Object.entries(window.__fb.fs).filter(([k]) => k.startsWith('notices/n1/comments/'))));
try {
  await p.evaluate(() => { switchTab('notice'); }); await p.waitForTimeout(300);
  await p.evaluate(() => showNoticeDetail('n1')); await p.waitForTimeout(600);
  assert(await p.isVisible('#notice-hub-detail-view') && (await p.innerText('#notice-hub-detail-view')).includes('시험 일정 안내'), '공지 상세가 열림');
  assert((await p.innerText('#notice-comments-list')).includes('댓글 1개') && (await p.innerText('#notice-comments-list')).includes('다른 사람 댓글'), '공지 아래에 기존 댓글이 보임(댓글 1개)');
  if (which === 'guest') {
    assert((await p.getAttribute('#notice-reply', 'placeholder')).includes('로그인'), '로그아웃 상태: 입력창에 "로그인하면 댓글을 남길 수 있어요"');
    await p.fill('#notice-reply', '게스트 댓글'); await p.click('#notice-reply-btn'); await p.waitForTimeout(400);
    assert(await p.evaluate(() => getComputedStyle(document.getElementById('auth-container')).display) === 'flex', '로그아웃 상태에서 등록하면 로그인 위젯이 뜸');
    assert(Object.keys(await store()).length === 1, '게스트 댓글은 저장되지 않음');
    assert(!(await p.innerText('#notice-comments-list')).match(/삭제|수정/), '게스트에게는 수정/삭제 버튼이 없음');
  } else if (which === 'member') {
    assert(!(await p.innerText('#notice-comments-list')).match(/삭제|수정/), '남의 댓글에는 수정/삭제 버튼이 없음');
    await p.fill('#notice-reply', '확인했습니다!'); await p.press('#notice-reply', 'Enter'); await p.waitForTimeout(500);
    const s = await store(); const mine = Object.entries(s).find(([k, v]) => v.content === '확인했습니다!');
    assert(!!mine && mine[1].authorId === 'userA' && mine[1].authorOriginal === member.email && typeof mine[1].createdAt === 'number', 'Enter 로 등록: notices/n1/comments 에 내 댓글이 저장됨');
    assert((await p.innerText('#notice-comments-list')).includes('댓글 2개') && (await p.inputValue('#notice-reply')) === '', '목록이 2개로 늘고 입력창이 비워짐');
    // 수정
    p.once('dialog', d => d.accept('수정한 댓글'));
    await p.click('#notice-comments-list .detail-comment-actions span:has-text("수정")'); await p.waitForTimeout(500);
    assert(Object.values(await store()).some(v => v.content === '수정한 댓글' && v.editedAt), '내 댓글 수정(수정됨 표시)');
    assert((await p.innerText('#notice-comments-list')).includes('수정됨'), '"수정됨"이 화면에 보임');
    // 삭제
    p.once('dialog', d => d.accept());
    await p.click('#notice-comments-list .detail-comment-actions span:has-text("삭제")'); await p.waitForTimeout(500);
    assert(Object.keys(await store()).length === 1 && (await p.innerText('#notice-comments-list')).includes('댓글 1개'), '내 댓글 삭제');
    // XSS
    await p.fill('#notice-reply', '<img src=x onerror="window.__xss=1">'); await p.click('#notice-reply-btn'); await p.waitForTimeout(500);
    assert(await p.evaluate(() => !window.__xss), '댓글에 넣은 HTML 은 실행되지 않음');
    // 공지 닫았다 열어도 구독 정리/재구독
    await p.evaluate(() => closeNoticeDetailView()); await p.evaluate(() => showNoticeDetail('n1')); await p.waitForTimeout(500);
    assert((await p.innerText('#notice-comments-list')).includes('댓글 2개'), '닫았다가 다시 열어도 댓글이 보임');
  } else {
    // 관리자(공지 작성 권한): 남의 댓글 삭제 가능 + 공지 삭제 시 댓글도 함께 삭제
    assert((await p.innerText('#notice-comments-list')).includes('삭제'), '관리자는 남의 댓글도 삭제할 수 있음');
    p.on('dialog', d => d.accept());
    await p.evaluate(() => deleteNoticeConfirm('n1')); await p.waitForTimeout(700);
    assert(await p.evaluate(() => window.__fb.fs['notices/n1'] === undefined), '공지가 삭제됨');
    assert(Object.keys(await store()).length === 0, '공지를 지우면 그 공지의 댓글도 함께 삭제됨');
  }
  assert(!b.errors.some(e => /PAGEERROR/.test(e)), '페이지 오류 없음 ' + b.errors.filter(e => /PAGEERROR/.test(e)).join('|'));
  console.log('\nNOTICE COMMENTS TEST PASSED (' + which + ')');
} finally { await b.close(); }
