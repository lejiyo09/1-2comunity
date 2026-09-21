// 자료실 파일 업로드 Edge Function.
// - Firebase ID 토큰을 서버에서 직접 검증한다 (Admin SDK 없이, Firebase가 공식 문서로 안내하는
//   "ID 토큰을 Admin SDK 없이 확인하기" 방식 - 구글이 공개하는 JWKS로 서명을 검증).
// - anon 키에는 materials 테이블/버킷에 대한 쓰기 권한이 전혀 없으므로(RLS), 실제 저장은 여기서
//   service_role 키로만 수행한다.
// - Deno 런타임 기본 JWT 검증(Authorization 헤더)을 통과하려면 이 함수는 반드시
//   `--no-verify-jwt` 옵션으로 배포해야 한다 (클라이언트가 여기 Authorization에 보내는 건
//   실제 Supabase 세션 토큰이 아니라 publishable key이기 때문). 배포 방법은 supabase/README.md 참고.

import { createClient } from "npm:@supabase/supabase-js@2";
import * as jose from "npm:jose@5";

const FIREBASE_PROJECT_ID = "over-2a177";
const FIREBASE_JWKS = jose.createRemoteJWKSet(
    new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
);

const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
}

const MATERIALS_ALLOWED_EXT = [
    "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "hwp", "hwpx", "zip", "jpg", "jpeg", "png", "gif", "txt",
];
const MATERIALS_MAX_SIZE = 50 * 1024 * 1024; // 50MB

async function verifyFirebaseIdToken(idToken: string): Promise<string> {
    const { payload } = await jose.jwtVerify(idToken, FIREBASE_JWKS, {
        issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
        audience: FIREBASE_PROJECT_ID,
    });
    if (!payload.sub) throw new Error("토큰에 사용자 정보(sub)가 없습니다.");
    return payload.sub;
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    if (req.method !== "POST") return jsonResponse({ error: "허용되지 않는 요청입니다." }, 405);

    let formData: FormData;
    try {
        formData = await req.formData();
    } catch (_e) {
        return jsonResponse({ error: "잘못된 요청 형식입니다." }, 400);
    }

    const idToken = formData.get("firebaseIdToken");
    if (typeof idToken !== "string" || !idToken) {
        return jsonResponse({ error: "로그인 정보가 없습니다." }, 401);
    }

    let uid: string;
    try {
        uid = await verifyFirebaseIdToken(idToken);
    } catch (e) {
        console.error("Firebase 토큰 검증 실패:", e);
        return jsonResponse({ error: "로그인 정보가 유효하지 않습니다.\n다시 로그인해주세요." }, 401);
    }

    const title = String(formData.get("title") || "").trim();
    if (!title) return jsonResponse({ error: "제목을 입력해주세요." }, 400);
    const category = String(formData.get("category") || "기타").trim() || "기타";
    const description = String(formData.get("description") || "");
    const ownerName = String(formData.get("ownerName") || "");
    const file = formData.get("file");

    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let storagePath: string | null = null;
    let fileName: string | null = null;
    let fileSize: number | null = null;

    if (file instanceof File) {
        const ext = (file.name.split(".").pop() || "").toLowerCase();
        if (!MATERIALS_ALLOWED_EXT.includes(ext)) {
            return jsonResponse(
                { error: `허용되지 않는 파일 형식입니다.\n허용 형식: ${MATERIALS_ALLOWED_EXT.join(", ")}` },
                400,
            );
        }
        if (file.size > MATERIALS_MAX_SIZE) {
            return jsonResponse({ error: "파일 용량은 50MB를 넘을 수 없습니다." }, 400);
        }

        const safeName = file.name.replace(/[^\w.\-가-힣]/g, "_");
        storagePath = `${uid}/${crypto.randomUUID()}-${safeName}`;
        const { error: uploadErr } = await supabase.storage
            .from("materials")
            .upload(storagePath, file, { contentType: file.type || "application/octet-stream" });
        if (uploadErr) {
            console.error("파일 업로드 오류:", uploadErr);
            return jsonResponse({ error: "파일 업로드에 실패했습니다." }, 500);
        }
        fileName = file.name;
        fileSize = file.size;
    }

    const { data, error: insertErr } = await supabase
        .from("materials")
        .insert({
            title,
            category,
            description,
            owner_uid: uid,
            owner_name: ownerName || null,
            original_file_name: fileName,
            file_size: fileSize,
            storage_path: storagePath,
            status: "active",
        })
        .select("id")
        .single();

    if (insertErr) {
        console.error("자료 등록 오류:", insertErr);
        // 파일은 이미 업로드됐는데 행 생성만 실패한 고아 파일이 남지 않도록 정리한다.
        if (storagePath) await supabase.storage.from("materials").remove([storagePath]).catch(() => {});
        return jsonResponse({ error: "자료 등록에 실패했습니다." }, 500);
    }

    return jsonResponse({ success: true, id: data.id }, 200);
});
