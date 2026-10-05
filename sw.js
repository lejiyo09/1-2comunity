// 서비스워커: PWA 설치 조건을 만족시키는 동시에, 오프라인일 때도 마지막으로 성공했던 페이지/자원을
// 볼 수 있게 해준다. 단, 이 앱은 배포마다 내용이 자주 바뀌므로 "캐시 우선"은 절대 쓰지 않는다 -
// 온라인일 땐 항상 네트워크에서 최신 버전을 먼저 받아오고, 그게 실패했을 때(오프라인)만 마지막으로
// 저장해둔 캐시로 대체한다("네트워크 우선, 실패 시 캐시").
//
// ⚠️ 이 캐시는 "예전에 온라인 상태에서 최소 한 번은 성공적으로 열어본 적 있는 화면"만 오프라인에서
// 대신 보여줄 수 있다 - 애초에 한 번도 성공적으로 못 연 사이트라면(예: 호스팅 서비스가 잠들어 있거나
// 다운된 상태에서 처음 접속) 오프라인 캐시에 저장된 게 아무것도 없어서 대신 보여줄 화면 자체가 없다.
const CACHE_NAME = 'appshell-v3'; // 파일을 css/·js/ 로 나눈 구조(앱 셸이 바뀌어 이름을 올려 예전 캐시를 비운다)
// 앱 화면을 이루는 파일 전부 - 처음 방문 때 같이 저장해 두면, 그 뒤 오프라인에서도 화면 전체가 열린다.
const APP_SHELL_URLS = [
    './', './index.html', './manifest.webmanifest',
    '/css/main.css', '/css/planner.css', '/css/mini-widgets.css', '/css/pwa-install.css', '/css/notice-popup.css',
    '/js/config.js', '/js/tailwind-config.js', '/js/app.js', '/js/appstore-zip.js', '/js/appstore.js', '/js/planner.js',
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
        )
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    // 다른 출처(Firebase/Supabase/CDN 등)는 건드리지 않는다 - 이 앱 자신의 파일(같은 출처)만 캐싱한다.
    if (url.origin !== self.location.origin) return;

    const isNavigate = event.request.mode === 'navigate';

    event.respondWith(
        fetch(event.request)
            .then((response) => {
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
            })
            .catch(() =>
                caches.match(event.request, { ignoreSearch: true }).then((cached) => {
                    if (cached) return cached;
                    // 캐시에 없는 페이지로의 이동(예: 첫 방문 이후 새로 생긴 경로)이면, 최소한 앱 화면(index.html)이라도 보여준다.
                    if (isNavigate) return caches.match('./index.html');
                    return undefined;
                })
            )
    );
});
