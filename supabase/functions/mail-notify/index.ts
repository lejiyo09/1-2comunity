// 이메일 알림(Gmail SMTP) Edge Function: 내 글에 댓글이 달렸을 때 / 새 공지가 올라왔을 때 등록해 둔 Gmail 로 알려 준다.
//
// 구조
//   · 로그인은 Firebase Auth 라서, 클라이언트가 보낸 Firebase ID 토큰을 서버에서 직접 검증한다(apps-write 와 같은 방식).
//   · 이메일 주소는 개인정보라 Supabase 테이블(email_subscriptions, RLS 로 직접 접근 불가)에 두고 이 함수만 service_role 로 읽는다.
//   · 알림은 "클라이언트가 댓글/공지를 올린 직후 이 함수를 부르는" 방식이다(Firestore 에는 서버 트리거가 없다 = Cloud Functions 유료 플랜 필요).
//     그래서 부른 사람의 말을 믿지 않고, 같은 ID 토큰으로 Firestore REST 를 읽어서 "정말 그 댓글/공지가 있고, 부른 사람이 쓴 것"인지 확인한 뒤에만 보낸다.
//   · 본인이 쓴 글에는 보내지 않고, 같은 알림은 한 번만(중복 방지), 하루 발송 한도(Gmail 약 500통)를 넘기지 않는다.
//
// action (POST JSON, Authorization: Bearer <Firebase ID 토큰>)
//   get                                   내 구독 상태
//   request_code { email }                Gmail 주소로 인증 코드(6자리) 발송
//   verify_code  { code }                 코드 확인 → 알림 켜짐
//   update_prefs { notifyComments, notifyNotices }
//   remove                                알림 끄기(주소 삭제)
//   notify_comment { kind: "post"|"notice", parentId, commentId }
//   notify_notice  { noticeId }
//
// 설정(Secrets): GMAIL_USER(발송에 쓸 Gmail 주소), GMAIL_APP_PASSWORD(구글 "앱 비밀번호" 16자리), SITE_URL(메일 속 링크 주소, 예: https://내사이트.onrender.com)
//   선택: MAIL_FROM_NAME, MAIL_DAILY_LIMIT(기본 400)
//   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 Supabase 가 자동으로 넣어 준다)
// 배포: supabase functions deploy mail-notify --no-verify-jwt --project-ref <프로젝트>   (자세한 순서는 docs/email-notify.md)

const FIREBASE_API_KEY = "AIzaSyDQaFGU_N0NyDr6yZChZJKPplJgQL6bfJA";
const FIREBASE_PROJECT_ID = "over-2a177";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://cryeosgmuxqyphntqqlc.supabase.co";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GMAIL_USER = (Deno.env.get("GMAIL_USER") ?? "").trim();
const GMAIL_APP_PASSWORD = (Deno.env.get("GMAIL_APP_PASSWORD") ?? "").replace(/\s+/g, ""); // 구글이 보여주는 "abcd efgh ..." 공백은 지운다
const SITE_URL = (Deno.env.get("SITE_URL") ?? "").trim().replace(/\/+$/, "");
const FROM_NAME = (Deno.env.get("MAIL_FROM_NAME") ?? "1-2 커뮤니티").replace(/[\r\n]/g, " ");
const DAILY_LIMIT = Math.max(1, Number(Deno.env.get("MAIL_DAILY_LIMIT") ?? "400") || 400);

const CODE_TTL_MS = 10 * 60_000;
const CODE_RESEND_MS = 60_000;
const CODE_MAX_PER_DAY = 5;
const CODE_MAX_ATTEMPTS = 5;
const CALLS_PER_HOUR = 60;
const COMMENT_DEDUP_MS = 5 * 60_000;      // 같은 사람이 같은 글에서 5분 안에 또 알림을 받지 않게(연달아 달린 댓글 폭주 방지)
const NOTICE_MAX_AGE_MS = 15 * 60_000;    // 방금 올린 공지만 알린다(오래된 공지를 다시 뿌리는 오용 방지)
const NOTICE_MAX_RECIPIENTS = 60;
const GMAIL_RE = /^[a-z0-9._%+-]{1,64}@(gmail\.com|googlemail\.com)$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
class HttpError extends Error { status: number; constructor(m: string, s = 400) { super(m); this.status = s; } }

