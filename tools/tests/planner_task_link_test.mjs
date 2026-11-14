// 플래너 타임테이블: 새벽 2시까지(19줄) + 이어진 칸 한 덩어리 + 편집 칸을 할일과 연결 + 지운 할일 기록 옮기기
import { bootApp, assert } from './harness.mjs';
const member = { role: 'class2_member', grade: '1', ban: '2', number: '04', email: '20261204@hanilgo.cnehs.kr', nickname: 'A' };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fakeNow = new Date(); fakeNow.setHours(13, 0, 0, 0);
const today = ymd(fakeNow);
const subjects = JSON.stringify([{ id: 'sub_1', name: '수학', color: '#6366f1' }, { id: 'sub_2', name: '국어', color: '#10b981' }]);
const records = JSON.stringify({
  [today]: {
    tasks: [
      { id: 'tA', title: '수학 문제집', subjectId: 'sub_1', targetMin: 60, completed: false, elapsedSec: 0 },
      { id: 'tB', title: '수학 오답노트', subjectId: 'sub_1', targetMin: 30, completed: false, elapsedSec: 0 },
      { id: 'tC', title: '국어 비문학', subjectId: 'sub_2', targetMin: 30, completed: false, elapsedSec: 0 },
    ], grid: {}, diary: '', mood: ''
  },
});

