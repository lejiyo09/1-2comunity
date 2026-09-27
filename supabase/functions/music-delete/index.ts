// 공유 음악(1-2 Music, music_tracks 테이블) 삭제 전용 Edge Function.
//
// 기존 music-write 함수(공유/좋아요/재생기록/다운로드기록을 이미 처리 중)의 소스 코드를 이 저장소에
// 갖고 있지 않아서, 그 함수에 삭제 기능을 직접 추가하면 실수로 기존 동작을 깨뜨릴 위험이 있다.
// 그래서 삭제만 담당하는 별도 함수로 분리했다 - music-write는 전혀 건드리지 않는다.
//
// 클라이언트(index.html의 deleteSharedMusicTrack)가 보내는 JSON:
//   - trackId: 삭제할 곡의 music_tracks.id
//   - firebaseIdToken: 로그인한 사용자의 Firebase ID 토큰 (신원 확인용, 서버에서 직접 검증한다)
//
// 소유권 확인: 토큰에서 얻은 uid가 그 곡의 uploader_id와 일치할 때만 삭제를 허용한다 - 클라이언트가
// 보낸 값을 신뢰하지 않고 서버에서 DB를 다시 조회해서 확인한다.
//
// 삭제 방식: 완전히 지우지 않고 status를 'deleted'로 바꾼다(다른 모든 조회가 이미 .eq('status','active')로
// 걸러서 읽으므로 화면에서는 완전히 사라진다) - 좋아요/다운로드/재생 기록 등 trackId를 참조하는 다른 행을
// 굳이 함께 지우지 않아도 안전하다. 오디오 파일 자체는 용량을 아끼기 위해 스토리지에서 실제로 삭제한다.
//
// 배포 방법 (Supabase CLI 필요):
//   1. supabase login
//   2. supabase link --project-ref robineymrvvtetuphkjt   (1-2 Music 전용 프로젝트, music-write와 동일)
//   3. supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<이 프로젝트의 service_role 키>
//      (SUPABASE_URL은 플랫폼이 함수 실행 환경에 자동으로 넣어준다)
//   4. supabase functions deploy music-delete --no-verify-jwt
//      (--no-verify-jwt: 이 함수 안에서 Firebase ID 토큰을 직접 검증한다 - upload-freeimage 등과 동일한 패턴)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FIREBASE_API_KEY = "AIzaSyDQaFGU_N0NyDr6yZChZJKPplJgQL6bfJA";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://robineymrvvtetuphkjt.supabase.co";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MUSIC_BUCKET = "music";

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
        const trackId = body?.trackId;
        const idToken = body?.firebaseIdToken;

        if (!trackId || typeof trackId !== "string") {
            return jsonResponse({ error: "trackId가 필요합니다." }, 400);
        }
        if (!idToken || typeof idToken !== "string") {
            return jsonResponse({ error: "로그인이 필요합니다." }, 401);
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

        const { data: track, error: fetchErr } = await supabase
            .from("music_tracks")
            .select("id, uploader_id, storage_path, status")
            .eq("id", trackId)
            .single();

        if (fetchErr || !track) {
            return jsonResponse({ error: "곡을 찾을 수 없습니다." }, 404);
        }
        if (track.uploader_id !== uid) {
            return jsonResponse({ error: "본인이 공유한 곡만 삭제할 수 있습니다." }, 403);
        }
        if (track.status === "deleted") {
            return jsonResponse({ ok: true }); // 이미 삭제된 곡 - 조용히 성공 처리(중복 클릭 등)
        }

        if (track.storage_path) {
            const { error: storageErr } = await supabase.storage.from(MUSIC_BUCKET).remove([track.storage_path]);
            if (storageErr) {
                // 스토리지 삭제가 실패해도 DB 쪽 삭제 처리는 계속 진행한다 - 화면에서는 어차피 status로
                // 걸러지므로 사용자 입장에서는 삭제된 것과 같다. 남은 파일 정리는 나중에 따로 해도 된다.
                console.error("공유 음악 파일 삭제 실패(DB 삭제 처리는 계속 진행):", storageErr);
            }
        }

        const { error: updateErr } = await supabase
            .from("music_tracks")
            .update({ status: "deleted" })
            .eq("id", trackId);

        if (updateErr) {
            console.error("공유 음악 레코드 삭제 처리 실패:", updateErr);
            return jsonResponse({ error: "삭제 처리에 실패했습니다." }, 500);
        }

        return jsonResponse({ ok: true });
    } catch (e) {
        console.error("music-delete 처리 중 오류:", e);
        return jsonResponse({ error: "서버 오류가 발생했습니다." }, 500);
    }
});
