// 외부 API(날씨 / NEIS 학사일정) 호출을 대신해 주는 Supabase Edge Function.
//
// 왜 필요한가:
//   예전에는 weatherapi.com / NEIS 인증키가 index.html 안에 그대로 들어 있어서, 사이트를 연 누구나 개발자도구로 키를 꺼내 쓸 수 있었다.
//   (브라우저에서 도는 코드는 "키를 숨기는" 것이 원천적으로 불가능하다 → 키는 서버에만 두고, 브라우저는 이 함수를 부른다.)
//   키는 Supabase Secrets 에만 저장되고, 이 저장소/화면/네트워크 요청 어디에도 나오지 않는다.
//
// 남용 방지(공개 데이터지만 키의 호출 한도를 누가 다 써 버리지 못하게):
//   - 허용한 서비스/경로/파라미터만 통과(화이트리스트). 날씨는 학교 위치로 고정, NEIS 는 우리 학교 코드만 허용.
//   - 같은 요청은 서버 메모리에 잠깐 캐시(날씨 10분, NEIS 30분) → 업스트림 호출 수가 사용자 수와 무관해진다.
//   - IP 당 10분에 90회까지(인스턴스 메모리 기준, best-effort).
//   - (선택) ALLOWED_ORIGINS 를 설정하면 그 사이트에서 온 브라우저 요청만 허용(핫링크 방지. 브라우저 밖 요청은 위조 가능하므로 보안 장치가 아니라 방지 수준).
//
// 호출 형식 (GET, 헤더 없음 → CORS 사전요청 없음):
//   /functions/v1/api-proxy?service=weather
//   /functions/v1/api-proxy?service=neis&path=SchoolSchedule&ATPT_OFCDC_SC_CODE=N10&SD_SCHUL_CODE=8140107&AA_FROM_YMD=20260301&AA_TO_YMD=20270228
//
// 배포 방법 (Supabase CLI, 자료실 Edge Function 들과 같은 프로젝트):
//   1. supabase link --project-ref cryeosgmuxqyphntqqlc
//   2. supabase secrets set WEATHER_API_KEY=<weatherapi.com 키> NEIS_API_KEY=<NEIS 인증키>
//      (선택) supabase secrets set ALLOWED_ORIGINS=https://one-2comunity-test.onrender.com,https://내사이트.netlify.app
//   3. supabase functions deploy api-proxy --no-verify-jwt     (공개 데이터라 로그인 없이 부른다)
//   대시보드로 하려면: Edge Functions → New Function → 이름 `api-proxy` → 이 파일 붙여넣기 → Verify JWT 끄기 → Deploy, Secrets 에 위 키 등록.
//   ⚠️ 예전에 이 저장소(git 기록)에 올라간 키는 이미 노출된 것이므로, 각 서비스에서 키를 새로 발급(회전)해서 위 Secrets 에 넣어야 한다.

