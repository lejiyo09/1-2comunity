    // 서비스워커 등록 + "새 버전이 준비되었습니다 [업데이트]" 알림
    // 배포로 앱 파일이 바뀌면 빌드가 sw.js 의 APP_VERSION 을 바꾸고, 브라우저가 그 새 서비스워커를 뒤에서 설치해 "대기" 상태로 둔다.
    // 바로 바꾸지 않고(쓰던 글·타이머가 섞이지 않도록) 알림을 띄워, 사용자가 누르면 교체 후 새로고침한다.
    // 단, 지금 열린 화면이 이미 그 버전이면(새로고침으로 최신 파일을 이미 받은 경우) 알림 없이 조용히 교체만 한다.
    (function(){
        "use strict";
        if (!('serviceWorker' in navigator)) return;
        const pageVersion = (document.querySelector('meta[name="app-version"]') || {}).content || '';
        let userAskedUpdate = false;
        let bar = null;

        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (userAskedUpdate) location.reload();
        });

        // 대기 중인 서비스워커에게 버전을 물어본다(오래된 서비스워커는 대답이 없으므로 잠시 뒤 '' 로 본다)
        function askVersion(worker){
            return new Promise((resolve) => {
                try {
                    const ch = new MessageChannel();
                    const t = setTimeout(() => resolve(''), 1500);
                    ch.port1.onmessage = (e) => { clearTimeout(t); resolve(String(e.data || '')); };
                    worker.postMessage('GET_VERSION', [ch.port2]);
                } catch (e) { resolve(''); }
            });
        }

        function showBar(worker){
            if (!bar) {
                bar = document.createElement('div');
                bar.id = 'gmw-update-bar';
                bar.className = 'gmw-update-bar';
                bar.setAttribute('role', 'status');
                bar.innerHTML = '<span>새 버전이 준비되었습니다</span><button type="button" class="gmw-update-btn">업데이트</button>';
                document.body.appendChild(bar);
            }
            bar.querySelector('button').onclick = () => {
                bar.classList.remove('visible');
                userAskedUpdate = true;
                worker.postMessage('SKIP_WAITING');
                setTimeout(() => location.reload(), 3000); // 교체 신호(controllerchange)가 오지 않는 브라우저 대비
            };
            requestAnimationFrame(() => bar.classList.add('visible'));
        }

        async function offerUpdate(worker){
            if (!worker || !navigator.serviceWorker.controller) return; // 첫 설치는 알릴 필요 없음
            const v = await askVersion(worker);
            if (v && pageVersion && v === pageVersion) { worker.postMessage('SKIP_WAITING'); return; } // 화면은 이미 최신
            showBar(worker);
        }

        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js').then((reg) => {
                if (reg.waiting) offerUpdate(reg.waiting);
                reg.addEventListener('updatefound', () => {
                    const w = reg.installing;
                    if (!w) return;
                    w.addEventListener('statechange', () => { if (w.state === 'installed') offerUpdate(w); });
                });
                // 앱으로 돌아올 때, 그리고 켜 둔 동안 30분마다 새 버전 확인
                const check = () => { if (!document.hidden && navigator.onLine) reg.update().catch(() => {}); };
                document.addEventListener('visibilitychange', check);
                setInterval(check, 30 * 60 * 1000);
            }).catch((err) => {
                console.warn('[한일고 PWA] service worker 등록 실패:', err);
            });
        });
    })();
