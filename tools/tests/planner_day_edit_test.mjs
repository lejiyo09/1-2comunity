// 플래너: 이번 주 요일로 이동하면 그날의 할 일·타임테이블이 뜨고 고칠 수 있는지 + 모바일에서 칸이 겹치지 않는지
import { bootApp, assert } from './harness.mjs';
const member = { role: 'class2_member', grade: '1', ban: '2', number: '04', email: '20261204@hanilgo.cnehs.kr', nickname: 'A' };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const add = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
// 어느 요일에 돌려도 같은 경우를 시험하도록 브라우저 시계를 이번 주 수요일 낮으로 고정한다
const now0 = new Date(); now0.setHours(0, 0, 0, 0);
const mon = add(now0, -((now0.getDay() + 6) % 7));
const t = add(mon, 2); const fakeNow = new Date(t); fakeNow.setHours(13, 0, 0, 0);
const D = { today: ymd(t), tomorrow: ymd(add(t, 1)), mon: ymd(mon), sun: ymd(add(mon, 6)), lastMon: ymd(add(mon, -7)), lastTue: ymd(add(mon, -6)) };
const records = JSON.stringify({
  [D.lastMon]: { tasks: [{ id: 'old1', title: '지난주 남은 일', subjectId: 's1', targetMin: 30, completed: false, elapsedSec: 0 }], grid: {}, diary: '', mood: '' },
  [D.lastTue]: { tasks: [{ id: 'plan1', title: '미리 넣은 일', subjectId: 's1', targetMin: 20, completed: false, elapsedSec: 0 }], grid: {}, diary: '', mood: '', plannedAhead: true },
  [D.today]: { tasks: [{ id: 'td1', title: '오늘 할 일', subjectId: 's1', targetMin: 30, completed: false, elapsedSec: 0 }], grid: {}, diary: '', mood: '' },
});

// 페이지를 떠날 때(beforeunload) 플래너가 지금 기록을 다시 저장하므로, 새로 열리는 페이지의 스크립트보다 먼저 한 번만 심는다
async function openPlanner(b) {
  const p = b.page;
  await p.clock.setFixedTime(fakeNow);
  await b.ctx.addInitScript((r) => { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem('planner_records', r); sessionStorage.setItem('__seeded', '1'); } }, records);
  await p.reload(); await p.waitForTimeout(1800);
  await p.evaluate(() => { switchTab('planner'); PlannerApp.switchView('view-main'); }); await p.waitForTimeout(500);
}
const recs = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('planner_records')));
const genericOpen = (p) => p.evaluate(() => !document.getElementById('modal-generic').classList.contains('hidden'));
const closeGeneric = (p) => p.evaluate(() => document.getElementById('modal-generic').classList.add('hidden'));