// 시크릿에 붙여 넣을 때 흔히 섞이는 공백/줄바꿈/따옴표를 자동으로 걷어낸다(키에는 원래 공백이 없다).
const cleanSecret = (v: string | undefined) => (v ?? "").replace(/\s+/g, "").replace(/^["'`]+|["'`]+$/g, "");
const WEATHER_API_KEY = cleanSecret(Deno.env.get("WEATHER_API_KEY"));
const NEIS_API_KEY = cleanSecret(Deno.env.get("NEIS_API_KEY"));
const WEATHER_QUERY = Deno.env.get("WEATHER_QUERY") ?? "36.4555,127.1264"; // 한일고등학교 (공주)
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const SCHOOL = { name: "한일고등학교", office: "N10", code: "8140107" };
const TTL_MS = { weather: 10 * 60_000, neis: 30 * 60_000 };
const RATE_LIMIT = 90, RATE_WINDOW_MS = 10 * 60_000;
const UPSTREAM_TIMEOUT_MS = 8000;

// NEIS 경로별로 받을 수 있는 파라미터와 값 규칙. 문자열이면 그 값과 정확히 같아야 하고, RegExp 이면 전체가 일치해야 한다.
const PAGE_INDEX = /^[1-9]\d?$/;
const NEIS_ENDPOINTS: Record<string, { params: Record<string, string | RegExp>; required: string[] }> = {
    schoolInfo: { params: { SCHUL_NM: SCHOOL.name, pIndex: PAGE_INDEX, pSize: /^([1-9]\d?|100)$/ }, required: ["SCHUL_NM"] },
    SchoolSchedule: {
        params: { ATPT_OFCDC_SC_CODE: SCHOOL.office, SD_SCHUL_CODE: SCHOOL.code, AA_FROM_YMD: /^20\d{6}$/, AA_TO_YMD: /^20\d{6}$/, pIndex: PAGE_INDEX, pSize: /^([1-9]\d{0,2}|1000)$/ },
        required: ["ATPT_OFCDC_SC_CODE", "SD_SCHUL_CODE", "AA_FROM_YMD", "AA_TO_YMD"],
    },
    mealServiceDietInfo: {
        params: { ATPT_OFCDC_SC_CODE: SCHOOL.office, SD_SCHUL_CODE: SCHOOL.code, MLSV_YMD: /^20\d{6}$/ },
        required: ["ATPT_OFCDC_SC_CODE", "SD_SCHUL_CODE", "MLSV_YMD"],
    },
};

const cache = new Map<string, { exp: number; body: string }>();
const hits = new Map<string, number[]>();

function corsHeaders(origin: string | null): Record<string, string> {
    const allow = ALLOWED_ORIGINS.length === 0 ? "*" : (origin && ALLOWED_ORIGINS.includes(origin) ? origin : "");
    const h: Record<string, string> = { "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Vary": "Origin" };
    if (allow) h["Access-Control-Allow-Origin"] = allow;
    return h;
}
function json(body: unknown, status: number, origin: string | null, extra: Record<string, string> = {}) {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status, headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8", ...extra },
    });
}
class HttpError extends Error { status: number; constructor(m: string, s = 400) { super(m); this.status = s; } }

