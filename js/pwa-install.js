
    (function(){
        "use strict";
        const DISMISS_KEY = 'hanilgo_pwa_card_dismissed';
        let deferredPrompt = null;
        const card = document.getElementById('gmw-pwa-card');
        const installBtn = document.getElementById('gmw-pwa-install-btn');
        const closeBtn = document.getElementById('gmw-pwa-close');

        function isStandalone(){
            return window.matchMedia && window.matchMedia('(display-mode: standalone)').matches
                || window.navigator.standalone === true;
        }

        function showCard(){
            if (isStandalone()) return;
            if (localStorage.getItem(DISMISS_KEY) === '1') return;
            card.classList.add('visible');
        }
        function hideCard(){ card.classList.remove('visible'); }

        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredPrompt = e;
            showCard();
        });

        installBtn.addEventListener('click', async () => {
            if (!deferredPrompt) { hideCard(); return; }
            deferredPrompt.prompt();
            try {
                await deferredPrompt.userChoice;
            } catch (e) {}
            deferredPrompt = null;
            hideCard();
        });

        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            localStorage.setItem(DISMISS_KEY, '1');
            hideCard();
        });

        window.addEventListener('appinstalled', () => {
            deferredPrompt = null;
            hideCard();
        });

        if (isStandalone()) hideCard();

        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('/sw.js').catch((err) => {
                    console.warn('[한일고 PWA] service worker 등록 실패:', err);
                });
            });
        }
    })();
    