const b = await bootApp({ userData: member, uid: 'userA', userEmail: member.email, waitMs: 1500 });
const p = b.page;
try {
  await openPlanner(b);
  // --- 앞으로의 날(내일): 이어받기 없이 빈 상태로 미리 계획 ---
  await p.evaluate((ds) => PlannerApp.goToDate(ds), D.tomorrow); await p.waitForTimeout(300);
  let r = await recs(p);
  assert(r[D.tomorrow] && r[D.tomorrow].tasks.length === 0 && r[D.tomorrow].plannedAhead === true, '내일로 가면 오늘 할 일을 미리 끌어오지 않고 빈 계획(plannedAhead)으로 시작');
  assert((await p.innerText('#viewing-status')).includes('미리 계획 중'), '상태 표시: 미리 계획 중');
  assert(await p.isVisible('#workspace-note'), '앞으로의 날도 메모장이 보임');
  await p.evaluate(() => PlannerApp.openAddTaskModal()); await p.waitForTimeout(150);
  assert(await p.evaluate(() => !document.getElementById('modal-add-task').classList.contains('hidden')), '앞으로의 날에 할 일 추가 창이 열림');
  await p.fill('#main-task-title', '내일 영어 단어'); await p.fill('#main-task-target', '30'); await p.evaluate(() => document.getElementById('form-main-add-task').requestSubmit()); await p.waitForTimeout(200);
  r = await recs(p);
  assert(r[D.tomorrow].tasks.some(x => x.title === '내일 영어 단어') && !r[D.today].tasks.some(x => x.title === '내일 영어 단어'), '할 일이 그날(내일)에만 추가됨');
  assert((await p.innerText('#main-task-list')).includes('내일 영어 단어'), 'TASKS 목록에 바로 보임');
  // 타임테이블 편집
  await p.evaluate(() => PlannerApp.toggleGridEditMode()); await p.waitForTimeout(150);
  assert(await genericOpen(p), '타임테이블 편집 확인 창');
  await p.click('#generic-confirm-btn'); await p.waitForTimeout(150);
  await p.click('#cell-09-00'); await p.waitForTimeout(150);
  r = await recs(p);
  assert(r[D.tomorrow].grid['09:00'] && r[D.tomorrow].grid['09:00'].seconds === 600 && !(r[D.today].grid['09:00']), '타임테이블 칸을 고치면 그날 기록에 저장됨');
  // 타이머는 당일만
  const tid = r[D.tomorrow].tasks[0].id;
  await p.evaluate((id) => PlannerApp.openConfirmStart(id), tid); await p.waitForTimeout(150);
  assert(await genericOpen(p) && (await p.innerText('#generic-message')).includes('당일') && await p.evaluate(() => document.getElementById('modal-confirm').classList.contains('hidden')), '앞으로의 날은 타이머 시작 안 됨(안내만)');
  await closeGeneric(p);
  // 메모는 쓰던 날에 저장(저장 전에 날짜를 넘겨도)
  await p.fill('#workspace-note', '내일 메모'); await p.evaluate(() => PlannerApp.returnToToday()); await p.waitForTimeout(700);
  r = await recs(p);
  assert(r[D.tomorrow].workspaceNote === '내일 메모' && !r[D.today].workspaceNote, '메모가 쓰던 날(내일)에 저장되고 오늘로 새지 않음');
  // --- 다음 날 화살표: 이번 주 일요일까지 ---
  await p.evaluate((ds) => PlannerApp.goToDate(ds), D.sun); await p.waitForTimeout(200);
  assert(await p.evaluate(() => document.getElementById('btn-next-date').disabled), '이번 주 일요일에서는 다음 날 화살표가 막힘');
  {
    await p.evaluate(() => PlannerApp.returnToToday()); await p.waitForTimeout(200);
    assert(await p.evaluate(() => !document.getElementById('btn-next-date').disabled), '오늘(일요일 아님)에서는 다음 날로 넘어갈 수 있음');
  }
  // --- 이번 주 지난 요일(월요일): 비밀번호 없이 수정 가능 ---
  {
    await p.evaluate((ds) => PlannerApp.goToDate(ds), D.mon); await p.waitForTimeout(200);
    assert((await p.innerText('#viewing-status')).includes('수정 가능') && await p.isVisible('#workspace-note'), '이번 주 지난 요일: "수정 가능" 표시 + 메모장');
    await p.evaluate(() => PlannerApp.openAddTaskModal()); await p.waitForTimeout(150);
    await p.fill('#main-task-title', '월요일 보충'); await p.fill('#main-task-target', '20'); await p.evaluate(() => document.getElementById('form-main-add-task').requestSubmit()); await p.waitForTimeout(200);
    assert((await recs(p))[D.mon].tasks.some(x => x.title === '월요일 보충'), '이번 주 지난 요일에도 할 일 추가됨');
    await p.evaluate((id) => PlannerApp.openConfirmStart(id), 'x'); await p.waitForTimeout(100);
    assert(await genericOpen(p) && (await p.innerText('#generic-message')).includes('오늘 날짜에서만'), '지난 요일은 타이머 시작 안 됨');
    await closeGeneric(p);
  }
  // --- 지난주 이전: 그대로 잠김 ---
  await p.evaluate((ds) => PlannerApp.goToDate(ds), D.lastMon); await p.waitForTimeout(200);
  await p.evaluate(() => PlannerApp.openAddTaskModal()); await p.waitForTimeout(150);
  assert(await genericOpen(p) && await p.evaluate(() => document.getElementById('modal-add-task').classList.contains('hidden')), '지난주 이전 기록은 할 일 추가가 막힘');
  await closeGeneric(p);
  assert((await p.innerText('#viewing-status')).includes('과거 기록 열람중') && !(await p.isVisible('#workspace-note')), '지난주 이전: "과거 기록 열람중" + 통계 화면');
  // --- 미리 계획해 둔 날이 지나면(오늘 이전) 그때 이어받기를 합친다 ---
  await p.evaluate((ds) => PlannerApp.ensureDailyRecord(ds), D.lastTue); await p.waitForTimeout(100);
  r = await recs(p);
  const titles = r[D.lastTue].tasks.map(x => x.title);
  assert(titles.includes('미리 넣은 일') && titles.includes('지난주 남은 일') && !r[D.lastTue].plannedAhead, '미리 계획한 날이 되면 그 전날 남은 일을 합쳐 이어받음 ' + titles.join(','));
  assert(!b.errors.some(e => /PAGEERROR/.test(e)), '페이지 오류 없음 ' + b.errors.filter(e => /PAGEERROR/.test(e)).join('|'));
} finally { await b.close(); }

// --- 모바일: WORKSPACE / TASKS / TIMETABLE 이 겹치지 않고 위에서 아래로 쌓임 ---
const m = await bootApp({ userData: member, uid: 'userA', userEmail: member.email, waitMs: 1500, viewport: { width: 390, height: 844 } });
try {
  await openPlanner(m);
  const box = await m.page.evaluate(() => {
    const g = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: r.height, w: r.width, right: r.right }; };
    const tasksSec = document.getElementById('main-task-list').parentElement;
    const tr = tasksSec.getBoundingClientRect();
    return { ws: g('#workspace-iframe-container'), tasks: { top: tr.top, bottom: tr.bottom, h: tr.height }, list: g('#main-task-list'), tt: g('#timetable-area'), header: g('#planner-header'), menu: g('#menu-dropdown-btn'), vw: innerWidth, sw: document.documentElement.scrollWidth };
  });
  console.log(JSON.stringify(box));
  assert(box.ws.h >= 200 && box.ws.bottom <= box.tasks.top + 1, '모바일: 메모장이 충분히 크고 TASKS 와 겹치지 않음');
  assert(box.list.h >= 90 && box.tasks.bottom <= box.tt.top + 1, '모바일: TASKS 목록이 보이고 TIMETABLE 과 겹치지 않음');
  assert(box.tt.h >= 400, '모바일: 타임테이블이 읽을 수 있는 높이 (' + Math.round(box.tt.h) + 'px)');
  assert(box.menu.right <= box.vw && box.header.h < 200, '모바일: 머리글 메뉴 버튼이 화면 안에 있고 머리글이 세로로 늘어지지 않음');
  assert(box.sw <= box.vw + 1, '모바일: 가로 스크롤 없음');
  console.log('\nPLANNER DAY EDIT TEST PASSED');
} finally { await m.close(); }
