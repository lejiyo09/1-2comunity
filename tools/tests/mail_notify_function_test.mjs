// supabase/functions/mail-notify/index.ts 시험: Deno/네트워크를 가짜로 바꿔서 함수 로직(인증 코드, 구독, 댓글/공지 알림, 한도·중복 방지, 보안)을 확인한다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
function assert(c, m) { if (!c) { console.error('FAIL: ' + m); process.exitCode = 1; throw new Error('FAIL: ' + m); } console.log('ok -', m); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'supabase/functions/mail-notify/index.ts'), 'utf8');
const { code: JS } = await transform(SRC, { loader: 'ts', format: 'esm', target: 'es2022' });

// ---------- 가짜 서버 상태 ----------
const SITE = 'https://site.example.com';
let env, handler, mails, subs, logs, docs, now0 = Date.now(), seq = 0, dbFail = false;
const users = { 'tok-A': { localId: 'userA', email: '20261201@hanilgo.cnehs.kr' }, 'tok-B': { localId: 'userB', email: '20261202@hanilgo.cnehs.kr' }, 'tok-C': { localId: 'userC', email: '20261203@hanilgo.cnehs.kr' } };
const str = (v) => ({ stringValue: v }), int = (v) => ({ integerValue: String(v) });
const matches = (row, key, cond) => {
  const [op, ...rest] = cond.split('.'); const val = rest.join('.');
  const x = row[key];
  if (op === 'eq') return String(x) === val;
  if (op === 'neq') return String(x) !== val;
  if (op === 'gte') return String(x) >= val;
  if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').includes(String(x));
  return true;
};
const tableOf = (name) => name === 'email_subscriptions' ? subs : logs;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)); const method = (init.method || 'GET').toUpperCase();
  const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'identitytoolkit.googleapis.com') { const t = JSON.parse(init.body).idToken; return users[t] ? reply(200, { users: [users[t]] }) : reply(400, { error: 'bad' }); }
  if (u.hostname === 'firestore.googleapis.com') {
    const p = decodeURIComponent(u.pathname.split('/documents/')[1]); const token = (init.headers?.Authorization || '').replace('Bearer ', '');
    if (!users[token]) return reply(401, {});
    return docs[p] ? reply(200, { name: p, fields: docs[p] }) : reply(404, {});
  }
  if (u.pathname.startsWith('/rest/v1/')) {
    if (dbFail) return reply(500, { message: 'boom with secret ' + env.GMAIL_APP_PASSWORD });
    const name = u.pathname.split('/rest/v1/')[1]; const T = tableOf(name);
    const filters = [...u.searchParams.entries()].filter(([k]) => !['select', 'limit', 'on_conflict'].includes(k));
    const sel = () => T.filter((r) => filters.every(([k, c]) => matches(r, k, c)));
    if (method === 'GET') { let rows = sel(); const lim = Number(u.searchParams.get('limit') || 0); if (lim) rows = rows.slice(0, lim); return reply(200, rows.map((r) => ({ ...r }))); }
    const body = init.body ? JSON.parse(init.body) : null;
    if (method === 'POST') {
      if (name === 'email_log') { T.push({ id: ++seq, created_at: new Date().toISOString(), ...body }); return reply(201); }
      const ex = T.find((r) => r.uid === body.uid);
      if (!ex && body.verified === false) { /* 새 행 */ }
      if (ex) Object.assign(ex, body); else T.push({ notify_comments: true, notify_notices: true, code_attempts: 0, verified: false, ...body });
      return reply(201);
    }
    if (method === 'PATCH') { sel().forEach((r) => Object.assign(r, body)); return reply(204); }
    if (method === 'DELETE') { const del = new Set(sel()); const keep = T.filter((r) => !del.has(r)); T.length = 0; T.push(...keep); return reply(204); }
  }
  return reply(404, {});
};
async function load(extraEnv = {}) {
  env = { SUPABASE_SERVICE_ROLE_KEY: 'svc-key', GMAIL_USER: 'sender@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop', SITE_URL: SITE + '/', ...extraEnv };
  subs = []; logs = []; mails = []; dbFail = false;
  docs = {};
  globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
  globalThis.__gmwSendMails = async (m) => { mails.push(...m); return m.length; };
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-')), 'fn.mjs'); fs.writeFileSync(f, JS);
  await import(f + '?v=' + Math.random());
}
const call = async (token, body, opts = {}) => {
  const r = await handler(new Request('https://x.supabase.co/functions/v1/mail-notify', { method: opts.method || 'POST', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, body: opts.method === 'GET' ? undefined : JSON.stringify(body) }));
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) {} return { status: r.status, j, text };
};
const verifyUser = async (token, email) => { await call(token, { action: 'request_code', email }); const code = mails[mails.length - 1].text.match(/(\d{6})/)[1]; return (await call(token, { action: 'verify_code', code })); };
const resend = () => { subs.forEach((s) => { if (s.code_requested_at) s.code_requested_at = new Date(Date.now() - 120000).toISOString(); }); };