// ---------- Firebase ----------
async function verifyFirebaseIdToken(idToken: string): Promise<{ uid: string; email: string } | null> {
    const resp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }),
    });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    const user = data?.users?.[0];
    if (!user?.localId || !user?.email) return null; // 이메일 없는 계정(익명 게스트)은 사용할 수 없다
    return { uid: user.localId, email: user.email };
}
// Firestore REST 로 문서를 읽는다. 부른 사람의 ID 토큰을 그대로 쓰므로 Firestore 보안 규칙이 그대로 적용된다(읽을 수 없으면 null).
async function readDoc(idToken: string, path: string): Promise<Record<string, any> | null> {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`, { headers: { Authorization: `Bearer ${idToken}` } });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    return d?.fields ?? null;
}
const fStr = (f: Record<string, any> | null, k: string): string => (f && typeof f[k]?.stringValue === "string") ? f[k].stringValue : "";
const fNum = (f: Record<string, any> | null, k: string): number => Number(f?.[k]?.integerValue ?? f?.[k]?.doubleValue ?? 0) || 0;

// ---------- DB (PostgREST, service_role) ----------
async function db(path: string, init: { method?: string; body?: unknown; prefer?: string } = {}): Promise<any> {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        method: init.method ?? "GET",
        headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json", ...(init.prefer ? { Prefer: init.prefer } : {}) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await r.text();
    if (!r.ok) { console.error("mail-notify db error", r.status, path, text.slice(0, 200)); throw new HttpError(r.status === 409 ? "이미 다른 계정에서 사용 중인 주소예요." : "서버 오류가 발생했어요.", r.status === 409 ? 409 : 500); }
    return text ? JSON.parse(text) : null;
}
const q = (v: string) => encodeURIComponent(v);
const iso = (ms: number) => new Date(ms).toISOString();
async function getSub(uid: string): Promise<any | null> { const rows = await db(`email_subscriptions?uid=eq.${q(uid)}&select=*`); return rows?.[0] ?? null; }
async function logMail(uid: string, kind: string, key: string | null) { await db("email_log", { method: "POST", body: { uid, kind, key }, prefer: "return=minimal" }); }
async function countLogs(filter: string): Promise<number> {
    const rows = await db(`email_log?${filter}&select=id`);
    return Array.isArray(rows) ? rows.length : 0;
}
async function sentToday(): Promise<number> { return await countLogs(`kind=in.(code,comment,notice)&created_at=gte.${q(iso(Date.now() - 86_400_000))}`); }
async function hasKey(key: string, sinceMs?: number): Promise<boolean> {
    return (await countLogs(`key=eq.${q(key)}${sinceMs ? `&created_at=gte.${q(iso(Date.now() - sinceMs))}` : ""}`)) > 0;
}

// ---------- 메일 ----------
type Mail = { to: string; subject: string; text: string; html: string };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const oneLine = (s: string, max: number) => s.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
async function sendMails(mails: Mail[]): Promise<number> {
    const hook = (globalThis as any).__gmwSendMails; // 시험용 대체 발송기
    if (hook) return await hook(mails);
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) throw new HttpError("메일 서버 설정(GMAIL_USER / GMAIL_APP_PASSWORD)이 아직 안 되어 있어요.", 503);
    const { SMTPClient } = await import("https://deno.land/x/denomailer@1.6.0/mod.ts");
    const client = new SMTPClient({ connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD } } });
    let sent = 0;
    try {
        for (const m of mails) {
            try { await client.send({ from: `${FROM_NAME} <${GMAIL_USER}>`, to: m.to, subject: m.subject, content: m.text, html: m.html }); sent++; }
            catch (e) { console.error("mail send failed", e); }
        }
    } finally { try { await client.close(); } catch (_) { /* ignore */ } }
    return sent;
}
function layout(title: string, bodyHtml: string, link: string | null): string {
    return `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif; max-width:480px; margin:0 auto; padding:20px; color:#1f2937;">
<div style="font-size:13px; color:#6b7280; margin-bottom:6px;">${esc(FROM_NAME)}</div>
<h2 style="font-size:18px; margin:0 0 14px;">${esc(title)}</h2>
${bodyHtml}
${link ? `<p style="margin:20px 0;"><a href="${esc(link)}" style="background:#2f6fed; color:#fff; text-decoration:none; padding:10px 18px; border-radius:10px; font-weight:700; display:inline-block;">사이트에서 보기</a></p>` : ""}
<p style="font-size:12px; color:#9ca3af; margin-top:24px;">이 메일은 사이트의 설정 → 이메일 알림에서 받기로 한 알림이에요. 받고 싶지 않으면 같은 곳에서 끌 수 있어요.</p>
</div>`;
}
const linkFor = (kind: "post" | "notice", id: string) => SITE_URL ? `${SITE_URL}/?share=${kind}&id=${encodeURIComponent(id)}` : null;

// ---------- 동작 ----------
const sha256 = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");
const publicSub = (s: any | null) => s ? { email: s.email, verified: !!s.verified, notifyComments: !!s.notify_comments, notifyNotices: !!s.notify_notices } : { email: null, verified: false, notifyComments: true, notifyNotices: true };

async function requestCode(uid: string, body: any) {
    const email = String(body?.email ?? "").trim().toLowerCase();
    if (!GMAIL_RE.test(email)) throw new HttpError("Gmail 주소(@gmail.com)만 등록할 수 있어요.");
    const cur = await getSub(uid);
    if (cur?.verified && cur.email.toLowerCase() === email) return { ...publicSub(cur), alreadyVerified: true };
    if (cur?.code_requested_at && Date.now() - Date.parse(cur.code_requested_at) < CODE_RESEND_MS) throw new HttpError("인증 코드는 1분에 한 번만 보낼 수 있어요. 잠시 후 다시 시도해 주세요.", 429);
    if (await countLogs(`uid=eq.${q(uid)}&kind=eq.code&created_at=gte.${q(iso(Date.now() - 86_400_000))}`) >= CODE_MAX_PER_DAY) throw new HttpError("오늘은 인증 코드를 더 받을 수 없어요. 내일 다시 시도해 주세요.", 429);
    if (await sentToday() >= DAILY_LIMIT) throw new HttpError("오늘 보낼 수 있는 메일 한도를 넘었어요. 내일 다시 시도해 주세요.", 429);
    const taken = await db(`email_subscriptions?email=eq.${q(email)}&verified=eq.true&uid=neq.${q(uid)}&select=uid`); // 주소는 항상 소문자로 저장한다
    if (taken?.length) throw new HttpError("이미 다른 계정에서 쓰고 있는 주소예요.", 409);
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    const row = { uid, email, verified: false, code_hash: await sha256(`${uid}:${code}`), code_expires_at: iso(Date.now() + CODE_TTL_MS), code_requested_at: iso(Date.now()), code_attempts: 0, updated_at: iso(Date.now()) };
    await db("email_subscriptions?on_conflict=uid", { method: "POST", body: row, prefer: "resolution=merge-duplicates,return=minimal" });
    const sent = await sendMails([{
        to: email, subject: "[이메일 알림] 인증 코드 " + code,
        text: `인증 코드: ${code}\n10분 안에 사이트에 입력해 주세요. 본인이 요청하지 않았다면 이 메일은 무시해도 돼요.`,
        html: layout("이메일 알림 인증 코드", `<p style="font-size:30px; letter-spacing:6px; font-weight:800; margin:8px 0 14px;">${code}</p><p style="font-size:14px;">10분 안에 사이트에 입력해 주세요. 본인이 요청하지 않았다면 이 메일은 무시해도 돼요.</p>`, null),
    }]);
    if (!sent) throw new HttpError("메일을 보내지 못했어요. 주소를 확인하고 잠시 후 다시 시도해 주세요.", 502);
    await logMail(uid, "code", null);
    return { sent: true };
}

async function verifyCode(uid: string, body: any) {
    const code = String(body?.code ?? "").trim();
    const cur = await getSub(uid);
    if (!cur || cur.verified || !cur.code_hash) throw new HttpError("먼저 인증 코드를 받아 주세요.");
    if (!/^\d{6}$/.test(code)) throw new HttpError("6자리 숫자를 입력해 주세요.");
    if (!cur.code_expires_at || Date.parse(cur.code_expires_at) < Date.now()) throw new HttpError("인증 코드가 만료됐어요. 새 코드를 받아 주세요.", 410);
    if ((cur.code_attempts ?? 0) >= CODE_MAX_ATTEMPTS) throw new HttpError("틀린 횟수가 너무 많아요. 새 코드를 받아 주세요.", 429);
    if (await sha256(`${uid}:${code}`) !== cur.code_hash) {
        await db(`email_subscriptions?uid=eq.${q(uid)}`, { method: "PATCH", body: { code_attempts: (cur.code_attempts ?? 0) + 1 }, prefer: "return=minimal" });
        throw new HttpError("코드가 달라요. 다시 확인해 주세요.");
    }
    await db(`email_subscriptions?uid=eq.${q(uid)}`, { method: "PATCH", body: { verified: true, code_hash: null, code_expires_at: null, code_attempts: 0, updated_at: iso(Date.now()) }, prefer: "return=minimal" });
    return publicSub(await getSub(uid));
}

async function updatePrefs(uid: string, body: any) {
    const cur = await getSub(uid);
    if (!cur?.verified) throw new HttpError("먼저 Gmail 주소를 인증해 주세요.");
    const patch: Record<string, unknown> = { updated_at: iso(Date.now()) };
    if (typeof body?.notifyComments === "boolean") patch.notify_comments = body.notifyComments;
    if (typeof body?.notifyNotices === "boolean") patch.notify_notices = body.notifyNotices;
    await db(`email_subscriptions?uid=eq.${q(uid)}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
    return publicSub(await getSub(uid));
}

