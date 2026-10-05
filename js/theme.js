
    (function(){
        "use strict";
        const THEME_KEY = 'hanilgo_site_theme'; // localStorage에 'light' | 'dark'가 있으면 수동 설정, 없으면 자동(시스템 추종)
        const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

        const openBtn = document.getElementById('btn-open-settings');
        const modal = document.getElementById('settings-modal');
        const themeToggle = document.getElementById('settings-theme-toggle');
        const themeKnob = document.getElementById('settings-theme-knob');
        const pipToggle = document.getElementById('settings-pip-toggle');
        const pipKnob = document.getElementById('settings-pip-knob');
        const pipInlineToggle = document.getElementById('settings-pip-inline-toggle');
        const pipInlineKnob = document.getElementById('settings-pip-inline-knob');
        const sidebarPinToggle = document.getElementById('settings-sidebar-pin-toggle');
        const sidebarPinKnob = document.getElementById('settings-sidebar-pin-knob');
        const SIDEBAR_PIN_KEY = 'hanilgo_sidebar_pinned'; // 개인별(브라우저별) 설정 - 예전 4.0처럼 사이드바를 항상 펼쳐둔다

        function setKnob(knobEl, on){
            knobEl.style.transform = on ? 'translateX(22px)' : 'translateX(0)';
        }
        function setSmallKnob(knobEl, on){
            knobEl.style.transform = on ? 'translateX(18px)' : 'translateX(0)';
        }

        // 터치 인터페이스(hover가 없거나 주 입력이 손가락)에서는 hover로 펼칠 수 없으므로, 사용자가 직접 정한 적이 없으면
        // "사이드바 항상 펼치기"를 자동으로 켠다. 직접 켜거나 끈 적이 있으면('1'/'0') 그 선택이 항상 우선이다.
        function isTouchInterface(){
            return window.matchMedia('(hover: none)').matches || window.matchMedia('(pointer: coarse)').matches;
        }
        function isSidebarPinned(){
            const saved = localStorage.getItem(SIDEBAR_PIN_KEY);
            if (saved === '1') return true;
            if (saved === '0') return false;
            return isTouchInterface();
        }
        function applySidebarPinUI(){
            const pinned = isSidebarPinned();
            const sidebarEl = document.getElementById('sidebar');
            if (sidebarEl) sidebarEl.classList.toggle('pinned-expanded', pinned);
            setKnob(sidebarPinKnob, pinned);
        }
        applySidebarPinUI();
        // 터치 인터페이스로 바뀌거나(예: 태블릿 모드 전환) 돌아오면, 직접 정한 적 없는 경우에 한해 다시 반영한다
        ['(hover: none)', '(pointer: coarse)'].forEach(q => {
            const mq = window.matchMedia(q);
            if (mq.addEventListener) mq.addEventListener('change', applySidebarPinUI);
        });
        if (sidebarPinToggle) sidebarPinToggle.addEventListener('click', () => {
            const next = !isSidebarPinned();
            localStorage.setItem(SIDEBAR_PIN_KEY, next ? '1' : '0');
            applySidebarPinUI();
        });

        // 우선순위: ① 사용자가 사이트에서 직접 선택한 테마 > ② 시스템(Chromebook) 테마 > ③ 기본값(라이트)
        function getManualTheme(){ return localStorage.getItem(THEME_KEY); } // 'light' | 'dark' | null(자동)
        function computeIsDark(){
            const manual = getManualTheme();
            if (manual === 'dark') return true;
            if (manual === 'light') return false;
            return systemThemeQuery.matches; // 수동 설정이 없으면 시스템 설정을 따라간다
        }

        function applySiteTheme(){
            const dark = computeIsDark();
            document.body.classList.toggle('gmw-site-dark', dark);
            setKnob(themeKnob, dark);
            // 배경 프리셋(기본2)이나 "다크 모드에서 라이트 사진 그대로 쓰기"는 테마에 따라 다른
            // 결과를 내야 하므로, 라이트/다크가 바뀔 때마다 배경도 다시 계산해서 적용한다.
            if (window.applyActiveBackground) window.applyActiveBackground();
        }

        function isPiPEnabledNow(){
            return window.GlobalMiniController ? window.GlobalMiniController.isPiPEnabled() : (localStorage.getItem('hanilgo_pip_enabled') !== '0');
        }
        function isInlinePiPEnabledNow(){
            return window.GlobalMiniController ? window.GlobalMiniController.isInlineEnabled() : (localStorage.getItem('hanilgo_pip_inline_enabled') !== '0');
        }

        function applyPipToggleUI(){
            setSmallKnob(pipKnob, isPiPEnabledNow());
            setSmallKnob(pipInlineKnob, isInlinePiPEnabledNow());
        }

        // 초기 상태 반영
        applySiteTheme();
        applyPipToggleUI();

        // 사용자가 수동으로 테마를 지정하지 않은 동안에는 Chromebook 시스템 테마가 바뀌면 즉시 따라간다.
        systemThemeQuery.addEventListener('change', () => {
            if (getManualTheme() === null) applySiteTheme();
        });

        if (openBtn) openBtn.addEventListener('click', () => {
            applyPipToggleUI(); // 모달 열 때마다 최신 상태로 동기화
            if (window.renderAccentColorSwatches) window.renderAccentColorSwatches(); // 강조색 선택 UI도 최신 상태로
            if (window.updateBgSettingsUI) window.updateBgSettingsUI(); // 배경화면 선택 UI도 최신 상태로
            modal.style.display = 'flex';
        });
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

        // 토글을 누르는 순간부터는 "수동 설정"이 되어, 이후 시스템 테마 변경에 더 이상 영향받지 않는다.
        themeToggle.addEventListener('click', () => {
            const next = !computeIsDark();
            localStorage.setItem(THEME_KEY, next ? 'dark' : 'light');
            applySiteTheme();
        });

        pipToggle.addEventListener('click', () => {
            const next = !isPiPEnabledNow();
            if (window.GlobalMiniController) window.GlobalMiniController.setPiPEnabled(next);
            else localStorage.setItem('hanilgo_pip_enabled', next ? '1' : '0');
            setSmallKnob(pipKnob, next);
        });

        if (pipInlineToggle) pipInlineToggle.addEventListener('click', () => {
            const next = !isInlinePiPEnabledNow();
            if (window.GlobalMiniController) window.GlobalMiniController.setInlineEnabled(next);
            else localStorage.setItem('hanilgo_pip_inline_enabled', next ? '1' : '0');
            setSmallKnob(pipInlineKnob, next);
        });
    })();
    