await load();
// --- 인증/기본 ---
let r = await call(null, { action: 'get' }); assert(r.status === 401, '토큰 없으면 401');
r = await call('tok-bad', { action: 'get' }); assert(r.status === 401, '잘못된 토큰이면 401');
r = await handler(new Request('https://x/', { method: 'GET' })); assert(r.status === 405, 'POST 아닌 요청은 405');
r = await handler(new Request('https://x/', { method: 'OPTIONS' })); assert(r.status === 200 && r.headers.get('access-control-allow-origin') === '*', 'OPTIONS(CORS) 응답');
r = await call('tok-A', { action: 'nope' }); assert(r.status === 400, '알 수 없는 action 은 400');
r = await call('tok-A', { action: 'get' }); assert(r.status === 200 && r.j.verified === false && r.j.email === null, '처음엔 구독 없음');

// --- 인증 코드 ---
r = await call('tok-A', { action: 'request_code', email: 'someone@naver.com' }); assert(r.status === 400 && /Gmail/.test(r.j.error), 'Gmail 이 아니면 거부');
r = await call('tok-A', { action: 'request_code', email: 'a b@gmail.com' }); assert(r.status === 400, '형식이 이상한 주소는 거부');
r = await call('tok-A', { action: 'request_code', email: 'Student.A+x@Gmail.com' }); assert(r.status === 200 && mails.length === 1, '코드 요청 성공 → 메일 1통');
assert(mails[0].to === 'student.a+x@gmail.com' && /^\[이메일 알림\] 인증 코드 \d{6}$/.test(mails[0].subject), '주소는 소문자로, 제목에 6자리 코드');
const code1 = mails[0].text.match(/(\d{6})/)[1];
assert(subs[0].code_hash && subs[0].code_hash.length === 64 && !JSON.stringify(subs[0]).includes(code1), '코드는 해시로만 저장(평문 없음)');
r = await call('tok-A', { action: 'request_code', email: 'student.a+x@gmail.com' }); assert(r.status === 429, '1분 안에 또 요청하면 429');
r = await call('tok-A', { action: 'verify_code', code: '000000' === code1 ? '111111' : '000000' }); assert(r.status === 400 && subs[0].code_attempts === 1, '틀린 코드 → 400, 시도 횟수 기록');
r = await call('tok-A', { action: 'verify_code', code: 'abc' }); assert(r.status === 400, '6자리 숫자가 아니면 400');
r = await call('tok-A', { action: 'verify_code', code: code1 }); assert(r.status === 200 && r.j.verified === true && r.j.email === 'student.a+x@gmail.com', '맞는 코드 → 인증 완료');
assert(subs[0].code_hash === null, '인증 뒤 코드 해시 삭제');
r = await call('tok-A', { action: 'verify_code', code: code1 }); assert(r.status === 400, '이미 인증됐으면 다시 확인할 수 없음');
// 다른 계정이 같은 주소를 쓰려 하면 거부
resend(); r = await call('tok-B', { action: 'request_code', email: 'student.a+x@gmail.com' }); assert(r.status === 409, '다른 계정이 이미 인증한 주소는 409');
// 만료/시도 횟수
resend(); await call('tok-B', { action: 'request_code', email: 'b@gmail.com' });
const subB = subs.find((s) => s.uid === 'userB'); const codeB = mails[mails.length - 1].text.match(/(\d{6})/)[1];
for (let i = 0; i < 5; i++) await call('tok-B', { action: 'verify_code', code: codeB === '123456' ? '654321' : '123456' });
r = await call('tok-B', { action: 'verify_code', code: codeB }); assert(r.status === 429, '틀린 횟수 5회 이후에는 맞는 코드도 거부(새 코드 필요)');
subB.code_expires_at = new Date(Date.now() - 1000).toISOString(); subB.code_attempts = 0;
r = await call('tok-B', { action: 'verify_code', code: codeB }); assert(r.status === 410, '만료된 코드는 410');
resend(); r = await call('tok-B', { action: 'request_code', email: 'b@gmail.com' }); const codeB2 = mails[mails.length - 1].text.match(/(\d{6})/)[1];
r = await call('tok-B', { action: 'verify_code', code: codeB2 }); assert(r.status === 200 && r.j.verified, '새 코드로 인증 성공(B)');
resend(); r = await call('tok-C', { action: 'request_code', email: 'c@gmail.com' }); const codeC = mails[mails.length - 1].text.match(/(\d{6})/)[1]; await call('tok-C', { action: 'verify_code', code: codeC });
// 하루 요청 횟수 제한(계정당 5회)
resend(); logs.filter((l) => l.uid === 'userC' && l.kind === 'code').length;
for (let i = 0; i < 4; i++) logs.push({ id: ++seq, created_at: new Date().toISOString(), uid: 'userC', kind: 'code', key: null });
resend(); r = await call('tok-C', { action: 'request_code', email: 'c2@gmail.com' }); assert(r.status === 429 && /오늘/.test(r.j.error), '하루 인증 코드 요청 5회 초과는 429');