async function notifyComment(user: { uid: string }, idToken: string, body: any) {
    const kind = body?.kind === "notice" ? "notice" : body?.kind === "post" ? "post" : null;
    const parentId = String(body?.parentId ?? ""), commentId = String(body?.commentId ?? "");
    if (!kind || !ID_RE.test(parentId) || !ID_RE.test(commentId)) throw new HttpError("요청이 올바르지 않아요.");
    const base = kind === "post" ? "posts" : "notices";
    // 1) 부른 사람이 정말 그 댓글을 썼는지 확인
    const comment = await readDoc(idToken, `${base}/${parentId}/comments/${commentId}`);
    if (!comment) return { sent: 0, reason: "comment-not-found" };
    if (fStr(comment, "authorId") !== user.uid) throw new HttpError("본인이 쓴 댓글만 알릴 수 있어요.", 403);
    // 2) 글/공지 작성자 = 받는 사람 (본인 글이면 보내지 않음)
    const parent = await readDoc(idToken, `${base}/${parentId}`);
    if (!parent) return { sent: 0, reason: "parent-not-found" };
    const recipientUid = kind === "post" ? fStr(parent, "authorId") : fStr(parent, "authorUid");
    if (!recipientUid || recipientUid === user.uid) return { sent: 0, reason: "self-or-unknown" };
    const sub = await getSub(recipientUid);
    if (!sub?.verified || !sub.notify_comments) return { sent: 0, reason: "not-subscribed" };
    // 3) 중복/폭주 방지, 하루 한도
    if (await hasKey(`c:${commentId}`)) return { sent: 0, reason: "duplicate" };
    if (await hasKey(`cp:${kind}:${parentId}:${recipientUid}`, COMMENT_DEDUP_MS)) return { sent: 0, reason: "recent" };
    if (await sentToday() >= DAILY_LIMIT) return { sent: 0, reason: "daily-limit" };
    const who = oneLine(fStr(comment, "authorName") || "누군가", 20);
    const title = oneLine(fStr(parent, "title") || (kind === "post" ? "내 글" : "공지"), 60);
    const content = oneLine(fStr(comment, "content"), 200);
    const link = linkFor(kind, parentId);
    const sent = await sendMails([{
        to: sub.email, subject: `[댓글] ${title}`,
        text: `${who}님이 ${kind === "post" ? "내 글" : "내가 올린 공지"} "${title}"에 댓글을 남겼어요.\n\n${content}\n${link ? `\n${link}` : ""}`,
        html: layout(`${kind === "post" ? "내 글" : "내가 올린 공지"}에 새 댓글이 달렸어요`, `<p style="font-size:14px; margin:0 0 8px;"><b>${esc(title)}</b></p><div style="background:#f3f4f6; border-radius:10px; padding:12px 14px; font-size:14px; line-height:1.5;"><b>${esc(who)}</b><br>${esc(content)}</div>`, link),
    }]);
    if (sent) { await logMail(recipientUid, "comment", `c:${commentId}`); await logMail(recipientUid, "comment", `cp:${kind}:${parentId}:${recipientUid}`); }
    return { sent };
}

