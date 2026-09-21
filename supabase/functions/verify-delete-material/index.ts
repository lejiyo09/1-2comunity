// 자료실 파일 삭제 Edge Function.
// - Firebase ID 토큰을 서버에서 직접 검증해 "본인이 등록한 자료인지"만 확인한다 (관리자 삭제는 아직 없음).
// - anon 키에는 materials 테이블/버킷에 대한 삭제 권한이 전혀 없으므로(RLS), 실제 삭제는 여기서
//   service_role 키로만 수행한다.
// - 이 함수도 `--no-verify-jwt` 옵션으로 배포해야 한다 (upload-material과 동일한 이유).

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

    let body: { materialId?: string; firebaseIdToken?: string };
    try {
        body = await req.json();
    } catch (_e) {
        return jsonResponse({ error: "잘못된 요청 형식입니다." }, 400);
    }

    const { materialId, firebaseIdToken } = body;
    if (!materialId || typeof firebaseIdToken !== "string" || !firebaseIdToken) {
        return jsonResponse({ error: "잘못된 요청입니다." }, 400);
    }

    let uid: string;
    try {
        uid = await verifyFirebaseIdToken(firebaseIdToken);
    } catch (e) {
        console.error("Firebase 토큰 검증 실패:", e);
        return jsonResponse({ error: "로그인 정보가 유효하지 않습니다.\n다시 로그인해주세요." }, 401);
    }

    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: row, error: fetchErr } = await supabase
        .from("materials")
        .select("id, owner_uid, storage_path")
        .eq("id", materialId)
        .single();

    if (fetchErr || !row) {
        return jsonResponse({ error: "자료를 찾을 수 없습니다." }, 404);
    }
    if (row.owner_uid !== uid) {
        return jsonResponse({ error: "본인이 등록한 자료만 삭제할 수 있습니다." }, 403);
    }

    if (row.storage_path) {
        const { error: removeErr } = await supabase.storage.from("materials").remove([row.storage_path]);
        if (removeErr) console.error("파일 삭제 오류(자료 행 삭제는 계속 진행):", removeErr);
    }

    const { error: deleteErr } = await supabase.from("materials").delete().eq("id", materialId);
    if (deleteErr) {
        console.error("자료 삭제 오류:", deleteErr);
        return jsonResponse({ error: "자료 삭제에 실패했습니다." }, 500);
    }

    return jsonResponse({ success: true }, 200);
});
