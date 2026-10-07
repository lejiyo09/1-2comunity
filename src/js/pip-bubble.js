
    (function(){
        "use strict";
        const RADIUS = 27;
        const CIRC = 2 * Math.PI * RADIUS;
        const INLINE_RADIUS = 28;
        const INLINE_CIRC = 2 * Math.PI * INLINE_RADIUS;

        const pipRoot = document.getElementById('gmw-pip-root');
        const pipHomeParent = pipRoot.parentNode; // PiP 종료 시 되돌아올 원래 위치 (항상 display:none 상태)
        function pip$(id){ return pipRoot.querySelector('#' + id); }
        const pipCard = pip$('gmw-pip-card');
        const pipFocusRow = pip$('gmw-pip-focus');
        const pipMixRow = pip$('gmw-pip-mixtape');

        const inlineFocusCard = document.getElementById('gmw-inline-focus');
        const inlineMixCard = document.getElementById('gmw-inline-mixtape');

        let pipWindow = null;
        // Focus/MixTape 표시 조합(showFocus+showMix)이 실제로 바뀔 때만 resizeOpenPiP를 부르기 위한 키.
        // render()는 재생 중 1초마다도 호출되는데, 매번 resizeTo를 부르면 사용자가 PiP 창을 손으로
        // 늘려도 다음 tick에 바로 원래 크기로 되돌아가버리는 문제가 있었다 (드래그해도 계속 줄어듦).
        let lastPiPSizeKey = null;

        // ===== 상태 관리자 =====
        const state = {
            mode: 'inline',       // 'inline' | 'pip'
            currentPage: null,    // 'planner' | 'mixtape' | 그 외 실제 tab id
            focusActive: false,
            mixTapeActive: false
        };

        function isPiPSupported(){ return 'documentPictureInPicture' in window; }
        function isPiPEnabled(){ return localStorage.getItem('hanilgo_pip_enabled') !== '0'; } // 전역 PiP: 다른 탭/창으로 나가면 뜨는 진짜 브라우저 PiP
        function isInlineEnabled(){ return localStorage.getItem('hanilgo_pip_inline_enabled') !== '0'; } // 커뮤니티 내부 PiP: 사이트 안을 보는 동안 뜨는 인라인 미니 위젯
        let focusInlineDismissed = false; // "닫기" 버튼으로 숨긴 뒤, 해당 활동이 완전히 끝났다가 다시 시작되면 초기화된다
        let mixInlineDismissed = false;

        function getCurrentPage(){
            const el = document.querySelector('.tab-content.active');
            return el && el.id ? el.id.replace(/^tab-/, '') : null;
        }

        // 현재 곡의 앨범아트 Blob -> object URL. 매 렌더(초 단위 tick)마다 새로 만들면 안 되므로,
        // 같은 Blob이면 이미 만든 URL을 그대로 재사용하고 곡이 바뀔 때만 새로 만들고 이전 것을 해제한다.
        let mixArtworkCache = { blob: null, url: null };
        function resolveMixArtworkUrl(blob){
            if (!blob) {
                if (mixArtworkCache.url) URL.revokeObjectURL(mixArtworkCache.url);
                mixArtworkCache = { blob: null, url: null };
                return null;
            }
            if (mixArtworkCache.blob === blob) return mixArtworkCache.url;
            if (mixArtworkCache.url) URL.revokeObjectURL(mixArtworkCache.url);
            const url = URL.createObjectURL(blob);
            mixArtworkCache = { blob, url };
            return url;
        }

        function getFocusData(){
            try {
                if (window.PlannerApp && typeof window.PlannerApp.getFocusWidgetData === 'function') {
                    const d = window.PlannerApp.getFocusWidgetData();
                    if (!d) return null;
                    return { title: d.title, subjectName: d.subjectName || '', elapsedSec: d.elapsedSec || 0, targetSec: (d.targetMin || 0) * 60, isRunning: !!d.isRunning };
                }
            } catch (e) {}
            return null;
        }

        function getMixData(){
            try {
                if (window.MixTapeApp && typeof window.MixTapeApp.getNowPlaying === 'function') {
                    const np = window.MixTapeApp.getNowPlaying();
                    if (!np || !np.name) return null;
                    return {
                        name: np.name, playlistName: np.playlistName || '',
                        artworkUrl: resolveMixArtworkUrl(np.artwork || null),
                        index: np.index, total: np.total || 0,
                        currentTime: np.currentTime || 0, duration: np.duration || 0,
                        playing: !!np.playing, isShuffle: !!np.isShuffle, repeatMode: np.repeatMode || 0
                    };
                }
            } catch (e) {}
            return null;
        }

        function fmt(sec){
            sec = Math.max(0, Math.floor(sec || 0));
            const m = Math.floor(sec / 60);
            const s = sec % 60;
            return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        }

        // artEl은 기본적으로 "📼" 텍스트를 담은 박스. 앨범아트가 있으면 그 안에 <img>를 넣고,
        // 없으면 다시 텍스트로 되돌린다. data-art-url로 마지막 반영한 URL을 기억해서 매 tick마다
        // (곡이 안 바뀌었는데도) innerHTML을 다시 쓰지 않는다.
        function updateMixArtEl(artEl, url){
            if (!artEl) return;
            const current = artEl.dataset.artUrl || '';
            if (current === (url || '')) return;
            artEl.dataset.artUrl = url || '';
            artEl.innerHTML = url ? `<img src="${url}" onerror="this.parentElement.innerHTML='📼'; this.parentElement.dataset.artUrl='';">` : '📼';
        }

        function setRing(circleEl, pct, circumference){
            if (!circleEl) return;
            const clamped = Math.max(0, Math.min(100, pct || 0));
            circleEl.style.strokeDasharray = `${circumference}`;
            circleEl.style.strokeDashoffset = `${circumference * (1 - clamped / 100)}`;
        }

        // ===================== INLINE 위젯 (사이트 디자인과 통일된 밝은 카드) =====================

        function renderInlineFocus(data, suppressed){
            if (!data) focusInlineDismissed = false; // 활동이 끝나면 다음 번엔 다시 보이도록 닫힘 상태를 초기화
            const visible = !!data && !suppressed && state.mode === 'inline' && isInlineEnabled() && !focusInlineDismissed;
            inlineFocusCard.style.display = visible ? 'flex' : 'none';
            if (!visible) return false;
            const pct = data.targetSec > 0 ? (data.elapsedSec / data.targetSec) * 100 : 0;
            setRing(document.getElementById('gmw-inline-focus-ring'), pct, INLINE_CIRC);
            document.getElementById('gmw-inline-focus-time').textContent = fmt(data.elapsedSec);
            document.getElementById('gmw-inline-focus-target').textContent = `/ ${fmt(data.targetSec)}`;
            document.getElementById('gmw-inline-focus-title').textContent = data.title || '집중 중인 과제';
            document.getElementById('gmw-inline-focus-status').textContent = data.isRunning ? '집중 중' : '일시정지됨';
            const toggleBtn = document.getElementById('gmw-inline-focus-toggle-btn');
            if (toggleBtn) toggleBtn.textContent = data.isRunning ? 'Ⅱ' : '▶';
            return true;
        }

        function renderInlineMix(data, suppressed){
            if (!data) mixInlineDismissed = false; // 재생이 끝나면 다음 번엔 다시 보이도록 닫힘 상태를 초기화
            const visible = !!data && !suppressed && state.mode === 'inline' && isInlineEnabled() && !mixInlineDismissed;
            inlineMixCard.style.display = visible ? 'flex' : 'none';
            if (!visible) return false;
            document.getElementById('gmw-inline-mix-title').textContent = data.name;
            document.getElementById('gmw-inline-mix-sub').textContent = `${fmt(data.currentTime)} / ${fmt(data.duration)}`;
            updateMixArtEl(document.getElementById('gmw-inline-mix-art'), data.artworkUrl);
            const playBtn = document.getElementById('gmw-inline-mix-play-btn');
            if (playBtn) playBtn.textContent = data.playing ? 'Ⅱ' : '▶';
            return true;
        }

        // ===================== Document PiP (완전히 별도의 각진 dark 컨트롤 패널) =====================

        function renderPiPFocus(data, suppressed){
            if (!data || suppressed) { pipFocusRow.style.display = 'none'; return false; }
            pipFocusRow.style.display = 'flex';
            pipFocusRow.classList.toggle('is-running', !!data.isRunning);
            const pct = data.targetSec > 0 ? (data.elapsedSec / data.targetSec) * 100 : 0;
            setRing(pip$('gmw-pip-focus-ring'), pct, CIRC);
            pip$('gmw-pip-focus-time').textContent = fmt(data.elapsedSec);
            pip$('gmw-pip-focus-target').textContent = `/ ${fmt(data.targetSec)}`;
            pip$('gmw-pip-focus-title').textContent = data.title || '집중 중인 과제';
            pip$('gmw-pip-focus-status').textContent = data.isRunning ? '집중 중' : '일시정지됨';
            const toggleBtn = pip$('gmw-pip-focus-toggle-btn');
            if (toggleBtn) toggleBtn.textContent = data.isRunning ? 'Ⅱ' : '▶';
            return true;
        }

        function renderPiPMix(data, suppressed){
            if (!data || suppressed) { pipMixRow.style.display = 'none'; return false; }
            pipMixRow.style.display = 'flex';
            const pct = data.duration > 0 ? (data.currentTime / data.duration) * 100 : 0;
            setRing(pip$('gmw-pip-mix-ring'), pct, CIRC);
            pip$('gmw-pip-mix-cur').textContent = fmt(data.currentTime);
            pip$('gmw-pip-mix-dur').textContent = `/ ${fmt(data.duration)}`;
            pip$('gmw-pip-mix-title').textContent = data.name;
            updateMixArtEl(pip$('gmw-pip-mix-art'), data.artworkUrl);
            const idx = (data.index != null && data.index >= 0) ? data.index + 1 : 0;
            pip$('gmw-pip-mix-sub').textContent = data.playlistName ? `${data.playlistName} · ${idx}/${data.total}` : `${idx}/${data.total}곡`;
            const playBtn = pip$('gmw-pip-mix-play-btn');
            if (playBtn) playBtn.textContent = data.playing ? 'Ⅱ' : '▶';
            const shuffleBtn = pip$('gmw-pip-mix-shuffle-btn');
            if (shuffleBtn) shuffleBtn.classList.toggle('active', !!data.isShuffle);
            const repeatBtn = pip$('gmw-pip-mix-repeat-btn');
            if (repeatBtn) {
                repeatBtn.classList.toggle('active', data.repeatMode !== 0);
                repeatBtn.textContent = data.repeatMode === 2 ? '⟳¹' : '⟳';
            }
            return true;
        }

        // 인라인 위젯(.gmw-inline-card)과 같은 288px 너비를 기준으로 잡는다 - 전역 PiP가
        // 인라인보다 커 보인다는 피드백 반영.
        // ⚠️ 세로 높이는 고정값을 추측해서 쓰지 않는다 - 80/160으로 하면 아래가 잘리고, 96/180으로
        // 늘리면 이번엔 아래 여백이 너무 많이 남는 등 환경(폰트/브라우저)마다 실제 콘텐츠 높이가
        // 조금씩 달라 고정값으로는 계속 어긋났다. 여기 height는 창을 "처음 열 때"만 쓰는 대략적인
        // 값이고, 연 직후 measurePiPContentHeight()로 실제 렌더된 높이를 재서 바로 정확히 맞춘다.
        function sizeForPiP(showFocus, showMix){
            if (showFocus && showMix) return { width: 288, height: 160 };
            return { width: 288, height: 80 };
        }

        // pipCard의 실제 렌더링된 콘텐츠 높이(scrollHeight)를 재서, 셸 패딩(위아래 6px씩)을 더한
        // "이 내용에 정확히 맞는" 창 높이를 구한다. 고정값 추측 대신 매번 실측해서 여백이 남거나
        // 잘리는 문제를 근본적으로 없앤다.
        function measurePiPContentHeight(){
            if (!pipCard) return null;
            const h = pipCard.scrollHeight;
            return h > 0 ? h + 12 : null; // .gmw-pip-shell padding: 6px 이므로 위+아래 12px
        }

        // ----- Window 상태 관리: "숨김"이 아니라 완전히 닫는다(Option A) -----
        // Document PiP에는 "창을 살려둔 채 화면에서 완전히 감추는" API가 없다.
        // resizeTo(1,1) + moveTo(화면 밖) 같은 편법은 실제로는 창이 계속 살아있는 것이라
        // 아주 작은 빈 창이 화면 한 구석에 남는 것처럼 보이는 부작용이 있었다. 이 편법은 제거한다.
        // 대신 커뮤니티로 돌아오면 PiP를 실제로 닫는다. 그 결과 다음 번 외부 탭 이동 시
        // 사용자 제스처(클릭) 없이 자동으로 다시 뜨는 것은 브라우저 정책상 보장할 수 없지만,
        // Focus 시작/정지, MixTape 재생, switchTab 같은 실제 클릭 지점에서는 정상적으로 다시 열린다.
        function destroyPiPWindow(){
            if (!pipWindow) return;
            try { pipWindow.close(); } catch (e) {}
            // close()는 'pagehide'를 비동기로 트리거해 pipRoot 반환 등 뒷정리를 하지만,
            // 그 사이 다른 코드가 pipWindow를 다시 참조하지 않도록 여기서도 즉시 참조를 끊는다.
            pipWindow = null;
            lastPiPSizeKey = null;
        }

        // Document PiP는 반드시 실제 사용자 제스처 호출 스택 안에서 열어야 브라우저가 허용한다.
        // 이미 pipWindow가 존재하면 절대로 다시 호출하지 않는다 (재사용).
        async function openPiPIfPossible(showFocus, showMix){
            if (!isPiPSupported() || !isPiPEnabled() || pipWindow) return;
            if (!showFocus && !showMix) return;
            try {
                const { width, height } = sizeForPiP(showFocus, showMix);
                pipWindow = await window.documentPictureInPicture.requestWindow({ width, height });
                lastPiPSizeKey = `${showFocus}-${showMix}`; // 방금 이 크기로 열었으니, 조합이 안 바뀌는 한 다시 resizeTo를 부르지 않는다

                const styleSrc = document.getElementById('gmw-pip-style');
                if (styleSrc) pipWindow.document.head.appendChild(styleSrc.cloneNode(true));
                pipWindow.document.documentElement.style.colorScheme = 'dark';
                pipWindow.document.documentElement.style.height = '100%';
                pipWindow.document.body.style.height = '100%';
                pipWindow.document.body.style.margin = '0';
                pipWindow.document.body.style.padding = '0';
                pipWindow.document.body.style.background = '#111827';
                pipWindow.document.body.style.overflow = 'hidden';

                pipRoot.style.display = 'block';
                pipRoot.style.width = '100%';
                pipRoot.style.height = '100%';
                pipWindow.document.body.appendChild(pipRoot);

                // 대략적인 크기로 창을 만들었으니, 실제로 내용이 이 창 안에 배치된 직후 진짜
                // 필요한 높이로 다시 맞춘다 (레이아웃이 끝난 뒤 재야 정확하므로 한 프레임 기다린다).
                requestAnimationFrame(() => {
                    const measured = measurePiPContentHeight();
                    if (measured && pipWindow) { try { pipWindow.resizeTo(width, measured); } catch (e) {} }
                });

                // 사용자가 PiP 창을 직접 닫거나(destroyPiPWindow 포함) 브라우저가 종료할 때 실행된다.
                pipWindow.addEventListener('pagehide', () => {
                    // PiP 창이 닫혀도 Focus 타이머/음악 재생 자체는 절대 건드리지 않는다.
                    pipHomeParent.appendChild(pipRoot);
                    pipRoot.style.display = 'none';
                    pipWindow = null;
                    lastPiPSizeKey = null;
                    render(); // 닫힌 뒤 상태에 맞게 다시 그린다 (사이트를 보고 있었다면 inline이 나타남)
                }, { once: true });
            } catch (err) {
                console.warn('[한일고 미니컨트롤러] PiP 열기 실패(사용자 제스처 없음 등):', err);
                pipWindow = null;
            }
        }

        function resizeOpenPiP(showFocus, showMix){
            if (!pipWindow) return;
            try {
                const { width, height } = sizeForPiP(showFocus, showMix);
                if (typeof pipWindow.resizeTo !== 'function') return;
                pipWindow.resizeTo(width, height); // Focus/MixTape 행이 늘거나 줄어드는 순간 우선 대략 맞춰둔다
                requestAnimationFrame(() => {
                    const measured = measurePiPContentHeight();
                    if (measured && pipWindow) { try { pipWindow.resizeTo(width, measured); } catch (e) {} } // 실측치로 정확히 보정
                });
            } catch (e) { /* 일부 환경에서 제한될 수 있음 - 무시 */ }
        }

        // ===================== 핵심 렌더 파이프라인 =====================

        // 실제 상태를 읽어 현재 mode에 맞는 화면(inline 또는 pip)만 그린다.
        // 이 함수 자체는 새 PiP 창을 "열지" 않는다 (open은 별도 지점에서만 명시적으로 시도).
        function render(){
            const page = getCurrentPage();
            state.currentPage = page;

            const focusData = getFocusData();
            const mixData = getMixData();
            state.focusActive = !!focusData;
            state.mixTapeActive = !!mixData;

            // 이 suppress는 "지금 보고 있는 사이트 내부 페이지와 중복 표시되지 않도록" inline 위젯에만 적용한다.
            // Document PiP(외부)는 사이트 자체를 벗어난 상태에서만 뜨므로, 마지막으로 활성화됐던 내부 탭이
            // 무엇이었는지와 무관하게 Focus/MixTape가 "실제로 켜져 있는지"만 기준으로 항상 보여줘야 한다.
            //
            // 1-2 Music: Music Home은 이제 자체 "재생 중" 위젯이 없어서 항상 PiP/인라인이 정상적으로
            // 떠야 한다. 유일한 예외는 "지금 재생 중인 바로 그 플레이리스트"의 실제 카세트 화면을
            // 보고 있을 때뿐이다 (그 화면 자체가 이미 재생 상태를 보여주므로 중복 표시를 막는다).
            const suppressMixHere = !!window.__inPlaylistPlayScreen;
            // 플래너 탭에 있어도, 타이머가 도는 바로 그 날짜가 아니라 이전 기록을 열람 중이면
            // 화면에 타이머가 안 보이므로(중복 표시 우려가 없으므로) 인라인 위젯을 그대로 띄운다.
            const suppressInlineFocus = page === 'planner' && (!window.PlannerApp || !window.PlannerApp.isViewingLiveFocusDate || window.PlannerApp.isViewingLiveFocusDate());
            const suppressInlineMix = page === 'mixtape' && suppressMixHere;

            if (state.mode === 'inline') {
                renderInlineFocus(focusData, suppressInlineFocus);
                renderInlineMix(mixData, suppressInlineMix);
                // 커뮤니티 화면으로 돌아온 상태이므로 PiP는 완전히 닫는다 (숨김 편법 없음).
                // 다음에 외부로 나갈 때 자동 재생성은 사용자 제스처가 있는 지점에서만 시도된다.
                if (pipWindow) destroyPiPWindow();
                return { showFocus: false, showMix: false };
            }

            // mode === 'pip' -> 내부 탭 기준 suppress를 적용하지 않는다 (Focus/MixTape가 켜져있으면 무조건 노출)
            inlineFocusCard.style.display = 'none';
            inlineMixCard.style.display = 'none';
            const showFocus = renderPiPFocus(focusData, false);
            // 1-2 Music: "Music Home"이나 "재생 중인 플레이리스트 페이지"에 있을 때만 PiP의 MixTape 표시를 막는다.
            // 공유 음악/좋아요/내 음악/플레이리스트 목록 화면에서는 정상적으로 PiP가 뜬다.
            const showMix = renderPiPMix(mixData, suppressMixHere);
            if (pipCard) pipCard.classList.toggle('gmw-pip-both', showFocus && showMix);
            if (pipWindow) {
                if (!showFocus && !showMix) {
                    // Focus도 MixTape도 완전히 꺼진 상태 - 더 보여줄 게 없으므로 이때도 창을 닫는다.
                    destroyPiPWindow();
                } else {
                    // render()는 재생 중 1초에도 여러 번 호출되므로, 매번 resizeTo를 부르면 사용자가
                    // 손으로 늘린 창 크기가 곧바로 원래 크기로 되돌아가버린다. 조합이 실제로 바뀔 때만 부른다.
                    const sizeKey = `${showFocus}-${showMix}`;
                    if (sizeKey !== lastPiPSizeKey) {
                        resizeOpenPiP(showFocus, showMix);
                        lastPiPSizeKey = sizeKey;
                    }
                }
            }
            return { showFocus, showMix };
        }

        // 이미 열려 있는 화면(둘 중 하나)의 내용만 갱신한다. 새 PiP를 열지 않는다.
        // timerTick(), audio timeupdate 등 "사용자 제스처가 아닌" 주기적 지점에서 호출된다.
        function refresh(){
            render();
        }

        // 실제 클릭 이벤트 안에서만 호출된다 (Focus 시작/정지, MixTape 재생, switchTab 등).
        // mode가 'pip'인데 아직 창이 없다면(=최초 생성이 필요한 시점) 지금이 유일하게 열기를 시도할 수 있는 시점이다.
        // 이미 pipWindow가 있다면 render()가 이미 내용을 다시 표시했으므로 여기서 추가로 할 일이 없다.
        function handleGesture(){
            const { showFocus, showMix } = render();
            if (state.mode === 'pip' && !pipWindow && (showFocus || showMix)) {
                openPiPIfPossible(showFocus, showMix);
            }
        }

        // switchTab()에서 호출: 새 tabId를 즉시 반영해서 판별 정확도를 높인 뒤 handleGesture와 동일하게 처리.
        function handlePageChange(tabId){
            // "닫기"로 숨긴 음악 미니 위젯은 음악 페이지에 새로 들어가면 다시 나타나게 한다
            // (예전에는 재생이 완전히 끝날 때까지 계속 숨겨져서, 닫은 뒤 음악 페이지를 다녀와도 안 돌아왔다).
            if (tabId === 'mixtape') mixInlineDismissed = false;
            // 집중 타이머 미니 위젯도 같은 방식: 닫았더라도 플래너 페이지에 새로 들어가면 다시 나타나게 한다
            if (tabId === 'planner') focusInlineDismissed = false;
            handleGesture();
        }

        // 사용자가 inline 위젯의 "⇱ 미니 플레이어로 분리" 버튼을 눌렀을 때: 확실한 사용자 제스처이므로
        // 사이트를 보고 있는 중이라도 즉시 PiP로 전환한다 (창이 없으면 이때 최초 생성).
        function popOut(){
            if (!isPiPEnabled()) return;
            state.mode = 'pip';
            const { showFocus, showMix } = render();
            if (!pipWindow) openPiPIfPossible(showFocus, showMix);
        }

        function setPiPEnabled(enabled){
            localStorage.setItem('hanilgo_pip_enabled', enabled ? '1' : '0');
            document.body.classList.toggle('gmw-pip-disabled', !enabled);
            if (!enabled) {
                state.mode = 'inline';
                destroyPiPWindow(); // 기능 자체를 끈 것이므로 이 경우는 완전히 닫는 게 맞다.
            }
            render();
        }

        function setInlineEnabled(enabled){
            localStorage.setItem('hanilgo_pip_inline_enabled', enabled ? '1' : '0');
            render();
        }

        // ===================== 사이트 <-> 바깥 전환 감지 =====================

        // Document PiP의 requestWindow()는 "최근의 실제 사용자 제스처(클릭 등)"가 있어야만 허용된다.
        // 탭을 다시 활성화하는 행위 자체는 페이지 입장에서 제스처로 인정되지 않기 때문에,
        // 커뮤니티로 돌아온 뒤 아무것도 클릭하지 않고 바로 다시 다른 탭으로 가면 브라우저가 재생성을 막는다.
        // 이건 가짜 숨김 없이 PiP를 매번 완전히 닫기로 한 설계의 자연스러운 트레이드오프라 완전히
        // 없앨 수는 없고, 대신 "한 번만 아무데나 눌러주면 된다"는 걸 짧게 알려준다.
        let pipReminderLastShown = 0;
        function showPipReminderToast(){
            const now = Date.now();
            if (now - pipReminderLastShown < 8000) return; // 짧은 간격으로 반복 표시 방지
            pipReminderLastShown = now;
            const old = document.getElementById('gmw-pip-reminder-toast');
            if (old) old.remove();
            const toast = document.createElement('div');
            toast.id = 'gmw-pip-reminder-toast';
            toast.textContent = '🔔 화면을 한 번 눌러야 다음에 나갈 때 미니플레이어가 다시 떠요';
            toast.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%) translateY(-6px);z-index:9998;background:#111827;color:#f2f3f5;font-size:12.5px;font-weight:600;padding:9px 16px;border-radius:999px;box-shadow:0 6px 18px rgba(0,0,0,0.35);opacity:0;transition:opacity .25s ease, transform .25s ease;pointer-events:none;font-family:"Pretendard",sans-serif;max-width:calc(100vw - 32px);text-align:center;';
            document.body.appendChild(toast);
            requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(-50%) translateY(0)'; });
            const remove = () => {
                if (!toast.parentNode) return;
                toast.style.opacity = '0';
                toast.style.transform = 'translateX(-50%) translateY(-6px)';
                setTimeout(() => toast.remove(), 250);
            };
            setTimeout(remove, 4000);
            document.addEventListener('click', remove, { once: true, capture: true });
        }

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                if (!isPiPEnabled()) return; // 설정에서 PiP를 껐다면 사이트를 벗어나도 아무 것도 띄우지 않는다.
                // 사이트를 벗어남(다른 탭 활성화 / 다른 앱으로 전환 / 최소화 등) -> PiP 모드로.
                state.mode = 'pip';
                const { showFocus, showMix } = render();
                // pipWindow가 아직 없을 때만 여기서 최초 생성을 "시도"한다.
                // 이 시점은 사용자 제스처가 아니라서 브라우저가 거부할 수 있다 (Document PiP 정책).
                // 대신 Focus 시작/정지, MixTape 재생, switchTab 같은 실제 클릭 지점에서는 항상 정상적으로 열린다.
                if (!pipWindow && (showFocus || showMix)) openPiPIfPossible(showFocus, showMix);
            } else {
                // 사이트로 돌아옴 -> PiP를 완전히 닫는다 (편법으로 숨기지 않는다).
                const wasPip = !!pipWindow;
                state.mode = 'inline';
                if (pipWindow) destroyPiPWindow();
                render();
                // Focus/MixTape가 여전히 켜져 있는데 방금 전까지 외부 PiP였다면, 다음 번에 제스처 없이
                // 나가면 못 열릴 수 있으니 한 번 눌러달라고 알려준다.
                if (wasPip && isPiPEnabled() && (state.focusActive || state.mixTapeActive)) {
                    showPipReminderToast();
                }
            }
        });

        function bindControls(){
            const stop = (e) => e.stopPropagation();

            // ---- inline 위젯 컨트롤 ----
            const inFocusToggle = document.getElementById('gmw-inline-focus-toggle-btn');
            const inFocusStop = document.getElementById('gmw-inline-focus-stop-btn');
            const inFocusPopout = document.getElementById('gmw-inline-focus-popout-btn');
            const inFocusClose = document.getElementById('gmw-inline-focus-close-btn');
            if (inFocusToggle) inFocusToggle.addEventListener('click', (e) => {
                stop(e);
                if (!window.PlannerApp) return;
                const d = window.PlannerApp.getFocusWidgetData && window.PlannerApp.getFocusWidgetData();
                if (d && d.isRunning) window.PlannerApp.pauseTimer();
                else window.PlannerApp.resumeTimer();
            });
            if (inFocusStop) inFocusStop.addEventListener('click', (e) => { stop(e); if (window.PlannerApp) window.PlannerApp.stopTimer(); });
            if (inFocusPopout) inFocusPopout.addEventListener('click', (e) => { stop(e); popOut(); });
            if (inFocusClose) inFocusClose.addEventListener('click', (e) => { stop(e); focusInlineDismissed = true; render(); });
            if (inlineFocusCard) inlineFocusCard.addEventListener('click', () => window.switchTab('planner'));

            const inMixPrev = document.getElementById('gmw-inline-mix-prev-btn');
            const inMixPlay = document.getElementById('gmw-inline-mix-play-btn');
            const inMixNext = document.getElementById('gmw-inline-mix-next-btn');
            const inMixPopout = document.getElementById('gmw-inline-mix-popout-btn');
            const inMixClose = document.getElementById('gmw-inline-mix-close-btn');
            if (inMixPrev) inMixPrev.addEventListener('click', (e) => { stop(e); if (window.MixTapeApp) window.MixTapeApp.prevTrack(); });
            if (inMixPlay) inMixPlay.addEventListener('click', (e) => { stop(e); if (window.MixTapeApp) window.MixTapeApp.togglePlay(); });
            if (inMixNext) inMixNext.addEventListener('click', (e) => { stop(e); if (window.MixTapeApp) window.MixTapeApp.nextTrack(); });
            if (inMixPopout) inMixPopout.addEventListener('click', (e) => { stop(e); popOut(); });
            if (inMixClose) inMixClose.addEventListener('click', (e) => { stop(e); mixInlineDismissed = true; render(); });
            // 인라인 미니 위젯을 누르면 지금 재생 중인 바로 그 플레이리스트의 실제 재생 화면으로
            // 바로 이동한다 (홈의 "현재 재생" 위젯과 동일한 동작 - goToNowPlayingPlaylist 참고).
            if (inlineMixCard) inlineMixCard.addEventListener('click', () => {
                if (window.goToNowPlayingPlaylist) window.goToNowPlayingPlaylist();
                else window.switchTab('mixtape');
            });

            // ---- PiP 컨트롤 ----
            const pipFocusToggle = pip$('gmw-pip-focus-toggle-btn');
            const pipFocusStop = pip$('gmw-pip-focus-stop-btn');
            if (pipFocusToggle) pipFocusToggle.addEventListener('click', (e) => {
                stop(e);
                if (!window.PlannerApp) return;
                const d = window.PlannerApp.getFocusWidgetData && window.PlannerApp.getFocusWidgetData();
                if (d && d.isRunning) window.PlannerApp.pauseTimer();
                else window.PlannerApp.resumeTimer();
            });
            if (pipFocusStop) pipFocusStop.addEventListener('click', (e) => { stop(e); if (window.PlannerApp) window.PlannerApp.stopTimer(); });

            const pipMixPrev = pip$('gmw-pip-mix-prev-btn');
            const pipMixPlay = pip$('gmw-pip-mix-play-btn');
            const pipMixNext = pip$('gmw-pip-mix-next-btn');
            const pipMixShuffle = pip$('gmw-pip-mix-shuffle-btn');
            const pipMixRepeat = pip$('gmw-pip-mix-repeat-btn');
            if (pipMixPrev) pipMixPrev.addEventListener('click', (e) => { stop(e); if (window.MixTapeApp) window.MixTapeApp.prevTrack(); });
            if (pipMixPlay) pipMixPlay.addEventListener('click', (e) => { stop(e); if (window.MixTapeApp) window.MixTapeApp.togglePlay(); });
            if (pipMixNext) pipMixNext.addEventListener('click', (e) => { stop(e); if (window.MixTapeApp) window.MixTapeApp.nextTrack(); });
            if (pipMixShuffle) pipMixShuffle.addEventListener('click', (e) => { stop(e); if (window.MixTapeApp) window.MixTapeApp.toggleShuffle(); });
            if (pipMixRepeat) pipMixRepeat.addEventListener('click', (e) => { stop(e); if (window.MixTapeApp) window.MixTapeApp.cycleRepeat(); });
            // PiP의 MixTape 줄 자체를 누르면 인라인 미니 위젯과 똑같이 지금 재생 중인 곳으로 이동한다
            // (버튼들은 위에서 이미 stop(e)로 전파를 막아뒀으니 이 핸들러까지 올라오지 않는다).
            if (pipMixRow) pipMixRow.addEventListener('click', () => {
                if (window.goToNowPlayingPlaylist) window.goToNowPlayingPlaylist();
                else window.switchTab('mixtape');
            });

            document.body.classList.toggle('gmw-pip-disabled', !isPiPEnabled());
            render();
            setInterval(refresh, 1000);
        }

        window.GlobalMiniController = {
            state,
            refresh,
            handleGesture,
            handlePageChange,
            popOut,
            open: () => { const { showFocus, showMix } = render(); openPiPIfPossible(showFocus, showMix); },
            close: destroyPiPWindow,
            isPiPEnabled,
            setPiPEnabled,
            isInlineEnabled,
            setInlineEnabled
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', bindControls);
        } else {
            bindControls();
        }
    })();
    