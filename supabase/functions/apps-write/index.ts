// 앱스토어(웹앱 게시) 쓰기 전용 Edge Function: 앱 등록 / 수정(새 버전 업로드 포함) / 삭제 / 내 앱 목록.
//
// 왜 Edge Function인가:
//   이 사이트의 로그인은 Supabase Auth가 아니라 Firebase Auth다. 그래서 Supabase RLS의 auth.uid()로는 "누가 만든 앱인지"를 알 수 없다.
//   기존 자료실(edit-material)/음악(music-delete)과 같은 패턴으로, 클라이언트가 보낸 Firebase ID 토큰을 서버에서 직접 검증하고
//   (클라이언트가 "나는 이 사람이다"라고 주장하는 값을 그대로 믿지 않는다), DB의 author_uid와 비교해 "본인 앱"일 때만 쓴다.
//   apps / app_versions 테이블은 RLS로 클라이언트의 직접 쓰기가 전부 막혀 있고(supabase/migrations/20261002_appstore.sql),
//   이 함수만 service_role 키로 쓴다.
//
// 업로드 흐름 (파일이 크므로 함수를 거치지 않고 Storage로 직접 올린다):
//   1) action: "prepare"  → 권한/형식/크기 검사 후 "서명된 업로드 URL(토큰)"을 발급 (등록이면 새 appId를 만들고, 그 ID로 "등록 중" 임시 행
//                            (published=false, file_path='pending')을 작성자 이름으로 미리 만들어 둔다 → 이후 commit 은 본인 행에만 가능)
//   2) 클라이언트가 그 토큰으로 webapps 버킷에 파일을 직접 업로드 (sb.storage.from('webapps').uploadToSignedUrl)
//   3) action: "commit"   → 올라간 파일이 실제로 있는지/크기/ZIP 시그니처를 서버에서 다시 확인한 뒤 DB에 반영
//   그 외: "update-meta"(파일 없이 정보만 수정), "delete", "mine"(내 앱 목록: 비공개 포함)
//
// 앱을 수정(새 파일 교체)해도 apps.id(= 공개 주소 /app/<id>)는 그대로고 file_path만 새 경로로 바뀐다.
// 이전 버전 파일은 버전 이력(app_versions)에 남겨 둔다.
//
// 배포 방법 (Supabase CLI):
//   1. supabase login
//   2. supabase link --project-ref cryeosgmuxqyphntqqlc      (자료실 Edge Function들과 같은 프로젝트)
//   3. supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<이 프로젝트의 service_role 키>
//      (이미 upload-material/edit-material 때 등록했다면 같은 프로젝트라 다시 등록하지 않아도 된다)
//   4. supabase functions deploy apps-write --no-verify-jwt
//      (--no-verify-jwt: 이 함수 안에서 Firebase ID 토큰을 직접 검증한다 - 기존 함수들과 동일한 패턴)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FIREBASE_API_KEY = "AIzaSyDQaFGU_N0NyDr6yZChZJKPplJgQL6bfJA";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://cryeosgmuxqyphntqqlc.supabase.co";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BUCKET = "webapps";

// ---- 제한값 (클라이언트에도 같은 값이 있지만, 신뢰는 항상 이 서버 값이다) ----
const MAX_HTML_BYTES = 5 * 1024 * 1024;   // 단일 HTML 5MB
const MAX_ZIP_BYTES = 20 * 1024 * 1024;   // ZIP 20MB (버킷 제한과 동일)
const MAX_ICON_BYTES = 1 * 1024 * 1024;   // 아이콘 1MB
const MAX_APPS_PER_USER = 50;
const CATEGORIES = ["유틸리티", "게임", "교육", "생산성", "엔터테인먼트", "도구", "기타"];
const ICON_EXT_BY_TYPE: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}
class HttpError extends Error {
    status: number;
    constructor(message: string, status = 400) { super(message); this.status = status; }
}

