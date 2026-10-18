import { bootApp, assert } from './harness.mjs';
const member = { role: 'class2_member', grade: '1', ban: '2', number: '04', email: '20261204@hanilgo.cnehs.kr', nickname: 'A' };
const b = await bootApp({ userData: member, uid: 'userA', userEmail: member.email, waitMs: 1500 });
const p = b.page;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
try {
  // 이번 주(월~일) 계획 몇 개 + 다음 주 계획 1개를 미리 저장해 두고 다시 연다
  const dates = await p.evaluate(() => {
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const t = new Date(); t.setHours(0, 0, 0, 0); const mon = new Date(t); mon.setDate(t.getDate() - ((t.getDay() + 6) % 7));
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6); const nextMon = new Date(mon); nextMon.setDate(mon.getDate() + 7);
    const plans = {}; const put = (d, text) => { const k = ymd(d).slice(0, 7); plans[k] = plans[k] || { goal: '', days: {} }; plans[k].days[ymd(d)] = text; };
    // 오늘이 월요일/일요일이어도 겹치지 않게: 시험용 다른 날(x)은 이번 주에서 오늘·월요일이 아닌 날로 고른다
    const other = [1, 2, 3, 4, 5, 6].map(i => { const d = new Date(mon); d.setDate(mon.getDate() + i); return d; }).find(d => ymd(d) !== ymd(t));
    put(mon, '월요일 계획'); put(other, '<img src=x onerror="window.__xss=1">다른 날'); put(nextMon, '다음 주 계획'); put(t, '수학 문제집 3쪽\n영어 단어 50개');
    window.__monIsToday = ymd(mon) === ymd(t);
    localStorage.setItem('planner_monthly_plans', JSON.stringify(plans));
    return { today: ymd(t), mon: ymd(mon), sun: ymd(sun) };
  });
  await p.reload(); await p.waitForTimeout(2000);
  await p.evaluate(() => { switchTab('planner'); PlannerApp.switchView('view-main'); }); await p.waitForTimeout(600);
  // --- 이번 주 계획 줄 ---
  const days = await p.evaluate(() => [...document.querySelectorAll('#week-plan-days .week-plan-day')].map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  console.log(days.join(' | '));
  assert(days.length === 7 && days[0].startsWith('월') && days[6].startsWith('일'), '이번 주 계획: 월요일부터 일요일까지 7칸');
  const monIsToday = await p.evaluate(() => window.__monIsToday);
  assert((monIsToday || days[0].includes('월요일 계획')) && days.some(d => d.includes('다른 날')), '월별 계획에 적은 날짜별 계획이 그 요일 칸에 보임');
  assert(days.some(d => d.includes('오늘') && d.includes('수학 문제집 3쪽')), '오늘 칸에 "오늘" 표시 + 오늘 계획');
  assert(!days.some(d => d.includes('다음 주 계획')), '다음 주 계획은 이번 주 줄에 나오지 않음');
  assert(await p.evaluate(() => !window.__xss && document.getElementById('week-plan-days').innerHTML.includes('&lt;img')), '계획 글의 HTML 은 실행되지 않고 글자로 보임');
  assert(await p.evaluate(() => { const r = document.getElementById('week-plan-bar').getBoundingClientRect(); return r.height > 30 && r.width > 200; }), '이번 주 계획 줄이 플래너 기본 화면에 보임');
  // --- 오늘 메모장 위 "오늘의 계획" ---
  const plan = await p.evaluate(() => ({ hidden: document.getElementById('workspace-day-plan').classList.contains('hidden'), text: document.getElementById('workspace-day-plan-text').textContent, note: document.getElementById('workspace-note').value }));
  assert(!plan.hidden && plan.text === '수학 문제집 3쪽\n영어 단어 50개', '메모장(✏️ 자유롭게 적어보세요) 위에 오늘 계획이 줄바꿈 그대로 자동으로 보임');
  assert(plan.note === '', '내 메모 내용(textarea)은 건드리지 않음');
  // --- 월별 계획에서 고치면 바로 반영 ---
  await p.evaluate(() => document.querySelector('#workspace-day-plan button').click()); await p.waitForTimeout(300);
  assert(await p.evaluate(() => !document.getElementById('modal-monthly').classList.contains('hidden')), '"수정"을 누르면 월별 계획이 그날로 열림');
  const label = await p.innerText('#monthly-editor-label');
  assert(await p.inputValue('#monthly-day-text') === '수학 문제집 3쪽\n영어 단어 50개', '월별 계획 편집칸에 오늘 계획 ' + label);
  await p.fill('#monthly-day-text', '과학 실험 보고서'); await p.waitForTimeout(200);
  assert((await p.innerText('#workspace-day-plan-text')) === '과학 실험 보고서' && (await p.innerText('#week-plan-days')).includes('과학 실험 보고서'), '월별 계획에서 고치면 메모장 위/이번 주 줄에 바로 반영');
  await p.fill('#monthly-day-text', ''); await p.waitForTimeout(200);
  assert(await p.evaluate(() => document.getElementById('workspace-day-plan').classList.contains('hidden')), '오늘 계획을 지우면 "오늘의 계획" 칸도 사라짐');
  await p.evaluate(() => PlannerApp.closeModal('modal-monthly'));
  await p.waitForTimeout(500);
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('planner_monthly_plans')));
  assert(!(saved[dates.today.slice(0, 7)].days[dates.today]), '지운 내용이 저장됨');
  // --- 요일 칸을 누르면 그날 계획 편집 ---
  await p.evaluate(() => document.querySelectorAll('#week-plan-days .week-plan-day')[0].click()); await p.waitForTimeout(300);
  assert(monIsToday || (await p.inputValue('#monthly-day-text')) === '월요일 계획', '이번 주 줄의 요일 칸을 누르면 그날 계획을 바로 고칠 수 있음');
  await p.evaluate(() => PlannerApp.closeModal('modal-monthly'));
  assert(!b.errors.some(e => /PAGEERROR/.test(e)), '페이지 오류 없음 ' + b.errors.filter(e => /PAGEERROR/.test(e)).join('|'));
  console.log('\nPLANNER WEEK PLAN TEST PASSED');
} finally { await b.close(); }
