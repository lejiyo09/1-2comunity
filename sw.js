// 서비스워커: PWA 설치 조건을 만족시키는 동시에, 오프라인일 때도 마지막으로 성공했던 페이지/자원을
// 볼 수 있게 해준다. 단, 이 앱은 배포마다 내용이 자주 바뀌므로 "캐시 우선"은 절대 쓰지 않는다 -
// 온라인일 땐 항상 네트워크에서 최신 버전을 먼저 받아오고, 그게 실패했을 때(오프라인)만 마지막으로
// 저장해둔 캐시로 대체한다("네트워크 우선, 실패 시 캐시").
const CACHE_NAME = 'appshell-v1';
const APP_SHELL_URLS = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_URLS).catch(() => {}))
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

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                if (response && response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() =>
                caches.match(event.request).then((cached) => {
                    if (cached) return cached;
                    // 캐시에 없는 페이지로의 이동(예: 첫 방문 이후 새로 생긴 경로)이면, 최소한 앱 화면(index.html)이라도 보여준다.
                    if (event.request.mode === 'navigate') return caches.match('./index.html');
                    return undefined;
                })
            )
    );
});