// Firebase ID 토큰 검증 → { uid, email }. 이메일이 없는 계정(익명 게스트)은 앱을 올릴 수 없다.
async function verifyFirebaseIdToken(idToken: string): Promise<{ uid: string; email: string } | null> {
    const resp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
    });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    const user = data?.users?.[0];
    if (!user?.localId || !user?.email) return null;
    return { uid: user.localId, email: user.email };
}

function randomId(len: number): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function cleanText(v: unknown, max: number): string {
    return typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, max) : "";
}

// ---- 입력 검증 ----
function validateFields(f: any, partial: boolean) {
    const out: Record<string, unknown> = {};
    if (!partial || f?.name !== undefined) {
        const name = cleanText(f?.name, 40);
        if (!name) throw new HttpError("앱 이름을 입력해주세요.");
        out.name = name;
    }
    if (!partial || f?.description !== undefined) out.description = cleanText(f?.description, 1000);
    if (!partial || f?.category !== undefined) {
        const category = cleanText(f?.category, 20);
        if (!CATEGORIES.includes(category)) throw new HttpError("카테고리가 올바르지 않습니다.");
        out.category = category;
    }
    if (!partial || f?.version !== undefined) {
        const version = cleanText(f?.version, 20);
        if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,19}$/.test(version)) throw new HttpError("버전 형식이 올바르지 않습니다. (예: 1.0.0)");
        out.version = version;
    }
    if (f?.published !== undefined) out.published = !!f.published;
    return out;
}

function mainFileInfo(file: any): { fileType: "html" | "zip"; fileName: string; maxBytes: number } {
    const name = cleanText(file?.name, 200).toLowerCase();
    const size = Number(file?.size);
    if (!Number.isFinite(size) || size <= 0) throw new HttpError("파일이 비어 있습니다.");
    if (/\.html?$/.test(name)) {
        if (size > MAX_HTML_BYTES) throw new HttpError("HTML 파일은 5MB 이하만 올릴 수 있어요.");
        return { fileType: "html", fileName: "app.html", maxBytes: MAX_HTML_BYTES };
    }
    if (/\.zip$/.test(name)) {
        if (size > MAX_ZIP_BYTES) throw new HttpError("ZIP 파일은 20MB 이하만 올릴 수 있어요.");
        return { fileType: "zip", fileName: "app.zip", maxBytes: MAX_ZIP_BYTES };
    }
    throw new HttpError(".html 또는 .zip 파일만 올릴 수 있어요.");
}

function iconFileInfo(file: any): { fileName: string } {
    const size = Number(file?.size);
    const ext = ICON_EXT_BY_TYPE[String(file?.type || "").toLowerCase()];
    if (!ext) throw new HttpError("아이콘은 PNG/JPG/WEBP/GIF 이미지만 올릴 수 있어요.");
    if (!Number.isFinite(size) || size <= 0 || size > MAX_ICON_BYTES) throw new HttpError("아이콘은 1MB 이하 이미지만 올릴 수 있어요.");
    return { fileName: `icon.${ext}` };
}

