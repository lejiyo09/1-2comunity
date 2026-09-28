// 자료실(materials 테이블) 수정 전용 Edge Function - 제목/카테고리/설명만 바꾼다(파일 자체는 바꾸지 않는다).
//
// 기존 upload-material/verify-delete-material 함수의 소스 코드를 이 저장소에 갖고 있지 않아서, 그 함수들에
// 수정 기능을 직접 추가하면 실수로 이미 잘 동작 중인 업로드/삭제 기능을 깨뜨릴 위험이 있다. 그래서 수정만
// 담당하는 별도 함수로 분리했다 - 저 둘은 전혀 건드리지 않는다. (music-write/music-delete와 동일한 패턴)
//
// 클라이언트(index.html의 submitMaterialEdit)가 보내는 JSON:
//   - materialId: 수정할 자료의 materials.id
//   - title, category, description: 새 값
//   - firebaseIdToken: 로그인한 사용자의 Firebase ID 토큰 (신원 확인용, 서버에서 직접 검증한다)
//
// 소유권 확인: 토큰에서 얻은 uid가 그 자료의 owner_uid와 일치할 때만 수정을 허용한다 - 클라이언트가
// 보낸 값을 신뢰하지 않고 서버에서 DB를 다시 조회해서 확인한다.
//
// 배포 방법 (Supabase CLI 필요):
//   1. supabase login
//   2. supabase link --project-ref cryeosgmuxqyphntqqlc   (자료실 업로드/삭제 Edge Function과 같은 프로젝트)
//   3. supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<이 프로젝트의 service_role 키>
//      (이미 upload-material 등에서 등록해뒀다면 다시 등록하지 않아도 된다 - 같은 프로젝트라 시크릿을 공유한다)
//   4. supabase functions deploy edit-material --no-verify-jwt
//      (--no-verify-jwt: 이 함수 안에서 Firebase ID 토큰을 직접 검증한다 - upload-freeimage 등과 동일한 패턴)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FIREBASE_API_KEY = "AIzaSyDQaFGU_N0NyDr6yZChZJKPplJgQL6bfJA";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://cryeosgmuxqyphntqqlc.supabase.co";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
}

async function verifyFirebaseIdTokenAndGetUid(idToken: string): Promise<string | null> {
    const resp = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ idToken }),
        },
    );
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    const user = data?.users?.[0];
    return user?.localId ?? null;
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: CORS_HEADERS });
    }
    if (req.method !== "POST") {
        return jsonResponse({ error: "POST만 지원합니다." }, 405);
    }

    try {
        const body = await req.json().catch(() => null);
        const materialId = body?.materialId;
        const idToken = body?.firebaseIdToken;
        const title = typeof body?.title === "string" ? body.title.trim() : "";
        const category = typeof body?.category === "string" ? body.category.trim() : "";
        const description = typeof body?.description === "string" ? body.description : "";

        if (!materialId || typeof materialId !== "string") {
            return jsonResponse({ error: "materialId가 필요합니다." }, 400);
        }
        if (!idToken || typeof idToken !== "string") {
            return jsonResponse({ error: "로그인이 필요합니다." }, 401);
        }
        if (!title) {
            return jsonResponse({ error: "제목을 입력해주세요." }, 400);
        }

        const uid = await verifyFirebaseIdTokenAndGetUid(idToken);
        if (!uid) {
            return jsonResponse({ error: "인증에 실패했습니다." }, 401);
        }
        if (!SERVICE_ROLE_KEY) {
            console.error("SUPABASE_SERVICE_ROLE_KEY가 설정되지 않았습니다.");
            return jsonResponse({ error: "서버 설정 오류입니다." }, 500);
        }

        const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

        const { data: material, error: fetchErr } = await supabase
            .from("materials")
            .select("id, owner_uid, status")
            .eq("id", materialId)
            .single();

        if (fetchErr || !material) {
            return jsonResponse({ error: "자료를 찾을 수 없습니다." }, 404);
        }
        if (material.owner_uid !== uid) {
            return jsonResponse({ error: "본인이 등록한 자료만 수정할 수 있습니다." }, 403);
        }
        if (material.status !== "active") {
            return jsonResponse({ error: "삭제된 자료는 수정할 수 없습니다." }, 400);
        }

        const { error: updateErr } = await supabase
            .from("materials")
            .update({ title, category: category || "기타", description })
            .eq("id", materialId);

        if (updateErr) {
            console.error("자료 수정 처리 실패:", updateErr);
            return jsonResponse({ error: "수정 처리에 실패했습니다." }, 500);
        }

        return jsonResponse({ ok: true });
    } catch (e) {
        console.error("edit-material 처리 중 오류:", e);
        return jsonResponse({ error: "서버 오류가 발생했습니다." }, 500);
    }
});