// --- 설정 ---
r = await call('tok-A', { action: 'update_prefs', notifyComments: false, notifyNotices: true }); assert(r.status === 200 && r.j.notifyComments === false && r.j.notifyNotices === true, '알림 종류 설정');
await call('tok-A', { action: 'update_prefs', notifyComments: true });
await call('tok-B', { action: 'update_prefs', notifyNotices: false });
r = await call('tok-A', { action: 'update_prefs', notifyComments: 'yes' }); assert(r.status === 200 && r.j.notifyComments === true, '불리언이 아닌 값은 무시');

// --- 댓글 알림 ---
docs['posts/p1'] = { title: str('수학 질문 있어요'), authorId: str('userA') };
docs['posts/p1/comments/c1'] = { authorId: str('userB'), authorName: str('B학생'), content: str('이거 <script>alert(1)</script> 풀이 알려줄게요\n두 번째 줄') };
mails.length = 0;
r = await call('tok-B', { action: 'notify_comment', kind: 'post', parentId: 'p1', commentId: 'c1' });
assert(r.status === 200 && r.j.sent === 1 && mails.length === 1 && mails[0].to === 'student.a+x@gmail.com', '남이 내 글에 댓글 → 글쓴이(A)의 Gmail 로 1통');
assert(mails[0].subject === '[댓글] 수학 질문 있어요' && mails[0].text.includes('B학생') && mails[0].html.includes(`${SITE}/?share=post&amp;id=p1`) && mails[0].text.includes(`${SITE}/?share=post&id=p1`), '제목/보낸 사람/사이트 링크 포함(SITE_URL 은 서버 설정값)');
assert(!mails[0].html.includes('<script>') && mails[0].html.includes('&lt;script&gt;'), '댓글 내용의 HTML 은 이스케이프됨');
assert(!/[\r\n]/.test(mails[0].subject), '제목에 줄바꿈 없음(헤더 주입 방지)');
r = await call('tok-B', { action: 'notify_comment', kind: 'post', parentId: 'p1', commentId: 'c1' }); assert(r.j.sent === 0 && r.j.reason === 'duplicate' && mails.length === 1, '같은 댓글 알림은 한 번만');
docs['posts/p1/comments/c2'] = { authorId: str('userB'), authorName: str('B학생'), content: str('두번째') };
r = await call('tok-B', { action: 'notify_comment', kind: 'post', parentId: 'p1', commentId: 'c2' }); assert(r.j.sent === 0 && r.j.reason === 'recent', '같은 글에서 5분 안의 연속 댓글은 알림 폭주 방지');
docs['posts/p1/comments/c3'] = { authorId: str('userA'), authorName: str('A'), content: str('내 글에 내가 단 댓글') };
r = await call('tok-A', { action: 'notify_comment', kind: 'post', parentId: 'p1', commentId: 'c3' }); assert(r.j.sent === 0 && r.j.reason === 'self-or-unknown', '본인 글에 단 본인 댓글은 알리지 않음');
docs['posts/p1/comments/c4'] = { authorId: str('userC'), authorName: str('C'), content: str('C 의 댓글') };
r = await call('tok-B', { action: 'notify_comment', kind: 'post', parentId: 'p1', commentId: 'c4' }); assert(r.status === 403, '남의 댓글을 내가 쓴 것처럼 알리게 할 수 없음(403)');
r = await call('tok-B', { action: 'notify_comment', kind: 'post', parentId: 'p1', commentId: 'none' }); assert(r.j.sent === 0 && r.j.reason === 'comment-not-found', '없는 댓글은 보내지 않음');
r = await call('tok-B', { action: 'notify_comment', kind: 'post', parentId: '../x', commentId: 'c1' }); assert(r.status === 400, '경로를 건드리는 ID 는 거부');
docs['posts/p2'] = { title: str('B의 글'), authorId: str('userB') }; docs['posts/p2/comments/d1'] = { authorId: str('userC'), authorName: str('C'), content: str('hi') };
r = await call('tok-C', { action: 'notify_comment', kind: 'post', parentId: 'p2', commentId: 'd1' }); assert(r.j.sent === 1 && mails[mails.length - 1].to === 'b@gmail.com', '다른 글쓴이(B)에게는 B 의 주소로');
docs['posts/p3'] = { title: str('구독 안 한 사람 글'), authorId: str('userZ') }; docs['posts/p3/comments/e1'] = { authorId: str('userC'), authorName: str('C'), content: str('hi') };
r = await call('tok-C', { action: 'notify_comment', kind: 'post', parentId: 'p3', commentId: 'e1' }); assert(r.j.sent === 0 && r.j.reason === 'not-subscribed', '알림을 안 켠 글쓴이에게는 보내지 않음');
await call('tok-A', { action: 'update_prefs', notifyComments: false });
docs['posts/p1/comments/c5'] = { authorId: str('userC'), authorName: str('C'), content: str('또 다른 댓글') };
r = await call('tok-C', { action: 'notify_comment', kind: 'post', parentId: 'p1', commentId: 'c5' }); assert(r.j.sent === 0 && r.j.reason === 'not-subscribed', '"댓글 알림"을 끈 사람에게는 보내지 않음');
await call('tok-A', { action: 'update_prefs', notifyComments: true });
// 공지 댓글 → 공지 작성자(authorUid)
docs['notices/n1'] = { title: str('시험 안내'), authorUid: str('userA'), createdAt: int(Date.now()), content: str('내용'), important: { booleanValue: true } };
docs['notices/n1/comments/k1'] = { authorId: str('userC'), authorName: str('C'), content: str('확인했습니다') };
mails.length = 0;
r = await call('tok-C', { action: 'notify_comment', kind: 'notice', parentId: 'n1', commentId: 'k1' }); assert(r.j.sent === 1 && mails[0].to === 'student.a+x@gmail.com' && mails[0].html.includes('share=notice&amp;id=n1'), '공지에 달린 댓글은 공지 작성자에게');

