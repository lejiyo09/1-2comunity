// freeimage.host 자체 API는 브라우저에서 직접 fetch하면 CORS로 막힌다(Access-Control-Allow-Origin
// 헤더가 없음, 실제 브라우저 콘솔에서 확인됨). 서버끼리는 CORS 제약이 없으므로, 이 Edge Function이
// 대신 업로드를 수행하는 프록시 역할을 한다.
//
// 클라이언트(index.html의 uploadImageToFreeImageHost)가 보내는 FormData:
//   - firebaseIdToken: 로그인한 사용자의 Firebase ID 토큰 (신원 확인용, 서버에서 직접 검증한다 -
//     클라이언트가 "나는 로그인했다"고 주장하는 걸 그대로 믿지 않는다)
//   - source: 업로드할 이미지 파일
//
// 배포 방법 (Supabase CLI 필요, `npm i -g supabase` 또는 `brew install supabase/tap/supabase`):
//   1. supabase login
//   2. supabase link --project-ref cryeosgmuxqyphntqqlc   (자료실 업로드 Edge Function과 같은 프로젝트)
//   3. supabase secrets set FREEIMAGE_API_KEY=6d207e02198a847aa98d0a2a901485a5
//   4. supabase functions deploy upload-freeimage --no-verify-jwt
//      (--no-verify-jwt: Supabase 플랫폼 레벨 JWT 검증을 끄고, 이 함수 안에서 Firebase ID 토큰을
//       직접 검증한다 - upload-material 등 기존 Edge Function들과 동일한 패턴)
//
// Supabase 대시보드에서 배포하려면: 프로젝트 → Edge Functions → New Function → 이름 "upload-freeimage"
// → 이 파일 내용 붙여넣기 → Deploy. Secrets는 Edge Functions → Manage secrets에서 등록한다.

const FIREBASE_API_KEY = "AIzaSyDQaFGU_N0NyDr6yZChZJKPplJgQL6bfJA";
const FREEIMAGE_API_KEY = Deno.env.get("FREEIMAGE_API_KEY") ?? "6d207e02198a847aa98d0a2a901485a5";

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

async function verifyFirebaseIdToken(idToken: string): Promise<boolean> {
    const resp = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ idToken }),
        },
    );
    if (!resp.ok) return false;
    const data = await resp.json().catch(() => null);
    return !!(data && Array.isArray(data.users) && data.users.length > 0);
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: CORS_HEADERS });
    }
    if (req.method !== "POST") {
        return jsonResponse({ error: "POST만 지원합니다." }, 405);
    }

    try {
        const formData = await req.formData();
        const idToken = formData.get("firebaseIdToken");
        const source = formData.get("source");

        if (!idToken || typeof idToken !== "string") {
            return jsonResponse({ error: "로그인이 필요합니다." }, 401);
        }
        if (!source || !(source instanceof File)) {
            return jsonResponse({ error: "이미지 파일이 없습니다." }, 400);
        }

        const isValidUser = await verifyFirebaseIdToken(idToken);
        if (!isValidUser) {
            return jsonResponse({ error: "인증에 실패했습니다." }, 401);
        }

        const upstreamForm = new FormData();
        upstreamForm.append("key", FREEIMAGE_API_KEY);
        upstreamForm.append("action", "upload");
        upstreamForm.append("format", "json");
        upstreamForm.append("source", source, source.name);

        const upstreamResp = await fetch("https://freeimage.host/api/1/upload", {
            method: "POST",
            body: upstreamForm,
        });
        const upstreamText = await upstreamResp.text();
        let upstreamJson: any;
        try {
            upstreamJson = JSON.parse(upstreamText);
        } catch {
            console.error("freeimage.host 응답 파싱 실패:", upstreamResp.status, upstreamText);
            return jsonResponse({ error: "이미지 호스트 응답을 해석할 수 없습니다." }, 502);
        }

        const url = upstreamJson?.image?.url;
        if (!upstreamResp.ok || !url) {
            console.error("freeimage.host 업로드 실패:", upstreamResp.status, upstreamJson);
            return jsonResponse(
                { error: upstreamJson?.status_txt || upstreamJson?.error?.message || "업로드 실패" },
                502,
            );
        }

        return jsonResponse({ url });
    } catch (e) {
        console.error("upload-freeimage 처리 중 오류:", e);
        return jsonResponse({ error: "서버 오류가 발생했습니다." }, 500);
    }
});