const b = await bootApp({ userData: member, uid: 'userA', userEmail: member.email, waitMs: 1500 });
const p = b.page;
const recs = () => p.evaluate(() => JSON.parse(localStorage.getItem('planner_records')));
const task = async (id) => (await recs())[today].tasks.find(t => t.id === id);
const hidden = (id) => p.evaluate((i) => document.getElementById(i).classList.contains('hidden'), id);
try {
  await p.clock.setFixedTime(fakeNow);
  await b.ctx.addInitScript(([r, s]) => { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem('planner_records', r); localStorage.setItem('planner_subjects', s); sessionStorage.setItem('__seeded', '1'); } }, [records, subjects]);
  await p.reload(); await p.waitForTimeout(1800);
  await p.evaluate(() => { switchTab('planner'); PlannerApp.switchView('view-main'); }); await p.waitForTimeout(500);

  // --- 19줄: 07시 ~ 01시(01:50 칸까지) ---
  assert(await p.$('#cell-01-50') !== null && await p.$('#cell-02-00') === null, '타임테이블이 새벽 01:50 칸까지 보임(02시 줄은 없음)');

  // --- 편집 모드: 확인 창 없이 바로 ---
  await p.evaluate(() => PlannerApp.toggleGridEditMode()); await p.waitForTimeout(150);
  assert(await hidden('modal-generic') && !(await hidden('manual-subject-select')), '편집 모드가 확인 창 없이 바로 켜짐');
  await p.selectOption('#manual-subject-select', 'sub_1');

  // 같은 과목에 할일이 2개 → 고르는 창
  await p.click('#cell-09-00'); await p.waitForTimeout(150);
  assert(!(await hidden('modal-task-pick')), '과목에 할일이 여러 개면 어느 할일에 넣을지 묻는 창이 뜸');
  await p.click('#task-pick-list button:has-text("수학 문제집")'); await p.waitForTimeout(200);
  let r = await recs();
  assert(r[today].grid['09:00'].seconds === 600 && r[today].grid['09:00'].segments[0].taskId === 'tA', '칸이 고른 할일(수학 문제집)로 채워짐');
  assert((await task('tA')).elapsedSec === 600, '고른 할일의 누적 시간에 10분이 더해짐');
  assert((await p.innerText('#manual-task-btn')).includes('수학 문제집') && !(await hidden('manual-task-btn')), '지금 찍는 할일 이름이 편집 버튼 옆에 보임');

  // 두 번째 칸은 다시 묻지 않음
  await p.click('#cell-09-10'); await p.waitForTimeout(200);
  assert(await hidden('modal-task-pick') && (await task('tA')).elapsedSec === 1200, '한 번 고른 할일은 편집이 끝날 때까지 다시 묻지 않음');

  // 이어진 칸은 사이 세로줄이 없어짐
  const cls = await p.evaluate(() => [document.getElementById('cell-09-00').className, document.getElementById('cell-09-10').className]);
  assert(!/\bborder-r\b/.test(cls[0]) && /\bborder-r\b/.test(cls[1]), '이어진 두 칸 사이 세로줄이 지워져 한 덩어리로 보임');

  // 칸을 지우면 누적 시간에서도 빠짐
  await p.click('#cell-09-10'); await p.waitForTimeout(200);
  assert((await recs())[today].grid['09:10'].seconds === 0 && (await task('tA')).elapsedSec === 600, '칸을 지우면 그 칸의 10분이 할일 누적 시간에서도 빠짐');

  // 과목을 바꾸면 기억한 할일이 풀리고, 할일이 1개뿐이면 묻지 않고 바로 연결
  await p.selectOption('#manual-subject-select', 'sub_2'); await p.waitForTimeout(100);
  assert(await hidden('manual-task-btn'), '과목을 바꾸면 기억해 둔 할일이 풀림');
  await p.click('#cell-10-00'); await p.waitForTimeout(200);
  assert(await hidden('modal-task-pick') && (await recs())[today].grid['10:00'].segments[0].taskId === 'tC', '과목에 할일이 1개면 묻지 않고 그 할일로 채움');

  // --- 지운 할일의 기록 옮기기 ---
  await p.selectOption('#manual-subject-select', 'sub_1');
  await p.click('#cell-09-10'); await p.waitForTimeout(150); // 다시 묻는 창 → 문제집
  await p.click('#task-pick-list button:has-text("수학 문제집")'); await p.waitForTimeout(200);
  await p.evaluate(() => PlannerApp.resetEditMode()); await p.waitForTimeout(100);
  await p.evaluate(() => PlannerApp.deleteTask('tA')); await p.waitForTimeout(100);
  await p.click('#generic-confirm-btn'); await p.waitForTimeout(200);
  r = await recs();
  assert(r[today].deletedTasks && r[today].deletedTasks.tA === '수학 문제집', '할일을 지워도 이름은 따로 남겨 둠');
  assert(r[today].grid['09:00'].segments[0].taskId === 'tA', '지운 할일의 타임테이블 기록은 그대로 남음');

  await p.evaluate(() => PlannerApp.toggleGridEditMode()); await p.waitForTimeout(150);
  await p.click('#cell-09-00'); await p.waitForTimeout(200);
  assert(!(await hidden('modal-orphan')) && (await p.innerText('#orphan-name')).includes('수학 문제집'), '지운 할일의 칸을 누르면 옮길지 묻는 창(이름 표시)');
  assert(await p.isChecked('#orphan-all') && (await p.innerText('#orphan-count')).includes('2개'), '같은 할일 칸이 여러 개면 "함께 옮기기"가 켜진 채로 나옴');
  await p.click('#orphan-list button:has-text("수학 오답노트")'); await p.waitForTimeout(250);
  r = await recs();
  const segIds = ['09:00', '09:10'].map(k => r[today].grid[k].segments[0].taskId);
  assert(segIds.every(id => id === 'tB') && (await task('tB')).elapsedSec === 1200, '두 칸 모두 수학 오답노트로 옮겨지고 20분이 더해짐');
  assert(!r[today].deletedTasks.tA, '옮길 기록이 없어지면 남겨 둔 이름도 정리됨');
  await p.evaluate(() => document.getElementById('modal-generic').classList.add('hidden'));

  // 지운 할일 칸에서 "이 칸 지우기"
  await p.evaluate(() => PlannerApp.resetEditMode());
  await p.evaluate(() => PlannerApp.deleteTask('tC')); await p.waitForTimeout(100);
  await p.click('#generic-confirm-btn'); await p.waitForTimeout(200);
  await p.evaluate(() => PlannerApp.toggleGridEditMode()); await p.waitForTimeout(150);
  await p.click('#cell-10-00'); await p.waitForTimeout(200);
  await p.click('#orphan-clear-btn'); await p.waitForTimeout(200);
  assert((await recs())[today].grid['10:00'].seconds === 0, '"이 칸 지우기"를 누르면 칸이 비워짐');

  assert(!b.errors.some(e => /PAGEERROR/.test(e)), '페이지 오류 없음 ' + b.errors.filter(e => /PAGEERROR/.test(e)).join('|'));
  console.log('\nPLANNER TASK LINK TEST PASSED');
} finally {
  await b.close();
}
