

(function(){
'use strict';

    const defaultSubjects = [
      { id: 'sub_1', name: '수학', color: '#6366f1' }, { id: 'sub_2', name: '국어', color: '#10b981' },
      { id: 'sub_3', name: '영어', color: '#f59e0b' }, { id: 'sub_4', name: '탐구/기타', color: '#ec4899' }
    ];
    function safeJSONParse(key, fallback) { try { const item = localStorage.getItem(key); return item && item !== "undefined" && item !== "null" ? JSON.parse(item) : JSON.parse(JSON.stringify(fallback)); } catch (e) { return JSON.parse(JSON.stringify(fallback)); } }

    // 이 플래너는 <script type="module"> 블록(hexToRgba/escapeNoticeText가 있는 곳)과는 완전히
    // 분리된 별도 스코프(이 IIFE)라서, 그 안의 함수를 이름만으로는 절대 호출할 수 없다(모듈은
    // 독립된 스코프라 전역에 안 보임 - 호출하면 ReferenceError로 렌더링 전체가 멈춰버린다).
    // 그래서 이 플래너 스코프 안에 똑같은 아주 작은 버전을 따로 둔다.
    function plannerHexToRgba(hex, alpha) {
      const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
      if (!m) return null;
      const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
    function plannerEscapeText(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // xp는 로그인/Firebase 동기화 전까지 잠깐 보여줄 값일 뿐이며, 로그인 후에는 곧바로
    // setXPFromCloud()로 Firebase(users/{uid}/xp) 값으로 교체된다. 이 localStorage 값은
    // (신규 XP 시스템 도입 이전부터 남아있었다면) 최초 1회 마이그레이션 소스로도 쓰인다.
    let state = {
      subjects: safeJSONParse('planner_subjects', defaultSubjects), dDay: safeJSONParse('planner_dday', { title: '', date: '' }),
      records: safeJSONParse('planner_records', {}), xp: safeJSONParse('planner_xp', 0), allClearDates: safeJSONParse('planner_all_clear', {}),
      adminPassword: safeJSONParse('planner_admin_pw', '1234')
    };

    let todayStr = getLocalDateStr(new Date()); let currentDateStr = todayStr;
    let timerState = { interval: null, isRunning: false, taskId: null, subjectId: null, dateStr: null, lastTickTime: null, lastRenderedTimeKey: null };
    let calYear = new Date().getFullYear(), calMonth = new Date().getMonth(), tempStartTaskId = null;
    let isGridEditMode = false; let isTimeMachineUnlocked = false;
    // 타임테이블 임시 마킹(반투명 하이라이트): 실제 공부 기록과는 완전히 별개로, 드래그해서
    // "이 시간에 뭘 할지" 같은 걸 표시만 해두는 기능이다. planner_records(state)에는 안 남기고
    // 날짜별로 따로 저장한다 - 실수로 실제 학습 데이터와 섞이면 안 되기 때문.
    let isMarkMode = false;
    // 타임테이블 칸에 마우스를 올렸을 때 "같은 활동으로 채워진 칸 전체"를 강조하기 위한 상태.
    // (renderTimetable()이 칸을 통째로 다시 만들어도 강조가 이어지도록 DOM이 아니라 여기에 기억해둔다)
    let activeHighlightKey = null;   // 지금 강조 중인 활동 키(없으면 null)
    let activeHighlightDate = null;  // 그 활동이 속한 날짜 - 다른 날짜로 넘어가면 무효로 본다
    let markDragActive = false;
    let markDragAdding = true; // 드래그를 시작한 첫 칸이 "칠하기"였는지 "지우기"였는지를 드래그 내내 유지한다
    let markSubjectId = null; // 표시 모드에서 지금 선택된 과목 - 이 과목 색으로 칠한다
    // 날짜별 { timeKey: subId } - 어떤 칸을 어떤 과목 색으로 표시해뒀는지. (예전 버전은 과목 구분 없이
    // timeKey 배열만 저장했었다 - 아래 함수들이 그 예전 형태도 그대로 읽을 수 있게 호환 처리한다.)
    let plannerMarks = safeJSONParse('planner_marks', {});
    function savePlannerMarks() { try { localStorage.setItem('planner_marks', JSON.stringify(plannerMarks)); } catch (e) {} }
    function getCellMarkSubject(dateStr, timeKey) {
      const rec = plannerMarks[dateStr];
      if (!rec) return null;
      if (Array.isArray(rec)) return rec.includes(timeKey) ? (state.subjects[0] && state.subjects[0].id) : null; // 구버전 호환
      return rec[timeKey] || null;
    }
    function setCellMark(dateStr, timeKey, subId) {
      if (!plannerMarks[dateStr] || Array.isArray(plannerMarks[dateStr])) plannerMarks[dateStr] = {};
      if (subId) plannerMarks[dateStr][timeKey] = subId;
      else delete plannerMarks[dateStr][timeKey];
    }

    let editTaskId = null; 
    const UI = {}; let saveTickCounter = 0;

    function sanitizeState() {
      if (!state) state = {}; if (!Array.isArray(state.subjects) || state.subjects.length === 0) state.subjects = JSON.parse(JSON.stringify(defaultSubjects));
      if (!state.dDay || typeof state.dDay !== 'object') state.dDay = { title: '', date: '' }; if (!state.records || typeof state.records !== 'object') state.records = {};
      if (typeof state.xp !== 'number') state.xp = 0; if (!state.allClearDates || typeof state.allClearDates !== 'object') state.allClearDates = {};
      if (typeof state.adminPassword !== 'string' || !state.adminPassword) state.adminPassword = '1234';
      saveData();
    }

    function initDOMCache() {
      UI.totalTime = document.getElementById('total-time-display'); UI.targetTime = document.getElementById('target-time-display');
      UI.totalAchieve = document.getElementById('total-achievement'); UI.totalBar = document.getElementById('total-progress-bar');
      UI.zenTime = document.getElementById('zen-time-display'); UI.zenTaskBar = document.getElementById('zen-task-progress-bar');
      UI.clock = document.getElementById('real-time-clock'); UI.viewStatus = document.getElementById('viewing-status');
      UI.btnToday = document.getElementById('btn-today'); UI.currentDate = document.getElementById('current-date'); UI.btnNextDate = document.getElementById('btn-next-date');
      UI.zenView = document.getElementById('zen-view'); UI.normalView = document.getElementById('normal-view-container');
    }

    function init() {
      sanitizeState(); ensureDailyRecord(currentDateStr); initDOMCache();
      renderSubjects(); updateDdayDisplay(); updateTierBadge();
      
      document.getElementById('form-setup-add-task').onsubmit = (e) => { e.preventDefault(); addTask('setup'); };
      document.getElementById('form-main-add-task').onsubmit = (e) => { e.preventDefault(); addTask('main'); };
      document.getElementById('form-add-subject').onsubmit = handleAddSubject; document.getElementById('form-dday').onsubmit = handleDdaySubmit;
      document.getElementById('form-change-password').onsubmit = handleChangePassword;
      
      setInterval(updateClock, 1000); updateClock();
      let lastMainDate = null;
      try { lastMainDate = localStorage.getItem('planner_last_main_date'); } catch (e) {}
      if (lastMainDate === todayStr) switchView('view-main'); else switchView('view-start');
      notifyMiniWidgetFocus();
    }

    function updateClock() { if (UI.clock) UI.clock.innerText = new Date().toLocaleTimeString('en-US', { hour12: false }); }

    function updateViewingStatusUI() {
      if (!UI.viewStatus) return;
      if (currentDateStr === todayStr) { UI.viewStatus.classList.add('hidden'); return; }
      UI.viewStatus.classList.remove('hidden');
      if (isTimeMachineUnlocked) {
        UI.viewStatus.innerHTML = "과거 기록 수정 중 🔓"; UI.viewStatus.className = "text-[9px] text-red-400 font-semibold bg-red-500/10 px-1.5 py-0.5 rounded border border-red-500/30 cursor-pointer transition-all duration-300 select-none";
      } else {
        UI.viewStatus.innerHTML = "과거 기록 열람중"; UI.viewStatus.className = "text-[9px] text-amber-400 font-semibold bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/30 cursor-pointer transition-all duration-300 select-none";
      }
    }

    function toggleTimeMachine() {
      if (currentDateStr === todayStr) return; 
      if (isTimeMachineUnlocked) { 
        isTimeMachineUnlocked = false; 
        uiAlert("타임머신 모드가 종료되었습니다.", {icon:'🔒', title:'타임머신 종료'});
        updateViewingStatusUI(); updateDashboard(); renderTimetable(); renderTasks();
      } else {
        uiPrompt("과거 기록을 수정하시겠습니까?\n관리자 비밀번호를 입력하세요.", (val) => {
          if (val === state.adminPassword) { 
            isTimeMachineUnlocked = true; 
            uiAlert("타임머신 모드 가동: 과거 기록 수정 및 할일 추가 권한이 해제되었습니다.", {icon:'🔓', title:'타임머신 가동'});
            updateViewingStatusUI(); updateDashboard(); renderTimetable(); renderTasks();
          } else { 
            uiAlert("비밀번호가 틀렸습니다.", {icon:'⚠️', title:'인증 실패'});
          }
        }, {icon:'🔒', title:'관리자 인증', isPassword:true, placeholder:'비밀번호 입력'});
      }
    }

    function switchView(viewId) {
      document.getElementById('view-start').classList.add('hidden'); document.getElementById('view-setup').classList.add('hidden'); document.getElementById('view-main').classList.add('hidden'); document.getElementById(viewId).classList.remove('hidden');
      if (viewId === 'view-setup') renderSetupView();
      if (viewId === 'view-main') {
        isGridEditMode = false; updateHeaderDate(); renderTasks(); renderTimetable(); updateDashboard(); updateTierBadge();
        if (currentDateStr === todayStr) { try { localStorage.setItem('planner_last_main_date', todayStr); } catch (e) {} }
      }
    }

    function ensureDailyRecord(dateStr) {
      if (!state.records) state.records = {};
      if (!state.records[dateStr] || !state.records[dateStr].tasks || !state.records[dateStr].grid) {
        let carriedTasks = []; const pastDates = Object.keys(state.records).sort().filter(d => d < dateStr);
        if (pastDates.length > 0) { const lastDate = pastDates[pastDates.length - 1]; const lastTasks = state.records[lastDate].tasks || [];
          lastTasks.forEach(t => { if (t.isRoutine || !t.completed) carriedTasks.push({ ...t, id: 't_'+Date.now()+'_'+Math.random().toString(36).substr(2,4), completed: false, elapsedSec: 0 }); });
        }
        state.records[dateStr] = { tasks: carriedTasks, grid: {}, diary: '', mood: '' }; saveData();
      }
    }

    // XP는 더 이상 localStorage가 아니라 Firebase(users/{uid}/xp)가 단일 원본(source of truth)이다.
    // UI는 즉시(낙관적으로) 갱신하고, 실제 저장은 Firebase 트랜잭션으로 처리한다.
    // 만약 Firebase 저장이 실패하면(오프라인 등) 낙관적으로 반영했던 UI를 되돌리고 사용자에게 알린다.
    function addXP(amount) {
      const prevXP = state.xp;
      state.xp = Math.max(0, state.xp + amount);
      updateTierBadge();
      if (window.onXPChanged) window.onXPChanged(state.xp);
      if (window.__fbApplyXPDelta) {
        window.__fbApplyXPDelta(amount).catch(() => {
          state.xp = prevXP;
          updateTierBadge();
          if (window.onXPChanged) window.onXPChanged(state.xp);
          uiAlert('XP가 서버에 저장되지 못했습니다. 인터넷 연결을 확인해주세요.', {icon:'⚠️', title:'저장 실패'});
        });
      }
    }
    function getXP() { return state.xp; }
    // 로그인한 계정의 실제 XP를 Firebase(users/{uid}/xp)에서 읽어와 반영한다.
    // 이 브라우저에 남아있던 값(다른 계정으로 로그인했을 때 생긴 값일 수 있음)을 그대로 쓰지 않고,
    // 클라우드 값으로 덮어써서 "1렙 계정으로 들어갔더니 3렙으로 보임" 같은 계정 간 XP 뒤섞임 문제를 막는다.
    // 클라우드에 값이 아예 없는 신규 계정은 0으로 시작한다(1회 마이그레이션 로직은 상단 module 스크립트 참고).
    function setXPFromCloud(xp) {
      const safeXp = (typeof xp === 'number' && !isNaN(xp)) ? Math.max(0, xp) : 0;
      if (state.xp === safeXp) { updateTierBadge(); return; }
      state.xp = safeXp;
      updateTierBadge();
      if (window.onXPChanged) window.onXPChanged(state.xp);
    }
    // 버그 수정: 로그아웃 시 "다음 로그인 계정에 이전 계정 XP가 새지 않도록" 화면 표시만 0으로 되돌리려는
    // 용도였는데, 기존에는 setXPFromCloud(0)을 그대로 호출하고 있었다. setXPFromCloud()는 값이 바뀌면
    // window.onXPChanged()를 호출하고, onXPChanged()는 그 값을 Firestore(profiles/student_{num}.xp)에
    // 그대로 저장한다 - 즉 로그아웃할 때마다 "방금 로그아웃한 계정"의 실제 XP가 Firebase에 0으로 덮어써지고
    // 있었다(원본 users/{uid}/xp 자체는 아니지만, 다른 화면에서 이 미러 값을 레벨/cosmetic 계산에 사용하고 있어
    // 재로그인 후에도 XP가 0인 것처럼 보이는 원인이 됐다).
    // 로그아웃은 인증 상태만 종료해야 하므로, Firebase에는 아무것도 쓰지 않고 이 브라우저의 화면 표시값만 되돌린다.
    function resetLocalXPDisplay() {
      state.xp = 0;
      updateTierBadge();
    }
    // 레벨별 명칭 (요청하신 구간 그대로). 레벨 자체는 XP 누적에 따라 1~30+까지 계속 올라가고,
    // 이 표는 "그 레벨이 어떤 구간에 속하는지"만 결정한다 (기능/권한과는 무관한 순수 명칭).
    const LEVEL_TITLE_RANGES = [
      { min: 1,  max: 2,        title: "새내기" },
      { min: 3,  max: 4,        title: "신입 구성원" },
      { min: 5,  max: 6,        title: "적응생" },
      { min: 7,  max: 9,        title: "적극 참여자" },
      { min: 10, max: 12,       title: "성실 구성원" },
      { min: 13, max: 15,       title: "모범 구성원" },
      { min: 16, max: 19,       title: "우수 구성원" },
      { min: 20, max: 24,       title: "핵심 구성원" },
      { min: 25, max: 29,       title: "대표 구성원" },
      { min: 30, max: Infinity, title: "명예 구성원" }
    ];
    function getTitleForLevel(level) {
      const band = LEVEL_TITLE_RANGES.find(b => level >= b.min && level <= b.max);
      return band ? band.title : "새내기";
    }
    // 레벨 N에 도달하는 데 필요한 누적 XP (삼각수 곡선: 100, 300, 600, 1000, 1500 ...).
    // 레벨이 올라갈수록 다음 레벨까지 필요한 XP가 점점 더 늘어난다.
    function xpThresholdForLevel(level) {
      if (level <= 1) return 0;
      return Math.round(100 * (level - 1) * level / 2);
    }
    function getLevelFromXP(xp) {
      let level = 1;
      while (xpThresholdForLevel(level + 1) <= xp) level++;
      return level;
    }
    function getTierInfo(xp) {
      const level = getLevelFromXP(xp);
      const title = getTitleForLevel(level);
      return {
        name: `Lv.${level} ${title}`,
        nextXP: xpThresholdForLevel(level + 1),
        currentLevelBase: xpThresholdForLevel(level)
      };
    }
    function updateTierBadge() {
      const tier = getTierInfo(state.xp);
      const elName = document.getElementById('tier-name'); const elContainer = document.getElementById('tier-badge-container');
      if (!elName) return; elName.innerText = tier.name;
      if (elContainer) elContainer.className = `flex items-center gap-1.5 px-2.5 py-1 rounded-full border cursor-pointer transition shadow-sm ml-1 text-indigo-300 border-indigo-500/40 bg-indigo-500/10`;
    }
    function openXpModal() {
      if (window.openGrowthModal) window.openGrowthModal();
    }

    function renderSetupView() {
      const dateObj = new Date(todayStr); const days = ['일','월','화','수','목','금','토']; document.getElementById('setup-today-date').innerText = `${todayStr.replace(/-/g, '.')} (${days[dateObj.getDay()]})`;
      const pastDates = Object.keys(state.records).sort().filter(d => d < todayStr); let yesterdayHTML = '';
      if (pastDates.length > 0) {
        const lastRec = state.records[pastDates[pastDates.length - 1]]; const targetSec = lastRec.tasks.reduce((sum, t) => sum + ((t.targetMin || 0) * 60), 0); const totalSec = Object.values(lastRec.grid || {}).reduce((sum, c) => sum + (c.seconds || 0), 0);
        const pct = targetSec > 0 ? Math.floor((totalSec / targetSec) * 100) : (totalSec>0 ? 100 : 0); const stamp = pct >= 100 ? '🔥 완벽했어요!' : pct >= 80 ? '🟢 훌륭합니다!' : pct >= 50 ? '🟡 잘했어요!' : '🔴 오늘은 더 화이팅!';
        yesterdayHTML = `<div class="text-xs text-slate-400 mb-1">${pastDates[pastDates.length - 1]}</div><div class="text-3xl font-black text-white mb-2 font-mono">${formatTime(totalSec, true)}</div><div class="text-emerald-400 font-bold mb-4">목표 달성률 ${pct}%</div><div class="bg-slate-700/50 px-4 py-2 rounded-full text-sm font-bold text-slate-200">${stamp}</div>`;
      } else { yesterdayHTML = `<div class="text-slate-400 text-sm mb-2"><span class="text-3xl mb-3 text-emerald-400 block">🌱</span>기록된 이전 데이터가 없습니다.</div><div class="text-slate-200 font-bold">오늘부터 멋진 기록을 만들어보세요!</div>`; }
      document.getElementById('setup-yesterday-card').innerHTML = yesterdayHTML; renderSetupTaskList();
    }
    
    function renderSetupTaskList() {
      const tasks = state.records[todayStr].tasks || []; const listEl = document.getElementById('setup-task-list');
      if (tasks.length === 0) { listEl.innerHTML = '<div class="text-center text-slate-500 text-xs py-4">등록된 할 일이 없습니다.<br>위에서 추가해주세요.</div>'; return; }
      listEl.innerHTML = tasks.map(task => { const sub = getSubject(task.subjectId); return `<div class="flex justify-between items-center bg-slate-900/60 p-2.5 rounded border border-slate-700/70 group"><div class="flex items-center gap-2"><span class="px-1.5 py-0.5 rounded text-[8px] font-bold text-white" style="background-color: ${sub.color}">${sub.name}</span><span class="text-xs font-bold text-slate-200">${task.title}</span><span class="text-[9px] text-slate-400 font-mono">${task.targetMin}m</span></div><button onclick="PlannerApp.deleteTask('${task.id}', true)" class="text-slate-500 hover:text-red-400 text-xs px-2"><span>🗑️</span></button></div>`; }).join('');
    }

    function getSubject(id) { if (!state.subjects || state.subjects.length === 0) sanitizeState(); return state.subjects.find(s => s && s.id === id) || state.subjects[0] || defaultSubjects[0]; }
    function renderSubjects() {
      const ops = state.subjects.map(sub => sub && sub.name && sub.id ? `<option value="${sub.id}">${sub.name}</option>` : '').join('');
      ['setup-task-subject', 'main-task-subject', 'manual-subject-select', 'mark-subject-select'].forEach(id => { const el = document.getElementById(id); if(el) el.innerHTML = ops; });
      document.getElementById('settings-subject-list').innerHTML = state.subjects.map(sub => sub ? `<div class="flex justify-between items-center bg-slate-900 p-2 rounded border border-slate-700"><div class="flex items-center gap-2"><div class="w-3 h-3 rounded-full" style="background-color: ${sub.color}"></div><span class="text-xs font-bold text-slate-200">${sub.name}</span></div><button onclick="PlannerApp.deleteSubject('${sub.id}')" class="text-slate-500 hover:text-red-400 text-[10px]"><span>🗑️</span></button></div>` : '').join('');
    }

    let dragTaskIdx = null;
    function taskDragStart(e, idx) { dragTaskIdx = idx; e.dataTransfer.effectAllowed = 'move'; setTimeout(() => e.target.classList.add('opacity-40', 'border-dashed'), 10); }
    function taskDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
    function taskDrop(e, targetIdx) { e.preventDefault(); if (dragTaskIdx === null || dragTaskIdx === targetIdx) return; const tasks = state.records[currentDateStr].tasks; const [movedTask] = tasks.splice(dragTaskIdx, 1); tasks.splice(targetIdx, 0, movedTask); saveData(); renderTasks(); updateDashboard(); }
    function taskDragEnd(e) { e.target.classList.remove('opacity-40', 'border-dashed'); dragTaskIdx = null; }

    let taskClickTimer = null;
    function handleTaskClick(id) {
        if (taskClickTimer) { clearTimeout(taskClickTimer); taskClickTimer = null; openEditTaskModal(id); } 
        else { taskClickTimer = setTimeout(() => { taskClickTimer = null; openConfirmStart(id); }, 250); }
    }

    function renderTasks() {
      let tasks = [...(state.records[currentDateStr].tasks || [])]; let totalTarget = 0;
      if (timerState.taskId) { const idx = tasks.findIndex(t => t.id === timerState.taskId); if (idx > 0) tasks.unshift(tasks.splice(idx, 1)[0]); }

      document.getElementById('main-task-list').innerHTML = tasks.map((task, idx) => {
        const sub = getSubject(task.subjectId); totalTarget += (task.targetMin || 0);
        const isRun = timerState.isRunning && timerState.taskId === task.id; const isPause = !timerState.isRunning && timerState.taskId === task.id;
        let hiCls = 'border-slate-700/70 bg-slate-900/60'; let bHTML = '';
        if (isRun) { hiCls = 'border-indigo-500 bg-indigo-950/40 shadow-[0_0_12px_rgba(99,102,241,0.35)]'; bHTML = `<span class="text-[8px] bg-indigo-500 text-white font-black px-1.5 py-0.5 rounded animate-pulse">▶ 집중 중</span>`; } 
        else if (isPause) { hiCls = 'border-amber-500/70 bg-amber-950/30'; bHTML = `<span class="text-[8px] bg-amber-500/20 text-amber-300 font-bold px-1.5 py-0.5 rounded border border-amber-500/30">|| 일시정지</span>`; }
        
        const elapsedHTML = `<div id="task-elapsed-${task.id}" class="text-[9px] font-mono text-indigo-300 mt-0.5">${task.elapsedSec > 0 ? `누적: ${formatTime(task.elapsedSec)}` : ''}</div>`;
        return `<div draggable="true" ondragstart="taskDragStart(event, ${idx})" ondragover="taskDragOver(event)" ondrop="taskDrop(event, ${idx})" ondragend="taskDragEnd(event)" class="flex items-center gap-1.5 p-2 rounded-lg border ${hiCls} hover:border-slate-500 transition group min-w-0 cursor-grab active:cursor-grabbing">
            <input type="checkbox" class="task-check" ${task.completed ? 'checked' : ''} onchange="PlannerApp.toggleTaskComplete('${task.id}', this.checked)">
            <div class="flex-1 min-w-0 cursor-pointer ${task.completed ? 'opacity-40 line-through' : ''}" onclick="PlannerApp.handleTaskClick('${task.id}')" title="한 번 클릭: 공부 시작 / 더블클릭: 할일 수정">
                <div class="flex items-center gap-1 mb-0.5 flex-wrap">
                    <span class="px-1.5 py-0.5 rounded text-[8px] font-bold text-white whitespace-nowrap" style="background-color: ${sub.color}">${sub.name}</span>
                    ${bHTML}${task.isRoutine ? '<span class="text-[7px] text-indigo-300 bg-indigo-500/20 px-1 rounded font-semibold whitespace-nowrap">루틴</span>' : ''}
                    <span class="text-[8px] text-slate-400 font-mono whitespace-nowrap"><span class="mr-0.5">🕐</span>${task.targetMin}m</span>
                </div>
                <div class="text-[11px] font-bold text-slate-200 leading-tight truncate select-none">${task.title}</div>
                ${elapsedHTML}
            </div>
            <button onclick="PlannerApp.deleteTask('${task.id}')" class="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 transition p-1 text-[10px] flex-none"><span>✕</span></button>
        </div>`;
      }).join('');
      document.getElementById('task-total-min').innerText = totalTarget;
    }

    // ✨ V49 핵심: 세그먼트 배열을 바탕으로 빈틈없이 정확한 그라데이션을 뽑아주는 엔진
    function getCellGradient(cellData) {
        if (!cellData || cellData.seconds === 0) return 'transparent';
        
        // 95% 이상 공부했으면 빈틈없이 꽉 채운 솔리드 컬러로 덮어버림
        let rawFillPct = (cellData.seconds / 600) * 100;
        if (rawFillPct >= 95) {
            return getSubject(cellMainSubId(cellData)).color;
        } 
        
        let gradParts = [];
        if (cellData.segments && cellData.segments.length > 0) {
            let currentPct = 0;
            // 멈췄다 켰던 시간 조각(Segment)들을 정확히 그 위치에 하나씩 그림
            cellData.segments.forEach(seg => {
                let startPct = (seg.startOffset / 600) * 100;
                let widthPct = (seg.seconds / 600) * 100;
                let subColor = getSubject(seg.subId).color;
                
                if (startPct > currentPct) {
                    gradParts.push(`transparent ${currentPct}% ${startPct}%`); // 쉰 시간(공백)은 투명하게!
                }
                gradParts.push(`${subColor} ${startPct}% ${startPct + widthPct}%`);
                currentPct = startPct + widthPct;
            });
            if (currentPct < 100) gradParts.push(`transparent ${currentPct}% 100%`);
        } else {
            // 호환성: 예전 방식의 데이터일 경우 왼쪽부터 채움
            let startPct = cellData.startOffset !== undefined ? (cellData.startOffset / 600) * 100 : 0;
            let fillPct = Math.min(100, rawFillPct);
            if (startPct + fillPct > 100) fillPct = 100 - startPct;
            
            if (startPct > 0) gradParts.push(`transparent 0% ${startPct}%`);
            let currentPct = startPct;
            for (let subId in cellData.parts) {
                let subColor = getSubject(subId).color;
                let pct = (cellData.parts[subId] / 600) * 100;
                gradParts.push(`${subColor} ${currentPct}% ${currentPct + pct}%`);
                currentPct += pct;
            }
            if (currentPct < 100) gradParts.push(`transparent ${currentPct}% 100%`);
        }
        return `linear-gradient(to right, ${gradParts.join(', ')})`;
    }

    // 타임테이블 칸 위에서 마우스를 움직이면, 그 x좌표가 가리키는 정확한 세그먼트(조각)를 찾아
    // "할일 이름 · 과목" 플로팅 툴팁으로 보여준다. 할일이 나중에 삭제됐으면 그 사실도 알려준다.
    // 커서가 가리키는 세그먼트를 돌려준다(없으면 null) - 호출한 쪽이 같은 활동 강조에도 쓴다.
    function showSegmentTooltip(e, box, segments) {
      const rect = box.getBoundingClientRect();
      if (rect.width === 0) { hideSegmentTooltip(); return null; }
      const relX = e.clientX - rect.left;
      const offsetSec = Math.max(0, Math.min(599, (relX / rect.width) * 600));
      const seg = segments.find(s => offsetSec >= s.startOffset && offsetSec < s.startOffset + s.seconds);
      if (!seg) { hideSegmentTooltip(); return null; }
      const task = seg.taskId ? (state.records[currentDateStr].tasks || []).find(t => t.id === seg.taskId) : null;
      const taskLabel = task ? task.title : (seg.taskId ? '삭제된 할 일' : '알 수 없음');
      const sub = getSubject(seg.subId);
      const run = computeActivityRun(seg, box.id.slice(5).replace('-', ':'));
      let tooltipEl = document.getElementById('planner-segment-tooltip');
      if (!tooltipEl) {
        tooltipEl = document.createElement('div');
        tooltipEl.id = 'planner-segment-tooltip';
        tooltipEl.className = 'planner-segment-tooltip';
        document.body.appendChild(tooltipEl);
      }
      tooltipEl.style.setProperty('--tip-color', sub.color);
      tooltipEl.style.setProperty('--tip-glow', plannerHexToRgba(sub.color, 0.45) || 'rgba(99,102,241,0.45)');
      tooltipEl.innerHTML = `<div class="pst-row"><div class="pst-icon">📖</div><div class="pst-body">`
        + `<div class="pst-sub">${plannerEscapeText(sub.name)}</div>`
        + `<div class="pst-title">${plannerEscapeText(taskLabel)}</div></div></div>`
        + (run ? `<div class="pst-meta"><div>🕐 ${formatClockFromOffset(run.startSec)} ~ ${formatClockFromOffset(run.endSec)}</div><div>⏱ ${formatRunDuration(run.totalSec)}</div></div>` : '');
      tooltipEl.style.display = 'block';
      // 화면 오른쪽/아래 끝에서는 잘리지 않도록 커서 반대편으로 뒤집는다.
      let left = e.clientX + 14, top = e.clientY + 16;
      if (left + tooltipEl.offsetWidth > window.innerWidth - 8) left = Math.max(8, e.clientX - 14 - tooltipEl.offsetWidth);
      if (top + tooltipEl.offsetHeight > window.innerHeight - 8) top = Math.max(8, e.clientY - 16 - tooltipEl.offsetHeight);
      tooltipEl.style.left = left + 'px';
      tooltipEl.style.top = top + 'px';
      return seg;
    }
    // 타임테이블은 07:00부터 시작해 다음 날 00시대까지 이어지므로, 07:00를 0초로 하는 "하루 안의 위치(초)"로 바꿔 계산한다.
    function timeKeyToOffsetSec(timeKey) {
      const [h, m] = timeKey.split(':').map(Number);
      return ((h - 7 + 24) % 24) * 3600 + m * 60;
    }
    function formatClockFromOffset(sec) {
      const total = Math.round(sec / 60) * 60;
      return `${String((7 + Math.floor(total / 3600)) % 24).padStart(2, '0')}:${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}`;
    }
    function formatRunDuration(sec) {
      const total = Math.round(sec);
      const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60);
      if (h > 0) return `${h}시간 ${m}분`;
      if (m > 0) return `${m}분`;
      return `${total}초`;
    }
    // 커서가 가리키는 조각이 속한 "이어진 구간"(같은 활동이 쉬지 않고 이어진 막대)의 시작/끝/총 시간을 구한다.
    // 칸 경계를 넘어 이어지는 조각은 같은 구간으로 합치고, 중간에 쉰 시간이 있으면 별개 구간으로 본다.
    function computeActivityRun(seg, timeKey) {
      const recordGrid = (state.records[currentDateStr] && state.records[currentDateStr].grid) || {};
      const key = activityKeyOf(seg);
      const items = [];
      Object.keys(recordGrid).forEach(tk => {
        const segs = recordGrid[tk] && recordGrid[tk].segments;
        if (!segs) return;
        const base = timeKeyToOffsetSec(tk);
        segs.forEach(sg => {
          if (activityKeyOf(sg) === key) items.push({ start: base + sg.startOffset, end: base + sg.startOffset + sg.seconds, ref: sg });
        });
      });
      if (!items.length) return null;
      items.sort((a, b) => a.start - b.start);
      const runs = [];
      items.forEach(it => {
        const last = runs[runs.length - 1];
        if (last && it.start - last.end <= 2) { last.end = Math.max(last.end, it.end); last.total += it.end - it.start; last.items.push(it); }
        else runs.push({ start: it.start, end: it.end, total: it.end - it.start, items: [it] });
      });
      const run = runs.find(r => r.items.some(it => it.ref === seg));
      return run ? { startSec: run.start, endSec: run.end, totalSec: run.total } : null;
    }
    function hideSegmentTooltip() {
      const el = document.getElementById('planner-segment-tooltip');
      if (el) el.style.display = 'none';
    }

    // 세그먼트가 어떤 "활동"인지 나타내는 키 - 할 일(taskId)이 기록된 조각은 그 할 일끼리, 예전 데이터처럼
    // 할 일 정보가 없는 조각은 과목(subId)끼리만 묶는다(접두어로 구분해서 서로 섞이지 않게 한다).
    function activityKeyOf(seg) { return seg.taskId ? 't:' + seg.taskId : 's:' + seg.subId; }
    // 강조 대상이 실제로 바뀔 때만 DOM을 건드린다(mousemove는 초당 수십 번 오기 때문).
    function setActivityHighlight(key) {
      if (key === activeHighlightKey && (key === null || activeHighlightDate === currentDateStr)) return;
      activeHighlightKey = key;
      activeHighlightDate = key ? currentDateStr : null;
      applyActivityHighlight();
    }
    // 칸이 "95% 이상 찼으면 빈틈없이 한 색으로 칠하는" 규칙(getCellGradient)과 똑같이 대표 과목을 고른다.
    function cellMainSubId(cellData) {
      return Object.keys(cellData.parts).reduce((a, b) => cellData.parts[a] > cellData.parts[b] ? a : b, Object.keys(cellData.parts)[0]);
    }
    // [x0,x1] 구간에서 cuts(구간 목록)와 겹치는 부분을 빼고 남는 구간들을 돌려준다.
    function subtractSpans(x0, x1, cuts) {
      let rest = [[x0, x1]];
      cuts.forEach(([c0, c1]) => {
        const next = [];
        rest.forEach(([a, b]) => {
          if (c1 <= a || c0 >= b) { next.push([a, b]); return; }
          if (c0 > a) next.push([a, c0]);
          if (c1 < b) next.push([c1, b]);
        });
        rest = next;
      });
      return rest.filter(([a, b]) => b - a > 0.5);
    }
    // 강조 중인 활동이 실제로 색칠된 영역의 "바깥 테두리"만 SVG 경로로 만든다.
    // 행(시간) 단위로 이어진 칠해진 구간을 구한 뒤, 위/아래 행과 맞닿은 면은 빼고 바깥으로 드러난 변만 긋는다.
    function buildActivityOutline(grid, recordGrid) {
      const gr = grid.getBoundingClientRect();
      const rows = Array.from(grid.children).filter(el => el.querySelector && el.querySelector('.time-box'));
      const rowInfo = rows.map(row => {
        const cells = Array.from(row.querySelectorAll('.time-box'));
        const rr = cells[0].getBoundingClientRect();
        const spans = [];
        cells.forEach(cell => {
          const cd = recordGrid[cell.id.slice(5).replace('-', ':')];
          const segs = cd && cd.segments ? cd.segments.filter(sg => activityKeyOf(sg) === activeHighlightKey) : [];
          if (!segs.length) return;
          const cr = cell.getBoundingClientRect();
          const left = cr.left - gr.left;
          let ranges;
          if (cd.seconds / 600 * 100 >= 95 && cd.segments.every(sg => sg.subId === cellMainSubId(cd))) {
            ranges = [[0, 1]]; // 이 칸은 통째로 한 색으로 칠해져 보이므로 칸 전체를 감싼다
          } else {
            ranges = segs.slice().sort((p, q) => p.startOffset - q.startOffset)
              .map(sg => [sg.startOffset / 600, (sg.startOffset + sg.seconds) / 600])
              .reduce((acc, r) => { const last = acc[acc.length - 1]; if (last && r[0] - last[1] < 0.002) last[1] = r[1]; else acc.push(r.slice()); return acc; }, []);
          }
          ranges.forEach(([a, b]) => {
            const x0 = left + a * cr.width, x1 = left + b * cr.width;
            const last = spans[spans.length - 1];
            if (last && x0 - last[1] < 0.75) last[1] = x1; else spans.push([x0, x1]);
          });
        });
        return { y0: rr.top - gr.top, y1: rr.bottom - gr.top, spans };
      });
      let d = '';
      const f = n => Math.round(n * 100) / 100;
      rowInfo.forEach((row, i) => {
        const above = i > 0 ? rowInfo[i - 1].spans : [];
        const below = i < rowInfo.length - 1 ? rowInfo[i + 1].spans : [];
        row.spans.forEach(([x0, x1]) => {
          d += `M${f(x0)} ${f(row.y0)}V${f(row.y1)}M${f(x1)} ${f(row.y0)}V${f(row.y1)}`;
          subtractSpans(x0, x1, above).forEach(([a, b]) => { d += `M${f(a)} ${f(row.y0)}H${f(b)}`; });
          subtractSpans(x0, x1, below).forEach(([a, b]) => { d += `M${f(a)} ${f(row.y1)}H${f(b)}`; });
        });
      });
      if (!d) return null;
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'planner-hl-outline');
      ['hl-under', 'hl-line'].forEach(cls => {
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('class', cls); path.setAttribute('d', d); svg.appendChild(path);
      });
      return svg;
    }
    // 현재 보고 있는 날짜의 기록에서, 강조 중인 활동이 칠해진 막대의 바깥 테두리를 그린다(칸 하나하나가 아니라 이어진 덩어리 단위).
    function applyActivityHighlight() {
      const grid = document.getElementById('timetable-grid');
      if (!grid) return;
      const old = grid.querySelector('.planner-hl-outline');
      if (old) old.remove();
      if (activeHighlightKey && activeHighlightDate !== currentDateStr) { activeHighlightKey = null; activeHighlightDate = null; } // 다른 날짜로 넘어갔으면 잊는다(되돌아와도 되살아나지 않게)
      if (!activeHighlightKey) return;
      const recordGrid = (state.records[currentDateStr] && state.records[currentDateStr].grid) || {};
      const svg = buildActivityOutline(grid, recordGrid);
      if (svg) grid.appendChild(svg);
    }
    function handleSegmentHover(e, box, segments) {
      const seg = showSegmentTooltip(e, box, segments);
      // 표시(마킹) 모드에서는 칸을 칠하는 중이라 강조가 오히려 방해되므로 툴팁만 보여준다.
      setActivityHighlight(seg && !isMarkMode ? activityKeyOf(seg) : null);
    }
    function clearSegmentHover() { hideSegmentTooltip(); setActivityHighlight(null); }

    function renderTimetable() {
      const grid = document.getElementById('timetable-grid'); if (!grid) return;
      const recordGrid = state.records[currentDateStr].grid || {}; grid.innerHTML = '';
      const now = new Date(); const activeTimeKey = timerState.isRunning && currentDateStr === timerState.dateStr ? `${String(now.getHours()).padStart(2, '0')}:${String(Math.floor(now.getMinutes() / 10) * 10).padStart(2, '0')}` : null;
      
      for (let i = 0; i < 18; i++) {
        let h = (7 + i) % 24; let row = document.createElement('div'); row.className = 'flex-1 grid grid-cols-[30px_repeat(6,1fr)] w-full min-h-0';
        let label = document.createElement('div'); label.className = 'flex items-center justify-center text-[8px] font-mono font-bold text-slate-500 border-b border-r border-slate-700/80 bg-slate-800/30'; label.innerText = `${(7+i)>=24?'+':''}${String(h).padStart(2, '0')}`; row.appendChild(label);
        
        for (let m = 0; m < 6; m++) {
          let timeKey = `${String(h).padStart(2, '0')}:${String(m * 10).padStart(2, '0')}`;
          let cellData = recordGrid[timeKey] || { seconds: 0, passed: false, parts: {} };
          let box = document.createElement('div');

          box.id = 'cell-' + timeKey.replace(':', '-');
          const markSubId = getCellMarkSubject(currentDateStr, timeKey);
          box.className = `time-box relative overflow-hidden group border-b border-r border-slate-700/80 ${timeKey === activeTimeKey ? 'active-slot' : ''} ${markSubId ? 'marked' : ''} ${isMarkMode ? 'cursor-pointer' : (isGridEditMode ? 'unlocked cursor-pointer' : 'locked')}`;
          // 표시(마킹)는 과목별 색을 쓰되, 실제 공부 기록 색과 헷갈리지 않도록 훨씬 연하게(반투명하게) 얹는다.
          if (markSubId) box.style.setProperty('--mark-color', plannerHexToRgba(getSubject(markSubId).color, 0.28) || 'rgba(245, 158, 11, 0.28)');

          // ✨ V49: 복잡한 수학 공식을 getCellGradient() 함수 하나로 깔끔하게 처리!
          box.style.background = getCellGradient(cellData);
          if (isMarkMode) {
            // 표시(마킹) 모드에서는 실제 기록을 건드리는 클릭 대신 드래그로 반투명 표시를 칠하거나 지운다.
            box.onmousedown = (e) => { e.preventDefault(); startMarkDrag(timeKey); };
            box.onmouseenter = () => applyMarkDrag(timeKey);
            box.ontouchstart = (e) => { e.preventDefault(); startMarkDrag(timeKey); };
          } else {
            box.onclick = () => handleManualOverride(timeKey);
          }
          // 마우스를 올리면: (1) 그 부분이 어떤 할 일·과목이었는지 툴팁으로 보여주고, (2) 같은 활동으로 채워진
          // 모든 칸을 살짝 띄우고 테두리로 강조해서 타임테이블에서 얼마나 차지하는지 한눈에 보여준다.
          // 채워지지 않은 칸 위로 옮겼을 때도 강조를 풀어야 하므로, 칸 종류와 상관없이 mousemove를 건다.
          box.onmousemove = (e) => {
            if (cellData.segments && cellData.segments.length > 0) handleSegmentHover(e, box, cellData.segments);
            else clearSegmentHover();
          };
          box.onmouseleave = hideSegmentTooltip;
          row.appendChild(box);
        }
        grid.appendChild(row);
      }
      grid.onmouseleave = clearSegmentHover;
      // 타이머 등으로 칸을 통째로 다시 그려도 커서가 그대로면 강조도 그대로 이어지도록 다시 입힌다.
      applyActivityHighlight();
    }

    function updateDashboard() {
      const tasks = state.records[currentDateStr].tasks || []; const targetSec = tasks.reduce((sum, t) => sum + ((t.targetMin || 0) * 60), 0);
      let totalSec = Object.values(state.records[currentDateStr].grid || {}).reduce((sum, cell) => sum + (cell.seconds || 0), 0);
      if(UI.totalTime) UI.totalTime.innerText = formatTime(totalSec); 
      if(UI.targetTime) UI.targetTime.innerText = formatTime(targetSec);
      
      let achPct = targetSec > 0 ? Math.floor((totalSec / targetSec) * 100) : 0; 
      if(UI.totalAchieve) UI.totalAchieve.innerText = `${achPct}%`;
      if(UI.totalBar) UI.totalBar.style.transform = `scaleX(${Math.min(achPct / 100, 1)})`;

      const btnStart = document.getElementById('btn-start'); const btnStop = document.getElementById('btn-stop');
      const menuBtn = document.getElementById('menu-dropdown-btn');

      if (currentDateStr !== todayStr && !isTimeMachineUnlocked) {
        if (btnStart) { btnStart.disabled = true; btnStart.className = 'w-10 h-10 rounded-xl bg-slate-700 text-slate-500 flex items-center justify-center text-base cursor-not-allowed transition-all duration-300'; }
        if (btnStop) btnStop.disabled = true;
        return;
      }

      if (timerState.taskId) {
        if(UI.normalView) UI.normalView.classList.add('opacity-0', 'pointer-events-none');
        if(UI.zenView) UI.zenView.classList.remove('hidden');
        if(menuBtn) menuBtn.classList.add('opacity-50', 'pointer-events-none');

        const task = tasks.find(t => t.id === timerState.taskId);
        if (task) {
          const sub = getSubject(task.subjectId); document.getElementById('zen-subject-badge').innerText = sub.name; document.getElementById('zen-subject-badge').style.backgroundColor = sub.color; document.getElementById('zen-task-title').innerText = task.title;
          if(UI.zenTime) UI.zenTime.innerText = formatTime(task.elapsedSec || 0);
          
          if (UI.zenTaskBar && task.targetMin > 0) {
            const taskPct = Math.floor(((task.elapsedSec || 0) / (task.targetMin * 60)) * 100);
            UI.zenTaskBar.style.transform = `scaleX(${Math.min(taskPct / 100, 1)})`;
          }
        }

        const zenPauseBtn = document.getElementById('zen-btn-pause');
        if (timerState.isRunning) {
          zenPauseBtn.innerHTML = '<span>⏸</span> <span id="zen-btn-pause-text">일시정지</span>'; zenPauseBtn.className = 'px-4 py-2 bg-amber-500 hover:bg-amber-400 text-white rounded-xl font-bold text-[11px] transition shadow flex items-center gap-1.5';
        } else {
          zenPauseBtn.innerHTML = '<span>▶</span> <span>이어하기</span>'; zenPauseBtn.className = 'px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-bold text-[11px] transition shadow flex items-center gap-1.5';
        }

        if (btnStart) {
          btnStart.disabled = false;
          if (timerState.isRunning) { btnStart.innerHTML = '<span>⏸</span>'; btnStart.className = 'w-8 h-8 rounded-lg bg-amber-500 text-white flex items-center justify-center text-xs shadow-lg transition-all duration-300'; }
          else { btnStart.innerHTML = '<span>▶</span>'; btnStart.className = 'w-8 h-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center text-xs shadow-lg transition-all duration-300'; }
        }
        if (btnStop) { btnStop.disabled = false; btnStop.className = 'w-8 h-8 rounded-lg bg-red-500 text-white flex items-center justify-center text-xs shadow-lg transition-all duration-300'; }
      } else {
        if(UI.normalView) UI.normalView.classList.remove('opacity-0', 'pointer-events-none');
        if(UI.zenView) UI.zenView.classList.add('hidden');
        if(menuBtn) menuBtn.classList.remove('opacity-50', 'pointer-events-none');
        
        if (btnStart) { btnStart.innerHTML = '<span>▶</span>'; btnStart.className = 'w-10 h-10 rounded-xl bg-slate-700 text-slate-500 flex items-center justify-center text-base disabled:opacity-50 cursor-not-allowed transition-all duration-300'; btnStart.disabled = true; }
        if (btnStop) { btnStop.disabled = true; btnStop.className = 'w-10 h-10 rounded-xl bg-slate-700 text-slate-500 flex items-center justify-center text-base disabled:opacity-50 cursor-not-allowed transition-all duration-300'; }
      }
    }

    function toggleTimer() { if (timerState.isRunning) pauseTimer(); else if (timerState.taskId) resumeTimer(); }

    function toggleGridEditMode() {
      if (currentDateStr !== todayStr && !isTimeMachineUnlocked) { uiAlert('과거 타임테이블은 타임머신 모드(날짜 더블클릭 후 관리자 비밀번호 입력)에서만 수정 가능합니다.'); return; }
      if (isMarkMode) { uiAlert('표시 기능을 먼저 끈 뒤에 편집 모드를 사용해주세요.'); return; }
      if (!isGridEditMode) {
        uiConfirm("타임테이블을 수동으로 편집하시겠습니까?", () => { isGridEditMode = true; document.getElementById('manual-subject-select').classList.remove('hidden'); const btn = document.getElementById('btn-edit-grid'); btn.innerHTML = '<span>✓</span> 완료'; btn.className = 'px-1.5 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded text-[9px] font-bold transition shadow'; const markBtn = document.getElementById('btn-mark-grid'); if (markBtn) markBtn.classList.add('hidden'); renderTimetable(); }, {icon:'✏️', title:'편집 모드'});
      } else resetEditMode();
    }
    function resetEditMode() { isGridEditMode = false; document.getElementById('manual-subject-select').classList.add('hidden'); const btn = document.getElementById('btn-edit-grid'); btn.innerHTML = '<span>🔒</span> 편집'; btn.className = 'px-1.5 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded text-[9px] font-bold transition shadow border border-slate-600'; const markBtn = document.getElementById('btn-mark-grid'); if (markBtn) markBtn.classList.remove('hidden'); renderTimetable(); }

    // 타임테이블 임시 마킹(반투명): 실제 기록 수정 모드(편집)와 동시에 켜면 드래그 동작이
    // 서로 헷갈리므로, 편집 모드일 때는 마킹 모드로 들어갈 수 없게 막는다.
    function toggleMarkMode() {
      if (isGridEditMode) { uiAlert('편집 모드를 먼저 끈 뒤에 표시 기능을 사용해주세요.'); return; }
      isMarkMode = !isMarkMode;
      setActivityHighlight(null); // 표시 모드로 들어가거나 나올 때 남아있는 활동 강조는 풀어준다
      const btn = document.getElementById('btn-mark-grid');
      const subSelect = document.getElementById('mark-subject-select');
      const editBtn = document.getElementById('btn-edit-grid');
      if (isMarkMode) {
        btn.innerHTML = '<span>✓</span> 표시'; btn.className = 'px-1.5 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded text-[9px] font-bold transition shadow';
        if (!markSubjectId || !state.subjects.some(s => s.id === markSubjectId)) markSubjectId = state.subjects[0] && state.subjects[0].id;
        if (subSelect) { subSelect.value = markSubjectId; subSelect.classList.remove('hidden'); }
        if (editBtn) editBtn.classList.add('hidden');
      } else {
        btn.innerHTML = '<span>🖍</span> 표시'; btn.className = 'px-1.5 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded text-[9px] font-bold transition shadow border border-slate-600';
        if (subSelect) subSelect.classList.add('hidden');
        if (editBtn) editBtn.classList.remove('hidden');
      }
      renderTimetable();
    }
    function setMarkSubject(subId) { markSubjectId = subId; }
    // 드래그로 여러 칸을 한 번에 칠하거나 지운다 - 첫 칸을 누른 순간의 상태(지금 선택된 과목으로
    // 이미 칠해져 있는지)를 뒤집은 방향으로 드래그 내내 유지해서(칠하던 중이면 계속 칠하고,
    // 지우던 중이면 계속 지움) 자연스럽게 동작한다.
    function startMarkDrag(timeKey) {
      markDragActive = true;
      markDragAdding = getCellMarkSubject(currentDateStr, timeKey) !== markSubjectId;
      applyMarkDrag(timeKey);
    }
    function applyMarkDrag(timeKey) {
      if (!markDragActive) return;
      setCellMark(currentDateStr, timeKey, markDragAdding ? markSubjectId : null);
      savePlannerMarks();
      renderTimetable();
    }
    function endMarkDrag() { markDragActive = false; }
    document.addEventListener('mouseup', endMarkDrag);
    document.addEventListener('touchend', endMarkDrag);

    function handleManualOverride(timeKey) {
      if (currentDateStr !== todayStr && !isTimeMachineUnlocked) { uiAlert('과거 기록은 타임머신 모드에서만 수정할 수 있습니다.'); return; }
      if (!isGridEditMode) { uiAlert('칸을 수정하려면 상단의 [🔒 편집] 버튼을 먼저 눌러주세요.'); return; }
      
      let gridData = state.records[currentDateStr].grid;
      if (!gridData[timeKey]) gridData[timeKey] = { seconds: 0, passed: false, parts: {}, segments: [] };
      
      const subId = document.getElementById('manual-subject-select').value || state.subjects[0].id;
      let currentSec = gridData[timeKey].seconds;
      
      // 수동 편집 시 한 번 클릭으로 즉시 10분(100%) 채우고, 다시 클릭하면 초기화 (0% -> 100% -> 0%)
      if (currentSec === 0) {
         gridData[timeKey].seconds = 600;
         gridData[timeKey].parts = {}; gridData[timeKey].parts[subId] = 600;
         gridData[timeKey].segments = [{ subId: subId, startOffset: 0, seconds: 600 }]; // 편집은 무조건 0초(왼쪽)부터
         gridData[timeKey].passed = true;
      } else {
         gridData[timeKey].seconds = 0;
         gridData[timeKey].parts = {};
         gridData[timeKey].segments = [];
         gridData[timeKey].passed = false;
      }
      saveData(); updateDashboard(); renderTimetable(); 
    }

    function openAddTaskModal() { 
      if (currentDateStr !== todayStr && !isTimeMachineUnlocked) { uiAlert('과거 기록에는 과제를 추가할 수 없습니다.'); return; }
      editTaskId = null;
      document.getElementById('form-main-add-task').reset(); 
      document.getElementById('modal-add-task-title').innerText = "새로운 할일 추가";
      document.getElementById('modal-add-task-btn').innerHTML = "추가하기";
      document.getElementById('modal-add-task').classList.remove('hidden'); 
    }
    
    function openEditTaskModal(id) {
      if (currentDateStr !== todayStr && !isTimeMachineUnlocked) { uiAlert('과거 기록은 타임머신 모드(날짜 더블클릭 후 관리자 비밀번호 입력)에서만 수정할 수 있습니다.'); return; }
      const task = state.records[currentDateStr].tasks.find(t => t.id === id);
      if (!task) return;
      
      editTaskId = id;
      document.getElementById('modal-add-task-title').innerText = "할일 목표 수정";
      document.getElementById('modal-add-task-btn').innerHTML = '<span>✓</span> 수정 완료';
      
      document.getElementById('main-task-title').value = task.title;
      document.getElementById('main-task-subject').value = task.subjectId;
      document.getElementById('main-task-target').value = task.targetMin;
      document.getElementById('main-task-routine').checked = task.isRoutine || false;
      
      document.getElementById('modal-add-task').classList.remove('hidden');
    }

    function addTask(source) {
      if(currentDateStr !== todayStr && !isTimeMachineUnlocked) { uiAlert('과거 기록에는 과제를 추가하거나 수정할 수 없습니다.'); return; }
      const prefix = source === 'setup' ? 'setup' : 'main';
      const title = document.getElementById(`${prefix}-task-title`).value || '새 과제';
      const subjectId = document.getElementById(`${prefix}-task-subject`).value || state.subjects[0].id;
      const targetMin = parseInt(document.getElementById(`${prefix}-task-target`).value) || 10;
      const isRoutine = document.getElementById(`${prefix}-task-routine`) ? document.getElementById(`${prefix}-task-routine`).checked : false;

      ensureDailyRecord(currentDateStr); 

      if (source === 'main' && editTaskId) {
         const task = state.records[currentDateStr].tasks.find(t => t.id === editTaskId);
         if (task) { task.title = title; task.subjectId = subjectId; task.targetMin = targetMin; task.isRoutine = isRoutine; }
         editTaskId = null;
      } else {
         const newTask = { id: 't_'+Date.now()+'_'+Math.floor(Math.random()*1000), title, subjectId, targetMin, completed: false, elapsedSec: 0, isRoutine };
         state.records[currentDateStr].tasks.push(newTask); 
      }
      
      saveData(); 
      if(source === 'setup') { document.getElementById('form-setup-add-task').reset(); renderSetupTaskList(); } 
      else { document.getElementById('form-main-add-task').reset(); renderTasks(); updateDashboard(); closeModal('modal-add-task'); }
    }
    
    function importYesterdayTasks() {
      if (currentDateStr !== todayStr && !isTimeMachineUnlocked) { uiAlert('과거 기록에서는 할 일을 가져올 수 없습니다.'); return; }
      const pastDates = Object.keys(state.records).sort().filter(d => d < currentDateStr);
      if (pastDates.length === 0) { uiAlert('가져올 이전 기록이 없습니다.'); return; }
      const lastTasks = state.records[pastDates[pastDates.length - 1]].tasks || [];
      if (lastTasks.length === 0) { uiAlert('가져올 할 일이 없습니다.'); return; }
      let importedCount = 0;
      lastTasks.forEach(t => {
        if (!state.records[currentDateStr].tasks.some(ct => ct.title === t.title)) {
          state.records[currentDateStr].tasks.push({ id: 't_'+Date.now()+'_'+Math.floor(Math.random()*1000) + importedCount, title: t.title, subjectId: t.subjectId, targetMin: t.targetMin, completed: false, elapsedSec: 0, isRoutine: t.isRoutine });
          importedCount++;
        }
      });
      if (importedCount === 0) uiAlert('이미 모든 할 일이 추가되어 있습니다.'); 
      else { saveData(); renderTasks(); updateDashboard(); uiAlert(`${importedCount}개의 할 일을 성공적으로 가져왔습니다!`, {icon:'✅', title:'가져오기 완료'}); }
    }

    function deleteTask(id, fromSetup=false) {
      uiConfirm('과제를 삭제하시겠습니까?', () => {
        if(timerState.taskId === id) stopTimer();
        state.records[currentDateStr].tasks = state.records[currentDateStr].tasks.filter(t => t.id !== id); saveData(); 
        if(fromSetup) renderSetupTaskList(); else { renderTasks(); updateDashboard(); }
      }, {icon:'🗑️', title:'삭제 확인', confirmText:'삭제'});
    }
    function toggleTaskComplete(id, isChecked) {
      const task = state.records[currentDateStr].tasks.find(t => t.id === id);
      if(task) { 
        task.completed = isChecked; if(isChecked && timerState.taskId === id) stopTimer(); 
        if (isChecked) addXP(10); else addXP(-10);
        const allTasks = state.records[currentDateStr].tasks; const isAllClear = allTasks.length > 0 && allTasks.every(t => t.completed);
        if (isAllClear && !state.allClearDates[currentDateStr]) { state.allClearDates[currentDateStr] = true; addXP(30); setTimeout(() => uiAlert('오늘의 할 일 올클리어 완료!\n보너스 +30 XP 지급!', {icon:'🎉', title:'올클리어 달성'}), 100); }
        saveData(); renderTasks(); 
      }
    }
    function openConfirmStart(id) {
      if(currentDateStr !== todayStr && !isTimeMachineUnlocked) { uiAlert('과거 기록에서는 타이머 실행이 불가능합니다.'); return; }
      const task = state.records[currentDateStr].tasks.find(t => t.id === id); if(!task || task.completed) return;
      tempStartTaskId = id; document.getElementById('confirm-task-name').innerText = task.title; document.getElementById('modal-confirm').classList.remove('hidden');
    }
    
    // ✨ 타이머 재시작 시, 컴퓨터가 새로운 조각(Segment)을 팔 준비를 하도록 틱타임 리셋
    function confirmStartTask() { closeModal('modal-confirm'); const task = state.records[currentDateStr].tasks.find(t => t.id === tempStartTaskId); if(!task) return; timerState.taskId = task.id; timerState.subjectId = task.subjectId; timerState.dateStr = currentDateStr; resumeTimer(); if (window.completeDailyMission) window.completeDailyMission('planner', 50, '플래너 공부 시작'); }
    function getFocusWidgetData() {
      if (!timerState.taskId) return null;
      // PiP/인라인 미니 위젯에 표시할 데이터이므로, 지금 열람 중인 날짜(currentDateStr)가 아니라
      // 타이머가 실제로 돌고 있는 날짜(timerState.dateStr)의 과제 목록에서 찾아야 한다 -
      // 그래야 이전 기록을 보는 동안에도 PiP에 타이머 정보가 계속 정상적으로 표시된다.
      const focusDateStr = timerState.dateStr || currentDateStr;
      const tasks = (state.records[focusDateStr] && state.records[focusDateStr].tasks) || [];
      const task = tasks.find(t => t.id === timerState.taskId);
      if (!task) return null;
      const sub = getSubject(task.subjectId);
      return {
        isRunning: timerState.isRunning,
        title: task.title,
        subjectName: sub ? sub.name : '',
        subjectColor: sub ? sub.color : '#6366f1',
        elapsedSec: task.elapsedSec || 0,
        targetMin: task.targetMin || 0
      };
    }

    // ===== 주간 학습 리포트: 기존 플래너 기록(state.records)만 사용, 새 저장 구조 없음 =====
    function getWeeklyReport(weekOffset) {
      weekOffset = weekOffset || 0;
      const base = new Date(todayStr + 'T00:00:00');
      const dow = base.getDay(); // 0=일 .. 6=토
      const diffToMonday = (dow === 0 ? -6 : 1 - dow);
      const monday = new Date(base);
      monday.setDate(monday.getDate() + diffToMonday + weekOffset * 7);

      const dayLabels = ['일', '월', '화', '수', '목', '금', '토'];
      const days = [];
      let totalSec = 0, totalTargetSec = 0;
      const subjectTotals = {};

      for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(d.getDate() + i);
        const dStr = getLocalDateStr(d);
        const rec = state.records[dStr];
        let daySec = 0;
        if (rec && Array.isArray(rec.tasks)) {
          rec.tasks.forEach(t => {
            const sec = t.elapsedSec || 0;
            daySec += sec;
            totalSec += sec;
            totalTargetSec += (t.targetMin || 0) * 60;
            subjectTotals[t.subjectId] = (subjectTotals[t.subjectId] || 0) + sec;
          });
        }
        days.push({ dateStr: dStr, label: dayLabels[d.getDay()], seconds: daySec, isFuture: dStr > todayStr });
      }

      let bestDay = null;
      days.forEach(d => { if (d.seconds > 0 && (!bestDay || d.seconds > bestDay.seconds)) bestDay = d; });

      // 지난주(비교용) - 같은 방식으로 한 주 전 합계만 계산
      const prevMonday = new Date(monday); prevMonday.setDate(prevMonday.getDate() - 7);
      let prevTotalSec = 0;
      for (let i = 0; i < 7; i++) {
        const d = new Date(prevMonday); d.setDate(d.getDate() + i);
        const rec = state.records[getLocalDateStr(d)];
        if (rec && Array.isArray(rec.tasks)) rec.tasks.forEach(t => { prevTotalSec += (t.elapsedSec || 0); });
      }

      const subjectBreakdown = Object.entries(subjectTotals)
        .map(([subjectId, seconds]) => { const sub = getSubject(subjectId); return { id: subjectId, name: sub ? sub.name : '기타', color: sub ? sub.color : '#6366f1', seconds }; })
        .filter(s => s.seconds > 0)
        .sort((a, b) => b.seconds - a.seconds);

      return {
        weekOffset,
        mondayStr: getLocalDateStr(monday),
        sundayStr: days[6].dateStr,
        days,
        totalSec,
        totalTargetSec,
        prevTotalSec,
        subjectBreakdown,
        bestDay
      };
    }

    function notifyMiniWidgetFocus() { if (window.GlobalMiniController) window.GlobalMiniController.refresh(); }
    function notifyMiniWidgetFocusGesture() { if (window.GlobalMiniController) window.GlobalMiniController.handleGesture(); }
    function resumeTimer() { if(timerState.isRunning) return; timerState.isRunning = true; timerState.lastTickTime = Date.now(); timerState.interval = setInterval(timerTick, 1000); renderTasks(); renderTimetable(); updateDashboard(); notifyMiniWidgetFocusGesture(); }
    
    function pauseTimer() { timerState.isRunning = false; if (timerState.interval) clearInterval(timerState.interval); timerState.interval = null; saveData(); renderTasks(); updateDashboard(); renderTimetable(); notifyMiniWidgetFocusGesture(); }
    function stopTimer() { timerState.isRunning = false; if (timerState.interval) clearInterval(timerState.interval); timerState.interval = null; timerState.taskId = null; timerState.subjectId = null; timerState.dateStr = null; saveData(); renderTasks(); updateDashboard(); renderTimetable(); notifyMiniWidgetFocusGesture(); }

    function updateLiveTimerUI(timeKey, task) {
       const activeTimeKey = timerState.isRunning && currentDateStr === timerState.dateStr ? timeKey : null;
       const tasks = state.records[currentDateStr].tasks || [];
       const targetSec = tasks.reduce((sum, t) => sum + ((t.targetMin || 0) * 60), 0);
       const totalSec = Object.values(state.records[currentDateStr].grid || {}).reduce((sum, cell) => sum + (cell.seconds || 0), 0);
       
       if(UI.totalTime) UI.totalTime.innerText = formatTime(totalSec);
       
       let achPct = targetSec > 0 ? Math.floor((totalSec / targetSec) * 100) : 0;
       if(UI.totalAchieve) UI.totalAchieve.innerText = `${achPct}%`;
       if(UI.totalBar) UI.totalBar.style.transform = `scaleX(${Math.min(achPct / 100, 1)})`;

       if (task) {
          if(UI.zenTime) UI.zenTime.innerText = formatTime(task.elapsedSec || 0);
          if (UI.zenTaskBar && task.targetMin > 0) {
             const taskPct = Math.floor(((task.elapsedSec || 0) / (task.targetMin * 60)) * 100);
             UI.zenTaskBar.style.transform = `scaleX(${Math.min(taskPct / 100, 1)})`;
          }
          const elapsedEl = document.getElementById(`task-elapsed-${task.id}`);
          if (elapsedEl) elapsedEl.innerText = `누적: ${formatTime(task.elapsedSec)}`;
       }

       document.querySelectorAll('.time-box.active-slot').forEach(el => el.classList.remove('active-slot'));
       
       const cellId = 'cell-' + timeKey.replace(':', '-');
       const box = document.getElementById(cellId);
       if (box) {
          let cellData = state.records[currentDateStr].grid[timeKey];
          box.style.background = getCellGradient(cellData);
          if(timeKey === activeTimeKey) box.classList.add('active-slot');
       }
    }

    // ✨ V49 핵심: 시간 단절(Gap) 완벽 기억 엔진 (타이머가 돌 때마다 조각을 나눠서 저장)
    function timerTick() {
      const now = new Date(); const currentMs = Date.now(); 
      const diffSec = Math.round((currentMs - timerState.lastTickTime) / 1000); 
      if (diffSec < 1) return; 
      
      let t = timerState.lastTickTime;
      timerState.lastTickTime = currentMs;

      // 타이머가 실제로 기록을 쌓아야 할 날짜는 항상 timerState.dateStr(시작할 때 고정된 날짜)이다.
      // currentDateStr은 "지금 화면에 보이는 날짜"일 뿐이라, 타이머가 도는 동안 이전 기록을 열람해도
      // 그 열람 중인 날짜의 grid가 아니라 타이머가 시작된 날짜의 grid에 계속 쌓여야 한다.
      const tickDateStr = timerState.dateStr || currentDateStr;
      const task = state.records[tickDateStr].tasks.find(tk => tk.id === timerState.taskId);
      if(!timerState.subjectId && task) timerState.subjectId = task.subjectId;

      let gridData = state.records[tickDateStr].grid;
      let secCount = 0;
      
      while (t < currentMs && secCount < diffSec) {
          let d = new Date(t);
          let tk = `${String(d.getHours()).padStart(2, '0')}:${String(Math.floor(d.getMinutes() / 10) * 10).padStart(2, '0')}`;
          let secOffset = (d.getMinutes() % 10) * 60 + d.getSeconds(); // 이 칸의 정확한 초(0~599)
          
          if (!gridData[tk]) gridData[tk] = { seconds: 0, passed: false, parts: {}, segments: [] };
          if (!gridData[tk].segments) gridData[tk].segments = [];
          
          // 방금 전까지 공부하던 마지막 조각(Segment)을 확인
          let lastSeg = gridData[tk].segments[gridData[tk].segments.length - 1];

          // 만약 과목과 할 일이 같고, 쉬지 않고 이어서 공부 중이라면 그 조각의 길이를 +1초 늘림
          if (lastSeg && lastSeg.subId === timerState.subjectId && lastSeg.taskId === timerState.taskId && (lastSeg.startOffset + lastSeg.seconds === secOffset)) {
              lastSeg.seconds += 1;
          } else {
              // 과목/할 일이 바뀌었거나, 중간에 1초라도 쉬었다가 다시 켰다면 아예 새로운 조각을 만들어버림! (빈틈을 메우지 않음)
              // taskId를 함께 남겨서, 나중에 타임테이블 위에 마우스를 올렸을 때 "어떤 할 일이었는지"를 보여줄 수 있다.
              gridData[tk].segments.push({ subId: timerState.subjectId, taskId: timerState.taskId, startOffset: secOffset, seconds: 1 });
          }
          
          if (!gridData[tk].parts[timerState.subjectId]) gridData[tk].parts[timerState.subjectId] = 0;
          gridData[tk].parts[timerState.subjectId] += 1;
          gridData[tk].seconds += 1;
          if (gridData[tk].seconds >= 600 && !gridData[tk].passed) {
              gridData[tk].passed = true;
              addXP(5);
          }
          t += 1000;
          secCount++;
      }
      
      if (task) task.elapsedSec = (task.elapsedSec || 0) + diffSec; 
      
      const finalTimeKey = `${String(now.getHours()).padStart(2, '0')}:${String(Math.floor(now.getMinutes() / 10) * 10).padStart(2, '0')}`;
      
      if (timerState.lastRenderedTimeKey !== finalTimeKey) {
          renderTimetable(); 
          timerState.lastRenderedTimeKey = finalTimeKey;
      } else if (!document.hidden) { 
          updateLiveTimerUI(finalTimeKey, task); 
      }
      
      saveTickCounter += diffSec;
      if (saveTickCounter >= 10) { saveData(); saveTickCounter = 0; }
      notifyMiniWidgetFocus();
    }

    window.addEventListener('beforeunload', () => { saveData(); });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { saveData(); } 
      else { if (timerState.isRunning) { updateDashboard(); renderTimetable(); } }
    });

    // ================= 오늘의 학습 메모장 (자동 저장) =================
    let workspaceNoteSaveTimer = null;
    function loadWorkspaceNote() {
      const ta = document.getElementById('workspace-note'); if (!ta) return;
      ensureDailyRecord(currentDateStr);
      ta.value = state.records[currentDateStr].workspaceNote || '';
      updateWorkspaceNoteCount();
    }
    function updateWorkspaceNoteCount() {
      const ta = document.getElementById('workspace-note'); const cnt = document.getElementById('workspace-note-count');
      if (ta && cnt) cnt.innerText = `${ta.value.length}자`;
    }
    function handleWorkspaceNoteInput() {
      updateWorkspaceNoteCount();
      clearTimeout(workspaceNoteSaveTimer);
      workspaceNoteSaveTimer = setTimeout(() => {
        ensureDailyRecord(currentDateStr);
        state.records[currentDateStr].workspaceNote = document.getElementById('workspace-note').value;
        saveData();
      }, 400);
    }

    function updateWorkspaceView() {
       const iframeCont = document.getElementById('workspace-iframe-container');
       const statsCont = document.getElementById('workspace-past-stats');
       const title = document.getElementById('workspace-title');
       const badge = document.getElementById('workspace-badge');
       const btns = document.getElementById('workspace-quick-btns');

       if (currentDateStr === todayStr) {
           if(iframeCont) iframeCont.classList.remove('hidden');
           if(statsCont) statsCont.classList.add('hidden');
           if(btns) btns.classList.remove('hidden');
           if(title) title.innerHTML = '<span class="mr-1.5 text-indigo-400">📝</span>WORKSPACE';
           if(badge) { badge.innerText = '오늘의 학습 메모장'; badge.className = 'text-[9px] bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded border border-indigo-500/30'; }
           loadWorkspaceNote();
       } else {
           if(iframeCont) iframeCont.classList.add('hidden');
           if(statsCont) statsCont.classList.remove('hidden');
           if(btns) btns.classList.add('hidden');
           if(title) title.innerHTML = '<span class="mr-1.5 text-amber-400">📊</span>PAST RECORD';
           if(badge) { badge.innerText = `${currentDateStr} 학습 통계`; badge.className = 'text-[9px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded border border-amber-500/30'; }
           renderWorkspacePastStats();
       }
    }

    function renderWorkspacePastStats() {
       let subjectTimes = {}; state.subjects.forEach(s => { subjectTimes[s.id] = 0; });
       const record = state.records[currentDateStr];
       if (record && record.grid) {
           Object.values(record.grid).forEach(cell => {
               if (cell && cell.parts) { for(let sub in cell.parts) subjectTimes[sub] += cell.parts[sub]; } 
               else if (cell && cell.subjectId && cell.seconds > 0) subjectTimes[cell.subjectId] += cell.seconds;
           });
       }
       
       const totalSec = Object.values(subjectTimes).reduce((sum, val) => sum + val, 0);
       const visualEl = document.getElementById('ws-pie-chart-visual'); 
       const legendEl = document.getElementById('ws-pie-chart-legend');
       const totalEl = document.getElementById('ws-pie-chart-total');

       if (totalSec === 0) { 
           visualEl.style.background = "#334155"; 
           totalEl.innerText = "00:00";
           legendEl.innerHTML = `<div class="text-center text-slate-400 text-sm py-4 bg-slate-800/50 rounded-xl">해당 날짜의 학습 기록이 없습니다.</div>`; 
           return; 
       }
       
       totalEl.innerText = formatTime(totalSec, true);
       let gradientParts = []; let currentDeg = 0; let legendHTML = "";
       state.subjects.forEach(s => {
           const sec = subjectTimes[s.id] || 0; if (sec === 0) return;
           const pct = Math.round((sec / totalSec) * 100); const deg = (sec / totalSec) * 360;
           gradientParts.push(`${s.color} ${currentDeg}deg ${currentDeg + deg}deg`); currentDeg += deg;
           legendHTML += `<div class="flex items-center justify-between bg-slate-800/80 px-4 py-3 rounded-xl border border-slate-700/60 shadow-sm"><div class="flex items-center gap-3"><div class="w-4 h-4 rounded-full" style="background-color: ${s.color}"></div><span class="text-sm font-bold text-slate-200">${s.name}</span></div><div class="flex items-center gap-4"><span class="text-sm font-mono text-slate-400">${formatTime(sec, true)}</span><span class="text-xs font-black text-indigo-300 w-10 text-right">${pct}%</span></div></div>`;
       });
       visualEl.style.background = `conic-gradient(${gradientParts.join(', ')})`; legendEl.innerHTML = legendHTML;
    }

    function openStatsModal() { renderTodaySubjectPieChart(); renderYesterdayTop3(); document.getElementById('modal-stats').classList.remove('hidden'); }
    function renderTodaySubjectPieChart() {
      let subjectTimes = {}; state.subjects.forEach(s => { subjectTimes[s.id] = 0; });
      const todayRec = state.records[todayStr];
      if (todayRec && todayRec.grid) { Object.values(todayRec.grid).forEach(cell => { if (cell && cell.parts) { for(let sub in cell.parts) subjectTimes[sub] += cell.parts[sub]; } else if (cell && cell.subjectId && cell.seconds > 0) subjectTimes[cell.subjectId] += cell.seconds; }); }
      const totalSec = Object.values(subjectTimes).reduce((sum, val) => sum + val, 0);
      const visualEl = document.getElementById('pie-chart-visual'); const legendEl = document.getElementById('pie-chart-legend');

      if (totalSec === 0) { visualEl.style.background = "#334155"; legendEl.innerHTML = `<div class="text-center text-slate-400 text-xs py-3">오늘 학습한 기록이 없습니다.</div>`; return; }
      
      let gradientParts = []; let currentDeg = 0; let legendHTML = "";
      state.subjects.forEach(s => {
        const sec = subjectTimes[s.id] || 0; if (sec === 0) return;
        const pct = Math.round((sec / totalSec) * 100); const deg = (sec / totalSec) * 360;
        gradientParts.push(`${s.color} ${currentDeg}deg ${currentDeg + deg}deg`); currentDeg += deg;
        legendHTML += `<div class="flex items-center justify-between bg-slate-900/80 px-3 py-2 rounded-lg border border-slate-700"><div class="flex items-center gap-2"><div class="w-3 h-3 rounded-full" style="background-color: ${s.color}"></div><span class="text-xs font-bold text-slate-200">${s.name}</span></div><div class="flex items-center gap-3"><span class="text-xs font-mono text-slate-400">${formatTime(sec, true)}</span><span class="text-[10px] font-black text-indigo-300 w-8 text-right">${pct}%</span></div></div>`;
      });
      visualEl.style.background = `conic-gradient(${gradientParts.join(', ')})`; legendEl.innerHTML = legendHTML;
    }

    function renderYesterdayTop3() {
      const todayObj = new Date(todayStr); todayObj.setDate(todayObj.getDate() - 1); const yesterdayStr = getLocalDateStr(todayObj);
      const targetDateStr = state.records[yesterdayStr] ? yesterdayStr : Object.keys(state.records).sort().filter(d => d < todayStr).pop();
      const listEl = document.getElementById('yesterday-top3-list');
      if (!targetDateStr || !state.records[targetDateStr]) { listEl.innerHTML = `<div class="text-center text-slate-500 text-xs py-3 bg-slate-900/40 rounded-xl">어제 학습 기록이 없습니다.</div>`; return; }

      let subjectTimes = {}; state.subjects.forEach(s => { subjectTimes[s.id] = 0; });
      Object.values(state.records[targetDateStr].grid || {}).forEach(cell => { if (cell && cell.parts) { for(let sub in cell.parts) subjectTimes[sub] += cell.parts[sub]; } else if (cell && cell.subjectId && cell.seconds > 0) subjectTimes[cell.subjectId] += cell.seconds; });
      
      const totalSec = Object.values(subjectTimes).reduce((sum, val) => sum + val, 0);
      if (totalSec === 0) { listEl.innerHTML = `<div class="text-center text-slate-500 text-xs py-3 bg-slate-900/40 rounded-xl">${targetDateStr} 학습 기록이 0분입니다.</div>`; return; }
      
      const sortedSubjects = state.subjects.map(s => ({ ...s, seconds: subjectTimes[s.id] || 0 })).filter(s => s.seconds > 0).sort((a, b) => b.seconds - a.seconds).slice(0, 3);
      const medals = ['🥇 1위', '🥈 2위', '🥉 3위'];
      listEl.innerHTML = sortedSubjects.map((s, idx) => { const pct = Math.round((s.seconds / totalSec) * 100); return `<div class="flex items-center justify-between bg-slate-900/90 px-3 py-2 rounded-xl border border-slate-700/80"><div class="flex items-center gap-2"><span class="text-xs font-bold text-amber-400 w-12">${medals[idx]}</span><span class="px-1.5 py-0.5 rounded text-[8px] font-bold text-white" style="background-color: ${s.color}">${s.name}</span></div><div class="flex items-center gap-3"><span class="text-xs font-mono text-slate-300">${formatTime(s.seconds, true)}</span><span class="text-[10px] font-black text-emerald-400 w-8 text-right">${pct}%</span></div></div>`; }).join('');
    }

    function toggleMenuDropdown(e) { if (e) e.stopPropagation(); document.getElementById('menu-dropdown').classList.toggle('hidden'); }
    function closeMenuDropdown() { const dd = document.getElementById('menu-dropdown'); if (dd) dd.classList.add('hidden'); }
    function closeDropdownOnOutsideClick(e) { const wrapper = document.getElementById('menu-dropdown-wrapper'); if (wrapper && !wrapper.contains(e.target)) closeMenuDropdown(); }
    
    function openDiaryModal() { updateDiaryModalUI(); document.getElementById('modal-diary').classList.remove('hidden'); }
    function updateDiaryModalUI() { const days = ['일', '월', '화', '수', '목', '금', '토']; document.getElementById('diary-date-label').innerText = `${currentDateStr.replace(/-/g, '.')} (${days[new Date(currentDateStr).getDay()]})`; ensureDailyRecord(currentDateStr); document.getElementById('diary-textarea').value = state.records[currentDateStr].diary || ''; updateCharCount(); const mood = state.records[currentDateStr].mood || ''; document.querySelectorAll('#diary-mood-selector button').forEach(b => { b.className = b.getAttribute('data-mood') === mood ? 'px-2 py-1 rounded-lg text-[10px] font-bold bg-indigo-600 text-white border border-indigo-500 shadow transition' : 'px-2 py-1 rounded-lg text-[10px] font-bold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition'; }); }
    function changeDiaryDate(delta) { saveDiary(false); const curr = new Date(currentDateStr); curr.setDate(curr.getDate() + delta); currentDateStr = getLocalDateStr(curr); ensureDailyRecord(currentDateStr); updateDiaryModalUI(); updateHeaderDate(); renderTasks(); renderTimetable(); updateDashboard(); }
    function selectDiaryMood(mood) { ensureDailyRecord(currentDateStr); state.records[currentDateStr].mood = mood; saveData(); updateDiaryModalUI(); }
    function insertDiaryTemplate() { const ta = document.getElementById('diary-textarea'); const t = "[오늘 잘한 점]\n- \n\n[보완할 점]\n- \n\n[내일의 목표]\n- \n"; ta.value = ta.value.trim().length > 0 ? ta.value + "\n\n" + t : t; updateCharCount(); }
    function updateCharCount() { document.getElementById('diary-char-count').innerText = `${document.getElementById('diary-textarea') ? document.getElementById('diary-textarea').value.length : 0} 글자 작성 중`; }
    function saveDiary(showAlertFlag = true) { ensureDailyRecord(currentDateStr); state.records[currentDateStr].diary = document.getElementById('diary-textarea').value; saveData(); if (showAlertFlag) { closeModal('modal-diary'); uiAlert('기록장이 안전하게 저장되었습니다!', {icon:'📖', title:'저장 완료'}); } if (!document.getElementById('modal-calendar').classList.contains('hidden')) renderCalendar(); }
    
    function lockTimeMachineIfActive() { if(isTimeMachineUnlocked) { isTimeMachineUnlocked = false; updateViewingStatusUI(); } }
    function updateHeaderDate() { const days = ['일', '월', '화', '수', '목', '금', '토']; if(UI.currentDate) UI.currentDate.innerText = `${currentDateStr.replace(/-/g, '.')} (${days[new Date(currentDateStr).getDay()]})`; if(UI.btnToday) UI.btnToday.classList.toggle('hidden', currentDateStr === todayStr); if(UI.btnNextDate) UI.btnNextDate.disabled = (currentDateStr === todayStr); updateViewingStatusUI(); updateWorkspaceView(); }
    function returnToToday() { lockTimeMachineIfActive(); currentDateStr = todayStr; switchView('view-main'); }
    // 지금 보고 있는 날짜가 타이머가 실제로 도는 날짜와 같은지 - GlobalMiniController가 이 값을 보고
    // "인라인 미니 위젯을 굳이 또 띄울 필요가 있는지"(=지금 화면에 이미 타이머가 보이고 있는지)를
    // 판단한다. 다른 날짜(이전 기록)를 보는 중이면 화면에 타이머가 안 보이니 인라인 위젯을 띄워야 한다.
    function isViewingLiveFocusDate() { return currentDateStr === (timerState.dateStr || todayStr); }
    // 타이머가 도는 중에 다른 날짜의 기록을 열람하러 이동할 때: 타이머는 멈추지 않고 그대로 두고,
    // 화면에서 타이머 위젯이 사라진 만큼 사이트 안의 인라인 미니 위젯(커뮤니티 내장 PiP)으로
    // 대신 보여준다. 사이트를 벗어난 게 아니므로 굳이 브라우저의 진짜(전역) PiP 창을 띄울 필요는 없다.
    function notifyFocusVisibilityChanged() {
      if (window.GlobalMiniController) window.GlobalMiniController.handleGesture();
    }
    // 달력 모달을 열지 않고도 하루씩 앞뒤로 넘겨보는 빠른 기록 열람 (오늘보다 미래로는 못 감)
    function changeCurrentDate(delta) {
      lockTimeMachineIfActive();
      const curr = new Date(currentDateStr);
      curr.setDate(curr.getDate() + delta);
      const newDateStr = getLocalDateStr(curr);
      if (newDateStr > todayStr) return;
      currentDateStr = newDateStr;
      ensureDailyRecord(currentDateStr);
      switchView('view-main');
      if (timerState.isRunning) notifyFocusVisibilityChanged();
    }

    // ================= 월별 계획 (이달의 목표 + 날짜별 계획) =================
    // 저장: localStorage 'planner_monthly_plans' = { 'YYYY-MM': { goal: '', days: { 'YYYY-MM-DD': '메모' } } } (플래너 기록과 같은 방식 - 이 기기에만 저장)
    let monthlyPlans = safeJSONParse('planner_monthly_plans', {});
    if (!monthlyPlans || typeof monthlyPlans !== 'object' || Array.isArray(monthlyPlans)) monthlyPlans = {};
    let mpYear = new Date().getFullYear(), mpMonth = new Date().getMonth(), mpSelected = null, mpSaveTimer = null;
    const mpKey = () => `${mpYear}-${String(mpMonth + 1).padStart(2, '0')}`;
    const mpDateStr = (d) => `${mpKey()}-${String(d).padStart(2, '0')}`;
    const mpEsc = (t) => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    function mpEnsureMonth() { const k = mpKey(); if (!monthlyPlans[k] || typeof monthlyPlans[k] !== 'object') monthlyPlans[k] = { goal: '', days: {} }; if (!monthlyPlans[k].days) monthlyPlans[k].days = {}; return monthlyPlans[k]; }
    function mpSave() { try { localStorage.setItem('planner_monthly_plans', JSON.stringify(monthlyPlans)); } catch (e) { console.warn('월별 계획 저장 실패:', e); } }
    function mpScheduleSave() { clearTimeout(mpSaveTimer); mpSaveTimer = setTimeout(mpSave, 300); }
    function openMonthlyModal() {
      const t = new Date(); mpYear = t.getFullYear(); mpMonth = t.getMonth(); mpSelected = (mpYear === t.getFullYear() && mpMonth === t.getMonth()) ? todayStr : null;
      renderMonthly(); document.getElementById('modal-monthly').classList.remove('hidden');
    }
    function changeMonthlyMonth(delta) {
      mpSave();
      if (delta === 0) { const t = new Date(); mpYear = t.getFullYear(); mpMonth = t.getMonth(); }
      else { mpMonth += delta; if (mpMonth > 11) { mpMonth = 0; mpYear++; } else if (mpMonth < 0) { mpMonth = 11; mpYear--; } }
      mpSelected = (mpKey() === todayStr.slice(0, 7)) ? todayStr : mpDateStr(1);
      renderMonthly();
    }
    function renderMonthly() {
      const plan = mpEnsureMonth();
      document.getElementById('monthly-title').innerText = `${mpYear}년 ${mpMonth + 1}월 계획`;
      document.getElementById('monthly-goal').value = plan.goal || '';
      const grid = document.getElementById('monthly-grid'); let html = '';
      const firstDay = new Date(mpYear, mpMonth, 1).getDay(); const daysInMonth = new Date(mpYear, mpMonth + 1, 0).getDate();
      for (let i = 0; i < firstDay; i++) html += '<div></div>';
      for (let d = 1; d <= daysInMonth; d++) {
        const ds = mpDateStr(d); const note = (plan.days[ds] || '').trim(); const dow = (firstDay + d - 1) % 7;
        const border = ds === mpSelected ? 'border-sky-500 bg-sky-950/50 shadow-md' : (ds === todayStr ? 'border-amber-500/80 bg-amber-950/40' : 'border-slate-700/80 bg-slate-800/60');
        const dayColor = dow === 0 ? 'text-red-400' : dow === 6 ? 'text-blue-400' : 'text-slate-300';
        html += `<div onclick="PlannerApp.selectMonthlyDay('${ds}')" class="monthly-day min-h-[3.6rem] sm:min-h-[4.6rem] border rounded-xl p-1.5 cursor-pointer flex flex-col items-start overflow-hidden ${border}"><div class="text-[10px] font-bold ${dayColor}">${d}${ds === todayStr ? ' <span class="text-amber-400">·오늘</span>' : ''}</div>${note ? `<div class="monthly-note text-[9px] sm:text-[10px] leading-tight text-slate-200 mt-0.5 break-words">${mpEsc(note.split('\n')[0].slice(0, 40))}</div>` : ''}</div>`;
      }
      grid.innerHTML = html;
      renderMonthlyEditor();
    }
    function renderMonthlyEditor() {
      const label = document.getElementById('monthly-editor-label'), ta = document.getElementById('monthly-day-text'), btn = document.getElementById('monthly-goto-btn');
      if (!mpSelected || mpSelected.slice(0, 7) !== mpKey()) { label.innerText = '날짜를 선택해 주세요'; ta.value = ''; ta.disabled = true; btn.style.display = 'none'; return; }
      const dt = new Date(mpSelected + 'T00:00:00'); const names = ['일', '월', '화', '수', '목', '금', '토'];
      label.innerText = `${dt.getMonth() + 1}월 ${dt.getDate()}일 (${names[dt.getDay()]}) 계획`;
      ta.disabled = false; ta.value = mpEnsureMonth().days[mpSelected] || ''; btn.style.display = '';
    }
    function selectMonthlyDay(ds) { mpSave(); mpSelected = ds; renderMonthly(); }
    function onMonthlyGoalInput() { mpEnsureMonth().goal = document.getElementById('monthly-goal').value; mpScheduleSave(); }
    function onMonthlyDayInput() {
      if (!mpSelected) return;
      const plan = mpEnsureMonth(); const v = document.getElementById('monthly-day-text').value;
      if (v.trim()) plan.days[mpSelected] = v; else delete plan.days[mpSelected];
      mpScheduleSave();
      // 날짜 칸의 미리보기만 가볍게 갱신(입력 중인 칸의 포커스를 잃지 않도록 전체를 다시 그리지 않는다)
      const cell = [...document.querySelectorAll('#monthly-grid .monthly-day')].find(c => c.getAttribute('onclick').includes(`'${mpSelected}'`));
      if (cell) { let n = cell.querySelector('.monthly-note'); const first = v.trim().split('\n')[0].slice(0, 40); if (first) { if (!n) { n = document.createElement('div'); n.className = 'monthly-note text-[9px] sm:text-[10px] leading-tight text-slate-200 mt-0.5 break-words'; cell.appendChild(n); } n.textContent = first; } else if (n) n.remove(); }
    }
    function gotoMonthlyDay() { if (!mpSelected) return; mpSave(); closeModal('modal-monthly'); selectCalendarDate(mpSelected); }
    // ================= 플래너 사진 읽기(베타) =================
    // 외부로 사진을 보내지 않는다: Tesseract.js(글자 인식)를 처음 쓸 때 CDN 에서 내려받아 이 브라우저 안에서만 돌린다.
    // 결과는 항상 사람이 확인/수정한 뒤에만 할 일로 들어간다(손글씨 인식은 틀릴 수 있기 때문).
    const OCR_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    const OCR_MAX_SIDE = 2200, OCR_MIN_SIDE = 1400, OCR_MAX_INPUT = 15 * 1024 * 1024;
    const OCR_HEADER_WORDS = /^(to\s*do|todo|today|year|month|day|d-?day|comment|total\s*time|timetable|metamemo|memo|date)\b/i;
    let ocrSourceCanvas = null, ocrBusy = false;
    function loadOcrLibrary() {
      if (window.Tesseract) return Promise.resolve(window.Tesseract);
      return new Promise((resolve, reject) => {
        const sc = document.createElement('script'); sc.src = OCR_SCRIPT_URL; sc.async = true;
        sc.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('글자 인식 도구를 불러오지 못했어요.'));
        sc.onerror = () => reject(new Error('글자 인식 도구를 내려받지 못했어요. 인터넷 연결을 확인해 주세요.'));
        document.head.appendChild(sc);
      });
    }
    function openPhotoImportModal() {
      ocrSourceCanvas = null;
      document.getElementById('photo-import-file').value = '';
      document.getElementById('photo-import-run').disabled = true;
      document.getElementById('photo-import-preview-wrap').classList.add('hidden');
      document.getElementById('photo-import-result').classList.add('hidden');
      document.getElementById('photo-import-status').textContent = '';
      const di = document.getElementById('photo-import-date'); di.value = todayStr; di.min = todayStr;
      document.getElementById('modal-photo-import').classList.remove('hidden');
    }
    function setOcrStatus(text, isError) { const el = document.getElementById('photo-import-status'); el.textContent = text || ''; el.className = 'mb-3 min-h-[1.2em] ' + (isError ? 'text-red-400' : 'text-slate-400'); }
    async function onPhotoImportFile(input) {
      const file = input.files && input.files[0]; if (!file) return;
      document.getElementById('photo-import-result').classList.add('hidden');
      if (!/^image\//.test(file.type)) { setOcrStatus('이미지 파일을 골라 주세요.', true); input.value = ''; return; }
      if (file.size > OCR_MAX_INPUT) { setOcrStatus('15MB 이하 사진만 쓸 수 있어요.', true); input.value = ''; return; }
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
        const longSide = Math.max(bmp.width, bmp.height);
        const scale = longSide > OCR_MAX_SIDE ? OCR_MAX_SIDE / longSide : (longSide < OCR_MIN_SIDE ? OCR_MIN_SIDE / longSide : 1);
        const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); if (bmp.close) bmp.close();
        ocrSourceCanvas = c;
        const pv = document.getElementById('photo-import-preview'); pv.width = Math.min(c.width, 600); pv.height = Math.round(pv.width * c.height / c.width);
        pv.getContext('2d').drawImage(c, 0, 0, pv.width, pv.height);
        document.getElementById('photo-import-preview-wrap').classList.remove('hidden');
        document.getElementById('photo-import-run').disabled = false;
        setOcrStatus('사진을 불러왔어요. “글자 읽기”를 눌러 주세요.');
      } catch (e) { ocrSourceCanvas = null; document.getElementById('photo-import-run').disabled = true; setOcrStatus('사진을 읽지 못했어요. 다른 사진으로 해 보세요.', true); }
    }
    // 글자 인식 전처리: 지정한 영역을 잘라 흑백으로 바꾸고 밝기 범위를 늘려(오토 레벨) 흐린 연필 글씨도 조금 더 또렷하게 한다
    function ocrPrepareCanvas(area) {
      const src = ocrSourceCanvas; const r = area === 'todo' ? { x: 0, y: 0.2, w: 0.66, h: 0.68 } : { x: 0, y: 0, w: 1, h: 1 };
      const sx = Math.round(src.width * r.x), sy = Math.round(src.height * r.y), sw = Math.round(src.width * r.w), sh = Math.round(src.height * r.h);
      const c = document.createElement('canvas'); c.width = sw; c.height = sh; const ctx = c.getContext('2d');
      ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
      const img = ctx.getImageData(0, 0, sw, sh); const d = img.data; const hist = new Uint32Array(256);
      for (let i = 0; i < d.length; i += 4) { const g = Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114); d[i] = d[i + 1] = d[i + 2] = g; hist[g]++; }
      const total = sw * sh; let lo = 0, hi = 255, acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.01) { lo = v; break; } }
      acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.2) { hi = v; break; } }
      if (hi - lo < 20) { lo = 0; hi = 255; }
      for (let i = 0; i < d.length; i += 4) { const g = Math.max(0, Math.min(255, Math.round((d[i] - lo) * 255 / (hi - lo)))); d[i] = d[i + 1] = d[i + 2] = g; }
      ctx.putImageData(img, 0, 0); return c;
    }
    // OCR 결과 줄 정리: 머리말 글자/기호뿐인 줄/너무 짧은 줄을 걸러내고, 줄 앞의 체크박스·번호·불릿 기호를 뗀다
    function cleanOcrLines(rawLines) {
      const out = [];
      for (const raw of rawLines) {
        let t = String(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
        t = t.replace(/^[\s|\\\/\[\]()<>{}_=~*·•○●□■☐☑✓✔\-–—.:;,'"`!?]+/, '').replace(/[\s|\\\/_=~]+$/, '').trim();
        t = t.replace(/^(?:\d{1,2}\s*[.)]|[\u2460-\u2473])\s*/, '').replace(/^[\s|\\\/\[\]()<>{}_=~*·•○●□■☐☑✓✔\-–—.:;,'"`!?]+/, '').trim(); // "1." "2)" "①" 같은 번호
        const letters = (t.match(/[A-Za-z\uAC00-\uD7A3]/g) || []).length;
        if (letters < 2 || OCR_HEADER_WORDS.test(t)) continue;
        if (letters / t.length < 0.4) continue; // 숫자/기호가 대부분이면 표의 눈금일 가능성이 커서 뺀다
        out.push(t.slice(0, 60));
      }
      return Array.from(new Set(out)).slice(0, 30);
    }
    function renderPhotoImportLines(lines) {
      const box = document.getElementById('photo-import-lines');
      box.innerHTML = lines.map((t, i) => `<label class="flex items-center gap-2 bg-slate-900/60 border border-slate-700 rounded-lg px-2 py-1.5"><input type="checkbox" checked class="photo-import-check accent-emerald-500" data-i="${i}"><input type="text" maxlength="60" value="${mpEsc(t)}" class="photo-import-text flex-1 min-w-0 bg-transparent text-slate-100 outline-none text-sm" data-i="${i}"></label>`).join('');
      document.getElementById('photo-import-result').classList.remove('hidden');
    }
    async function runPhotoImportOcr() {
      if (!ocrSourceCanvas || ocrBusy) return;
      ocrBusy = true; const btn = document.getElementById('photo-import-run'); btn.disabled = true;
      document.getElementById('photo-import-result').classList.add('hidden');
      let worker = null;
      try {
        setOcrStatus('글자 인식 도구를 준비하는 중… (처음에는 몇십 초 걸릴 수 있어요)');
        const T = await loadOcrLibrary();
        worker = await T.createWorker(['kor', 'eng'], 1, { logger: (m) => { if (m && m.status && typeof m.progress === 'number') setOcrStatus(`${m.status === 'recognizing text' ? '글자 읽는 중' : '준비 중'}… ${Math.round(m.progress * 100)}%`); } });
        const canvas = ocrPrepareCanvas(document.getElementById('photo-import-area').value);
        const { data } = await worker.recognize(canvas);
        const raw = (data.lines && data.lines.length ? data.lines.map(l => l.text) : String(data.text || '').split('\n'));
        const lines = cleanOcrLines(raw);
        if (!lines.length) { setOcrStatus('읽힌 글자가 없어요. 더 밝고 반듯한 사진으로, 또는 “사진 전체”로 다시 해 보세요.', true); }
        else { setOcrStatus(`${lines.length}줄을 읽었어요. 틀린 글자는 고치고, 필요 없는 줄은 체크를 풀어 주세요.`); renderPhotoImportLines(lines); }
      } catch (e) { console.warn('플래너 사진 읽기 실패:', e); setOcrStatus((e && e.message) || '글자를 읽지 못했어요. 잠시 후 다시 시도해 주세요.', true); }
      finally { if (worker) { try { await worker.terminate(); } catch (e) {} } ocrBusy = false; btn.disabled = !ocrSourceCanvas; }
    }
    // 외부(사진 읽기/클래스룸)에서 온 할 일을 해당 날짜(오늘 이후)의 할 일로 넣는다. 과목은 첫 번째 과목, 목표 시간은 기본 30분.
    function addExternalTasks(titles, dateStr, targetMin) {
      const date = dateStr || todayStr;
      if (date < todayStr && !isTimeMachineUnlocked) return 0;
      ensureDailyRecord(date); let n = 0;
      titles.forEach((title, i) => { const t = String(title || '').trim().slice(0, 60); if (!t) return;
        state.records[date].tasks.push({ id: 't_' + Date.now() + '_' + Math.floor(Math.random() * 1000) + i, title: t, subjectId: state.subjects[0].id, targetMin: targetMin || 30, completed: false, elapsedSec: 0, isRoutine: false }); n++; });
      if (n) { saveData(); if (date === currentDateStr) { renderTasks(); updateDashboard(); } }
      return n;
    }
    function addPhotoImportTasks() {
      const date = document.getElementById('photo-import-date').value || todayStr;
      if (date < todayStr && !isTimeMachineUnlocked) { uiAlert('오늘 이후 날짜만 고를 수 있어요.'); return; }
      const titles = [...document.querySelectorAll('#photo-import-lines .photo-import-check')].filter(c => c.checked).map(c => document.querySelector(`#photo-import-lines .photo-import-text[data-i="${c.dataset.i}"]`).value);
      const n = addExternalTasks(titles, date, 30);
      if (!n) { uiAlert('추가할 줄을 하나 이상 체크해 주세요.'); return; }
      closeModal('modal-photo-import');
      uiAlert(`${n}개를 ${date === todayStr ? '오늘' : date} 할 일로 추가했어요.`, { icon: '✅', title: '추가 완료' });
    }
    function openCalendarModal() { renderCalendar(); document.getElementById('modal-calendar').classList.remove('hidden'); }
    function changeMonth(delta) { calMonth += delta; if(calMonth > 11) { calMonth = 0; calYear++; } else if(calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); }
    
    function renderCalendar() {
      document.getElementById('calendar-month-title').innerText = `${calYear}년 ${calMonth + 1}월`; const grid = document.getElementById('calendar-grid'); grid.innerHTML = '';
      const firstDay = new Date(calYear, calMonth, 1).getDay(); const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
      for(let i=0; i<firstDay; i++) grid.innerHTML += `<div></div>`;
      for(let d=1; d<=daysInMonth; d++) {
        const dateStr = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`; const record = state.records[dateStr]; 
        let stamp = '', details = ''; let borderClass = dateStr === currentDateStr ? 'border-indigo-500 bg-indigo-950/50 shadow-md' : (dateStr === todayStr ? 'border-amber-500/80 bg-amber-950/40' : 'border-slate-700/80 bg-slate-800/60');
        if (record) {
          const targetSec = (record.tasks||[]).reduce((sum, t) => sum + ((t.targetMin||0) * 60), 0); const totalSec = Object.values(record.grid||{}).reduce((sum, c) => sum + (c.seconds||0), 0);
          if (targetSec > 0 || totalSec > 0) { const pct = targetSec > 0 ? Math.floor((totalSec / targetSec) * 100) : (totalSec>0 ? 100 : 0); stamp = pct >= 100 ? '🔥' : pct >= 80 ? '🟢' : pct >= 50 ? '🟡' : '🔴'; details = `<div class="text-[9px] text-slate-400 mt-0.5 font-mono">${formatTime(totalSec, true)}</div><div class="text-[10px] font-black ${pct>=100 ? 'text-emerald-400' : 'text-slate-300'}">${pct}%</div>`; }
        }
        grid.innerHTML += `<div onclick="PlannerApp.selectCalendarDate('${dateStr}')" class="cal-day-box h-14 border rounded-xl p-1.5 cursor-pointer flex flex-col items-center justify-start ${borderClass}"><div class="text-[10px] font-bold ${dateStr === todayStr ? 'text-amber-400' : 'text-slate-300'}">${d} ${stamp}</div>${details}</div>`;
      }
    }

    function selectCalendarDate(dateStr) { lockTimeMachineIfActive(); closeModal('modal-calendar'); currentDateStr = dateStr; ensureDailyRecord(dateStr); switchView('view-main'); if (timerState.isRunning) notifyFocusVisibilityChanged(); }
    function openSettingsModal() { document.getElementById('modal-settings').classList.remove('hidden'); }
    function handleAddSubject(e) { e.preventDefault(); state.subjects.push({ id: 's_'+Date.now(), name: document.getElementById('input-sub-name').value, color: document.getElementById('input-sub-color').value }); saveData(); renderSubjects(); document.getElementById('form-add-subject').reset(); }
    function deleteSubject(id) { if(state.subjects.length <= 1) { uiAlert('최소 1개의 과목은 존재해야 합니다.'); return; } state.subjects = state.subjects.filter(s => s.id !== id); saveData(); renderSubjects(); }
    function openDdayModal() { document.getElementById('input-dday-title').value = state.dDay.title || ''; document.getElementById('input-dday-date').value = state.dDay.date || todayStr; document.getElementById('modal-dday').classList.remove('hidden'); }
    function handleDdaySubmit(e) { e.preventDefault(); if (!state.dDay) state.dDay = {}; state.dDay.title = document.getElementById('input-dday-title').value; state.dDay.date = document.getElementById('input-dday-date').value; saveData(); updateDdayDisplay(); closeModal('modal-dday'); }
    function updateDdayDisplay() { 
      if(state.dDay && state.dDay.date && state.dDay.title) { 
        const target = new Date(state.dDay.date + "T00:00:00"); const today = new Date(todayStr + "T00:00:00"); const diff = Math.round((target - today) / 86400000); const dStr = diff > 0 ? `D-${diff}` : diff === 0 ? 'D-Day' : `D+${Math.abs(diff)}`;
        document.getElementById('dday-display').innerHTML = `${state.dDay.title} <span class="ml-1 text-white">${dStr}</span>`; 
        const st = document.getElementById('setup-dday-title'); const sc = document.getElementById('setup-dday-count'); if(st && sc) { st.innerText = state.dDay.title; sc.innerText = dStr; }
      } else { document.getElementById('dday-display').innerText = 'D-Day 설정하기'; const st = document.getElementById('setup-dday-title'); const sc = document.getElementById('setup-dday-count'); if(st && sc) { st.innerText = '목표를 설정해주세요'; sc.innerText = 'D-?'; } }
    }

    function resetAllData() { uiConfirm('경고: 모든 플래너 기록과 설정이 완전히 삭제됩니다!\n정말 초기화하시겠습니까?', () => { Object.keys(localStorage).filter(k => k.indexOf('planner_') === 0).forEach(k => localStorage.removeItem(k)); location.reload(); }, {icon:'⚠️', title:'전체 초기화', confirmText:'삭제'}); }
    function exportData() { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(state)], { type: "application/json" })); a.download = `Daily_Planner_Backup_${todayStr}.json`; document.body.appendChild(a); a.click(); document.body.removeChild(a); }
    function importData(e) { const file = e.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = function(evt) { try { const imp = JSON.parse(evt.target.result); if(imp && imp.records) { state = imp; saveData(); init(); uiAlert('데이터 복원 완료!', {icon:'✅', title:'복원 완료'}); closeModal('modal-settings'); } else uiAlert('올바른 백업 파일이 아닙니다.', {icon:'⚠️', title:'오류'}); } catch(err) { uiAlert('파일 읽기 오류.', {icon:'⚠️', title:'오류'}); } }; reader.readAsText(file); e.target.value = ''; }
    function formatTime(sec, short=false) { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return short ? `${h}h ${m}m` : `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; }
    function getLocalDateStr(date) { const offset = date.getTimezoneOffset() * 60000; return new Date(date.getTime() - offset).toISOString().split('T')[0]; }
    // XP는 더 이상 localStorage에 저장하지 않는다(Firebase가 단일 원본). planner_xp는 과거 버전 사용자를 위한
    // 1회 마이그레이션 소스로만 읽힐 뿐, 이후로는 이 함수에서 다시 쓰지 않는다.
    function saveData() { localStorage.setItem('planner_subjects', JSON.stringify(state.subjects)); localStorage.setItem('planner_records', JSON.stringify(state.records)); localStorage.setItem('planner_dday', JSON.stringify(state.dDay)); localStorage.setItem('planner_all_clear', JSON.stringify(state.allClearDates)); localStorage.setItem('planner_admin_pw', JSON.stringify(state.adminPassword)); }
    function handleChangePassword(e) {
      e.preventDefault();
      const input = document.getElementById('input-new-password');
      const val = input.value.trim();
      if (!val) { uiAlert('새 비밀번호를 입력해주세요.'); return; }
      state.adminPassword = val; saveData(); input.value = '';
      uiAlert('관리자 비밀번호가 변경되었습니다.', {icon:'🔑', title:'변경 완료'});
    }

    function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

    // ================= 브라우저 기본 alert/confirm/prompt 대체 (모달 창) =================
    function uiAlert(message, opts = {}) {
      document.getElementById('generic-icon').innerText = opts.icon || 'ℹ️';
      document.getElementById('generic-title').innerText = opts.title || '알림';
      document.getElementById('generic-message').innerText = message;
      document.getElementById('generic-input-wrap').classList.add('hidden');
      document.getElementById('generic-cancel-btn').classList.add('hidden');
      const confirmBtn = document.getElementById('generic-confirm-btn');
      confirmBtn.innerText = opts.confirmText || '확인';
      confirmBtn.onclick = () => { closeModal('modal-generic'); if (opts.onConfirm) opts.onConfirm(); };
      document.getElementById('modal-generic').classList.remove('hidden');
    }

    function uiConfirm(message, onConfirm, opts = {}) {
      document.getElementById('generic-icon').innerText = opts.icon || '❓';
      document.getElementById('generic-title').innerText = opts.title || '확인';
      document.getElementById('generic-message').innerText = message;
      document.getElementById('generic-input-wrap').classList.add('hidden');
      const cancelBtn = document.getElementById('generic-cancel-btn');
      cancelBtn.classList.remove('hidden'); cancelBtn.innerText = opts.cancelText || '취소';
      cancelBtn.onclick = () => { closeModal('modal-generic'); if (opts.onCancel) opts.onCancel(); };
      const confirmBtn = document.getElementById('generic-confirm-btn');
      confirmBtn.innerText = opts.confirmText || '확인';
      confirmBtn.onclick = () => { closeModal('modal-generic'); onConfirm(); };
      document.getElementById('modal-generic').classList.remove('hidden');
    }

    function uiPrompt(message, onSubmit, opts = {}) {
      document.getElementById('generic-icon').innerText = opts.icon || '🔒';
      document.getElementById('generic-title').innerText = opts.title || '입력';
      document.getElementById('generic-message').innerText = message;
      const inputWrap = document.getElementById('generic-input-wrap');
      inputWrap.classList.remove('hidden');
      const input = document.getElementById('generic-input');
      input.value = ''; input.type = opts.isPassword ? 'password' : 'text'; input.placeholder = opts.placeholder || '';
      const cancelBtn = document.getElementById('generic-cancel-btn');
      cancelBtn.classList.remove('hidden'); cancelBtn.innerText = opts.cancelText || '취소';
      cancelBtn.onclick = () => { closeModal('modal-generic'); if (opts.onCancel) opts.onCancel(); };
      const confirmBtn = document.getElementById('generic-confirm-btn');
      confirmBtn.innerText = opts.confirmText || '확인';
      confirmBtn.onclick = () => { const val = input.value; closeModal('modal-generic'); onSubmit(val); };
      input.onkeydown = (e) => { if (e.key === 'Enter') confirmBtn.click(); };
      document.getElementById('modal-generic').classList.remove('hidden');
      setTimeout(() => input.focus(), 50);
    }
    
    init();
  
    // ===== 홈 대시보드 위젯 연동용 (메인 앱에서 window.PlannerApp.getHomeSummary()로 호출) =====
    function getHomeSummary() {
      try {
        const rec = state.records[todayStr] || { tasks: [], grid: {} };
        const tasks = rec.tasks || [];
        const targetSec = tasks.reduce((sum, t) => sum + ((t.targetMin || 0) * 60), 0);
        const totalSec = Object.values(rec.grid || {}).reduce((sum, cell) => sum + (cell.seconds || 0), 0);
        const achPct = targetSec > 0 ? Math.floor((totalSec / targetSec) * 100) : 0;
        const done = tasks.filter(t => t.completed).length;
        return { totalSec, targetSec, achPct, done, total: tasks.length };
      } catch (e) { return { totalSec: 0, targetSec: 0, achPct: 0, done: 0, total: 0 }; }
    }


    // ===== 활동 업적(Achievement) 계산용 - 이 브라우저의 플래너 기록을 그대로 집계한다 (새 저장소 없음) =====
    // 누적 집중 공부 시간(초). 학습가 업적(10h/20h)에 사용된다.
    function getTotalStudySeconds() {
      try {
        let total = 0;
        Object.values(state.records || {}).forEach(rec => {
          Object.values((rec && rec.grid) || {}).forEach(cell => { if (cell && cell.seconds) total += cell.seconds; });
        });
        return total;
      } catch (e) { return 0; }
    }
    // 하루에 할 일을 1개 이상 "완료"한 날이 오늘(또는 어제)부터 며칠 연속으로 이어지는지. 꾸준한 사람(streak5) 업적에 사용된다.
    function getTaskCompletionStreakDays() {
      try {
        const hasCompletedOn = (dateStr) => { const rec = state.records[dateStr]; return !!(rec && rec.tasks && rec.tasks.some(t => t.completed)); };
        let streak = 0;
        let d = new Date(todayStr + 'T00:00:00');
        if (!hasCompletedOn(getLocalDateStr(d))) d.setDate(d.getDate() - 1); // 오늘 기록 전이면 어제부터 거슬러 올라간다
        while (true) {
          const key = getLocalDateStr(d);
          if (hasCompletedOn(key)) { streak++; d.setDate(d.getDate() - 1); } else break;
        }
        return streak;
      } catch (e) { return 0; }
    }
    // 올클리어(하루 할 일 전부 완료) 누적 횟수. allClear5/15/30(실제 기준 3/5/9회) 업적에 사용된다.
    function getAllClearCount() {
      try { return Object.keys(state.allClearDates || {}).length; } catch (e) { return 0; }
    }

    window.PlannerApp = {
      addTask,
      addXP,
      setXPFromCloud,
      resetLocalXPDisplay,
      changeDiaryDate,
      changeMonth,
      closeDropdownOnOutsideClick,
      closeMenuDropdown,
      closeModal,
      confirmStartTask,
      deleteSubject,
      deleteTask,
      ensureDailyRecord,
      exportData,
      formatTime,
      getCellGradient,
      getLocalDateStr,
      getSubject,
      getFocusWidgetData,
      isViewingLiveFocusDate,
      getWeeklyReport,
      getXP,
      getTierInfo,
      handleAddSubject,
      handleChangePassword,
      handleDdaySubmit,
      handleManualOverride,
      handleTaskClick,
      handleWorkspaceNoteInput,
      importData,
      importYesterdayTasks,
      init,
      initDOMCache,
      insertDiaryTemplate,
      loadWorkspaceNote,
      lockTimeMachineIfActive,
      openAddTaskModal,
      openCalendarModal,
      openConfirmStart,
      openDdayModal,
      openDiaryModal,
      openMonthlyModal,
      openPhotoImportModal,
      onPhotoImportFile,
      runPhotoImportOcr,
      addPhotoImportTasks,
      addExternalTasks,
      changeMonthlyMonth,
      selectMonthlyDay,
      onMonthlyGoalInput,
      onMonthlyDayInput,
      gotoMonthlyDay,
      openEditTaskModal,
      openSettingsModal,
      openStatsModal,
      openXpModal,
      pauseTimer,
      renderCalendar,
      renderSetupTaskList,
      renderSetupView,
      renderSubjects,
      renderTasks,
      renderTimetable,
      renderTodaySubjectPieChart,
      renderWorkspacePastStats,
      renderYesterdayTop3,
      resetAllData,
      resetEditMode,
      resumeTimer,
      returnToToday,
      changeCurrentDate,
      safeJSONParse,
      sanitizeState,
      saveData,
      saveDiary,
      selectCalendarDate,
      selectDiaryMood,
      stopTimer,
      switchView,
      taskDragEnd,
      taskDragOver,
      taskDragStart,
      taskDrop,
      timerTick,
      toggleGridEditMode,
      toggleMarkMode,
      setMarkSubject,
      toggleMenuDropdown,
      toggleTaskComplete,
      toggleTimeMachine,
      toggleTimer,
      uiAlert,
      uiConfirm,
      uiPrompt,
      updateCharCount,
      updateClock,
      updateDashboard,
      updateDdayDisplay,
      updateDiaryModalUI,
      updateHeaderDate,
      updateLiveTimerUI,
      updateTierBadge,
      updateViewingStatusUI,
      updateWorkspaceNoteCount,
      updateWorkspaceView,
      getHomeSummary,
      getTotalStudySeconds,
      getTaskCompletionStreakDays,
      getAllClearCount
    };
})();