// --- 공지 알림 ---
mails.length = 0;
r = await call('tok-B', { action: 'notify_notice', noticeId: 'n1' }); assert(r.status === 403, '공지 작성자가 아닌 사람은 공지 알림을 보낼 수 없음(403)');
r = await call('tok-A', { action: 'notify_notice', noticeId: 'n1' });
// 구독자: A(공지 켬, 작성자라 제외), B(공지 끔), C(켬) → C 한 명
assert(r.j.sent === 1 && mails.length === 1 && mails[0].to === 'c@gmail.com', '새 공지 → 공지 알림을 켠 사람(작성자 본인 제외)에게만');
assert(mails[0].subject === '[공지 ⭐] 시험 안내', '중요 공지는 제목에 표시');
r = await call('tok-A', { action: 'notify_notice', noticeId: 'n1' }); assert(r.j.sent === 0 && r.j.reason === 'duplicate' && mails.length === 1, '같은 공지는 한 번만 알림');
docs['notices/n0'] = { title: str('옛 공지'), authorUid: str('userA'), createdAt: int(Date.now() - 3600_000) };
r = await call('tok-A', { action: 'notify_notice', noticeId: 'n0' }); assert(r.j.sent === 0 && r.j.reason === 'too-old', '15분 넘은 옛 공지는 알리지 않음(오용 방지)');
r = await call('tok-A', { action: 'notify_notice', noticeId: 'nx' }); assert(r.j.sent === 0 && r.j.reason === 'notice-not-found', '없는 공지는 보내지 않음');