async function notifyNotice(user: { uid: string }, idToken: string, body: any) {
    const noticeId = String(body?.noticeId ?? "");
    if (!ID_RE.test(noticeId)) throw new HttpError("요청이 올바르지 않아요.");
    const notice = await readDoc(idToken, `notices/${noticeId}`);
    if (!notice) return { sent: 0, reason: "notice-not-found" };
    if (fStr(notice, "authorUid") !== user.uid) throw new HttpError("본인이 올린 공지만 알릴 수 있어요.", 403);
    if (Date.now() - fNum(notice, "createdAt") > NOTICE_MAX_AGE_MS) return { sent: 0, reason: "too-old" };
    if (await hasKey(`notice:${noticeId}`)) return { sent: 0, reason: "duplicate" };
    const used = await sentToday();
    const room = DAILY_LIMIT - used;
    if (room <= 0) return { sent: 0, reason: "daily-limit" };
    const subs: any[] = (await db(`email_subscriptions?verified=eq.true&notify_notices=eq.true&uid=neq.${q(user.uid)}&select=uid,email&limit=${NOTICE_MAX_RECIPIENTS}`)) ?? [];
    const targets = subs.slice(0, room);
    await logMail(user.uid, "notice_mark", `notice:${noticeId}`); // 먼저 기록해서 동시에 두 번 불려도 한 번만 보낸다(발송 수에는 세지 않는 표시)
    if (!targets.length) return { sent: 0, reason: "no-subscribers" };
    const title = oneLine(fStr(notice, "title") || "새 공지", 80);
    const preview = oneLine(fStr(notice, "content"), 160);
    const important = notice.important?.booleanValue === true;
    const link = linkFor("notice", noticeId);
    const mails: Mail[] = targets.map((t) => ({
        to: t.email, subject: `[공지${important ? " ⭐" : ""}] ${title}`,
        text: `새 공지가 올라왔어요: ${title}\n\n${preview}\n${link ? `\n${link}` : ""}`,
        html: layout(`새 공지가 올라왔어요${important ? " (중요)" : ""}`, `<p style="font-size:15px; font-weight:700; margin:0 0 8px;">${esc(title)}</p><div style="background:#f3f4f6; border-radius:10px; padding:12px 14px; font-size:14px; line-height:1.5;">${esc(preview)}</div>`, link),
    }));
    const sent = await sendMails(mails);
    for (const t of targets.slice(0, sent)) await logMail(t.uid, "notice", null);
    return { sent };
}

