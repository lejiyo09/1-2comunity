import { bootApp, assert } from './harness.mjs';
const member = { role: 'class2_member', grade: '1', ban: '2', number: '04', email: '20261204@hanilgo.cnehs.kr', nickname: 'A' };
const mobile = process.argv[2] === 'mobile';
// 앱 14개: 조회수와 등록일이 서로 다르게 섞여 있음 (id 가 a01..a14, 숫자가 클수록 최근)
const apps = Array.from({ length: 14 }, (_, i) => {
  const n = i + 1; const views = [5, 90, 12, 3, 70, 1, 44, 0, 33, 8, 60, 2, 15, 25][i];
  return { id: 'a' + String(n).padStart(2, '0'), name: '앱' + n, description: '설명' + n, author_name: '제작자', category: '유틸리티', file_type: 'html', version: '1.0.0', published: true, views, created_at: new Date(Date.UTC(2026, 8, n)).toISOString(), updated_at: new Date(Date.UTC(2026, 8, n)).toISOString() };
});
const b = await bootApp({ userData: member, uid: 'userA', userEmail: member.email, waitMs: 2000, sbRows: { apps }, viewport: mobile ? { width: 390, height: 800 } : { width: 1280, height: 900 } });
const p = b.page;
const ids = (sel) => p.evaluate((s) => [...document.querySelectorAll(s + ' .as-card')].map(c => c.dataset.id), sel);
try {
  await p.evaluate(() => openAppStore()); await p.waitForSelector('.as-section', { timeout: 8000 });
  const titles = await p.evaluate(() => [...document.querySelectorAll('.as-section-title')].map(t => t.textContent.trim()));
  assert(titles.length === 2 && titles[0].includes('인기') && titles[1].includes('최신'), '전체: 맨 위 "인기 앱" 줄, 그 아래 "최신 앱" 두 구역만 (추천 앱 구역 없음) ' + titles.join(' / '));
  const pop = await p.evaluate(() => [...document.querySelectorAll('.as-section')[0].querySelectorAll('.as-card')].map(c => c.dataset.id));
  const rest = await p.evaluate(() => [...document.querySelectorAll('.as-section')[1].querySelectorAll('.as-card')].map(c => c.dataset.id));
  const cols = await p.evaluate(() => getComputedStyle(document.querySelectorAll('.as-section')[1].querySelector('.as-grid')).gridTemplateColumns.split(' ').length);
  console.log('열 수:', cols, '| 인기:', pop.join(','), '| 최신:', rest.join(','));
  const byViews = [...apps].sort((x, y) => y.views - x.views || y.created_at.localeCompare(x.created_at)).map(a => a.id);
  const wantN = mobile ? 6 : cols;
  assert(pop.length === wantN, `인기 앱 줄 개수 = ${mobile ? '모바일은 옆으로 넘기는 한 줄 6개' : '한 줄에 들어가는 카드 수(' + cols + '개)'} → ${pop.length}`);
  assert(pop.join() === byViews.slice(0, wantN).join(), '인기 앱은 조회수 높은 순 ' + pop.join());
  const geo = await p.evaluate(() => { const g = document.querySelectorAll('.as-section')[0].querySelector('.as-grid'); const cs = [...g.querySelectorAll('.as-card')]; const tops = new Set(cs.map(c => Math.round(c.getBoundingClientRect().top))); return { oneRow: tops.size === 1, strip: g.classList.contains('as-strip'), overflowX: getComputedStyle(g).overflowX }; });
  assert(geo.oneRow, '인기 앱은 정확히 한 줄에 놓임');
  assert(geo.strip === mobile, mobile ? '모바일: 옆으로 넘겨 보는 한 줄(as-strip)' : '데스크톱: 일반 격자 한 줄');
  assert(rest.length === apps.length - pop.length && !rest.some(id => pop.includes(id)), '최신 앱 목록에는 인기 줄에 나온 앱이 다시 나오지 않음');
  const newest = [...apps].filter(a => !pop.includes(a.id)).sort((x, y) => y.created_at.localeCompare(x.created_at)).map(a => a.id);
  assert(rest.join() === newest.join(), '그 아래는 최신 등록순(최근 것이 먼저) ' + rest.join());
  // 카테고리/검색을 고르면 기존처럼 하나의 목록
  await p.evaluate(() => document.querySelector('.as-cat[data-cat="유틸리티"]').click()); await p.waitForTimeout(300);
  assert(await p.evaluate(() => document.querySelectorAll('.as-section').length) === 1 && (await ids('.as-section')).length === 14, '카테고리를 고르면 그 카테고리 전체가 한 목록으로 나옴');
  if (!mobile) {
    // 창을 줄이면 한 줄에 들어가는 개수가 바뀌고 인기 줄이 거기에 맞춰짐
    await p.evaluate(() => document.querySelector('.as-cat[data-cat="전체"]').click()); await p.waitForTimeout(300);
    await p.setViewportSize({ width: 900, height: 900 }); await p.waitForTimeout(600);
    const pop2 = await p.evaluate(() => document.querySelectorAll('.as-section')[0].querySelectorAll('.as-card').length);
    const cols2 = await p.evaluate(() => getComputedStyle(document.querySelectorAll('.as-section')[1].querySelector('.as-grid')).gridTemplateColumns.split(' ').length);
    assert(pop2 === cols2 && cols2 !== cols, `창 크기를 바꾸면 인기 줄도 한 줄 개수(${cols2})에 맞춰짐`);
  }
  assert(!b.errors.some(e => /PAGEERROR/.test(e)), '페이지 오류 없음 ' + b.errors.filter(e => /PAGEERROR/.test(e)).join('|'));
  console.log('\nAPPSTORE ORDER TEST PASSED (' + (mobile ? 'mobile' : 'desktop') + ')');
} finally { await b.close(); }
