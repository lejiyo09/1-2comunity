// 최소 서비스워커: PWA 설치 조건(서비스워커 등록)만 만족시키기 위한 용도.
// 이 앱은 배포마다 내용이 자주 바뀌므로 캐싱은 전혀 하지 않는다 - 캐싱하면 새로고침해도
// 예전 버전이 계속 보이는 문제가 생길 수 있다. fetch 이벤트를 가로채지 않아 항상 네트워크로만 응답한다.
self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});