function clientIp(req: Request): string {
    return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "unknown";
}
function rateLimited(ip: string): boolean {
    const now = Date.now();
    const list = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    list.push(now); hits.set(ip, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(k); // 메모리 청소
    return list.length > RATE_LIMIT;
}

function buildUpstream(url: URL): { key: string; target: string; ttl: number } {
    const service = url.searchParams.get("service");
    if (service === "weather") {
        if (!WEATHER_API_KEY) throw new HttpError("서버 설정(WEATHER_API_KEY)이 아직 안 되어 있어요.", 503);
        const target = `https://api.weatherapi.com/v1/forecast.json?key=${encodeURIComponent(WEATHER_API_KEY)}&q=${encodeURIComponent(WEATHER_QUERY)}&days=1&aqi=yes&lang=ko`;
        return { key: "weather", target, ttl: TTL_MS.weather };
    }
    if (service === "neis") {
        const path = url.searchParams.get("path") ?? "";
        const spec = NEIS_ENDPOINTS[path];
        if (!spec) throw new HttpError("허용되지 않는 경로예요.");
        const qs = new URLSearchParams(); const keyParts: string[] = [];
        for (const [name, value] of url.searchParams) {
            if (name === "service" || name === "path" || name === "forceFunctionRegion") continue; // forceFunctionRegion: Supabase 가 실행 지역을 고를 때 쓰는 값
            const rule = spec.params[name];
            if (rule === undefined) throw new HttpError(`허용되지 않는 파라미터예요: ${name.slice(0, 30)}`);
            const ok = typeof rule === "string" ? value === rule : rule.test(value);
            if (!ok) throw new HttpError(`파라미터 값이 올바르지 않아요: ${name}`);
            qs.set(name, value); keyParts.push(`${name}=${value}`);
        }
        for (const r of spec.required) if (!qs.has(r)) throw new HttpError(`필수 파라미터가 없어요: ${r}`);
        if (NEIS_API_KEY) qs.set("KEY", NEIS_API_KEY); // 급식은 키 없이도 되지만, 있으면 호출 한도가 더 넉넉하다
        else if (path !== "mealServiceDietInfo") throw new HttpError("서버 설정(NEIS_API_KEY)이 아직 안 되어 있어요.", 503);
        qs.set("Type", "json");
        keyParts.sort();
        return { key: `neis:${path}:${keyParts.join("&")}`, target: `https://open.neis.go.kr/hub/${path}?${qs.toString()}`, ttl: TTL_MS.neis };
    }
    throw new HttpError("service 는 weather 또는 neis 만 쓸 수 있어요.");
}

Deno.serve(async (req: Request) => {
    const origin = req.headers.get("origin");
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
    try {
        if (req.method !== "GET") throw new HttpError("GET 만 지원합니다.", 405);
        if (ALLOWED_ORIGINS.length > 0 && origin && !ALLOWED_ORIGINS.includes(origin)) throw new HttpError("허용되지 않은 사이트예요.", 403);
        if (rateLimited(clientIp(req))) throw new HttpError("요청이 너무 많아요. 잠시 후 다시 시도해 주세요.", 429);

        const { key, target, ttl } = buildUpstream(new URL(req.url));
        const now = Date.now();
        const hit = cache.get(key);
        if (hit && hit.exp > now) return json(hit.body, 200, origin, { "Cache-Control": "public, max-age=120", "X-Proxy-Cache": "HIT" });

        // NEIS(WebTob) 서버는 낯선 요청(기본 Deno User-Agent, Accept: application/json 등)에 500 을 내는 일이 있어서
        // 브라우저가 보내는 것과 비슷한 헤더로 부르고, 5xx 가 오면 잠깐 뒤 한 번 더 시도한다.
        const UPSTREAM_HEADERS = { "Accept": "*/*", "User-Agent": "Mozilla/5.0 (compatible; ClassCommunityProxy/1.0)" };
        let upstream: Response | undefined; let text = "";
        for (let attempt = 0; attempt < 2; attempt++) {
            const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
            try { upstream = await fetch(target, { signal: ctrl.signal, headers: UPSTREAM_HEADERS }); text = await upstream.text(); }
            catch { upstream = undefined; }
            finally { clearTimeout(timer); }
            if (upstream && upstream.status < 500) break;
            if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
        }
        if (!upstream) throw new HttpError("외부 서비스에 연결하지 못했어요.", 502);
        // 업스트림 오류 내용에는 요청 주소(=키)가 섞일 수 있으니 그대로 돌려주지 않고, 키를 가린 짧은 요약만 붙인다.
        if (!upstream.ok) {
            const secret = key === "weather" ? WEATHER_API_KEY : NEIS_API_KEY;
            let snippet = text.replace(/<[^>]*>/g, " ").replace(/https?:\/\/\S+/g, "(주소)").replace(/\s+/g, " ").trim();
            for (const k of [WEATHER_API_KEY, NEIS_API_KEY]) if (k) snippet = snippet.split(k).join("***");
            throw new HttpError(`외부 서비스 오류 (${upstream.status}) · 응답: ${snippet.slice(0, 160) || "(없음)"} · 서버에 저장된 키 길이: ${secret.length}자`, 502);
        }
        try { JSON.parse(text); } catch { throw new HttpError("외부 서비스 응답이 올바르지 않아요.", 502); }
        cache.set(key, { exp: now + ttl, body: text });
        if (cache.size > 500) for (const [k, v] of cache) if (v.exp <= now) cache.delete(k);
        return json(text, 200, origin, { "Cache-Control": "public, max-age=120", "X-Proxy-Cache": "MISS" });
    } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status, origin);
        console.error("api-proxy error:", e);
        return json({ error: "서버 오류가 발생했어요." }, 500, origin);
    }
});
