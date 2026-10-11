// 서비스워커: PWA 설치 조건을 만족시키는 동시에, 오프라인일 때도 마지막으로 성공했던 페이지/자원을
// 볼 수 있게 해준다. 단, 이 앱은 배포마다 내용이 자주 바뀌므로 "캐시 우선"은 절대 쓰지 않는다 -
// 온라인일 땐 항상 네트워크에서 최신 버전을 먼저 받아오고, 그게 실패했을 때(오프라인)만 마지막으로
// 저장해둔 캐시로 대체한다("네트워크 우선, 실패 시 캐시").
//
// ⚠️ 이 캐시는 "예전에 온라인 상태에서 최소 한 번은 성공적으로 열어본 적 있는 화면"만 오프라인에서
// 대신 보여줄 수 있다 - 애초에 한 번도 성공적으로 못 연 사이트라면(예: 호스팅 서비스가 잠들어 있거나
// 다운된 상태에서 처음 접속) 오프라인 캐시에 저장된 게 아무것도 없어서 대신 보여줄 화면 자체가 없다.
const CACHE_NAME = 'appshell-v6'; // 오프라인 첫 화면 수정(외부 코드 캐시·네트워크 타임아웃) - 앱 셸이 바뀌어 이름을 올려 예전 캐시를 비운다
// 앱 코드가 불러오는 "외부" 모듈(Firebase·Supabase)과 글꼴은 따로 저장해 둔다. 이게 없으면 오프라인에서 app.js 가 import 단계에서 실패해
// 앱 전체가 시작되지 못하고 "불러오는 중…"에서 멈춘다. 버전이 고정된 파일이라 앱 셸 이름이 바뀌어도 지우지 않는다.
const CDN_CACHE = 'appcdn-v1';
const CDN_PRECACHE_URLS = [
    'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js',
    'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js',
    'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js',
    'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js',
    'https://esm.sh/@supabase/supabase-js@2',
];
let slowNetworkUntil = 0;
const NETWORK_TIMEOUT_FAST_MS = 800;
const NETWORK_TIMEOUT_MS = 4000; // 캐시가 있는데 네트워크가 이만큼 걸리면(연결은 됐지만 인터넷이 안 되는 상태) 먼저 캐시로 연다
function isCdnCacheable(url) {
    if (url.hostname === 'www.gstatic.com') return url.pathname.startsWith('/firebasejs/');
    if (url.hostname === 'esm.sh') return true;
    if (url.hostname === 'cdn.jsdelivr.net') return url.pathname.startsWith('/gh/orioncactus/pretendard/'); // 글꼴(Tesseract 같은 큰 파일은 제외)
    return false;
}
// ES 모듈 안의 import/export-from 주소를 찾아서(같은 서버 안의 경로만) 따라가며 저장한다.
async function precacheModuleGraph(cache, startUrl, seen, depth) {
    if (seen.has(startUrl) || seen.size > 80 || depth > 5) return;
    seen.add(startUrl);
    let res;
    try { res = await fetch(startUrl, { mode: 'cors' }); } catch (e) { return; }
    if (!res || !res.ok) return;
    const finalUrl = res.url || startUrl;
    await cache.put(startUrl, res.clone());
    if (!/javascript|ecmascript/.test(res.headers.get('content-type') || '') && !/\.m?js(\?|$)/.test(finalUrl)) return;
    const text = await res.text();
    const found = new Set(); let m;
    const re = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;
    while ((m = re.exec(text))) found.add(m[1]);
    await Promise.all([...found].map((spec) => {
        let abs; try { abs = new URL(spec, finalUrl).href; } catch (e) { return null; }
        if (!isCdnCacheable(new URL(abs))) return null;
        return precacheModuleGraph(cache, abs, seen, depth + 1);
    }));
}
// 앱 화면을 이루는 파일 전부 - 처음 방문 때 같이 저장해 두면, 그 뒤 오프라인에서도 화면 전체가 열린다.
const APP_SHELL_URLS = [
    './', './index.html', './manifest.webmanifest',
    '/css/main.css', '/css/tailwind.css', '/css/planner.css', '/css/mini-widgets.css', '/css/pwa-install.css', '/css/notice-popup.css',
    '/js/config.js', '/js/app.js', '/js/appstore-zip.js', '/js/appstore.js', '/js/planner.js',
    '/js/mixtape.js', '/js/home-bridge.js', '/js/pip-bubble.js', '/js/pwa-install.js', '/js/theme.js'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            // cache.addAll은 원자적이라 URL 하나만 실패해도 나머지까지 전부 캐싱되지 않는다(이전 버전의 버그 -
            // manifest 하나만 문제여도 index.html조차 캐싱되지 않아 오프라인 접근이 통째로 안 됐다).
            // 하나씩 따로 시도해서 서로 영향을 주지 않게 한다.
            Promise.all(APP_SHELL_URLS.map((url) =>
                cache.add(url).catch((err) => console.warn('앱 셸 사전 캐싱 실패 (무시하고 계속):', url, err))
            ))
        ).then(() => caches.open(CDN_CACHE)).then((cdn) => {
            // 외부 모듈도 미리 저장(실패해도 설치는 계속). 처음 방문 때는 서비스워커가 아직 페이지를 맡기 전이라 런타임 저장만으로는 비어 있기 때문.
            const seen = new Set();
            return Promise.all(CDN_PRECACHE_URLS.map((u) => precacheModuleGraph(cdn, u, seen, 0).catch((err) => console.warn('외부 모듈 사전 캐싱 실패 (무시하고 계속):', u, err))));
        })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME && n !== CDN_CACHE).map((n) => caches.delete(n))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    // 서비스가 끝난 via.placeholder.com(옛 글에 저장된 자리표시 사진 주소)은 응답 없이 오래 기다리게 되므로 바로 회색 이미지로 대신한다.
    if (url.hostname === 'via.placeholder.com') {
        event.respondWith(new Response('<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150"><rect width="150" height="150" fill="#e5e7eb"/></svg>', { headers: { 'Content-Type': 'image/svg+xml' } }));
        return;
    }
    // 앱 코드가 import 하는 외부 모듈/글꼴: 저장해 둔 것을 먼저 쓰고(오프라인에서도 앱이 시작되게), 뒤에서 최신으로 갱신한다.
    if (url.origin !== self.location.origin && isCdnCacheable(url)) {
        event.respondWith(caches.open(CDN_CACHE).then((cache) => cache.match(event.request).then((cached) => {
            const fetching = fetch(event.request).then((res) => {
                if (res && (res.ok || res.type === 'opaque')) cache.put(event.request, res.clone());
                return res;
            });
            if (cached) { event.waitUntil(fetching.catch(() => {})); return cached; }
            return fetching;
        })));
        return;
    }
    // 그 밖의 다른 출처(Firebase 데이터/Supabase API 등)는 건드리지 않는다 - 이 앱 자신의 파일(같은 출처)만 캐싱한다.
    if (url.origin !== self.location.origin) return;

    const isNavigate = event.request.mode === 'navigate';

    const network = fetch(event.request).then((response) => {
        // 호스팅 서비스가 잠들어 있다 깨어나는 중이면 네트워크 요청 자체는 "성공"하지만 502/503 같은
        // 오류 응답이 올 수 있다 - 페이지 이동 요청만큼은 그 오류 화면 대신 마지막 캐시를 먼저 시도한다.
        if (isNavigate && !response.ok) {
            return caches.match(event.request, { ignoreSearch: true })
                .then((cached) => cached || caches.match('./index.html'))
                .then((fallback) => fallback || response);
        }
        if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
    });
    const fromCache = () => caches.match(event.request, { ignoreSearch: true }).then((cached) => {
        if (cached) return cached;
        // 캐시에 없는 페이지로의 이동(예: 첫 방문 이후 새로 생긴 경로)이면, 최소한 앱 화면(index.html)이라도 보여준다.
        if (isNavigate) return caches.match('./index.html');
        return undefined;
    });
    // 오프라인이면 fetch 가 바로 실패해서 캐시로 넘어간다. "연결은 됐는데 인터넷이 안 되는" 상태에서는 fetch 가 한참 멈추므로,
    // 저장해 둔 게 있으면 일정 시간 뒤에 먼저 그걸로 연다(네트워크 응답은 뒤에서 계속 받아 캐시를 갱신한다).
    // 한 번 시간 초과가 나면 잠시(1분) 동안은 같은 상태일 가능성이 높으니, 이어지는 파일들은 훨씬 짧게 기다린다(화면의 스크립트들이 차례로 4초씩 걸리지 않도록).
    const waitMs = Date.now() < slowNetworkUntil ? NETWORK_TIMEOUT_FAST_MS : NETWORK_TIMEOUT_MS;
    const timeout = new Promise((resolve) => setTimeout(() => fromCache().then((res) => { if (res) slowNetworkUntil = Date.now() + 60000; resolve(res); }), waitMs));
    event.respondWith(Promise.race([network.catch(() => fromCache()), timeout]).then((res) => res || network.catch(() => undefined)));
    event.waitUntil(network.catch(() => {}));
});
