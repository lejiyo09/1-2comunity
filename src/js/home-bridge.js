
    // ===== 일일 플래너 / 믹스테이프 홈 대시보드 위젯 연동 =====
    (function(){
        const _originalSwitchTab = window.switchTab;
        window.switchTab = function(tabId){
            _originalSwitchTab(tabId);
            if (tabId === 'home') updateHomePlannerMixtapeWidgets();
            if (tabId === 'exam' && window.resizeExamNoteTextareas) window.resizeExamNoteTextareas();
            if (window.GlobalMiniController) window.GlobalMiniController.handlePageChange(tabId);
        };

        function formatMinSec(totalSec){
            const h = Math.floor(totalSec / 3600);
            const m = Math.floor((totalSec % 3600) / 60);
            if (h > 0) return `${h}시간 ${m}분`;
            return `${m}분`;
        }

        function updateHomePlannerMixtapeWidgets(){
            try {
                if (window.PlannerApp && typeof window.PlannerApp.getHomeSummary === 'function') {
                    const s = window.PlannerApp.getHomeSummary();
                    const timeEl = document.getElementById('home-planner-time');
                    const targetEl = document.getElementById('home-planner-target');
                    const barEl = document.getElementById('home-planner-bar');
                    const tasksEl = document.getElementById('home-planner-tasks');
                    if (timeEl) timeEl.innerText = s.totalSec > 0 ? `현재 공부시간: ${formatMinSec(s.totalSec)}` : '아직 공부 기록이 없어요';
                    if (targetEl) targetEl.innerText = s.targetSec > 0 ? `오늘 목표: ${formatMinSec(s.targetSec)} (달성률 ${s.achPct}%)` : '오늘 목표를 설정해보세요';
                    if (barEl) barEl.style.width = Math.min(s.achPct, 100) + '%';
                    if (tasksEl) tasksEl.innerText = `${s.done} / ${s.total}`;
                }
            } catch(e) { /* 플래너 탭을 아직 방문하지 않은 경우 등, 조용히 무시 */ }

            try {
                if (window.MixTapeApp && typeof window.MixTapeApp.getNowPlaying === 'function') {
                    const np = window.MixTapeApp.getNowPlaying();
                    const trackEl = document.getElementById('home-mixtape-track');
                    const statusEl = document.getElementById('home-mixtape-status');
                    if (trackEl) trackEl.innerText = np.name || '재생 중인 곡 없음';
                    if (statusEl) statusEl.innerText = np.name ? (np.playing ? '▶ 음악 재생 중' : '⏸ 일시정지됨') : '대기 중';
                }
            } catch(e) { /* 무시 */ }
        }

        // 홈 탭이 활성화되어 있는 동안 주기적으로 갱신 (공부 타이머/재생 상태 실시간 반영)
        setInterval(() => {
            const homeTab = document.getElementById('tab-home');
            if (homeTab && homeTab.classList.contains('active')) updateHomePlannerMixtapeWidgets();
        }, 3000);

        // 최초 로드시 홈 화면이 기본 탭이므로 한 번 갱신
        updateHomePlannerMixtapeWidgets();
    })();
    