export async function handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
    try {
        if (req.method !== "POST") throw new HttpError("POST 만 지원합니다.", 405);
        if (!SERVICE_ROLE_KEY) throw new HttpError("서버 설정이 아직 안 되어 있어요.", 503);
        const idToken = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
        if (!idToken) throw new HttpError("로그인이 필요해요.", 401);
        const user = await verifyFirebaseIdToken(idToken);
        if (!user) throw new HttpError("로그인 정보를 확인하지 못했어요. 다시 로그인해 주세요.", 401);
        const body = await req.json().catch(() => ({}));
        const action = String(body?.action ?? "");
        // 호출 횟수 제한(부풀린 호출로 DB/메일을 두드리는 것 방지) - 알림 호출만 센다
        if (action === "notify_comment" || action === "notify_notice") {
            if (await countLogs(`uid=eq.${q(user.uid)}&kind=eq.call&created_at=gte.${q(iso(Date.now() - 3_600_000))}`) >= CALLS_PER_HOUR) throw new HttpError("요청이 너무 많아요. 잠시 후 다시 시도해 주세요.", 429);
            await logMail(user.uid, "call", null);
        }
        switch (action) {
            case "get": return json(publicSub(await getSub(user.uid)));
            case "request_code": return json(await requestCode(user.uid, body));
            case "verify_code": return json(await verifyCode(user.uid, body));
            case "update_prefs": return json(await updatePrefs(user.uid, body));
            case "remove": await db(`email_subscriptions?uid=eq.${q(user.uid)}`, { method: "DELETE", prefer: "return=minimal" }); return json(publicSub(null));
            case "notify_comment": return json(await notifyComment(user, idToken, body));
            case "notify_notice": return json(await notifyNotice(user, idToken, body));
            default: throw new HttpError("알 수 없는 요청이에요.");
        }
    } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        console.error("mail-notify error:", e);
        return json({ error: "서버 오류가 발생했어요." }, 500);
    }
}
Deno.serve(handle);
