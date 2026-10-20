// 스쿼드 메이커: 선수 기록(xG/xA/PPDA/프로그레시브 패스·캐리/기회 창출) 입력 + 오각형 레이더 비교
//   node squad_stats_test.mjs          → 우리 반 학생: 입력·저장·비교·표·툴팁
//   node squad_stats_test.mjs denied   → 규칙에 squad_stats 가 없을 때 안내
import { bootApp, assert } from './harness.mjs';
const mode = process.argv[2] || 'member';
const member = { role: 'class2_member', grade: '1', ban: '2', number: '04', email: '20261204@hanilgo.cnehs.kr', nickname: 'A' };
const fsData = {
  'squad_stats/7': { xg: 0.8, xa: 0.2, ppda: 8, progPass: 5, progCarry: 3, chances: 2 },
  'squad_stats/12': { xg: 0.3, xa: 0.6, ppda: 12, progPass: 10, progCarry: 6, chances: 5 },
  'squad_stats/3': { xg: 0.1, xa: 0.1, ppda: 20, progPass: 1, progCarry: null, chances: 0 },
  'profiles/student_7': { name: '칠번<b>x</b>' }, 'profiles/student_12': { name: '십이번' },
};
const b = await bootApp({ userData: member, uid: 'userA', userEmail: member.email, waitMs: 1500, fsData, fsDeny: mode === 'denied' ? 'squad_stats' : null });
const p = b.page;
try {
  await p.evaluate(() => { try { localStorage.removeItem('squad_compare_sel'); } catch (e) {} switchTab('squad'); }); await p.waitForTimeout(600);
  if (mode === 'denied') {
    assert((await p.innerText('#squad-stats-status')).includes('권한'), '규칙이 없어 못 읽으면 권한 안내가 보임');
    assert(!b.errors.some(e => /PAGEERROR/.test(e)), '페이지 오류 없음');
    console.log('\nSQUAD STATS TEST PASSED (denied)');
  } else {
    // 처음엔 기록 있는 앞쪽 두 명(3, 7번)을 비교
    const chips = await p.$$eval('#squad-stats-chips .squad-chip', els => els.map(e => ({ t: e.innerText.trim(), on: e.getAttribute('aria-pressed') })));
    console.log(JSON.stringify(chips));
    assert(chips.length === 3 && chips.filter(c => c.on === 'true').length === 2, '기록 있는 선수 3명이 칩으로, 처음엔 2명 비교');
    assert(await p.evaluate(() => document.querySelectorAll('#squad-radar svg .squad-radar-grid').length === 4 && document.querySelectorAll('#squad-radar svg .squad-radar-area').length === 2), '오각형 눈금 4겹 + 선수 2명 영역');
    const pent = await p.evaluate(() => document.querySelector('#squad-radar svg .squad-radar-grid').getAttribute('points').split(' ').length);
    assert(pent === 5, '오각형(꼭짓점 5개)');
    const labels = await p.$$eval('#squad-radar .squad-radar-label', els => els.map(e => e.textContent));
    assert(['xG', 'xA', '기회 창출', '전진 패스·캐리', '압박 (PPDA)'].every(l => labels.includes(l)), '다섯 축 이름 ' + labels.join(','));
    assert(await p.evaluate(() => !document.querySelector('#squad-stats-card b') && document.getElementById('squad-stats-chips').innerText.includes('칠번<b>x</b>')), '친구 프로필 이름을 쓰되 HTML 은 글자로');
    // 12번 추가 → 3명, 기존 두 명 색은 그대로
    const before = await p.$$eval('#squad-radar .squad-radar-area', els => els.map(e => e.style.fill));
    await p.click('#squad-stats-chips .squad-chip:has-text("십이번")'); await p.waitForTimeout(200);
    const after = await p.$$eval('#squad-radar .squad-radar-area', els => els.map(e => e.style.fill));
    assert(after.length === 3 && before.every(c => after.includes(c)), '선수를 더해도 기존 선수 색은 그대로 ' + after.join(' | '));
    // 7번은 xG 최고 → xG 축 꼭짓점이 바깥 끝(반지름 110)
    const top = await p.evaluate(() => { const hit = [...document.querySelectorAll('#squad-radar .squad-radar-hit')].find(h => h.dataset.n === '7' && h.dataset.i === '0'); return +hit.getAttribute('cy'); });
    assert(Math.abs(top + 110) < 0.2, 'xG 최고 선수는 xG 축 끝(100점)');
    // PPDA 는 낮을수록 높은 점수: 7번(8) 100점, 3번(20) 40점
    await p.hover('#squad-radar .squad-radar-hit[data-n="3"][data-i="4"]', { force: true }); await p.waitForTimeout(100);
    const tip = await p.innerText('#squad-radar-tip');
    assert(tip.includes('압박 (PPDA): 20.0') && tip.includes('40점'), 'PPDA 는 낮을수록 높은 점수 + 마우스를 올리면 실제 값 ' + tip.replace(/\n/g, ' '));
    // 표에 실제 값
    const table = await p.innerText('#squad-stats-table');
    assert(table.includes('0.80') && table.includes('프로그레시브 캐리') && table.includes('—'), '표에 실제 입력값(빈 칸은 —)');
    // 내 번호(4번)가 기본 선택 → 입력 후 저장
    assert(await p.inputValue('#squad-stats-player') === '4', '입력할 선수는 내 번호가 기본');
    await p.fill('#squad-stat-xg', '1.2'); await p.fill('#squad-stat-xa', '0.4'); await p.fill('#squad-stat-ppda', '6'); await p.fill('#squad-stat-chances', '3'); await p.fill('#squad-stat-progPass', '7');
    await p.click('#squad-stats-save'); await p.waitForTimeout(400);
    const saved = await p.evaluate(() => window.__fb.fs['squad_stats/4']);
    assert(saved && saved.xg === 1.2 && saved.ppda === 6 && saved.progCarry === null && saved.updatedBy === 'userA', '저장: 숫자 + 빈 칸은 null ' + JSON.stringify(saved));
    assert(await p.$$eval('#squad-radar .squad-radar-area', els => els.length) === 4, '방금 기록한 선수가 비교에 바로 추가(4명)');
    // 5번째는 막힘
    await p.selectOption('#squad-stats-player', '20'); await p.fill('#squad-stat-xg', '0.5'); await p.click('#squad-stats-save'); await p.waitForTimeout(400);
    assert(await p.$$eval('#squad-radar .squad-radar-area', els => els.length) === 4, '최대 4명까지 비교');
    await p.click('#squad-stats-chips .squad-chip[aria-pressed="false"]'); await p.waitForTimeout(150);
    assert((await p.innerText('#squad-stats-status')).includes('최대 4명'), '5명째 선택 시 안내');
    // 잘못된 값
    await p.fill('#squad-stat-xg', '-1'); assert(await p.evaluate(() => !document.getElementById('squad-stats-form').checkValidity()), '음수는 입력칸에서 바로 막힘(브라우저 검사)'); await p.evaluate(() => saveSquadStats()); await p.waitForTimeout(150);
    assert((await p.innerText('#squad-stats-status')).includes('xG 값을 확인'), '음수는 저장 안 됨(검사 우회해도)');
    // 새로고침해도 비교 선택 유지
    await p.reload(); await p.waitForTimeout(2000); await p.evaluate(() => switchTab('squad')); await p.waitForTimeout(500);
    // (가짜 Firestore 는 새로고침하면 처음 데이터로 돌아가 방금 저장한 4·20번 기록이 없다 → 남은 3·7·12번이 선택된 채로)
    assert(await p.$$eval('#squad-stats-chips .squad-chip[aria-pressed="true"]', els => els.length) === 3 && await p.$$eval('#squad-radar .squad-radar-area', els => els.length) === 3, '비교 선택이 새로고침 뒤에도 유지');
    // 모바일 화면
    await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(300);
    const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, card: document.getElementById('squad-stats-card').getBoundingClientRect().width, radar: document.querySelector('#squad-radar svg').getBoundingClientRect().width }));
    assert(m.sw <= 391 && m.radar > 250, '휴대폰: 가로 스크롤 없이 레이더가 보임 ' + JSON.stringify(m));
    await p.evaluate(() => document.getElementById('squad-stats-card').scrollIntoView());
    await p.screenshot({ path: (process.env.SHOT_DIR || '/tmp') + '/squad-mobile.png' });
    assert(!b.errors.some(e => /PAGEERROR/.test(e)), '페이지 오류 없음 ' + b.errors.filter(e => /PAGEERROR/.test(e)).join('|'));
    console.log('\nSQUAD STATS TEST PASSED (member)');
  }
} finally { await b.close(); }