// --- 하루 한도 / 설정 누락 / 오류 시 비밀 비노출 / 삭제 ---
const logsBefore = logs.length;
await load({ MAIL_DAILY_LIMIT: '2' });
subs.push({ uid: 'userA', email: 'a@gmail.com', verified: true, notify_comments: true, notify_notices: true });
docs['posts/p1'] = { title: str('t'), authorId: str('userA') }; docs['posts/p1/comments/c1'] = { authorId: str('userB'), authorName: str('B'), content: str('x') }; docs['posts/p1/comments/c2'] = { authorId: str('userB'), authorName: str('B'), content: str('y') };
for (let i = 0; i < 2; i++) logs.push({ id: ++seq, created_at: new Date().toISOString(), uid: 'userA', kind: 'comment', key: 'old' + i });
r = await call('tok-B', { action: 'notify_comment', kind: 'post', parentId: 'p1', commentId: 'c1' }); assert(r.j.sent === 0 && r.j.reason === 'daily-limit' && mails.length === 0, '하루 발송 한도(MAIL_DAILY_LIMIT)를 넘으면 보내지 않음');
r = await call('tok-C', { action: 'request_code', email: 'new@gmail.com' }); assert(r.status === 429, '한도를 넘으면 인증 코드도 보내지 않음');
await load({ GMAIL_USER: '', GMAIL_APP_PASSWORD: '' });
delete globalThis.__gmwSendMails;
r = await call('tok-A', { action: 'request_code', email: 'a@gmail.com' }); assert(r.status === 503 && /GMAIL_USER/.test(r.j.error), '메일 서버 설정이 없으면 503 안내');
await load();
dbFail = true; r = await call('tok-A', { action: 'get' });
assert(r.status === 500 && !r.text.includes('abcdefghijklmnop') && !r.text.includes('svc-key') && !r.text.includes('boom'), 'DB 오류가 나도 응답에 키/내부 오류가 새지 않음');
dbFail = false;
await load();
subs.push({ uid: 'userA', email: 'a@gmail.com', verified: true, notify_comments: true, notify_notices: true });
r = await call('tok-A', { action: 'remove' }); assert(r.status === 200 && subs.length === 0 && r.j.verified === false, '알림 끄기: 저장된 주소 삭제');
// 호출 횟수 제한
for (let i = 0; i < 60; i++) logs.push({ id: ++seq, created_at: new Date().toISOString(), uid: 'userB', kind: 'call', key: null });
r = await call('tok-B', { action: 'notify_comment', kind: 'post', parentId: 'p1', commentId: 'c1' }); assert(r.status === 429, '알림 호출이 1시간에 60회를 넘으면 429');
console.log('\nMAIL NOTIFY FUNCTION TESTS PASSED');