const APP_ID_RE = /^[a-z0-9]{6,12}$/;

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
    if (req.method !== "POST") return jsonResponse({ error: "POST만 지원합니다." }, 405);

    try {
        if (!SERVICE_ROLE_KEY) throw new HttpError("서버 설정(SUPABASE_SERVICE_ROLE_KEY)이 아직 안 되어 있어요.", 500);
        const body = await req.json().catch(() => null);
        const action = body?.action;
        const idToken = body?.firebaseIdToken;
        if (!idToken || typeof idToken !== "string") throw new HttpError("로그인이 필요합니다.", 401);
        const user = await verifyFirebaseIdToken(idToken);
        if (!user) throw new HttpError("인증에 실패했습니다. 다시 로그인해주세요.", 401);

        const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

        // 본인 앱인지 확인 (클라이언트가 보낸 값이 아니라 DB의 author_uid와 비교)
        async function loadOwnApp(appId: unknown) {
            if (typeof appId !== "string" || !APP_ID_RE.test(appId)) throw new HttpError("앱 ID가 올바르지 않습니다.");
            const { data, error } = await sb.from("apps").select("*").eq("id", appId).maybeSingle();
            if (error) throw new HttpError("앱 정보를 불러오지 못했습니다.", 500);
            if (!data) throw new HttpError("존재하지 않는 앱입니다.", 404);
            if (data.author_uid !== user!.uid) throw new HttpError("내가 등록한 앱만 수정/삭제할 수 있어요.", 403);
            return data;
        }

        // ---------------------------------------------------------------- mine
        if (action === "mine") {
            const { data, error } = await sb.from("apps").select("*").eq("author_uid", user.uid).order("updated_at", { ascending: false });
            if (error) throw new HttpError("내 앱을 불러오지 못했습니다.", 500);
            return jsonResponse({ apps: (data ?? []).filter((a: any) => a.file_path !== "pending") });
        }

        // ------------------------------------------------------------- prepare
        if (action === "prepare") {
            const mode = body?.mode;
            let appId: string;
            if (mode === "create") {
                // 1시간 넘게 끝내지 않은 "등록 중" 임시 행은 치운다(올리다 만 흔적)
                const { data: drafts } = await sb.from("apps").select("id, created_at").eq("author_uid", user.uid).eq("file_path", "pending");
                for (const d of drafts ?? []) {
                    if (Date.now() - new Date(d.created_at).getTime() > 3600_000) await sb.from("apps").delete().eq("id", d.id).eq("author_uid", user.uid);
                }
                const { count } = await sb.from("apps").select("id", { count: "exact", head: true }).eq("author_uid", user.uid);
                if ((count ?? 0) >= MAX_APPS_PER_USER) throw new HttpError(`앱은 최대 ${MAX_APPS_PER_USER}개까지 등록할 수 있어요.`);
                if (!body?.mainFile) throw new HttpError("HTML 또는 ZIP 파일을 선택해주세요.");
                // 충돌 없는 새 ID. 앱 행을 "등록 중"(비공개, file_path='pending')으로 먼저 만들어 이 ID를 이 사용자에게 묶어 둔다.
                // (그래야 다른 사람이 남의 ID로 commit 해서 가로채는 일이 불가능하다. insert 가 PK 충돌을 막아주므로 겹치면 다시 뽑는다.)
                appId = "";
                const draftType = mainFileInfo(body.mainFile).fileType;
                for (let i = 0; i < 8 && !appId; i++) {
                    const candidate = randomId(8);
                    const { error } = await sb.from("apps").insert({
                        id: candidate, author_uid: user.uid, author_name: cleanText(body?.authorName, 30) || "익명", name: "(등록 중)",
                        file_path: "pending", file_type: draftType, published: false,
                    });
                    if (!error) appId = candidate;
                }
                if (!appId) throw new HttpError("앱 주소를 만들지 못했어요. 다시 시도해주세요.", 500);
            } else if (mode === "update") {
                appId = (await loadOwnApp(body?.appId)).id;
            } else {
                throw new HttpError("mode가 올바르지 않습니다.");
            }

            const stamp = randomId(12);
            const dir = `apps/${appId}/${stamp}`;
            const uploads: Record<string, { path: string; token: string }> = {};
            const meta: Record<string, string> = {};

            if (body?.mainFile) {
                const info = mainFileInfo(body.mainFile);
                const path = `${dir}/${info.fileName}`;
                const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
                if (error || !data) throw new HttpError("업로드 주소를 만들지 못했어요.", 500);
                uploads.main = { path, token: data.token };
                meta.fileType = info.fileType;
            }
            if (body?.icon) {
                const info = iconFileInfo(body.icon);
                const path = `${dir}/${info.fileName}`;
                const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
                if (error || !data) throw new HttpError("업로드 주소를 만들지 못했어요.", 500);
                uploads.icon = { path, token: data.token };
            }
            return jsonResponse({ appId, stamp, uploads, ...meta });
        }

        // -------------------------------------------------------------- commit
        if (action === "commit") {
            const mode = body?.mode;
            const appId = body?.appId;
            if (typeof appId !== "string" || !APP_ID_RE.test(appId)) throw new HttpError("앱 ID가 올바르지 않습니다.");
            if (mode !== "create" && mode !== "update") throw new HttpError("mode가 올바르지 않습니다.");
            // 등록(create)도 prepare 가 만든 "내" 임시 행이 있어야만 가능하다. 이미 완료된 앱을 create 로 덮어쓰는 것도 막는다.
            const existing = await loadOwnApp(appId);
            if (mode === "create" && existing.file_path !== "pending") throw new HttpError("이미 등록이 끝난 앱이에요.");
            if (mode === "update" && existing.file_path === "pending") throw new HttpError("아직 등록이 끝나지 않은 앱이에요.");

            const fields = validateFields(body?.fields, mode === "update");
            const changelog = cleanText(body?.fields?.changelog, 1000);

            // 올라온 파일 확인: 경로 모양 + 실제 존재 + 크기 + ZIP 시그니처
            async function verifyUploaded(path: unknown, kind: "main" | "icon", fileType?: string) {
                if (typeof path !== "string") throw new HttpError("업로드 정보가 올바르지 않습니다.");
                const re = kind === "main"
                    ? new RegExp(`^apps/${appId}/[a-z0-9]{12}/app\\.(html|zip)$`)
                    : new RegExp(`^apps/${appId}/[a-z0-9]{12}/icon\\.(png|jpg|webp|gif)$`);
                if (!re.test(path)) throw new HttpError("업로드 경로가 올바르지 않습니다.");
                const slash = path.lastIndexOf("/");
                const dir = path.slice(0, slash), name = path.slice(slash + 1);
                const { data: list, error } = await sb.storage.from(BUCKET).list(dir, { limit: 20 });
                if (error) throw new HttpError("업로드한 파일을 확인하지 못했습니다.", 500);
                const item = (list ?? []).find((o: any) => o.name === name);
                if (!item) throw new HttpError("파일이 아직 올라가지 않았어요. 다시 시도해주세요.");
                const size = Number(item.metadata?.size ?? 0);
                if (kind === "main") {
                    const isZip = name.endsWith(".zip");
                    if (isZip !== (fileType === "zip")) throw new HttpError("파일 형식이 올바르지 않습니다.");
                    if (size <= 0 || size > (isZip ? MAX_ZIP_BYTES : MAX_HTML_BYTES)) throw new HttpError("파일 크기가 허용 범위를 넘었어요.");
                    if (isZip) { // ZIP 시그니처(PK\x03\x04) 확인 - 이름만 .zip인 다른 파일을 막는다
                        const { data: signed } = await sb.storage.from(BUCKET).createSignedUrl(path, 60);
                        const head = signed ? await fetch(signed.signedUrl, { headers: { Range: "bytes=0-3" } }).then((r) => r.arrayBuffer()).catch(() => null) : null;
                        const b = head ? new Uint8Array(head) : null;
                        if (!b || b[0] !== 0x50 || b[1] !== 0x4b) throw new HttpError("올바른 ZIP 파일이 아니에요.");
                    }
                } else if (size <= 0 || size > MAX_ICON_BYTES) {
                    throw new HttpError("아이콘 크기가 허용 범위를 넘었어요.");
                }
                return size;
            }

            const publicUrl = (p: string) => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${p}`;
            const row: Record<string, unknown> = { ...fields, updated_at: new Date().toISOString() };
            let newVersionFile: { path: string; type: string; size: number } | null = null;

            if (body?.mainPath) {
                const fileType = body?.fileType === "zip" ? "zip" : "html";
                const size = await verifyUploaded(body.mainPath, "main", fileType);
                row.file_path = body.mainPath; row.file_type = fileType; row.file_size = size; row.entry_file = "index.html";
                newVersionFile = { path: body.mainPath, type: fileType, size };
            } else if (mode === "create") {
                throw new HttpError("HTML 또는 ZIP 파일이 필요합니다.");
            }
            let oldIconToRemove: string | null = null;
            if (body?.iconPath) {
                await verifyUploaded(body.iconPath, "icon");
                row.icon_path = body.iconPath; row.icon_url = publicUrl(body.iconPath);
                if (existing?.icon_path && existing.icon_path !== body.iconPath) oldIconToRemove = existing.icon_path;
            } else if (body?.removeIcon && existing?.icon_path) {
                oldIconToRemove = existing.icon_path; row.icon_path = null; row.icon_url = null;
            }

            if (mode === "create") row.published = fields.published === undefined ? true : fields.published;
            if (body?.authorName) row.author_name = cleanText(body.authorName, 30) || existing.author_name;
            const { data: saved, error: saveError } = await sb.from("apps").update(row).eq("id", appId).eq("author_uid", user.uid).select("*").single();
            if (saveError || !saved) throw new HttpError("앱을 저장하지 못했어요: " + (saveError?.message ?? ""), 500);
            if (newVersionFile) {
                await sb.from("app_versions").insert({
                    app_id: appId, version: saved.version, file_path: newVersionFile.path,
                    file_type: newVersionFile.type, file_size: newVersionFile.size, changelog: mode === "create" && !changelog ? "최초 등록" : changelog,
                });
            }
            if (oldIconToRemove) await sb.storage.from(BUCKET).remove([oldIconToRemove]).catch(() => {});
            return jsonResponse({ app: saved });
        }

        // --------------------------------------------------------- update-meta
        if (action === "update-meta") {
            const existing = await loadOwnApp(body?.appId);
            if (existing.file_path === "pending") throw new HttpError("아직 등록이 끝나지 않은 앱이에요.");
            const fields = validateFields(body?.fields, true);
            if (Object.keys(fields).length === 0) throw new HttpError("바꿀 내용이 없어요.");
            const { data, error } = await sb.from("apps").update({ ...fields, updated_at: new Date().toISOString() })
                .eq("id", existing.id).eq("author_uid", user.uid).select("*").single();
            if (error) throw new HttpError("앱을 수정하지 못했어요.", 500);
            return jsonResponse({ app: data });
        }

        // -------------------------------------------------------------- delete
        if (action === "delete") {
            const existing = await loadOwnApp(body?.appId);
            // apps/<id>/<stamp>/<file> 전부 지운다(버전 이력 파일 포함)
            const paths: string[] = [];
            const { data: dirs } = await sb.storage.from(BUCKET).list(`apps/${existing.id}`, { limit: 200 });
            for (const d of dirs ?? []) {
                const { data: files } = await sb.storage.from(BUCKET).list(`apps/${existing.id}/${d.name}`, { limit: 50 });
                for (const f of files ?? []) paths.push(`apps/${existing.id}/${d.name}/${f.name}`);
            }
            if (paths.length) await sb.storage.from(BUCKET).remove(paths).catch(() => {});
            const { error } = await sb.from("apps").delete().eq("id", existing.id).eq("author_uid", user.uid);
            if (error) throw new HttpError("앱을 삭제하지 못했어요.", 500);
            return jsonResponse({ ok: true });
        }

        throw new HttpError("지원하지 않는 요청입니다.");
    } catch (e) {
        if (e instanceof HttpError) return jsonResponse({ error: e.message }, e.status);
        console.error("apps-write error:", e);
        return jsonResponse({ error: "서버 오류가 발생했어요." }, 500);
    }
});
