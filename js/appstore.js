
        import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
        import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";
        import { ZipError, zipSafePath, zipInflate, zipOpen as zipOpenRaw, makeZip as asMakeZip } from "./appstore-zip.js";

        // =========================================================================
        // 앱스토어: HTML 웹앱(단일 .html 또는 .zip)을 올려 게시하고, 누구나 /app/<id> 에서 실행·다운로드하는 기능.
        //
        // - 저장소: 자료실과 같은 Supabase 프로젝트의 apps / app_versions 테이블 + webapps 스토리지 버킷
        //   (supabase/migrations/20261002_appstore.sql). 읽기는 anon 키로 직접(RLS: 공개 앱만),
        //   쓰기는 Edge Function apps-write 가 Firebase ID 토큰을 검증하고 "본인 앱"일 때만 수행한다.
        // - 실행: 업로드된 HTML/JS 는 이 사이트와 같은 출처에서 절대 실행하지 않는다. sandbox="allow-scripts" (allow-same-origin 없음)
        //   iframe 안에서만 실행되어 "고유하지 않은(opaque) 출처"가 되므로 부모 DOM/localStorage/Firebase·Supabase 토큰/쿠키에 접근할 수 없다.
        // - 로그인 정보는 main 스크립트가 노출한 window.__gmwAuth 브리지로만 받는다(토큰은 apps-write 호출에만 쓴다).
        // =========================================================================
        const AS_SB_URL = SUPABASE_URL; // js/config.js 의 같은 Supabase 프로젝트
        const AS_SB_KEY = SUPABASE_PUBLISHABLE_KEY;
        const AS_BUCKET = "webapps";
        const AS_FN_URL = `${AS_SB_URL}/functions/v1/apps-write`;
        // 자료실 클라이언트(위쪽 sb)와 같은 프로젝트라 저장 키가 같으면 "Multiple GoTrueClient instances" 경고가 나므로 키를 따로 쓴다(이 클라이언트는 세션을 저장하지 않는다).
        const sbApps = createClient(AS_SB_URL, AS_SB_KEY, { auth: { storageKey: 'gmw-appstore-anon', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });

        const AS_BASE_TITLE = document.title; // 앱 화면에서 바꾼 탭 제목을 되돌릴 때 쓴다
        const AS_CATEGORIES = ['유틸리티', '게임', '교육', '생산성', '엔터테인먼트', '도구', '기타'];
        // 로그인하지 않은 방문자(게스트)에게는 보이지 않는 카테고리 - 목록/검색/추천/상세/실행 전부에서 숨긴다.
        // (Supabase 는 Firebase 로그인 여부를 몰라 서버에서 걸러낼 수 없으므로 화면에서만 숨기는 정책이다.)
        // 선생님 계정에도 같은 카테고리를 숨긴다(학생 계정에서만 보임).
        const AS_MEMBER_ONLY_CATEGORIES = ['게임', '엔터테인먼트'];
        const asIsTeacher = () => { try { return !!(AUTH().isTeacher && AUTH().isTeacher()); } catch (e) { return false; } };
        const asHidesRestricted = () => !AUTH().user() || asIsTeacher(); // 게스트 또는 선생님
        const asCanSee = (app) => !asHidesRestricted() || !AS_MEMBER_ONLY_CATEGORIES.includes(app.category);
        const asVisibleCategories = () => asHidesRestricted() ? AS_CATEGORIES.filter(c => !AS_MEMBER_ONLY_CATEGORIES.includes(c)) : AS_CATEGORIES;
        const AS_LIMITS = {
            html: 800 * 1024, // 단일 HTML 은 800KB 까지(더 큰 앱은 ZIP 또는 외부 링크)
             zip: 800 * 1024, icon: 1 * 1024 * 1024,
            zipEntries: 400, zipFileBytes: 15 * 1024 * 1024, zipTotalBytes: 30 * 1024 * 1024,
            appData: 512 * 1024, // 앱이 sandbox 안에서 쓰는 localStorage 대용품을 이 브라우저에 저장하는 최대 크기(앱당)
            appDataTotal: 2 * 1024 * 1024 // 모든 앱을 합친 최대 크기(앱이 이 사이트의 저장 공간을 다 차지해 버리지 못하게)
        };
        const AS_MIME = {
            html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', txt: 'text/plain',
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif', bmp: 'image/bmp',
            mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
            mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
            woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', xml: 'application/xml', wasm: 'application/wasm', csv: 'text/csv'
        };

        const asEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const AUTH = () => window.__gmwAuth || { user: () => null, token: async () => null, login: () => {}, displayName: () => '익명' };
        const asPublicUrl = (path) => `${AS_SB_URL}/storage/v1/object/public/${AS_BUCKET}/${path}`;
        const asFmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`; };
        const asFmtSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';

        // ---------------------------------------------------------------- 상태
        const AS = { apps: [], loadedAt: 0, loading: false, loadError: '', cat: '전체', q: '', mine: null, view: 'list', appId: null, app: null, form: null, runFrame: null, runAppId: null };

        // ---------------------------------------------------------------- 서버 호출
        async function asCallFn(body) {
            const token = await AUTH().token();
            if (!token) throw new Error('로그인이 필요해요.');
            const resp = await fetch(AS_FN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AS_SB_KEY}` },
                body: JSON.stringify({ ...body, firebaseIdToken: token })
            });
            const data = await resp.json().catch(() => null);
            if (!resp.ok || !data || data.error) throw new Error((data && data.error) || `요청에 실패했어요 (${resp.status})`);
            return data;
        }

        async function asLoadApps(force) {
            if (AS.loading) return;
            if (!force && AS.apps.length && Date.now() - AS.loadedAt < 30000) return;
            AS.loading = true; AS.loadError = '';
            try {
                const { data, error } = await sbApps.from('apps').select('*').eq('published', true).order('created_at', { ascending: false }).limit(500);
                if (error) throw error;
                AS.apps = data || []; AS.loadedAt = Date.now();
            } catch (e) {
                AS.loadError = '앱 목록을 불러오지 못했어요. (앱스토어 DB 설정이 끝났는지 확인해주세요)';
                console.warn('앱 목록 로드 실패:', e);
            }
            AS.loading = false;
        }
        async function asLoadMine() {
            if (!AUTH().user()) { AS.mine = []; return; }
            try { AS.mine = (await asCallFn({ action: 'mine' })).apps || []; } catch (e) { AS.mine = []; console.warn(e); }
        }
        async function asFindApp(id) {
            let app = AS.apps.find(a => a.id === id) || (AS.mine || []).find(a => a.id === id);
            if (app) return app;
            try {
                const { data } = await sbApps.from('apps').select('*').eq('id', id).maybeSingle();
                if (data) return data;
            } catch (e) { /* 아래에서 비공개 앱(내 앱)도 찾아본다 */ }
            if (AUTH().user()) { await asLoadMine(); app = (AS.mine || []).find(a => a.id === id); }
            return app || null;
        }

        // ---------------------------------------------------------------- 표시 보조
        function asIconHtml(app, size) {
            const px = size || 56;
            if (app.icon_url) return `<img class="as-icon-img" style="width:${px}px;height:${px}px;" src="${asEsc(app.icon_url)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;as-icon-fallback&quot; style=&quot;width:${px}px;height:${px}px;&quot;>🧩</div>'">`;
            let h = 0; for (const c of String(app.id)) h = (h * 31 + c.charCodeAt(0)) % 360;
            const letter = asEsc((String(app.name || '?').trim()[0] || '?').toUpperCase());
            return `<div class="as-icon-fallback" style="width:${px}px;height:${px}px;font-size:${Math.round(px * 0.45)}px;background:linear-gradient(135deg,hsl(${h},70%,58%),hsl(${(h + 40) % 360},70%,46%));">${letter}</div>`;
        }
        // 외부 링크: https 만, 표시용 호스트 (서버도 같은 규칙으로 검사한다)
        function asExtUrl(app) {
            try { const u = new URL(app && app.external_url || ''); return u.protocol === 'https:' ? u : null; } catch (e) { return null; }
        }
        const asIsLink = (app) => app.file_type === 'link';
        function asCardHtml(app, opts) {
            const mine = opts && opts.mine;
            return `<div class="as-card" data-as="open" data-id="${asEsc(app.id)}">
                ${asIconHtml(app, 56)}
                <div class="as-card-body">
                    <div class="as-name">${asEsc(app.name)}${asIsLink(app) ? ' <span class="as-chip as-chip-ext">🌐 외부 링크</span>' : ''}${mine && !app.published ? ' <span class="as-chip as-chip-warn">비공개</span>' : ''}</div>
                    <div class="as-desc">${asEsc(app.description || '설명이 없어요')}</div>
                    <div class="as-meta"><span>${asEsc(app.author_name || '익명')}</span><span>v${asEsc(app.version)}</span><span>👁 ${Number(app.views || 0).toLocaleString()}</span><span>${asFmtDate(app.created_at)}</span></div>
                </div>
                ${mine ? `<button class="as-card-edit" data-as="edit" data-id="${asEsc(app.id)}" title="수정">✏️</button>` : ''}
            </div>`;
        }
        const asSection = (title, apps, opts) => apps.length ? `<section class="as-section"><h3 class="as-section-title">${title}</h3><div class="as-grid">${apps.map(a => asCardHtml(a, opts)).join('')}</div></section>` : '';

        // ---------------------------------------------------------------- 렌더링: 목록
        function asRenderList(root) {
            const user = AUTH().user();
            const q = AS.q.trim().toLowerCase();
            const visibleApps = AS.apps.filter(asCanSee);
            if (AS.cat === '내 앱' && !user) AS.cat = '전체';
            if (AS_MEMBER_ONLY_CATEGORIES.includes(AS.cat) && asHidesRestricted()) AS.cat = '전체';
            const catChips = ['전체', ...asVisibleCategories(), ...(user ? ['내 앱'] : [])].map(c => `<button class="as-cat ${AS.cat === c ? 'active' : ''}" data-as="cat" data-cat="${asEsc(c)}">${asEsc(c)}</button>`).join('');
            let body = '';
            if (AS.cat === '내 앱') {
                body = AS.mine === null ? '<div class="as-empty">불러오는 중…</div>'
                    : (AS.mine.length ? asSection('내가 올린 앱', AS.mine, { mine: true }) : '<div class="as-empty">아직 올린 앱이 없어요. 오른쪽 위 “앱 등록”으로 첫 앱을 올려보세요!</div>');
            } else if (AS.loading && !AS.apps.length) {
                body = '<div class="as-empty">불러오는 중…</div>';
            } else if (AS.loadError) {
                body = `<div class="as-empty">${asEsc(AS.loadError)}</div>`;
            } else {
                const filtered = visibleApps.filter(a => (AS.cat === '전체' || a.category === AS.cat) && (!q || `${a.name} ${a.description} ${a.author_name}`.toLowerCase().includes(q)));
                if (q || AS.cat !== '전체') {
                    body = filtered.length ? asSection(q ? `“${asEsc(AS.q.trim())}” 검색 결과` : asEsc(AS.cat), filtered) : '<div class="as-empty">조건에 맞는 앱이 없어요.</div>';
                } else if (!visibleApps.length) {
                    body = '<div class="as-empty">아직 등록된 앱이 없어요. 첫 번째 앱을 올려보세요! 🚀</div>';
                } else {
                    const popular = [...visibleApps].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 6);
                    const latest = visibleApps.slice(0, 6);
                    let featured = visibleApps.filter(a => a.featured).slice(0, 6);
                    if (!featured.length) { // 추천 앱을 따로 지정하지 않았다면 날짜마다 바뀌는 추천을 보여준다
                        const day = Math.floor(Date.now() / 86400000);
                        featured = [...visibleApps].sort((a, b) => ((a.id.charCodeAt(0) * 31 + day) % 97) - ((b.id.charCodeAt(0) * 31 + day) % 97)).slice(0, Math.min(3, visibleApps.length));
                    }
                    body = asSection('🔥 인기 앱', popular) + asSection('🆕 최신 앱', latest) + asSection('✨ 추천 앱', featured);
                }
            }
            root.innerHTML = `
                <div class="header as-header">
                    <div><h1>앱스토어 🧩</h1><p>HTML 웹앱을 올리고, 누구나 바로 실행해 보세요</p></div>
                    <button class="auth-btn as-btn-new" data-as="new">＋ 앱 등록</button>
                </div>
                <div class="as-toolbar"><input id="as-search" class="community-search-input" placeholder="🔎 앱 이름·설명·제작자 검색" value="${asEsc(AS.q)}" autocomplete="off"></div>
                <div class="as-cats">${catChips}</div>
                ${body}`;
        }

        // ---------------------------------------------------------------- 렌더링: 상세
        async function asRenderDetail(root) {
            const id = AS.appId;
            root.innerHTML = '<div class="as-empty">불러오는 중…</div>';
            const app = await asFindApp(id);
            if (AS.view !== 'detail' || AS.appId !== id) return; // 그 사이 다른 화면으로 이동
            if (!app) {
                root.innerHTML = `<div class="community-back-link" data-as="home">← 앱스토어</div><div class="card as-empty">존재하지 않거나 비공개로 바뀐 앱이에요.</div>`;
                return;
            }
            if (!asCanSee(app)) { asRenderMemberOnly(root); return; }
            AS.app = app;
            document.title = `${app.name} · 앱스토어`;
            asCountView(app);
            const u = AUTH().user();
            const isOwner = !!u && u.uid === app.author_uid;
            let versions = [];
            try { const { data } = await sbApps.from('app_versions').select('*').eq('app_id', app.id).order('created_at', { ascending: false }).limit(30); versions = data || []; } catch (e) { /* 이력이 없어도 상세는 보인다 */ }
            if (AS.view !== 'detail' || AS.appId !== id) return;
            const dl = app.file_type === 'zip' ? 'ZIP 다운로드' : 'HTML 다운로드';
            const linkOnly = asIsLink(app), ext = asExtUrl(app);
            const extBtn = ext ? `<a class="${linkOnly ? 'auth-btn as-btn-run' : 'btn-sub'}" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center;" href="${asEsc(ext.href)}" target="_blank" rel="noopener noreferrer nofollow" data-as-ext="1">🌐 외부 링크로 열기</a>` : '';
            const extBox = ext ? `<div class="as-ext-box">${linkOnly ? '용량이 커서 앱스토어에서 직접 실행·다운로드는 지원하지 않는 앱이에요. 제작자가 따로 올려 둔 외부 주소로 연결돼요.' : '제작자가 따로 걸어 둔 외부 공유 링크예요.'}<br>⚠️ 외부 사이트라 앱스토어의 격리(sandbox) 보호가 적용되지 않아요. 아는 사이트인지 확인하고 이용하세요.<br>주소 <a href="${asEsc(ext.href)}" target="_blank" rel="noopener noreferrer nofollow">${asEsc(ext.hostname)}</a></div>` : '';
            root.innerHTML = `
                <div class="community-back-link" data-as="home">← 앱스토어</div>
                <div class="card as-detail">
                    <div class="as-detail-top">
                        ${asIconHtml(app, 88)}
                        <div class="as-detail-info">
                            <h2 class="as-detail-name">${asEsc(app.name)}${!app.published ? ' <span class="as-chip as-chip-warn">비공개</span>' : ''}</h2>
                            <div class="as-detail-sub">${asEsc(app.author_name || '익명')} · <span class="as-chip">${asEsc(app.category)}</span></div>
                            <div class="as-stats">
                                <div><b>v${asEsc(app.version)}</b><span>버전</span></div>
                                <div><b>${Number(app.views || 0).toLocaleString()}</b><span>조회수</span></div>
                                <div><b>${asFmtDate(app.updated_at)}</b><span>업데이트</span></div>
                                <div><b>${asFmtDate(app.created_at)}</b><span>등록일</span></div>
                            </div>
                        </div>
                    </div>
                    <div class="as-actions">
                        ${linkOnly ? extBtn : `<button class="auth-btn as-btn-run" data-as="run" data-id="${asEsc(app.id)}">▶ 웹에서 실행</button>
                        <button class="btn-sub" data-as="download" data-id="${asEsc(app.id)}">⬇ ${dl}</button>${extBtn}`}
                        <button class="btn-sub" data-as="copylink" data-id="${asEsc(app.id)}">🔗 링크 복사</button>
                        ${isOwner ? `<button class="btn-sub" data-as="edit" data-id="${asEsc(app.id)}">✏️ 수정</button>` : ''}
                    </div>
                    ${extBox}
                    <div class="as-desc-full">${asEsc(app.description || '설명이 없어요.').replace(/\n/g, '<br>')}</div>
                    <div class="as-link-row">주소 <code>${asEsc(location.origin)}/app/${asEsc(app.id)}</code></div>
                    ${versions.length ? `<h3 class="as-section-title" style="margin-top:22px;">업데이트 기록</h3><div class="as-versions">${versions.map(v => `<div class="as-version"><b>v${asEsc(v.version)}</b><span>${asFmtDate(v.created_at)}</span><p>${asEsc(v.changelog || '').replace(/\n/g, '<br>') || '<i>변경 내용 없음</i>'}</p></div>`).join('')}</div>` : ''}
                </div>`;
        }
        function asRenderMemberOnly(root) {
            document.title = AS_BASE_TITLE;
            root.innerHTML = `<div class="community-back-link" data-as="home">← 앱스토어</div>
                <div class="card as-empty">🔒 ${AUTH().user() ? '이 앱은 학생 계정에게만 보여요.' : '이 앱은 로그인한 학생에게만 보여요.'}${AUTH().user() ? '' : '<br><br><button class="auth-btn" data-as="login" style="max-width:220px;">🔑 로그인하고 보기</button>'}</div>`;
        }
        function asCountView(app) {
            const key = `gmw_app_viewed:${app.id}`;
            try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch (e) { return; }
            app.views = (app.views || 0) + 1; // 화면에는 바로 반영하고, 서버에는 조용히 +1
            sbApps.rpc('increment_app_views', { p_app_id: app.id }).then(() => {}, () => {});
        }

        const zipOpen = (buf) => zipOpenRaw(buf, AS_LIMITS, asFmtSize); // 한도/크기 표시는 이 파일이 정하고, ZIP 검사 자체는 appstore-zip.js

        // ---------------------------------------------------------------- 실행 문서 만들기 (srcdoc)
        function asBytesToB64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
        const asExt = (name) => (String(name).split('.').pop() || '').toLowerCase();
        const asIsLocalRef = (u) => !!u && !/^(data:|blob:|https?:|\/\/|about:|javascript:|mailto:|tel:|#)/i.test(String(u).trim());
        function asResolvePath(ref, baseDir) { // ref(HTML이 적은 상대 경로) → ZIP 안의 정규화된 경로(실패하면 null)
            let r = String(ref).trim().split('#')[0].split('?')[0];
            try { r = decodeURIComponent(r); } catch (e) { /* 그대로 */ }
            r = r.replace(/\\/g, '/');
            const parts = r.startsWith('/') ? [] : baseDir.split('/').filter(Boolean);
            for (const seg of r.split('/')) { if (!seg || seg === '.') continue; if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg); }
            return parts.join('/');
        }
        // 파일 이름 대소문자가 달라도 찾을 수 있게 소문자 색인도 만든다
        function asBuildFileIndex(zip) {
            const lower = new Map(); for (const n of zip.entries.keys()) lower.set(n.toLowerCase(), n);
            return (path) => (path == null ? null : (zip.entries.has(path) ? path : (lower.get(path.toLowerCase()) || null)));
        }

        async function asBuildZipDocument(buf) {
            const zip = zipOpen(buf);
            const find = asBuildFileIndex(zip);
            const cache = new Map(); // path → { bytes, dataUrl }
            async function load(path) {
                if (cache.has(path)) return cache.get(path);
                const bytes = await zip.extract(path);
                const item = { bytes, dataUrl: `data:${AS_MIME[asExt(path)] || 'application/octet-stream'};base64,${asBytesToB64(bytes)}` };
                cache.set(path, item); return item;
            }
            const text = async (path) => new TextDecoder('utf-8').decode((await load(path)).bytes);
            const entryPath = zip.root + 'index.html';
            const baseDirOf = (p) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';

            // CSS 안의 url(...) 과 @import 를 ZIP 안 파일(data URL)로 바꾼다
            async function rewriteCss(css, cssDir, depth) {
                let out = css;
                const imports = [...css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;/gi)];
                for (const m of imports) {
                    const p = asIsLocalRef(m[1]) ? find(asResolvePath(m[1], cssDir)) : null;
                    out = out.replace(m[0], (p && depth < 3) ? await rewriteCss(await text(p), baseDirOf(p), depth + 1) : '');
                }
                const urls = [...out.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)];
                for (const m of urls) {
                    if (!asIsLocalRef(m[2])) continue;
                    const p = find(asResolvePath(m[2], cssDir));
                    if (p) out = out.split(m[0]).join(`url("${(await load(p)).dataUrl}")`);
                }
                return out;
            }

            const doc = new DOMParser().parseFromString(await text(entryPath), 'text/html');
            const entryDir = baseDirOf(entryPath);
            // 정적 참조 치환: 스타일시트/스크립트는 인라인으로, 나머지(이미지·오디오·비디오·폰트 등)는 data URL 로
            for (const el of [...doc.querySelectorAll('link[rel~="stylesheet"][href]')]) {
                const p = asIsLocalRef(el.getAttribute('href')) ? find(asResolvePath(el.getAttribute('href'), entryDir)) : null;
                if (!p) continue;
                const style = doc.createElement('style');
                style.textContent = await rewriteCss(await text(p), baseDirOf(p), 0);
                el.replaceWith(style);
            }
            for (const el of [...doc.querySelectorAll('script[src]')]) {
                const p = asIsLocalRef(el.getAttribute('src')) ? find(asResolvePath(el.getAttribute('src'), entryDir)) : null;
                if (!p) continue;
                el.removeAttribute('src');
                el.textContent = (await text(p)).replace(/<\/script/gi, '<\\/script');
            }
            for (const style of [...doc.querySelectorAll('style')]) style.textContent = await rewriteCss(style.textContent, entryDir, 0);
            for (const el of [...doc.querySelectorAll('[style*="url("]')]) el.setAttribute('style', await rewriteCss(el.getAttribute('style'), entryDir, 0));
            const attrs = [['src', '*'], ['poster', 'video'], ['href', 'link'], ['data', 'object']];
            for (const [attr, sel] of attrs) {
                for (const el of [...doc.querySelectorAll(`${sel}[${attr}]`)]) {
                    if (el.tagName === 'A' || !asIsLocalRef(el.getAttribute(attr))) continue;
                    const p = find(asResolvePath(el.getAttribute(attr), entryDir));
                    if (p) el.setAttribute(attr, (await load(p)).dataUrl);
                }
            }
            for (const el of [...doc.querySelectorAll('[srcset]')]) {
                const parts = [];
                for (const cand of el.getAttribute('srcset').split(',')) {
                    const [u, ...rest] = cand.trim().split(/\s+/);
                    const p = asIsLocalRef(u) ? find(asResolvePath(u, entryDir)) : null;
                    parts.push(`${p ? (await load(p)).dataUrl : u}${rest.length ? ' ' + rest.join(' ') : ''}`);
                }
                el.setAttribute('srcset', parts.join(', '));
            }
            // 스크립트가 fetch/XHR/new Audio('x.mp3') 처럼 "나중에" 부르는 파일을 위해 전체 색인(경로 → data URL)도 넣어 준다
            const files = {};
            for (const name of zip.entries.keys()) {
                if (zip.root && !name.startsWith(zip.root)) continue;
                files[name.slice(zip.root.length)] = (await load(name)).dataUrl;
            }
            return { doc, files, base: '' };
        }

        // sandbox 안에서 제일 먼저 실행되는 보조 스크립트: localStorage/sessionStorage 대용품(부모에 저장), ZIP 앱의 상대 경로 처리
        const AS_SHIM = `(function(){
            var CFG = window.__GMW_CFG__; delete window.__GMW_CFG__;
            function makeStore(initial, persist) {
                var d = Object.create(null); Object.keys(initial || {}).forEach(function (k) { d[k] = String(initial[k]); });
                var api = {
                    getItem: function (k) { k = String(k); return k in d ? d[k] : null; },
                    setItem: function (k, v) { d[String(k)] = String(v); persist(d); },
                    removeItem: function (k) { delete d[String(k)]; persist(d); },
                    clear: function () { d = Object.create(null); persist(d); },
                    key: function (i) { return Object.keys(d)[i] || null; }
                };
                return new Proxy(api, {
                    get: function (t, p) { if (p === 'length') return Object.keys(d).length; if (p in t) return t[p]; return typeof p === 'string' && p in d ? d[p] : undefined; },
                    set: function (t, p, v) { if (typeof p === 'string') { d[p] = String(v); persist(d); } return true; },
                    deleteProperty: function (t, p) { delete d[p]; persist(d); return true; },
                    has: function (t, p) { return p in t || p in d; },
                    ownKeys: function () { return Object.keys(d); },
                    getOwnPropertyDescriptor: function (t, p) { return p in d ? { value: d[p], writable: true, enumerable: true, configurable: true } : undefined; }
                });
            }
            var timer = null;
            function persistLocal(d) { clearTimeout(timer); timer = setTimeout(function () { try { parent.postMessage({ gmw: 'ls', appId: CFG.appId, data: JSON.stringify(d) }, '*'); } catch (e) {} }, 250); }
            try { var ls = makeStore(CFG.store, persistLocal); Object.defineProperty(window, 'localStorage', { get: function () { return ls; }, configurable: true }); } catch (e) {}
            try { var ss = makeStore({}, function () {}); Object.defineProperty(window, 'sessionStorage', { get: function () { return ss; }, configurable: true }); } catch (e) {}
            if (!CFG.files) return;
            var files = CFG.files, lower = {};
            Object.keys(files).forEach(function (k) { lower[k.toLowerCase()] = k; });
            function resolve(u) {
                if (typeof u !== 'string' || /^(data:|blob:|https?:|\\/\\/|about:|javascript:|#)/i.test(u)) return null;
                var r = u.split('#')[0].split('?')[0]; try { r = decodeURIComponent(r); } catch (e) {}
                var parts = [];
                r.replace(/\\\\/g, '/').split('/').forEach(function (s) { if (!s || s === '.') return; if (s === '..') parts.pop(); else parts.push(s); });
                var p = parts.join('/'); var key = p in files ? p : lower[p.toLowerCase()];
                return key ? files[key] : null;
            }
            var of = window.fetch;
            if (of) window.fetch = function (input, init) { var r = typeof input === 'string' ? resolve(input) : null; return of.call(window, r || input, init); };
            var oo = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (m, u) { var r = resolve(u); var a = Array.prototype.slice.call(arguments); if (r) a[1] = r; return oo.apply(this, a); };
            function patchProp(proto, prop) {
                var desc = Object.getOwnPropertyDescriptor(proto, prop); if (!desc || !desc.set) return;
                Object.defineProperty(proto, prop, { get: desc.get, configurable: true, enumerable: desc.enumerable, set: function (v) { var r = resolve(v); desc.set.call(this, r || v); } });
            }
            [[HTMLImageElement, 'src'], [HTMLMediaElement, 'src'], [HTMLSourceElement, 'src'], [HTMLScriptElement, 'src'], [HTMLLinkElement, 'href'], [HTMLVideoElement, 'poster']].forEach(function (x) { try { patchProp(x[0].prototype, x[1]); } catch (e) {} });
            try { var OA = window.Audio; window.Audio = function (src) { var a = new OA(); if (src !== undefined) a.src = src; return a; }; window.Audio.prototype = OA.prototype; } catch (e) {}
            var oset = Element.prototype.setAttribute;
            Element.prototype.setAttribute = function (n, v) { if (/^(src|href|poster)$/i.test(n)) { var r = resolve(v); if (r) v = r; } return oset.call(this, n, v); };
        })();`;

        function asJsonForScript(obj) { return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
        function asStoreKey(appId) { const u = AUTH().user(); return `gmw_appdata:${appId}:${u ? u.uid : 'guest'}`; }
        function asLoadAppData(appId) { try { const v = JSON.parse(localStorage.getItem(asStoreKey(appId)) || '{}'); return (v && typeof v === 'object') ? v : {}; } catch (e) { return {}; } }

        async function asBuildRunDocument(app) {
            const resp = await fetch(asPublicUrl(app.file_path), { cache: 'force-cache' }); // 경로 자체가 버전마다 달라서 캐시해도 안전하다
            if (!resp.ok) throw new Error('앱 파일을 불러오지 못했어요.');
            const buf = await resp.arrayBuffer();
            if (buf.byteLength > Math.max(AS_LIMITS.html, AS_LIMITS.zip)) throw new Error('앱 파일이 너무 커요.');
            let doc, files = null;
            if (app.file_type === 'zip') ({ doc, files } = await asBuildZipDocument(buf));
            else doc = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(buf), 'text/html');
            // <base href="about:srcdoc">: srcdoc 안에서 <a href="#x"> 같은 앵커가 부모(이 사이트) 주소로 이동해 버리는 문제를 막는다
            const head = doc.head || doc.documentElement.insertBefore(doc.createElement('head'), doc.body);
            const shim = doc.createElement('script');
            shim.textContent = `window.__GMW_CFG__ = ${asJsonForScript({ appId: app.id, store: asLoadAppData(app.id), files })};\n${AS_SHIM}`;
            head.insertBefore(shim, head.firstChild);
            const base = doc.createElement('base'); base.setAttribute('href', 'about:srcdoc');
            head.insertBefore(base, head.firstChild);
            doc.querySelectorAll('meta[http-equiv="refresh" i]').forEach(m => m.remove());
            return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
        }

        // 앱이 sandbox 안에서 쓴 "localStorage" 내용을 이 브라우저에 저장해 준다(앱·계정별로 분리, 크기 제한)
        window.addEventListener('message', (e) => {
            const d = e.data;
            if (!AS.runFrame || e.source !== AS.runFrame.contentWindow) return; // 우리가 띄운 앱 iframe 이 보낸 메시지만 받는다
            if (!d || d.gmw !== 'ls' || d.appId !== AS.runAppId || typeof d.data !== 'string') return;
            if (d.data.length > AS_LIMITS.appData) return;
            try {
                JSON.parse(d.data);
                const key = asStoreKey(AS.runAppId);
                let others = 0;
                for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('gmw_appdata:') && k !== key) others += (localStorage.getItem(k) || '').length; }
                if (others + d.data.length > AS_LIMITS.appDataTotal) return; // 앱 저장 데이터 전체 한도 초과
                localStorage.setItem(key, d.data);
            } catch (err) { /* 용량 초과 등은 무시 */ }
        });

        // ---------------------------------------------------------------- 렌더링: 실행
        async function asRenderRun(root) {
            const id = AS.appId;
            root.innerHTML = '<div class="as-empty">앱을 불러오는 중…</div>';
            const app = await asFindApp(id);
            if (AS.view !== 'run' || AS.appId !== id) return;
            if (!app) { root.innerHTML = `<div class="community-back-link" data-as="home">← 앱스토어</div><div class="card as-empty">존재하지 않거나 비공개로 바뀐 앱이에요.</div>`; return; }
            if (!asCanSee(app)) { asRenderMemberOnly(root); return; }
            if (asIsLink(app)) { asNavigate({ view: 'detail', appId: app.id }, false); return; } // 파일이 없는 외부 링크 앱은 실행 화면이 없다
            AS.app = app; document.title = `${app.name} · 앱스토어`;
            asCountView(app);
            root.innerHTML = `
                <div class="as-run-bar">
                    <button class="btn-sub" data-as="detail" data-id="${asEsc(app.id)}">← 앱 정보</button>
                    <div class="as-run-title">${asEsc(app.name)} <span class="as-chip">v${asEsc(app.version)}</span></div>
                    <button class="btn-sub" data-as="newtab" data-id="${asEsc(app.id)}" title="새 탭에서 열기">↗ 새 탭</button>
                    <button class="btn-sub" data-as="fullscreen" title="전체 화면">⛶</button>
                </div>
                <div class="as-run-note">🔒 이 앱은 격리된 상자(sandbox) 안에서 실행돼요. 사이트의 로그인 정보나 다른 데이터에는 접근할 수 없어요.</div>
                <div class="as-run-stage" id="as-run-stage"><div class="as-empty">앱을 준비하는 중…</div></div>`;
            try {
                const html = await asBuildRunDocument(app);
                if (AS.view !== 'run' || AS.appId !== id) return;
                const stage = document.getElementById('as-run-stage');
                const frame = document.createElement('iframe');
                // allow-same-origin 을 일부러 넣지 않는다 → 앱은 고유하지 않은(opaque) 출처가 되어 부모 DOM/저장소/토큰에 접근할 수 없다.
                // allow-top-navigation 도 없다 → 이 사이트 화면 자체를 다른 주소로 바꿔치기할 수 없다.
                frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads');
                frame.setAttribute('allow', 'fullscreen; autoplay; gamepad; clipboard-write');
                frame.setAttribute('allowfullscreen', '');
                frame.setAttribute('referrerpolicy', 'no-referrer');
                frame.className = 'as-run-frame'; frame.title = app.name;
                frame.srcdoc = html;
                stage.innerHTML = ''; stage.appendChild(frame);
                AS.runFrame = frame; AS.runAppId = app.id;
            } catch (e) {
                const msg = e instanceof ZipError ? e.message : (e && e.message) || '앱을 실행하지 못했어요.';
                const stage = document.getElementById('as-run-stage');
                if (stage) stage.innerHTML = `<div class="as-empty">⚠️ ${asEsc(msg)}</div>`;
            }
        }

        // ---------------------------------------------------------------- 렌더링: 등록/수정 폼
        // ---- 배포 도우미: Netlify/Render 에 올리는 방법 안내 + "index.html 이 들어 있는 ZIP" 만들어 주기 ----
        // (Netlify Drop 은 폴더/ZIP 맨 위에 index.html 이 있어야 한다. 파일 이름이 game.html 처럼 다르면 그대로는 안 열려서 이름을 바꿔 담아 준다.)
        function asDeployGuideHtml() {
            return `<details class="as-deploy" id="as-deploy">
                <summary>🚀 Netlify · Render 에 올리는 방법 (처음이어도 따라 하면 돼요)</summary>
                <div class="as-deploy-body">
                    <div class="as-deploy-tabs">
                        <button type="button" class="as-deploy-tab active" data-as-deploy="netlify">Netlify (가장 쉬움)</button>
                        <button type="button" class="as-deploy-tab" data-as-deploy="render">Render</button>
                    </div>
                    <div id="as-deploy-netlify">
                        <ol class="as-deploy-steps">
                            <li><b>배포용 ZIP 만들기</b> — 앱의 <b>.html 파일</b>을 고르면 <code>index.html</code> 이 들어 있는 ZIP 을 만들어 줘요. (이미 <code>index.html</code> 이 맨 위에 있는 폴더/ZIP 이면 이 단계는 건너뛰세요)
                                <div class="as-deploy-actions"><label class="btn-sub" style="cursor:pointer;">📁 .html 파일 고르기<input id="as-deploy-file" type="file" accept=".html,.htm" style="display:none;"></label></div></li>
                            <li><b>Netlify Drop 열기</b>
                                <div class="as-deploy-actions"><a class="btn-sub" href="https://app.netlify.com/drop" target="_blank" rel="noopener noreferrer">🌐 app.netlify.com/drop 열기</a></div></li>
                            <li>열린 페이지에 ZIP(또는 폴더)을 <b>끌어다 놓기</b>. 몇 초 뒤 <code>https://무작위이름.netlify.app</code> 주소가 생겨요.</li>
                            <li>주소가 생기면 <b>Netlify 에 로그인(회원가입)해서 그 사이트를 내 계정에 저장</b>해 두세요. 저장하지 않으면 일정 시간 뒤 사라질 수 있어요.</li>
                            <li>그 <b>https 주소를 복사</b>해서 위의 <b>외부 링크 주소</b>에 붙여넣고 게시하면 끝!</li>
                        </ol>
                    </div>
                    <div id="as-deploy-render" style="display:none;">
                        <ol class="as-deploy-steps">
                            <li><b>GitHub 저장소 만들기</b> — 새 저장소를 만들고 앱 파일을 올려요. (맨 위에 <code>index.html</code>)</li>
                            <li><a href="https://dashboard.render.com/select-repo?type=static" target="_blank" rel="noopener noreferrer">Render 대시보드</a>에서 <b>New + → Static Site</b> 를 고르고 그 저장소를 연결해요.</li>
                            <li><b>Build Command</b> 는 비워 두고, <b>Publish Directory</b> 는 <code>.</code> (점 하나)로 해요.</li>
                            <li><b>Create Static Site</b> 를 누르면 몇 분 뒤 <code>https://이름.onrender.com</code> 주소가 생겨요.</li>
                            <li>그 <b>https 주소를 복사</b>해서 위의 <b>외부 링크 주소</b>에 붙여넣고 게시하면 끝!</li>
                        </ol>
                    </div>
                    <div class="as-deploy-note">💡 파일이 800KB 이하(HTML·ZIP 모두)이면 외부 서비스 없이 위의 <b>“📦 파일 올리기”</b>로 바로 앱스토어에서 실행되게 할 수도 있어요. 외부 링크는 앱스토어의 격리 보호가 적용되지 않으니 본인이 만든 앱만 연결해 주세요. (화면 문구는 서비스 사정에 따라 조금 다를 수 있어요)</div>
                </div>
            </details>`;
        }
        const AS_EXT_LABEL_LINK = '외부 링크 주소 *';
        const AS_EXT_LABEL_OPT = '외부 공유 링크 <span class="as-hint">(선택 · 용량이 커서 올릴 수 없거나 따로 배포한 버전이 있을 때)</span>';
        const AS_EXT_HINT_LINK = '파일이 너무 커서 올릴 수 없는 앱은 Netlify 등에 직접 배포하고 그 주소(https)만 걸어 두세요. 이 경우 앱스토어에서는 직접 실행·다운로드 없이 이 주소로 연결만 해줘요.';
        const AS_EXT_HINT_OPT = 'https:// 로 시작하는 주소만 쓸 수 있어요. 앱 상세 화면에 “외부 링크로 열기” 버튼이 생겨요.';
        function asRenderForm(root) {
            const { mode, app } = AS.form;
            const isEdit = mode === 'update';
            const isLinkApp = isEdit && !!app && asIsLink(app);
            root.innerHTML = `
                <div class="community-back-link" data-as="${isEdit ? 'detail' : 'home'}" data-id="${asEsc(app ? app.id : '')}">← ${isEdit ? '앱 정보' : '앱스토어'}</div>
                <div class="card as-form">
                    <h2 class="as-form-title">${isEdit ? '앱 수정' : '새 앱 등록'}</h2>
                    <label class="as-label">앱 이름 *<input id="as-f-name" class="auth-input" maxlength="40" placeholder="예: 계산기" value="${asEsc(app ? app.name : '')}"></label>
                    <label class="as-label">설명<textarea id="as-f-desc" class="auth-input as-textarea" maxlength="1000" placeholder="어떤 앱인지 간단히 알려주세요">${asEsc(app ? app.description : '')}</textarea></label>
                    <div class="as-row">
                        <label class="as-label">카테고리<select id="as-f-cat" class="auth-select">${AS_CATEGORIES.filter(c => asVisibleCategories().includes(c) || (app && app.category === c)).map(c => `<option ${app && app.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
                        <label class="as-label">버전<input id="as-f-ver" class="auth-input" maxlength="20" placeholder="1.0.0" value="${asEsc(app ? app.version : '1.0.0')}"></label>
                    </div>
                    <div class="as-label">아이콘 <span class="as-hint">(PNG·JPG·WEBP·GIF, 1MB 이하 · 선택)</span>
                        <div class="as-icon-pick">
                            <div id="as-f-icon-preview">${app ? asIconHtml(app, 64) : '<div class="as-icon-fallback" style="width:64px;height:64px;font-size:28px;background:var(--surface-secondary);color:var(--text-muted);">🧩</div>'}</div>
                            <input id="as-f-icon" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
                            ${isEdit && app.icon_url ? '<label class="as-check"><input id="as-f-icon-remove" type="checkbox"> 아이콘 지우기</label>' : ''}
                        </div>
                    </div>
                    ${isEdit ? '' : `<div class="as-label">등록 방식
                        <div class="as-kind">
                            <label><input type="radio" name="as-f-kind" value="file" checked> 📦 파일 올리기 <span class="as-hint">(HTML/ZIP)</span></label>
                            <label><input type="radio" name="as-f-kind" value="link"> 🌐 외부 링크만 <span class="as-hint">(큰 앱용)</span></label>
                        </div>
                    </div>`}
                    ${isLinkApp ? '' : `<div class="as-label" id="as-f-file-block">${isEdit ? '새 버전 파일로 교체 <span class="as-hint">(선택 · 비워 두면 파일은 그대로)</span>' : 'HTML 또는 ZIP 파일 *'}
                        <input id="as-f-file" type="file" accept=".html,.htm,.zip">
                        <div class="as-hint">${isEdit ? `현재: ${app.file_type === 'zip' ? 'ZIP' : 'HTML'} · ${asFmtSize(app.file_size || 0)} · ` : ''}HTML 한 파일이면 <b>.html</b>, 여러 파일이면 <b>.zip</b>(맨 위에 <b>index.html</b>)으로 올려요. <b>둘 다 800KB 이하</b>만 돼요(더 크면 외부 링크로)으로 올려요. 주소는 수정해도 바뀌지 않아요.</div>
                    </div>`}
                    <label class="as-label" id="as-f-ext-block"><span id="as-f-ext-label">${isLinkApp ? AS_EXT_LABEL_LINK : AS_EXT_LABEL_OPT}</span>
                        <input id="as-f-ext" class="auth-input" type="url" maxlength="500" inputmode="url" placeholder="https://내앱.netlify.app" value="${asEsc(app && app.external_url ? app.external_url : '')}">
                        <div class="as-hint" id="as-f-ext-hint">${isLinkApp ? AS_EXT_HINT_LINK : AS_EXT_HINT_OPT}</div>
                    </label>
                    ${asDeployGuideHtml()}
                    ${isEdit && !isLinkApp ? `<label class="as-label">이번 업데이트 내용 <span class="as-hint">(업데이트 기록에 남아요)</span><textarea id="as-f-log" class="auth-input as-textarea" maxlength="1000" placeholder="예: 버그 수정, 검색 기능 추가"></textarea></label>` : ''}
                    <label class="as-check"><input id="as-f-pub" type="checkbox" ${!app || app.published ? 'checked' : ''}> 앱스토어에 공개</label>
                    <div class="as-limits">ℹ️ 실행 환경: 앱은 격리된 sandbox 에서 실행돼요. 서버 코드·IndexedDB·여러 HTML 페이지 이동·Web Worker·ES 모듈 import 는 지원하지 않아요. localStorage 는 이 브라우저에 앱별로 저장돼요.</div>
                    <div id="as-f-error" class="as-error" style="display:none;"></div>
                    <div class="as-form-actions">
                        ${isEdit ? '<button class="btn-sub as-danger" data-as="delete" id="as-f-delete">🗑 앱 삭제</button>' : '<span></span>'}
                        <div><button class="btn-sub" data-as="${isEdit ? 'detail' : 'home'}" data-id="${asEsc(app ? app.id : '')}">취소</button>
                        <button class="auth-btn as-btn-submit" id="as-f-submit" data-as="submit">${isEdit ? '저장' : '게시하기'}</button></div>
                    </div>
                </div>`;
            document.querySelectorAll('input[name="as-f-kind"]').forEach(r => r.addEventListener('change', () => {
                const link = document.querySelector('input[name="as-f-kind"]:checked').value === 'link';
                const fb = document.getElementById('as-f-file-block'); if (fb) fb.style.display = link ? 'none' : '';
                document.getElementById('as-f-ext-label').innerHTML = link ? AS_EXT_LABEL_LINK : AS_EXT_LABEL_OPT;
                document.getElementById('as-f-ext-hint').textContent = link ? AS_EXT_HINT_LINK : AS_EXT_HINT_OPT;
                asFormError('');
            }));
            document.querySelectorAll('[data-as-deploy]').forEach(tab => tab.addEventListener('click', () => {
                document.querySelectorAll('[data-as-deploy]').forEach(t => t.classList.toggle('active', t === tab));
                document.getElementById('as-deploy-netlify').style.display = tab.dataset.asDeploy === 'netlify' ? '' : 'none';
                document.getElementById('as-deploy-render').style.display = tab.dataset.asDeploy === 'render' ? '' : 'none';
            }));
            const deployFile = document.getElementById('as-deploy-file');
            if (deployFile) deployFile.addEventListener('change', async () => {
                const f = deployFile.files[0]; deployFile.value = '';
                if (!f) return;
                if (!/\.html?$/i.test(f.name)) return asFormError('.html 파일을 골라주세요.');
                if (f.size > 25 * 1024 * 1024) return asFormError('25MB 를 넘는 파일은 여기서 ZIP 으로 만들 수 없어요. 폴더째로 Netlify Drop 에 올려주세요.');
                const blob = asMakeZip([{ name: 'index.html', data: new Uint8Array(await f.arrayBuffer()) }]);
                const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
                a.download = (f.name.replace(/\.html?$/i, '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'app') + '-deploy.zip';
                document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
                asFormError('');
            });
            const iconInput = document.getElementById('as-f-icon');
            iconInput.addEventListener('change', () => {
                const f = iconInput.files[0]; if (!f) return;
                if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type) || f.size > AS_LIMITS.icon) { asFormError('아이콘은 1MB 이하의 PNG/JPG/WEBP/GIF 이미지만 쓸 수 있어요.'); iconInput.value = ''; return; }
                document.getElementById('as-f-icon-preview').innerHTML = `<img class="as-icon-img" style="width:64px;height:64px;" src="${URL.createObjectURL(f)}" alt="">`;
            });
        }
        function asFormError(msg) { const el = document.getElementById('as-f-error'); if (!el) return; el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none'; if (msg) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
        function asFormBusy(text) { const b = document.getElementById('as-f-submit'); if (!b) return; b.disabled = !!text; b.textContent = text || (AS.form && AS.form.mode === 'update' ? '저장' : '게시하기'); }

        async function asSubmitForm() {
            const { mode, app } = AS.form;
            asFormError('');
            const val = (id) => (document.getElementById(id) ? document.getElementById(id).value : '');
            const fields = { name: val('as-f-name').trim(), description: val('as-f-desc').trim(), category: val('as-f-cat'), version: val('as-f-ver').trim(), published: document.getElementById('as-f-pub').checked };
            if (!fields.name) return asFormError('앱 이름을 입력해주세요.');
            if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,19}$/.test(fields.version)) return asFormError('버전 형식이 올바르지 않아요. (예: 1.0.0)');
            const linkOnly = mode === 'create' ? document.querySelector('input[name="as-f-kind"]:checked').value === 'link' : asIsLink(app);
            const extRaw = val('as-f-ext').trim();
            if (extRaw) {
                let ok = false; try { const eu = new URL(extRaw); ok = eu.protocol === 'https:' && !eu.username && !eu.password; } catch (e) {}
                if (!ok) return asFormError('외부 링크는 https:// 로 시작하는 주소만 쓸 수 있어요. (예: https://my-app.netlify.app)');
            }
            if (linkOnly && !extRaw) return asFormError('외부 링크 주소를 입력해주세요.');
            fields.externalUrl = extRaw; // 빈 문자열이면 링크 제거
            const fileEl = document.getElementById('as-f-file');
            const file = (!linkOnly && fileEl && fileEl.files[0]) || null;
            const icon = document.getElementById('as-f-icon').files[0] || null;
            if (mode === 'create' && !linkOnly && !file) return asFormError('HTML 또는 ZIP 파일을 선택해주세요.');
            let fileType = null;
            if (file) {
                const n = file.name.toLowerCase();
                fileType = /\.html?$/.test(n) ? 'html' : (/\.zip$/.test(n) ? 'zip' : null);
                if (!fileType) return asFormError('.html 또는 .zip 파일만 올릴 수 있어요.');
                if (file.size > AS_LIMITS[fileType]) return asFormError(`${fileType === 'zip' ? 'ZIP은' : 'HTML은'} 800KB 이하만 올릴 수 있어요. 더 크면 “🌐 외부 링크만”으로 등록해 주세요.`);
                if (fileType === 'zip') { // 서버로 보내기 전에 구조/경로/크기를 미리 검사한다
                    try { zipOpen(await file.arrayBuffer()); } catch (e) { return asFormError(e instanceof ZipError ? e.message : 'ZIP 파일을 읽지 못했어요.'); }
                }
            }
            const u = AUTH().user();
            if (!u) { AUTH().login(() => {}); return; }
            try {
                asFormBusy('준비 중…');
                const prep = await asCallFn({
                    action: 'prepare', mode, appId: app ? app.id : undefined, linkOnly: linkOnly || undefined, externalUrl: linkOnly ? extRaw : undefined,
                    mainFile: file ? { name: file.name, size: file.size, type: file.type } : undefined,
                    icon: icon ? { name: icon.name, size: icon.size, type: icon.type } : undefined
                });
                const storage = sbApps.storage.from(AS_BUCKET);
                if (file) {
                    asFormBusy('파일 올리는 중…');
                    const { error } = await storage.uploadToSignedUrl(prep.uploads.main.path, prep.uploads.main.token, file, { contentType: fileType === 'zip' ? 'application/zip' : 'text/html' });
                    if (error) throw new Error('파일 업로드에 실패했어요: ' + (error.message || ''));
                }
                if (icon) {
                    const { error } = await storage.uploadToSignedUrl(prep.uploads.icon.path, prep.uploads.icon.token, icon, { contentType: icon.type });
                    if (error) throw new Error('아이콘 업로드에 실패했어요: ' + (error.message || ''));
                }
                asFormBusy('게시하는 중…');
                const removeIcon = !!(document.getElementById('as-f-icon-remove') && document.getElementById('as-f-icon-remove').checked);
                const done = await asCallFn({
                    action: 'commit', mode, appId: prep.appId,
                    fields: { ...fields, changelog: val('as-f-log') },
                    mainPath: file ? prep.uploads.main.path : undefined, fileType: file ? fileType : undefined,
                    iconPath: icon ? prep.uploads.icon.path : undefined, removeIcon,
                    authorName: AUTH().displayName()
                });
                AS.loadedAt = 0; AS.mine = null;
                await asLoadApps(true);
                asNavigate({ view: 'detail', appId: done.app.id }, true);
            } catch (e) {
                asFormBusy('');
                asFormError(e && e.message ? e.message : '저장하지 못했어요. 잠시 후 다시 시도해주세요.');
            }
        }

        async function asDeleteApp(app) {
            if (!confirm(`“${app.name}” 앱을 삭제할까요?\n주소와 모든 버전 파일이 사라지고 되돌릴 수 없어요.`)) return;
            try {
                await asCallFn({ action: 'delete', appId: app.id });
                AS.apps = AS.apps.filter(a => a.id !== app.id); AS.mine = null; AS.loadedAt = 0;
                asNavigate({ view: 'list' }, true);
            } catch (e) { asFormError(e.message || '삭제하지 못했어요.'); }
        }

        // ---------------------------------------------------------------- 다운로드 / 링크 복사
        async function asDownload(app) {
            try {
                const resp = await fetch(asPublicUrl(app.file_path));
                if (!resp.ok) throw new Error();
                const blob = await resp.blob();
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `${String(app.name).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'app'}.${app.file_type === 'zip' ? 'zip' : 'html'}`;
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 4000);
            } catch (e) { alert('파일을 내려받지 못했어요. 잠시 후 다시 시도해주세요.'); }
        }
        async function asCopyLink(app) {
            const url = `${location.origin}/app/${app.id}`;
            try { await navigator.clipboard.writeText(url); alert('링크가 복사됐어요!\n' + url); }
            catch (e) { prompt('링크를 복사하세요', url); }
        }

        // ---------------------------------------------------------------- 화면 전환 / 주소(/app/<id>) 처리
        function asPathFor(state) {
            if (state.view === 'detail' && state.appId) return `/app/${state.appId}`;
            if (state.view === 'run' && state.appId) return `/app/${state.appId}/run`;
            return '/';
        }
        function asNavigate(state, push) {
            AS.view = state.view; AS.appId = state.appId || null; AS.form = state.form || null;
            if (state.view !== 'run') { AS.runFrame = null; AS.runAppId = null; }
            const path = asPathFor(state);
            if (location.pathname !== path) { try { history[push ? 'pushState' : 'replaceState']({ gmwApp: true }, '', path); } catch (e) {} }
            if (state.view === 'list' || state.view === 'form') document.title = AS_BASE_TITLE;
            asRender();
        }
        async function asRender() {
            const root = document.getElementById('as-root');
            if (!root) return;
            if (AS.view === 'list') {
                asRenderList(root);
                if (!AS.apps.length || Date.now() - AS.loadedAt > 30000) { await asLoadApps(true); if (AS.view === 'list') asRenderList(root); }
                if (AS.cat === '내 앱' && AS.mine === null) { await asLoadMine(); if (AS.view === 'list') asRenderList(root); }
            } else if (AS.view === 'detail') await asRenderDetail(root);
            else if (AS.view === 'run') await asRenderRun(root);
            else if (AS.view === 'form') asRenderForm(root);
            document.querySelector('.main') && document.querySelector('.main').scrollTo({ top: 0 });
        }
        function asRequireLogin(then) {
            if (AUTH().user()) return then();
            AUTH().login(then);
        }

        // 클릭은 한 곳에서 처리한다(이벤트 위임)
        document.addEventListener('click', async (e) => {
            const el = e.target.closest('#tab-appstore [data-as]');
            if (!el) return;
            const act = el.dataset.as, id = el.dataset.id;
            if (act === 'open') { if (e.target.closest('[data-as="edit"]')) return; asNavigate({ view: 'detail', appId: id }, true); }
            else if (act === 'home') asNavigate({ view: 'list' }, true);
            else if (act === 'detail') asNavigate({ view: 'detail', appId: id }, true);
            else if (act === 'run') asNavigate({ view: 'run', appId: id }, true);
            else if (act === 'newtab') window.open(`/app/${id}/run`, '_blank', 'noopener');
            else if (act === 'fullscreen') { const f = document.getElementById('as-run-stage'); if (f && f.requestFullscreen) f.requestFullscreen().catch(() => {}); }
            else if (act === 'cat') {
                AS.cat = el.dataset.cat;
                if (AS.cat === '내 앱' && AS.mine === null) { asRender(); } else asRenderList(document.getElementById('as-root'));
            }
            else if (act === 'new') asRequireLogin(() => asNavigate({ view: 'form', form: { mode: 'create', app: null } }, true));
            else if (act === 'edit') { e.stopPropagation(); asRequireLogin(async () => { const app = await asFindApp(id); if (app) asNavigate({ view: 'form', appId: id, form: { mode: 'update', app } }, true); }); }
            else if (act === 'download') { const app = await asFindApp(id); if (app) asDownload(app); }
            else if (act === 'copylink') { const app = await asFindApp(id); if (app) asCopyLink(app); }
            else if (act === 'login') AUTH().login(() => {});
            else if (act === 'submit') asSubmitForm();
            else if (act === 'delete') { if (AS.form && AS.form.app) asDeleteApp(AS.form.app); }
        });
        document.addEventListener('input', (e) => {
            if (e.target && e.target.id === 'as-search') {
                AS.q = e.target.value;
                const pos = e.target.selectionStart;
                asRenderList(document.getElementById('as-root'));
                const input = document.getElementById('as-search'); input.focus(); try { input.setSelectionRange(pos, pos); } catch (err) {}
            }
        });

        // 로그인/로그아웃으로 보이는 앱이 달라지므로(게스트는 게임·엔터테인먼트 숨김) 앱스토어가 열려 있으면 다시 그린다
        window.addEventListener('gmw:authchange', () => {
            AS.mine = null;
            const tab = document.getElementById('tab-appstore');
            if (tab && tab.classList.contains('active')) asRender();
        });

        // 사이드바 "앱스토어"로 들어올 때는 항상 목록부터 보여준다
        window.openAppStore = function () {
            window.switchTab('appstore');
            asNavigate({ view: 'list' }, true);
        };
        // 다른 탭으로 나가면 주소를 / 로 되돌린다(새로고침했을 때 앱 화면으로 되돌아가지 않도록)
        (function wrapSwitchTab() {
            const orig = window.switchTab;
            if (typeof orig !== 'function') return;
            window.switchTab = function (tabId) {
                if (tabId !== 'appstore' && /^\/app\//.test(location.pathname)) { try { history.replaceState(null, '', '/'); } catch (e) {} AS.runFrame = null; AS.runAppId = null; document.title = AS_BASE_TITLE; }
                return orig.apply(this, arguments);
            };
        })();

        function asParseRoute() {
            const m = location.pathname.match(/^\/app\/([a-z0-9]{6,12})(\/run)?\/?$/);
            return m ? { view: m[2] ? 'run' : 'detail', appId: m[1] } : null;
        }
        window.addEventListener('popstate', () => {
            const r = asParseRoute();
            if (r) { window.switchTab('appstore'); AS.view = r.view; AS.appId = r.appId; asRender(); }
            else if (document.getElementById('tab-appstore').classList.contains('active')) { AS.view = 'list'; AS.appId = null; asRender(); }
        });

        // 처음 열린 주소가 /app/<id> 이면: 사이트가 준비(익명/로그인 세션 시작)된 뒤 해당 앱 화면을 연다
        (function bootRoute() {
            const r = asParseRoute();
            if (!r) return;
            const container = document.getElementById('app-container');
            const open = () => { window.switchTab('appstore'); asNavigate({ view: r.view, appId: r.appId }, false); };
            if (container.classList.contains('authenticated')) { setTimeout(open, 0); return; }
            const mo = new MutationObserver(() => { if (container.classList.contains('authenticated')) { mo.disconnect(); setTimeout(open, 0); } });
            mo.observe(container, { attributes: true, attributeFilter: ['class'] });
        })();

    