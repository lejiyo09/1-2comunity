
        import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
        import { getDatabase, ref, onValue, get, set, update, push, remove, runTransaction, onDisconnect } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
        import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut, setPersistence, browserLocalPersistence, browserSessionPersistence, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
        // Firestore SDK 추가 - 정적/영구 커뮤니티 데이터(게시글/아카이브/공지/설문/프로필 등)는 이제 여기로 저장한다.
        // RTDB의 runTransaction과 이름이 겹치므로 Firestore 쪽은 fsRunTransaction으로 별칭을 준다.
        // Firestore 인스턴스는 "(default)" 데이터베이스를 쓰며 getFirestore(app, "community") 같은 지정을 하지 않는다.
        import {
            getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
            collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
            query, where, orderBy, onSnapshot, runTransaction as fsRunTransaction
        } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

        // ⚠️ 자료실 전용 Supabase Storage/Database 연동 (Firebase는 그대로 로그인/인증/기존 데이터 담당).
        // Firebase Auth를 대체하지 않는다 - 로그인은 100% 기존 Firebase 그대로, 파일 저장소만 Supabase를 쓴다.
        import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
        import { firebaseConfig, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_MUSIC_URL, SUPABASE_MUSIC_KEY } from "./config.js";

        // (Firebase 설정/Supabase 주소·공개 키는 js/config.js 에 모아 두었다)
        const app = initializeApp(firebaseConfig); const db = getDatabase(app); const auth = getAuth(app);

        // ===============================
        // SUPABASE CONFIG (자료실 전용 - Firebase 설정과는 완전히 별개)
        // ⚠️ 여기 쓰는 키는 반드시 publishable(anon) key여야 한다. service_role/secret 키는 절대 넣지 않는다.
        // ===============================
        const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        const MATERIALS_BUCKET = 'materials';
        // 업로드/삭제는 anon 키로 직접 하지 않고, 전부 Edge Function(서버에서 Firebase ID 토큰 검증 후
        // service_role로 처리)을 통해서만 이루어진다. anon 키에는 write 권한을 아예 주지 않는다.
        const MATERIALS_UPLOAD_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/upload-material`;
        const MATERIALS_DELETE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/verify-delete-material`;
        // 자료 수정(제목/카테고리/설명)도 삭제와 같은 이유로 별도 Edge Function을 쓴다 - upload-material/
        // verify-delete-material 소스를 갖고 있지 않은 채로 그 함수들을 건드리면 이미 잘 동작 중인
        // 업로드/삭제 기능을 실수로 깨뜨릴 위험이 있어서, 수정 전용 함수(edit-material)로 완전히 분리했다.
        const MATERIALS_EDIT_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/edit-material`;
        // freeimage.host는 브라우저에서 직접 fetch하면 CORS로 100% 차단된다(콘솔에서 확인됨) - 이 Edge
        // Function이 서버에서 대신 업로드해준다(서버끼리는 CORS 제약이 없음). 반드시 별도로 배포해야 동작한다.
        const FREEIMAGE_UPLOAD_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/upload-freeimage`;
        // 날씨/학사일정(NEIS) 외부 API 는 인증키를 서버(Edge Function api-proxy)에만 두고 이 주소로 부른다 - 키가 브라우저에 내려오지 않는다.
        const API_PROXY_URL = `${SUPABASE_URL}/functions/v1/api-proxy`;

        // ===============================
        // SUPABASE CONFIG — 1-2 Music 전용 (자료실용 Supabase 프로젝트와는 완전히 다른 별도 프로젝트)
        // ⚠️ 여기도 publishable(anon) key만 넣는다. service_role은 절대 넣지 않는다.
        // ===============================
        const sbMusic = createClient(SUPABASE_MUSIC_URL, SUPABASE_MUSIC_KEY);
        const MUSIC_BUCKET = 'music';
        // 자료실과 동일한 패턴: anon 키로는 직접 쓰기(공유/좋아요/다운로드기록)를 하지 않고 전부 Edge Function을 거친다.
        const MUSIC_WRITE_FUNCTION_URL = `${SUPABASE_MUSIC_URL}/functions/v1/music-write`;
        // 공유 음악 삭제는 기존 music-write와 별도인 전용 함수로 분리했다 - 이미 배포되어 잘 동작 중인
        // music-write(공유/좋아요/재생·다운로드기록)의 소스를 갖고 있지 않은 상태에서 함부로 덮어써
        // 기존 기능을 깨뜨리는 위험을 피하기 위함이다 (supabase/functions/music-delete/index.ts 참고).
        const MUSIC_DELETE_FUNCTION_URL = `${SUPABASE_MUSIC_URL}/functions/v1/music-delete`;
        const MUSIC_SHARE_LIMIT = 10;
        // ⚠️ 이 30MB 제한은 "커뮤니티 공유 음악"에만 적용된다. 개인 "내 음악"(IndexedDB) 직접 추가나
        // 노래찾기로 가져온 음악에는 이 제한을 적용하지 않는다 (그쪽은 브라우저 로컬 저장이라 별개).
        const MAX_SHARED_MUSIC_SIZE = 30 * 1024 * 1024; // 30MB, 정확히 30MB까지는 허용, 초과분만 거부
        // fdb = Firestore. 기존 코드 전체가 RTDB를 "db"로 부르고 있어서(수천 곳), 그 이름을 그대로 유지하고
        // Firestore는 별도 변수명(fdb)을 쓴다 - 두 저장소를 이름으로도 명확히 구분하기 위함이다.
        // 오프라인에서도 예전에 온라인 상태에서 이미 불러온 적 있는 게시글/공지/설문 등을 그대로 볼 수
        // 있도록 IndexedDB 기반 로컬 캐시를 켠다(플래너/뮤직이 IndexedDB를 쓰는 것과 같은 방식). 여러 탭을
        // 동시에 열어도 충돌 없이 캐시를 공유하도록 persistentMultipleTabManager를 쓴다. 사파리 시크릿
        // 모드 등 지원하지 않는 환경에서는 실패할 수 있으니, 그럴 땐 캐시 없이(메모리 캐시로) 그대로 켠다.
        let fdb;
        try {
            fdb = initializeFirestore(app, {
                localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
            });
        } catch (e) {
            console.warn('Firestore 오프라인 캐시를 켜지 못했습니다 (온라인 상태에서는 정상 동작합니다):', e);
            fdb = getFirestore(app);
        }
        // Firestore QuerySnapshot을 기존 RTDB onValue(snap.val())와 같은 { id: data } 모양으로 바꿔주는 헬퍼.
        // 기존 코드 대부분이 Object.entries(posts) 형태로 순회하므로, 이 헬퍼로 감싸면 그 아래 로직을
        // 거의 그대로 재사용할 수 있다(불필요한 대규모 리팩터링을 피하기 위함).
        function fsSnapshotToMap(querySnap) {
            const map = {};
            querySnap.forEach(d => { map[d.id] = d.data(); });
            return map;
        }

        let currentUser = null; let currentUserInfo = null;
        // 비로그인 상태에서 쓰기 동작(글쓰기/좋아요/댓글 등)을 시도하면 requireLogin()이 여기에
        // "로그인 성공하면 이어서 할 일"을 담아두고, 로그인 완료 시점에 자동으로 실행한다.
        let pendingAction = null;
        let xpCloudLoaded = false; // 이 계정의 실제 XP(users/{uid}/xp)를 Firebase에서 한 번이라도 받아왔는지 - 받아오기 전의 로컬 값으로 거울을 덮어쓰지 않기 위한 표시
        let unsubscribeXpCloudSync = null; // Firebase → 로컬 XP 실시간 동기화 해제 함수 (계정 전환/로그아웃 시 해제)
        let unsubscribeDailyMissions = null; // 일일 미션(users/{uid}/dailyMissions 전체) 실시간 구독 해제 함수
        let dailyMissionsLoaded = false; // users/{uid}/dailyMissions를 Firebase에서 한 번이라도 받아왔는지 - 받기 전의 빈 값으로 내 연속 출석 거울을 덮어쓰지 않기 위한 표시
        let dailyMissionsAllCache = {}; // 날짜별 미션 완료 상태 전체 캐시 { 'YYYY-MM-DD': {attendance:true, ...}, ... } (연속 출석 계산에도 재사용)
        let unsubscribeAchievements = null; // 활동 업적(users/{uid}/achievements) 실시간 구독 해제 함수
        let myAchievementsUnlocked = {}; // 이 계정이 "한 번이라도" 해금한 업적 목록 (Firebase에서 실시간으로 채워짐)
        let latestPostsData = {}; // 활동 업적(게시글 합계) 계산용 - listenToPosts()가 채워준다(새로 읽지 않고 재사용)
        let latestArchiveData = {}; // 활동 업적(게시글 합계) 계산용 - listenToArchive()가 채워준다(새로 읽지 않고 재사용)
        let isAdmin = false; let isFounder = false; let isSubAdmin = false; let subAdminsList = {};
        // 이 파일엔 <script type="module"> 블록이 2개 있어 서로 스코프를 공유하지 않는다 - isAdmin을
        // 직접 참조하면 다른 모듈 블록(설정 모달을 여는 코드 등)에서 ReferenceError가 난다. 게터 함수로
        // 감싸서 window에 노출해두면 항상 최신 값을 안전하게 조회할 수 있다.
        window.isAdminNow = function() { return isAdmin; };
        let canPostNotice = false; // 홈 공지: 커뮤니티 엔지니어(관리자)/담임선생님/반장/부반장/운영자 작성 가능
        let canWriteSchedule = false; // 반 공용 일정: 1-2반 정회원(학생+담임선생님)이면 누구나 추가/수정/삭제 가능
        let canManageSeats = false; // 랜덤 자리 배치: 커뮤니티 엔지니어(관리자)/반장/부반장/담임선생님만 셔플·개별 자리 수정 가능
        let canManageShortcuts = false; // 홈 바로가기: 커뮤니티 엔지니어(관리자)/반장/부반장/담임선생님만 추가·수정·삭제 가능
        let isTeacherAccount = false;
        let isRestrictedViewer = false; // 1-2 담임선생님 + 타반 학생: 커뮤니티 접근 불가, 프로필은 열람만 가능(사진 기본, 설명/댓글 비공개)
        const TEACHER_ACCOUNT_EMAILS = ["nassir@hanilgo.cnehs.kr", "20261240@hanilgo.cnehs.kr"];

        // --- "1230 운영자" 권한: 최고관리자(isAdmin)/부관리자(isSubAdmin)와는 별개의 "콘텐츠 운영자" 등급 ---
        // 여러 곳에서 이메일 문자열을 따로 비교하지 않도록, 판별을 이 함수 하나로 통일한다.
        const OPERATOR_EMAIL = '20261230@hanilgo.cnehs.kr';
        function isOperatorAccount(user) {
            return !!user && (user.email || '').trim().toLowerCase() === OPERATOR_EMAIL.toLowerCase();
        }
        let isOperator = false;
        
        let profilesData = {}; // 스쿼드 연동용
        let isListeningToPosts = false;
        let isListeningToGuestReadable = false; // 로그인 없이도 볼 수 있는 커뮤니티/공지/자료실 구독 여부
        let isListeningToSquad = false;
        let activeStudentNum = null;

        const getAuthorName = () => currentUserInfo ? (currentUserInfo.nickname || `${currentUserInfo.ban}반 ${currentUserInfo.number}번`) : "익명";
        // 사이드바 프로필 카드의 내 닉네임: 커뮤니티 글과 같은 공용 렌더러(renderStyledName)로 그려 이름 효과/업적 연출이 그대로 보인다.
        let sidebarNickState = null;
        function renderSidebarNick() {
            const el = document.getElementById('profile-nick-text');
            if (!el || !sidebarNickState) return;
            const { nick, isGod, isTeacher } = sidebarNickState;
            const num = getMyStudentNum();
            if (isGod) el.innerHTML = `<span class="god-mode-text">👑 ${escapeNoticeText(nick)}</span>`;
            else if (isOperator && !num) el.innerHTML = renderStyledName(nick, operatorTestAppearance(), null, escapeNoticeText);
            else if (num && !isTeacher) el.innerHTML = renderStyledName(nick, getStudentAppearance(num, profilesData[`student_${num}`] || {}), null, escapeNoticeText);
            else el.textContent = nick;
        }
        const getAuthorOriginal = () => currentUserInfo ? `${currentUserInfo.number}번` : "익명";

        // --- 시간 표시 유틸 ---
        function formatPostTime(ts) {
            if (!ts) return '';
            const d = new Date(ts);
            const pad = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }
        // 아카이브에서 마이그레이션된 글 등 게시일이 없는 경우 undefined/NaN 대신 '—'을 보여준다.
        function formatPostTimeOrDash(ts) { return ts ? formatPostTime(ts) : '—'; }
        function formatCommentTime(ts) {
            if (!ts) return '';
            const d = new Date(ts);
            const pad = n => String(n).padStart(2, '0');
            return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }

        window.toggleAuthForm = function(showLogin) {
            document.getElementById('login-form').style.display = showLogin ? 'block' : 'none';
            document.getElementById('signup-form').style.display = showLogin ? 'none' : 'block';
        }

        document.getElementById('btn-signup').addEventListener('click', async () => {
            const email = document.getElementById('signup-email').value; const pw = document.getElementById('signup-password').value;
            const normalizedEmail = email.trim().toLowerCase();
            let grade, ban, number;
            if (TEACHER_ACCOUNT_EMAILS.includes(normalizedEmail) && normalizedEmail === "nassir@hanilgo.cnehs.kr") {
                // 1-2 담임선생님 전용 계정: 학번 형식이 아니므로 별도로 1학년 2반 소속(정회원 권한)으로 등록
                grade = "1"; ban = "2"; number = "98";
            } else {
                const match = normalizedEmail.match(/^(\d{4})(\d{1})(\d{1})(\d{2})@hanilgo\.cnehs\.kr$/);
                if(!match) return alert("⚠️ 가입 불가: 한일고 학생 메일(학번포함)만 가능합니다.");
                grade = match[2]; ban = match[3]; number = match[4];

                // 1학년 2반은 실제 존재하는 번호(1~26번), 관리자(30번), 부담임 계정(40번)만 가입 허용
                if (grade === "1" && ban === "2") {
                    const numInt = parseInt(number, 10);
                    const allowed = (numInt >= 1 && numInt <= 26) || numInt === 30 || numInt === 40;
                    if (!allowed) return alert("⚠️ 가입 불가: 1학년 2반에 존재하지 않는 번호입니다.");
                }
            }
            try {
                const userCred = await createUserWithEmailAndPassword(auth, email, pw);
                const roleVal = ban === "2" ? "class2_member" : "other_class_member";
                await set(ref(db, `users/${userCred.user.uid}`), { email: email, grade: grade, ban: ban, number: number, role: roleVal });
                // Firestore 보안 규칙은 RTDB를 읽을 수 없으므로, 규칙 판단에 필요한 최소 식별 정보(등급/반/번호/역할)만
                // Firestore에도 거울로 남긴다. RTDB의 users/{uid}가 여전히 원본이고, 이건 Rules 전용 사본이다.
                // number는 원본이 "06" 같은 0-padding 문자열이지만, sub_admins 등 다른 컬렉션의 문서ID는
                // student_6 처럼 정수로 만들어지므로, Rules에서 그 둘을 정확히 비교할 수 있도록 정수로 저장한다.
                await setDoc(doc(fdb, 'users', userCred.user.uid), { grade, ban, number: parseInt(number, 10), role: roleVal }).catch(() => {});
                alert("가입 성공!");
            } catch(e) { alert(e.message); }
        });

        document.getElementById('btn-login').addEventListener('click', async () => {
            try {
                const rememberMe = document.getElementById('login-remember-me')?.checked !== false;
                // 체크하면(기본값) 브라우저를 닫아도 로그인이 유지되고, 체크 해제하면 탭/브라우저를
                // 닫는 순간 로그아웃된다 (같은 계정으로 이후 다시 signIn하면 그때 선택으로 갱신됨).
                await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
                await signInWithEmailAndPassword(auth, document.getElementById('login-email').value, document.getElementById('login-password').value);
            }
            catch(e) { alert("로그인 실패"); }
        });

        document.getElementById('btn-logout').addEventListener('click', () => {
            teardownPresence();
            if (typeof unsubscribeXpCloudSync === 'function') { unsubscribeXpCloudSync(); unsubscribeXpCloudSync = null; }
            if (typeof unsubscribeDailyMissions === 'function') { unsubscribeDailyMissions(); unsubscribeDailyMissions = null; }
            if (typeof unsubscribeAchievements === 'function') { unsubscribeAchievements(); unsubscribeAchievements = null; }
            dailyMissionsAllCache = {}; myAchievementsUnlocked = {}; xpCloudLoaded = false; dailyMissionsLoaded = false;
            if (window.PlannerApp && window.PlannerApp.resetLocalXPDisplay) window.PlannerApp.resetLocalXPDisplay(); // 로그아웃은 인증 상태만 종료 - Firebase에는 아무것도 쓰지 않고 화면 표시만 초기화
            currentUser = null; currentUserInfo = null; isAdmin = false; isFounder = false; isSubAdmin = false; isTeacherAccount = false; isOperator = false; isRestrictedViewer = false; canPostNotice = false; canWriteSchedule = false; canManageSeats = false; canManageShortcuts = false; isListeningToPosts = false; isListeningToSquad = false; signOut(auth);
        });

        // 닉네임 수정은 "내 프로필 설정" 창으로 옮겨졌다(예전 사이드바 버튼/모바일 메뉴의 닉네임 버튼은 이 창을 연다).
        window.setNickname = function() {
            if (!currentUser) return showLoginScreen(() => setNickname());
            if (!currentUserInfo) return;
            openDecorateModal();
            setTimeout(() => {
                const input = document.getElementById('decorate-nick-input');
                if (input && document.getElementById('decorate-modal').style.display === 'flex') { input.focus(); input.select(); }
            }, 60);
        };

        // 리치 에디터 툴바 주입 (페이지 로드 시 한 번) - 커뮤니티/공지/설문 작성 화면 공용
        (function injectRichToolbars() {
            const slots = [
                ['post-content-toolbar-slot', 'post-content'],
                ['notice-form-content-toolbar-slot', 'notice-form-content'],
                ['poll-form-desc-toolbar-slot', 'poll-form-desc'],
            ];
            slots.forEach(([slotId, targetId]) => {
                const slot = document.getElementById(slotId);
                if (slot) slot.innerHTML = richEditorToolbarHTML(targetId);
            });
        })();

        const sidebar = document.getElementById('sidebar');
        const sidebarToggle = document.getElementById('sidebar-toggle'); // 5.0: hover-expand로 대체되어 더 이상 존재하지 않음 (구버전 호환용 가드)
        if (sidebarToggle) {
            sidebarToggle.addEventListener('click', () => {
                sidebar.classList.toggle('collapsed');
                sidebarToggle.innerText = sidebar.classList.contains('collapsed') ? '▶' : '◀';
            });
        }

        // 5.0 사이드바 스크롤 위치 기억: 접히기 직전 스크롤 위치를 저장해두고, 다시 펼쳐질 때 그 위치로 복원한다.
        // (접힌 상태에서는 그룹 하위메뉴가 안 보여서 스크롤 가능 높이가 줄어들고, 브라우저가 scrollTop을 자동으로
        //  0 근처로 잘라버리기 때문에 그냥 두면 항상 맨 위로 돌아가 버린다.)
        // "펼쳐져 있는 동안에만" 스크롤 값을 계속 기록해두는 방식이라, 접히는 순간 브라우저가 scrollTop을
        // 강제로 0으로 clamp해도(이때도 scroll 이벤트가 뜬다) 그 값으로 덮어쓰이지 않고 마지막으로 펼쳐져
        // 있었을 때의 값이 그대로 남는다.
        const sidebarMenuContainer = document.querySelector('.sidebar-menu-container');
        let savedSidebarScrollTop = 0;
        function isSidebarExpanded() {
            return sidebar.matches(':hover') || sidebar.classList.contains('mobile-open') || sidebar.classList.contains('touch-expanded') || sidebar.classList.contains('pinned-expanded');
        }
        if (sidebarMenuContainer) {
            sidebarMenuContainer.addEventListener('scroll', () => {
                if (isSidebarExpanded()) savedSidebarScrollTop = sidebarMenuContainer.scrollTop;
            });
        }
        function restoreSidebarScroll() {
            if (!sidebarMenuContainer) return;
            // 펼침 트랜지션(하위메뉴 max-height, 폭 등)이 끝나기 전에 한 번만 복원하면, 아직 다 안 늘어난
            // scrollHeight에 맞춰 브라우저가 값을 잘라버릴 수 있다. 그래서 트랜지션이 끝날 때까지
            // 여러 번 다시 적용해서, 콘텐츠가 다 펼쳐진 뒤의 최종 값으로 확실히 안착시킨다.
            sidebarMenuContainer.scrollTop = savedSidebarScrollTop;
            [30, 80, 150, 250].forEach(delay => {
                setTimeout(() => { sidebarMenuContainer.scrollTop = savedSidebarScrollTop; }, delay);
            });
        }
        sidebar.addEventListener('mouseenter', restoreSidebarScroll); // 데스크톱 마우스로 펼칠 때

        // 5.0 모바일: 하단 '메뉴' 버튼으로 사이드바를 드로어처럼 열고, 바깥(반투명 오버레이) 클릭 시 닫는다.
        // (모바일 하단 '메뉴' 버튼은 이제 왼쪽 드로어 대신, 버튼 바로 위에서 항목이 차례로 올라오는 시트(#mb-menu-sheet)를 연다.)
        const mbMenuBtn = document.getElementById('mb-menu-btn');
        const mbSheet = document.getElementById('mb-menu-sheet');
        const mbOverlay = document.getElementById('mb-menu-overlay');
        function closeMobileMenu(immediate) {
            if (!mbSheet || !mbSheet.classList.contains('open')) return;
            mbOverlay.classList.remove('open');
            mbMenuBtn.classList.remove('open'); mbMenuBtn.setAttribute('aria-expanded', 'false');
            mbMenuBtn.querySelector('.mb-icon').textContent = '☰';
            mbSheet.setAttribute('aria-hidden', 'true');
            mbSheet.classList.remove('open');
            if (!immediate) { mbSheet.classList.add('closing'); setTimeout(() => mbSheet.classList.remove('closing'), 170); }
        }
        // 사이드바 DOM 에서 지금 보이는 메뉴를 그대로 읽어 시트를 만든다(로그인/게스트/권한에 따라 숨겨진 항목은 자동으로 빠진다).
        function buildMobileMenu() {
            const visible = (el) => !!el && getComputedStyle(el).display !== 'none';
            const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
            const actions = []; // index → 눌렀을 때 실행할 원래 사이드바 요소
            const make = (el, cls, withIcon) => {
                const label = (el.querySelector('.nav-label') || el).textContent.trim();
                const icon = el.querySelector('.nav-icon');
                actions.push(el);
                return `<button type="button" class="mb-sheet-item ${cls || ''} ${el.classList.contains('active') ? 'active' : ''}" role="menuitem" data-mb="${actions.length - 1}">${withIcon && icon ? `<span class="mb-sheet-ico">${esc(icon.textContent.trim())}</span>` : ''}<span>${esc(label)}</span></button>`;
            };
            const blocks = []; // 위에서 아래 순서의 덩어리들(애니메이션은 아래쪽부터 시작)
            const profileCard = document.getElementById('user-profile-card'), guestCard = document.getElementById('guest-login-card');
            if (visible(profileCard)) {
                const nick = (document.getElementById('profile-nick-text') || {}).textContent || '';
                const role = (document.getElementById('profile-role-text') || {}).textContent || '';
                blocks.push(`<div class="mb-sheet-head"><div class="mb-sheet-head-main"><div class="mb-sheet-nick">👤 ${esc(nick.trim())}</div><div class="mb-sheet-role">${esc(role.trim())}</div></div><button type="button" class="mb-sheet-mini" data-mb-act="nick">⚙️ 프로필 설정</button></div>`);
            } else if (visible(guestCard)) {
                blocks.push(`<div class="mb-sheet-head"><div class="mb-sheet-head-main"><div class="mb-sheet-nick">로그인하지 않았어요</div><div class="mb-sheet-role">글쓰기·좋아요는 로그인이 필요해요</div></div><button type="button" class="mb-sheet-mini primary" data-mb-act="login">🔑 로그인</button></div>`);
            }
            document.querySelectorAll('.sidebar-nav > *').forEach((node) => {
                if (!visible(node)) return;
                if (node.classList.contains('nav-item')) {
                    blocks.push(`<div class="mb-sheet-list">${make(node, '', true)}</div>`);
                } else if (node.classList.contains('nav-group')) {
                    const header = node.querySelector('.nav-group-header');
                    const items = [...node.querySelectorAll('.nav-group-items > .nav-item')].filter(visible);
                    if (!items.length) return;
                    const title = `${header.querySelector('.nav-icon').textContent.trim()} ${header.querySelector('.nav-label').textContent.trim()}`;
                    blocks.push(`<div class="mb-sheet-section"><div class="mb-sheet-title">${esc(title)}</div><div class="mb-sheet-chips">${items.map(it => make(it, 'mb-sheet-chip', false)).join('')}</div></div>`);
                }
            });
            const foot = [];
            ['btn-open-settings', 'btn-logout'].forEach((id) => { const el = document.getElementById(id); if (visible(el)) foot.push(make(el, id === 'btn-logout' ? 'danger' : '', true)); });
            if (foot.length) blocks.push(`<div class="mb-sheet-foot">${foot.join('')}</div>`);
            // 아래쪽 덩어리일수록 먼저(--i 작게) 올라오도록 인덱스를 뒤집어 각 덩어리를 감싼다
            mbSheet.innerHTML = blocks.map((html, idx) => `<div class="mb-sheet-in" style="--i:${blocks.length - 1 - idx}">${html}</div>`).join('');
            mbSheet._actions = actions;
        }
        function openMobileMenu() {
            buildMobileMenu();
            const nav = document.getElementById('mobile-bottom-nav');
            const h = nav ? nav.getBoundingClientRect().height : 62;
            mbSheet.style.bottom = (h + 12) + 'px';
            mbSheet.style.maxHeight = `calc(100dvh - ${h + 80}px)`;
            mbSheet.scrollTop = 0;
            mbSheet.classList.remove('closing'); mbSheet.classList.add('open'); mbSheet.setAttribute('aria-hidden', 'false');
            mbOverlay.classList.add('open');
            mbMenuBtn.classList.add('open'); mbMenuBtn.setAttribute('aria-expanded', 'true');
            mbMenuBtn.querySelector('.mb-icon').textContent = '✕';
        }
        if (mbMenuBtn && mbSheet) {
            mbMenuBtn.addEventListener('click', () => { if (window.innerWidth > 768) return; mbSheet.classList.contains('open') ? closeMobileMenu() : openMobileMenu(); });
            mbOverlay.addEventListener('click', () => closeMobileMenu());
            mbSheet.addEventListener('click', (e) => {
                const act = e.target.closest('[data-mb-act]');
                if (act) {
                    closeMobileMenu();
                    if (act.dataset.mbAct === 'login' && window.showLoginScreen) window.showLoginScreen();
                    if (act.dataset.mbAct === 'nick' && window.setNickname) window.setNickname();
                    return;
                }
                const btn = e.target.closest('[data-mb]');
                if (!btn) return;
                const el = (mbSheet._actions || [])[Number(btn.dataset.mb)];
                closeMobileMenu();
                if (el) setTimeout(() => el.click(), 60); // 시트가 닫히기 시작한 뒤 원래 메뉴 동작 실행
            });
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMobileMenu(true); });
            window.addEventListener('resize', () => { if (window.innerWidth > 768) closeMobileMenu(true); });
        }
        sidebar.addEventListener('click', (e) => {
            if (e.target === sidebar && window.innerWidth <= 768) sidebar.classList.remove('mobile-open');
        });

        // 5.0 터치 인터페이스 대응: 데스크톱 폭(>768px)에서 마우스는 hover로 펼쳐지지만,
        // 터치 기기는 hover가 없어서 '첫 탭'이 곧바로 메뉴 클릭으로 오인식되는 문제가 있었다.
        // 그래서 터치 기기에서는: 접힌 상태의 첫 탭은 "펼치기만" 하고 실제 이동은 막았다가,
        // 이미 펼쳐진 상태의 탭만 정상적으로 메뉴를 실행한다. 바깥을 탭하면 다시 접힌다.
        function isCoarsePointer() {
            return window.matchMedia('(hover: none)').matches || window.matchMedia('(pointer: coarse)').matches;
        }
        sidebar.addEventListener('click', (e) => {
            if (window.innerWidth <= 768) return; // 모바일은 하단 '메뉴' 버튼 드로어 방식을 그대로 사용
            if (!isCoarsePointer()) return; // 마우스 환경은 기존 hover 확장 그대로 사용
            if (sidebar.classList.contains('pinned-expanded')) return; // "항상 펼치기"면 이미 펼쳐져 있으므로 첫 탭부터 바로 메뉴를 실행한다
            if (!sidebar.classList.contains('touch-expanded')) {
                sidebar.classList.add('touch-expanded');
                restoreSidebarScroll();
                e.stopPropagation();
                e.preventDefault();
            }
        }, true);
        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 768) return;
            if (!sidebar.classList.contains('touch-expanded')) return;
            if (!sidebar.contains(e.target)) sidebar.classList.remove('touch-expanded');
        });

        // 5.0 사이드바 그룹(👥 커뮤니티 / 📚 학습 / 🗂 자료실) 접기/펼치기
        window.toggleNavGroup = function(groupName) {
            const group = document.getElementById(`nav-group-${groupName}`);
            if (group) group.classList.toggle('expanded');
        };
        // 그룹으로 묶인 탭들 - 이 중 하나가 활성화되면 해당 그룹을 자동으로 펼친다
        const NAV_GROUP_OF_TAB = { community:'community', meal:'school', timetable:'school', schedule:'school', exam:'school', cleaning:'school', squad:'school', seat:'school', planner:'study' };

        window.switchTab = function(tabId) {
            if (isRestrictedViewer && tabId === 'community') { tabId = 'home'; }
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            const target = document.getElementById(`tab-${tabId}`);
            if(target) target.classList.add('active');
            // 5.0: 사이드바 구조가 그룹/중첩으로 복잡해져서, 위치 인덱스 대신 data-tab 속성으로 활성 항목을 찾는다
            document.querySelectorAll('.sidebar-nav [data-tab]').forEach(i => i.classList.toggle('active', i.dataset.tab === tabId));
            const grp = NAV_GROUP_OF_TAB[tabId];
            if (grp) { const g = document.getElementById(`nav-group-${grp}`); if (g) g.classList.add('expanded'); }
            document.querySelectorAll('.mobile-bottom-nav .mb-item').forEach(i => i.classList.remove('active'));
            const mbTarget = document.querySelector(`.mobile-bottom-nav .mb-item[data-tab="${tabId}"]`);
            if (mbTarget) mbTarget.classList.add('active');
            sidebar.classList.remove('mobile-open'); // 메뉴에서 탭을 고르면 드로어 자동으로 닫힘
            sidebar.classList.remove('touch-expanded'); // 터치 기기에서 펼친 뒤 탭을 고르면 다시 접힘
            if (tabId === 'mixtape') {
                if (typeof renderMusicHome === 'function') renderMusicHome();
            } else if (window.__inPlaylistPlayScreen) {
                // Music 탭 안의 "실제 재생 화면"을 보다가 다른 탭(홈/커뮤니티 등)으로 완전히 나가면,
                // 이 플래그가 계속 true로 남아서 전역 PiP의 MixTape 표시가 계속 억제되는 문제가 있었다.
                // 여기서도 반드시 꺼줘야 다른 탭에 있는 동안 PiP가 정상적으로 뜬다.
                window.__inPlaylistPlayScreen = false;
                if (window.GlobalMiniController) window.GlobalMiniController.handleGesture();
            }
            document.querySelector('.main').scrollTo({ top: 0, behavior: 'smooth' });
        }

// =========================================================================
        // XP 저장소: Firebase Realtime Database (users/{uid}/xp)
        // - 계정별 데이터. 기기(브라우저)가 아니라 로그인 계정에 귀속된다.
        // - 우선순위: Firebase XP > 이 브라우저의 기존 localStorage XP(1회 마이그레이션용) > 기본값 0
        // - 이미 Firebase에 xp가 있으면 절대로 localStorage 값으로 덮어쓰지 않는다.
        // =========================================================================
        function readLocalLegacyXP() {
            try {
                const v = JSON.parse(localStorage.getItem('planner_xp'));
                return (typeof v === 'number' && !isNaN(v)) ? Math.max(0, v) : null;
            } catch (e) { return null; }
        }

        // Firebase에 xp가 아직 없는 계정에 한해서만 1회 마이그레이션(또는 0 초기화)한다.
        // runTransaction으로 "값이 없을 때만 쓴다"를 보장하므로, 여러 탭/기기에서 동시에 로그인해도
        // 이미 존재하는 Firebase XP를 실수로 덮어쓸 위험이 없다.
        async function migrateOrInitUserXP(uid) {
            const legacyXP = readLocalLegacyXP();
            try {
                const result = await runTransaction(ref(db, `users/${uid}/xp`), (current) => {
                    if (typeof current === 'number') return; // 이미 값이 있음 -> 절대 덮어쓰지 않고 중단
                    return legacyXP !== null ? legacyXP : 0;
                });
                const finalVal = result.snapshot.val();
                return (typeof finalVal === 'number') ? finalVal : 0;
            } catch (e) {
                // 네트워크 오류 등으로 마이그레이션 자체가 실패한 경우: 최소한 화면이 죽지 않도록
                // 로컬에 남아있던 값(있다면)으로라도 우선 보여준다. 실제 저장은 재접속 시 재시도된다.
                return legacyXP !== null ? legacyXP : 0;
            }
        }

        // 현재 로그인 계정의 users/{uid}/xp를 실시간 구독한다.
        // - 값이 있으면 그대로 반영 (다른 기기에서 XP가 바뀌어도 곧바로 반영됨).
        // - 값이 없으면(신규 계정) 1회에 한해 마이그레이션/0 초기화를 수행한다.
        function subscribeAndSyncUserXP(uid) {
            if (typeof unsubscribeXpCloudSync === 'function') { unsubscribeXpCloudSync(); unsubscribeXpCloudSync = null; }
            let migrating = false;
            unsubscribeXpCloudSync = onValue(ref(db, `users/${uid}/xp`), (snap) => {
                const v = snap.val();
                if (typeof v === 'number') {
                    if (window.PlannerApp && window.PlannerApp.setXPFromCloud) window.PlannerApp.setXPFromCloud(v);
                    xpCloudLoaded = true;
                    syncOwnXpMirror();
                } else if (!migrating) {
                    migrating = true;
                    migrateOrInitUserXP(uid).then((xp) => {
                        if (window.PlannerApp && window.PlannerApp.setXPFromCloud) window.PlannerApp.setXPFromCloud(xp);
                        xpCloudLoaded = true;
                        syncOwnXpMirror();
                    });
                }
            }, (err) => {
                console.warn('XP 동기화 오류:', err);
            });
        }

        // addXP()에서 실제 XP 증감을 Firebase에 반영할 때 호출하는 브릿지 함수.
        // runTransaction을 사용해 동시 실행(여러 기기에서 거의 동시에 XP 변경)에도 값이 안전하게 누적되도록 한다.
        window.__fbApplyXPDelta = function(amount) {
            if (!currentUser) return Promise.reject(new Error('로그인이 필요합니다.'));
            return runTransaction(ref(db, `users/${currentUser.uid}/xp`), (current) => {
                const base = typeof current === 'number' ? current : 0;
                return Math.max(0, base + amount);
            }).then((result) => {
                if (!result.committed) throw new Error('XP 트랜잭션이 반영되지 않았습니다.');
                return result.snapshot.val();
            });
        };

// --- 인증 & 권한 상태 변경 감지 ---
        onAuthStateChanged(auth, (user) => {
            if (user) {
                document.getElementById('auth-container').style.display = 'none';
                document.getElementById('app-container').classList.add('authenticated');

                if (user.isAnonymous) {
                    // 게스트(비로그인 열람) 모드: currentUser/currentUserInfo는 절대 채우지 않는다 -
                    // 이래야 앱 전체에 이미 깔려있는 "!currentUser면 로그인 필요" 가드들이
                    // 하나도 손대지 않아도 그대로 상호작용을 막아준다. 여기서는 읽기 전용 구독과
                    // 사이드바 UI만 guest 모드로 맞춘다.
                    applyGuestUI();
                    notifyAuthChange('guest');
                    return;
                }

                // RTDB(users/{uid})는 브라우저 SDK에 오프라인 캐시가 없다 - 완전히 오프라인이면 이
                // 리스너가 영원히 응답하지 않아서, 로그인은 됐는데(Firebase Auth 자체는 로컬에 남아있는
                // 세션을 오프라인에서도 바로 복원한다) 그 아래 모든 초기화(플래너/급식/청소/일정 등 화면
                // 구성)가 통째로 멈춰 서서 "로그인 화면에서 안 넘어가는" 것처럼 보이는 원인이 됐다.
                // 그래서 리스너를 걸기 전에 마지막으로 저장해둔 내 프로필로 먼저 이 초기화를 실행해둔다.
                function initSignedInUser(d, user) {
                        currentUser = user;
                        currentUserInfo = d;
                        setGuestReadBanner(false);
                        // 게스트 모드였다가 방금 실제로 로그인한 경우를 포함해서, 사이드바를 항상 진짜 회원용으로 되돌린다.
                        document.getElementById('guest-login-card').style.display = 'none';
                        document.getElementById('user-profile-card').style.display = 'block';
                        setGuestLockedCards(false);
                        const logoutBtnEl = document.getElementById('btn-logout');
                        if (logoutBtnEl) logoutBtnEl.style.display = '';
                        // 글쓰기/좋아요 등 쓰기 동작을 하려다 로그인 위젯이 뜬 경우, 로그인이 끝난 지금
                        // 원래 하려던 동작을 자동으로 이어서 실행한다 (requireLogin/showLoginScreen 참고).
                        // 이 리스너는 유저 문서가 바뀔 때마다 다시 불릴 수 있으므로, 한 번 실행한 뒤에는
                        // 곧바로 null로 비워서 다음 재실행 때 중복 실행되지 않게 한다.
                        if (pendingAction) {
                            const action = pendingAction;
                            pendingAction = null;
                            hideLoginScreen();
                            try { action(); } catch (err) { console.error('로그인 후 이어하기 실패:', err); }
                        }
                        const is2Ban = d.role === "class2_member";

                        isAdmin = (d.grade === "1" && d.ban === "2" && parseInt(d.number) === 30);
                        isFounder = (d.grade === "1" && d.ban === "2" && parseInt(d.number) === 20);
                        if(isFounder) isAdmin = true;
                        isTeacherAccount = TEACHER_ACCOUNT_EMAILS.includes((user.email || "").trim().toLowerCase());
                        notifyAuthChange(user.uid); // 선생님 여부가 정해진 뒤에 알린다(앱스토어가 카테고리 숨김을 이 값으로 판단)
                        isOperator = isOperatorAccount(user); // 1230 운영자 (isAdmin/isSubAdmin과는 별개 등급)
                        isRestrictedViewer = isTeacherAccount || !is2Ban; // 담임선생님 & 타반 학생: 동일하게 제한된 열람 권한
                        applyUserCustomization(d); // 개인 배경화면/강조색 커스텀 적용

                        // Firestore 보안 규칙이 참조할 최소 식별 정보(등급/반/번호/역할) 거울을 1회 채워넣는다.
                        // 가입 시 이미 만들어졌다면(getDoc이 존재 확인) 다시 쓰지 않는다 - 신규 가입 계정과 중복 작업 방지.
                        getDoc(doc(fdb, 'users', user.uid)).then(snap => {
                            if (!snap.exists()) {
                                setDoc(doc(fdb, 'users', user.uid), { grade: d.grade, ban: d.ban, number: parseInt(d.number, 10), role: d.role }).catch(() => {});
                            }
                        }).catch(() => {});

                        // XP는 이 브라우저의 localStorage가 아니라 Firebase의 users/{uid}/xp를
                        // 단일 원본(source of truth)으로 쓴다 (계정별 데이터, 기기별 데이터가 아님).
                        // 로그인한 계정이 바뀔 때마다 클라우드 값으로 동기화해서,
                        // "다른 계정으로 로그인했더니 이전 계정의 레벨이 그대로 보이는" 문제를 막는다.
                        // 실시간 리스너라서 다른 기기에서 XP가 바뀌어도 곧바로 반영된다.
                        subscribeAndSyncUserXP(user.uid);
                        subscribeDailyMissions();
                        subscribeAchievements();

                        onSnapshot(collection(fdb, 'sub_admins'), (subSnap) => {
                            subAdminsList = {};
                            subSnap.forEach(d => { subAdminsList[d.id] = true; }); // 문서가 존재하면 곧 부관리자로 지정된 것 (문서 내용 자체보다 존재 여부가 플래그 역할)
                            isSubAdmin = !!subAdminsList[`student_${parseInt(d.number)}`];

                            const displayNick = isTeacherAccount ? TEACHER_98_DISPLAY_NAME : (d.nickname ? d.nickname : `${d.grade}-${d.ban}반 ${d.number}번`);
                            let roleText = is2Ban ? "🟢 1-2반 정회원" : "🟡 타 학급 회원";
                            if(isFounder) roleText = "🌟 커뮤니티 창시자";
                            else if(isAdmin) roleText = "⚙️ 커뮤니티 엔지니어";
                            else if (isSubAdmin) roleText = "🛡️ 커뮤니티 관리자";

                            // 학급 반장 / 부반장 표기 (1학년 2반 20번=반장, 3번=부반장)
                            let isViceClassPresident = false;
                            if (d.grade === "1" && d.ban === "2") {
                                const classNum = parseInt(d.number);
                                if (classNum === 20) roleText += " · 🎖️ 반장";
                                else if (classNum === 3) { roleText += " · 🎗️ 부반장"; isViceClassPresident = true; }
                            }

                            if (isTeacherAccount) roleText = "🧑‍🏫 1-2 담임선생님";

                            // 홈 공지 작성 권한: 커뮤니티 엔지니어(관리자/창시자)·담임선생님·반장(=창시자)·부반장·1230 운영자
                            canPostNotice = isAdmin || isTeacherAccount || isViceClassPresident || isOperator;
                            // 반 공용 일정 등록/수정/삭제 권한: 1-2반 정회원(학생+담임선생님)이면 누구나 가능
                            canWriteSchedule = is2Ban || isTeacherAccount;
                            // 랜덤 자리 배치 셔플/개별 자리 수정 권한: 커뮤니티 엔지니어(관리자)·반장·부반장·담임선생님만
                            canManageSeats = isAdmin || isFounder || isViceClassPresident || isTeacherAccount;
                            // 홈 화면 바로가기 추가/수정/삭제 권한: 커뮤니티 엔지니어(관리자)·반장·부반장·담임선생님만
                            canManageShortcuts = isAdmin || isFounder || isViceClassPresident || isTeacherAccount;
                            updateSeatComposerVisibility();
                            updateShortcutComposerVisibility();
                            updateNoticeComposerVisibility();
                            updatePollComposerVisibility();
                            updateScheduleComposerVisibility();
                            if (window.checkArchiveMigrationStatus) checkArchiveMigrationStatus();
                            if (window.PlannerApp && window.PlannerApp.getXP && window.onXPChanged) window.onXPChanged(window.PlannerApp.getXP());

                            const SPECIAL_EMAIL = "20261211@hanilgo.cnehs.kr"; 

                            const nickTextEl = document.getElementById('profile-nick-text');
                            const roleTextEl = document.getElementById('profile-role-text');
                            sidebarNickState = { nick: displayNick, isGod: user.email === SPECIAL_EMAIL, isTeacher: isTeacherAccount };
                            renderSidebarNick();
                            syncOwnNicknameMirror();
                            if (roleTextEl) roleTextEl.textContent = roleText;
                            if (window.updatePresenceWidgetUI) window.updatePresenceWidgetUI();
                        });

                        // 커뮤니티 엔지니어/창시자 전용: 공용 시간표 수정 버튼 노출
                        const adminToggleBtn = document.getElementById('admin-timetable-toggle');
                        const adminResetBtn = document.getElementById('admin-timetable-reset');
                        if (adminToggleBtn) adminToggleBtn.style.display = isAdmin ? 'inline-block' : 'none';
                        if (adminResetBtn) adminResetBtn.style.display = isAdmin ? 'inline-block' : 'none';
                        if (!isAdmin) adminTimetableEditMode = false;
                        
                        document.getElementById('welcome-title').innerText = isTeacherAccount ? "1-2 담임선생님, 반가워요! 🏠" : `${d.grade}학년 ${d.ban}반 반가워요! 🏠`;
                        
                        ['community', 'materials', 'exam', 'seat', 'profile'].forEach(id => {
                            const canView = is2Ban || isRestrictedViewer;
                            document.getElementById(`${id}-secure-content`).style.display = canView ? 'block' : 'none';
                            document.getElementById(`${id}-locked-content`).style.display = canView ? 'none' : 'block';
                        });

                        // 1-2 담임선생님 & 타반 학생 계정에게는 커뮤니티만 완전히 숨긴다 (2반 아카이브·프로필 등은 열람 가능)
                        ['nav-community'].forEach(id => {
                            const el = document.getElementById(id);
                            if (el) el.style.display = isRestrictedViewer ? 'none' : '';
                        });
                        ['home-community-card'].forEach(id => {
                            const el = document.getElementById(id);
                            if (el) el.style.display = isRestrictedViewer ? 'none' : '';
                        });
                        if (isRestrictedViewer) {
                            ['community'].forEach(id => {
                                const sec = document.getElementById(`${id}-secure-content`); if (sec) sec.style.display = 'none';
                                const lock = document.getElementById(`${id}-locked-content`); if (lock) lock.style.display = 'none';
                            });
                        }

                        listenToProfiles(); renderCurrentDuty(); renderHomeTimetable(); fetchMeals(); fetchWeather(); listenToHomeWidgets(); renderTimetableTable(); listenToNotices(); listenToPolls(); renderWeeklyReportSummary(); renderCurrentPeriodWidget(); renderDailyMissionsWidget(); setupPresence(); listenToPresence(); listenToSharedSchedule(); listenToPersonalSchedule(); listenToShortcuts();
                        // NEIS 학사일정 자동 동기화: 세션당 한 번만 시도하고, 브라우저별로 최근 동기화 후 일정 시간 내면 건너뛴다.
                        if (!neisSyncTriggered) {
                            neisSyncTriggered = true;
                            if (shouldSyncNeisNow()) syncNeisSchedules();
                        }

                        if (is2Ban && !isListeningToPosts) {
                            // listenToPosts/listenToArchiveStudy/listenToArchiveEtc/loadSupabaseMaterials는
                            // 게스트 모드에서 이미 구독했을 수 있으니(isListeningToGuestReadable) 중복 구독하지 않는다.
                            if (!isListeningToGuestReadable) { listenToPosts(); listenToArchiveStudy(); listenToArchiveEtc(); loadSupabaseMaterials(); isListeningToGuestReadable = true; }
                            listenToArchive(); listenToExamNotes(); listenToCalendar(); listenToSeating();
                            isListeningToPosts = true;
                        }
                        if (!isListeningToSquad) { listenToSquad(); isListeningToSquad = true; }
                }
                onValue(ref(db, `users/${user.uid}`), (snapshot) => {
                    const d = snapshot.val();
                    if (d) {
                        saveInfoCache('user_profile_' + user.uid, d);
                        initSignedInUser(d, user);
                    }
                });
                // 위 리스너가 응답하기 전(또는 오프라인이라 영원히 응답하지 않을 때) 마지막으로 저장해둔
                // 프로필로 먼저 화면을 채운다 - 온라인이면 곧바로 리스너의 최신 값이 덮어쓴다.
                const cachedUserProfile = loadInfoCache('user_profile_' + user.uid);
                if (cachedUserProfile) initSignedInUser(cachedUserProfile.data, user);
            } else {
                // 진짜 로그아웃 상태(익명 세션도 없음): 익명으로라도 로그인해서 커뮤니티를 읽을 수 있게
                // 시도한다. 이 콜백이 다시 익명 사용자로 한 번 더 불려서 위 user.isAnonymous 분기를 탄다.
                // 프로젝트에서 익명 로그인 자체가 꺼져있는 등 실패하면 기존처럼 로그인 화면만 보여준다.
                signInAnonymously(auth).catch(() => {
                    // 익명 로그인이 꺼져 있거나(Firebase 콘솔) 네트워크 문제로 실패해도 로그인 화면으로 막지 않는다 -
                    // 세션 없이 그대로 게스트 모드로 열람시키고(currentUser 는 null), 쓰기 동작을 할 때 로그인 위젯이 뜬다.
                    // (RTDB 규칙이 로그인 필요라면 커뮤니티 글 같은 실시간 데이터는 비어 보일 수 있다.)
                    document.getElementById('auth-container').style.display = 'none';
                    document.getElementById('app-container').classList.add('authenticated');
                    applyGuestUI();
                    notifyAuthChange('guest');
                });
            }
        });

        // 로그인 상태 확인(게스트 세션 만들기 포함)이 오래 걸려도(느린 네트워크/오프라인) 로딩 화면에 갇히지 않도록,
        // 6초가 지나도 앱 화면이 안 열렸으면 일단 게스트 화면으로 연다. 이후 인증이 끝나면 위 핸들러가 정상적으로 이어받는다.
        setTimeout(() => {
            const appEl = document.getElementById('app-container');
            if (appEl && !appEl.classList.contains('authenticated') && document.getElementById('auth-container').style.display !== 'flex') {
                appEl.classList.add('authenticated');
                applyGuestUI();
                notifyAuthChange('guest');
            }
        }, 6000);

        // 로그인 상태(게스트 ↔ 회원)가 바뀔 때만 다른 화면(앱스토어 등)에 알린다. initSignedInUser 는 같은 사용자로도 여러 번 불린다.
        let lastAuthKey = null;
        function notifyAuthChange(key) {
            if (lastAuthKey === key) return;
            lastAuthKey = key;
            window.dispatchEvent(new Event('gmw:authchange'));
        }

        // 게스트가 읽는 Firestore 컬렉션(글/공지/설문/자료)이 "로그인 필요" 규칙에 막히면(permission-denied) 콘솔에 "Uncaught Error in snapshot listener"
        // 만 쌓이고 화면은 "아직 글이 없어요"처럼 보인다. 이 경우 안내 배너를 띄우고, 로그인하면 숨긴다.
        // (근본 해결: Firebase 콘솔에서 익명 로그인을 켜거나, 해당 컬렉션을 공개 읽기로 허용)
        function setGuestReadBanner(on) {
            const el = document.getElementById('guest-read-banner');
            if (el) el.style.display = on ? 'flex' : 'none';
        }
        function onReadDenied(label) {
            return (err) => {
                console.warn(`${label} 읽기 실패:`, err && err.code);
                if (!currentUser && err && err.code === 'permission-denied') setGuestReadBanner(true);
            };
        }

        // 게스트에게는 반 친구 프로필/시험 아카이브/자리 배치처럼 계정이 있어야 의미 있는 화면이 빈 칸으로 보이므로,
        // 잠금 카드 자리에 "로그인하면 볼 수 있어요"를 보여준다. 로그인하면 원래 잠금 문구("접근 권한이 없습니다")로 되돌린다.
        const GUEST_LOCKED_TABS = ['exam', 'seat', 'profile'];
        function setGuestLockedCards(on) {
            GUEST_LOCKED_TABS.forEach(id => {
                const lock = document.getElementById(`${id}-locked-content`), secure = document.getElementById(`${id}-secure-content`);
                if (!lock) return;
                if (lock.dataset.origHtml === undefined) lock.dataset.origHtml = lock.innerHTML;
                if (on) {
                    lock.innerHTML = `<div class="card" style="text-align:center; padding:50px 20px;"><span style="font-size:50px;">🔑</span><h2 style="margin-top:20px; color:var(--text-main);">로그인하면 볼 수 있어요</h2><p style="margin:10px 0 18px; color:var(--text-secondary); font-size:14px;">우리 반 친구들과 함께 쓰는 화면이에요.</p><button class="auth-btn" style="width:auto; padding:10px 22px;" onclick="showLoginScreen()">🔑 로그인</button></div>`;
                    lock.style.display = 'block';
                    if (secure) secure.style.display = 'none';
                } else {
                    lock.innerHTML = lock.dataset.origHtml;
                }
            });
        }

        // ===== 게스트(비로그인) 열람 모드 =====
        // 커뮤니티/공지/자료실만 읽기 전용으로 열어준다 - 음악/플래너/프로필/자리 등은 그대로 로그인 필요.
        function applyGuestUI() {
            document.getElementById('user-profile-card').style.display = 'none';
            document.getElementById('guest-login-card').style.display = 'block';
            document.getElementById('welcome-title').innerText = '둘러보는 중이에요 🏠';

            const communitySecure = document.getElementById('community-secure-content');
            const communityLocked = document.getElementById('community-locked-content');
            if (communitySecure) communitySecure.style.display = 'block';
            if (communityLocked) communityLocked.style.display = 'none';
            const materialsSecure = document.getElementById('materials-secure-content');
            const materialsLocked = document.getElementById('materials-locked-content');
            if (materialsSecure) materialsSecure.style.display = 'block';
            if (materialsLocked) materialsLocked.style.display = 'none';
            setGuestLockedCards(true);

            if (!isListeningToGuestReadable) {
                listenToPosts(); listenToNotices(); listenToPolls(); listenToArchiveStudy(); listenToArchiveEtc(); loadSupabaseMaterials();
                isListeningToGuestReadable = true;
            }

            // 홈 화면: 로그인 없이도 되는 위젯(날씨/급식/시간표/지금 우리 학교는)은 그대로 채우고, 계정이 필요한 미션만 안내한다.
            const logoutBtn = document.getElementById('btn-logout');
            if (logoutBtn) logoutBtn.style.display = 'none'; // 게스트에겐 로그아웃이 의미 없다
            if (!guestHomeLoaded) {
                guestHomeLoaded = true;
                try { fetchMeals(); fetchWeather(); renderHomeTimetable(); renderCurrentPeriodWidget(); } catch (e) { console.warn('게스트 홈 위젯 로드 실패:', e); }
            }
            const missionEl = document.getElementById('daily-missions-widget');
            if (missionEl) missionEl.innerHTML = '<div style="font-size:13px; color:var(--text-secondary); line-height:1.5;">미션과 연속 출석은 로그인하면 이용할 수 있어요.</div><button class="btn-sub" style="margin-top:8px; font-size:12px;" onclick="showLoginScreen()">🔑 로그인</button>';
        }
        let guestHomeLoaded = false;

        // resumeAction을 넘기면, 로그인에 성공했을 때 그 함수를 자동으로 이어서 실행한다
        // (예: "글쓰기" 클릭 -> 로그인 -> 곧바로 글쓰기 화면). 그냥 사이드바 "로그인" 버튼처럼
        // 특정 작업 없이 로그인만 하려는 경우엔 인자 없이 호출하면 된다.
        window.showLoginScreen = function(resumeAction) {
            pendingAction = typeof resumeAction === 'function' ? resumeAction : null;
            // 실제로 되돌아갈 게스트 세션이 있을 때만(=지금 익명으로만 로그인된 상태) 닫기 버튼을 보여준다.
            const canDismiss = !currentUser; // 게스트 화면(익명 세션이 있든 없든)으로 되돌아갈 수 있을 때만 닫기 버튼을 보여준다
            document.getElementById('auth-container-close').style.display = canDismiss ? 'block' : 'none';
            document.getElementById('auth-container').style.display = 'flex';
        };
        // 앱스토어 모듈(별도 <script type="module">)이 로그인 상태를 쓰기 위한 최소한의 브리지.
        // 게스트(익명) 세션은 currentUser 가 null 이므로 "진짜 로그인한 사용자"만 user()로 보인다.
        window.__gmwAuth = {
            user: () => currentUser,
            token: async () => (currentUser ? currentUser.getIdToken() : null),
            login: (cb) => showLoginScreen(cb),
            displayName: () => getAuthorName(),
            isTeacher: () => isTeacherAccount // 선생님 계정은 앱스토어의 게임/엔터테인먼트 카테고리를 숨긴다
        };
        window.hideLoginScreen = function() {
            // 사용자가 로그인 위젯을 스스로 닫으면(X 버튼 등), 하려던 작업도 취소된 것으로 본다 -
            // 나중에 엉뚱한 타이밍에 로그인했을 때 이 작업이 갑자기 실행되면 안 되기 때문.
            pendingAction = null;
            document.getElementById('auth-container').style.display = 'none';
        };

        // 비로그인 사용자가 쓰기 동작을 시도할 때 공통으로 거치는 게이트.
        // 로그인돼 있으면 즉시 실행하고, 아니면 로그인 위젯을 띄우고 로그인 성공 시 이어서 실행한다.
        window.requireLogin = function(action) {
            if (currentUser) { action(); return; }
            showLoginScreen(action);
        };

        // =========================================================================
        // 홈 대시보드 자유 배치: 섹션(카테고리) 이름 변경, 섹션 순서, 위젯을 다른 섹션으로
        // 이동, 섹션 안에서 위젯 순서까지 전부 자유롭게 편집.
        // - 완전히 개인별 커스텀이라 Firebase에 쓰지 않고 이 브라우저의 localStorage에만 저장한다.
        // - Firebase 규칙과 무관하게 항상 동작하고, 로그인 여부와도 무관하게(로그인 전에도) 적용된다.
        // =========================================================================
        const HOME_LAYOUT_KEY = 'hanilgo_home_layout_v2';
        const DEFAULT_HOME_LAYOUT = [
            { id: 'shortcuts', label: '🔗 바로가기', widgets: ['w-shortcuts'] },
            { id: 'priority-strip', label: '⏱ 우선순위 (날씨·미션·지금 학교는)', widgets: ['w-weather', 'w-missions', 'w-period'] },
            { id: 'today', label: '📅 오늘 하루', widgets: ['w-meal', 'w-timetable', 'w-cleaning'] },
            { id: 'study-exam', label: '📖 공부 & 시험', widgets: ['w-report', 'w-exam', 'w-calendar', 'w-planner-time', 'w-planner-tasks', 'w-mixtape'] },
            { id: 'poll-community', label: '🗳️ 설문 & 소통', widgets: ['w-poll', 'w-community'] }
            // 메모/사진 위젯은 기본으로 주어지지 않는다 - 사용자가 필요할 때 "+ 메모"/"+ 사진"으로 원하는 만큼
            // 추가하고 삭제하는 것이다(숨기기 개념이 아님). 그 위젯을 담을 카테고리도 사용자가 알아서 만든다.
        ];
        const DEFAULT_HOME_SECTION_IDS = DEFAULT_HOME_LAYOUT.map(s => s.id);
        const ALL_HOME_WIDGET_IDS = DEFAULT_HOME_LAYOUT.flatMap(s => s.widgets);
        const REMOVED_HOME_WIDGET_IDS = ['w-classroom']; // 예전에 있었다가 삭제된 위젯 - 저장된 배치/숨김/크기 설정에서 정리한다
        try { Object.keys(localStorage).filter(k => k.startsWith('gmw_classroom_cache_')).forEach(k => localStorage.removeItem(k)); } catch (e) {} // 클래스룸 위젯이 남긴 과제 목록 캐시 삭제
        let homeSectionEditMode = false;

        // =========================================================================
        // 위젯 가로/세로 크기 편집 (개인별 커스텀, localStorage에만 저장 - 순서/섹션 배치와는 별개 저장소)
        // - 가로: 6컬럼 그리드 기준 grid-column span (1~6). 예전엔 3컬럼/3단계뿐이라 버튼을 눌러도
        //   너무 성글게(1/3 단위로만) 바뀐다는 피드백이 있어 칸 수를 두 배로 세분화했다.
        // - 세로: 예전엔 40px 단위 버튼으로만 조절 가능했는데, 카드 우하단 손잡이(⤡)를 마우스/터치로
        //   직접 드래그해서 원하는 픽셀 값으로 자유롭게 조절하도록 바꿨다 (setupWidgetResizeHandle).
        // =========================================================================
        const HOME_WIDGET_SIZE_KEY = 'hanilgo_home_widget_sizes';
        const WIDGET_COL_SPAN_MIN = 1;
        const WIDGET_COL_SPAN_MAX = 6; // 홈 대시보드 섹션은 전부 6컬럼 그리드
        const WIDGET_GRID_GAP = 24; // .dashboard-grid의 gap과 맞아야 드래그 중 칸 수 계산이 정확하다
        const WIDGET_MIN_HEIGHT_PX = 60; // 드래그로 줄일 수 있는 최소 높이

        // 페이지 로드 시, 아직 아무것도 건드리기 전 각 위젯 카드의 원래 기본 grid-column(HTML에 박혀있던
        // 인라인 style)을 기억해둔다. JS로 한 번 덮어쓰면 원본 값은 사라지므로, "기본값으로 되돌리기"를
        // 하려면 이렇게 미리 기억해둔 값이 필요하다. (인라인 span이 없는 위젯은 6컬럼 기준 2칸 = 1/3 폭이 기본)
        const HOME_WIDGET_DEFAULT_SIZES = {};
        document.querySelectorAll('#home-sections-container .card[data-widget-id]').forEach(el => {
            const m = /span\s+(\d+)/.exec(el.style.gridColumn || '');
            HOME_WIDGET_DEFAULT_SIZES[el.dataset.widgetId] = { colSpan: m ? parseInt(m[1], 10) : 2, minHeight: 0 };
        });

        function loadHomeWidgetSizes() {
            try {
                const saved = JSON.parse(localStorage.getItem(HOME_WIDGET_SIZE_KEY) || '{}');
                return (saved && typeof saved === 'object' && !Array.isArray(saved)) ? saved : {};
            } catch (e) { return {}; }
        }
        function saveHomeWidgetSizes(sizes) {
            try { localStorage.setItem(HOME_WIDGET_SIZE_KEY, JSON.stringify(sizes)); } catch (e) {}
        }
        function getEffectiveWidgetSize(widgetId) {
            const def = HOME_WIDGET_DEFAULT_SIZES[widgetId] || { colSpan: 2, minHeight: 0 };
            const saved = loadHomeWidgetSizes()[widgetId] || {};
            return { colSpan: saved.colSpan || def.colSpan, minHeight: saved.minHeight || def.minHeight };
        }
        // 저장된 크기(없으면 기본값)를 모든 위젯 카드에 실제로 반영한다 - 페이지 로드 시, 그리고
        // "기본값으로 되돌리기" 이후에 호출된다.
        function applyHomeWidgetSizes() {
            document.querySelectorAll('#home-sections-container .card[data-widget-id]').forEach(el => {
                const size = getEffectiveWidgetSize(el.dataset.widgetId);
                el.style.gridColumn = `span ${size.colSpan}`;
                el.style.minHeight = size.minHeight ? `${size.minHeight}px` : '';
            });
        }

        // 카드 우하단 손잡이를 눌러서 끌면, 가로(가장 가까운 칸 수로 반올림)와 세로(픽셀 단위 자유 조절)를
        // 동시에 조절한다. pointer capture를 쓰면 드래그 중 커서가 손잡이 밖으로 나가도 이벤트가 계속
        // 이 손잡이로만 전달되므로 document에 별도 리스너를 붙였다 떼는 번거로움이 없다.
        function setupWidgetResizeHandle(handleEl, widgetId) {
            handleEl.addEventListener('pointerdown', (e) => {
                e.preventDefault(); e.stopPropagation();
                const widgetEl = document.querySelector(`.card[data-widget-id="${widgetId}"]`);
                const grid = widgetEl && widgetEl.closest('[data-section-grid]');
                if (!widgetEl || !grid) return;
                const eff = getEffectiveWidgetSize(widgetId);
                const startX = e.clientX, startY = e.clientY;
                const startColSpan = eff.colSpan;
                const startHeightPx = widgetEl.offsetHeight;
                const colWidth = (grid.getBoundingClientRect().width - (WIDGET_COL_SPAN_MAX - 1) * WIDGET_GRID_GAP) / WIDGET_COL_SPAN_MAX;
                let curColSpan = startColSpan, curHeight = startHeightPx;
                handleEl.setPointerCapture(e.pointerId);

                function onMove(ev) {
                    const spanFloat = startColSpan + (ev.clientX - startX) / (colWidth + WIDGET_GRID_GAP);
                    curColSpan = Math.max(WIDGET_COL_SPAN_MIN, Math.min(WIDGET_COL_SPAN_MAX, Math.round(spanFloat)));
                    curHeight = Math.max(WIDGET_MIN_HEIGHT_PX, Math.round(startHeightPx + (ev.clientY - startY)));
                    widgetEl.style.gridColumn = `span ${curColSpan}`;
                    widgetEl.style.minHeight = `${curHeight}px`;
                }
                function onUp() {
                    handleEl.removeEventListener('pointermove', onMove);
                    handleEl.removeEventListener('pointerup', onUp);
                    const sizes = loadHomeWidgetSizes();
                    sizes[widgetId] = { colSpan: curColSpan, minHeight: curHeight };
                    saveHomeWidgetSizes(sizes);
                }
                handleEl.addEventListener('pointermove', onMove);
                handleEl.addEventListener('pointerup', onUp);
            });
        }

        function loadHomeLayout() {
            try {
                const saved = JSON.parse(localStorage.getItem(HOME_LAYOUT_KEY) || 'null');
                if (Array.isArray(saved) && saved.length > 0 && saved.every(s => s && typeof s.id === 'string' && typeof s.label === 'string' && Array.isArray(s.widgets))) {
                    // 카테고리(섹션)는 기본이든 사용자가 만든 것이든 자유롭게 삭제할 수 있다 - 그래서 더 이상
                    // "기본 섹션이 전부 남아있어야" 신뢰하지 않는다. 다만 기본 위젯(앱 기능 자체)은 삭제되지
                    // 않고 다른 카테고리로 옮겨지기만 하므로, 위젯만큼은 빠짐없이 어딘가에 있어야 신뢰한다.
                    // 없어진 위젯(클래스룸 과제 위젯은 삭제됨)이 예전에 저장된 배치에 남아 있으면 떼어낸다.
                    saved.forEach(sec => { sec.widgets = sec.widgets.filter(wid => !REMOVED_HOME_WIDGET_IDS.includes(wid)); });
                    // 새로 추가된 기본 위젯이 예전에 저장된 배치에 아직 없으면, 배치를 통째로 되돌리지 않고
                    // 그 위젯의 기본 카테고리(없으면 첫 카테고리)에 끼워 넣는다.
                    const have = new Set(saved.flatMap(s => s.widgets));
                    DEFAULT_HOME_LAYOUT.forEach(def => def.widgets.forEach(wid => {
                        if (have.has(wid)) return;
                        const target = saved.find(s => s.id === def.id) || saved[0];
                        const afterPrev = def.widgets[def.widgets.indexOf(wid) - 1];
                        const at = target.widgets.indexOf(afterPrev);
                        target.widgets.splice(at >= 0 ? at + 1 : target.widgets.length, 0, wid); have.add(wid);
                    }));
                    const savedWidgetIds = saved.flatMap(s => s.widgets);
                    const hasAllDefaultWidgets = ALL_HOME_WIDGET_IDS.every(id => savedWidgetIds.includes(id));
                    const noDuplicateWidgets = new Set(savedWidgetIds).size === savedWidgetIds.length;
                    if (hasAllDefaultWidgets && noDuplicateWidgets) {
                        return saved.map(s => ({ id: s.id, label: s.label, widgets: s.widgets.slice() }));
                    }
                }
            } catch (e) {}
            return DEFAULT_HOME_LAYOUT.map(s => ({ id: s.id, label: s.label, widgets: s.widgets.slice() }));
        }

        function saveHomeLayout(layout) {
            try { localStorage.setItem(HOME_LAYOUT_KEY, JSON.stringify(layout)); } catch (e) {}
        }

        // 정적 HTML에 없는 섹션/위젯(사용자가 새로 만든 카테고리나 메모/사진 위젯)은 여기서 처음 만들어진다.
        function createHomeSectionElement(sectionId, label) {
            const sectionEl = document.createElement('div');
            sectionEl.className = 'home-section';
            sectionEl.dataset.sectionId = sectionId;
            const titleInput = document.createElement('input');
            titleInput.type = 'text';
            titleInput.className = 'dashboard-section-title-input';
            titleInput.setAttribute('data-section-title', '');
            titleInput.readOnly = !homeSectionEditMode;
            titleInput.value = label;
            const header = document.createElement('div');
            header.className = 'home-section-header';
            header.appendChild(titleInput);
            const arrows = document.createElement('span');
            arrows.className = 'home-section-arrows';
            header.appendChild(arrows);
            const grid = document.createElement('div');
            grid.className = 'dashboard-grid';
            grid.setAttribute('data-section-grid', '');
            sectionEl.appendChild(header);
            sectionEl.appendChild(grid);
            return sectionEl;
        }
        function createHomeWidgetElement(widgetId) {
            if (!isMemoWidgetId(widgetId) && !isPhotoWidgetId(widgetId)) return null; // 지금은 메모/사진만 동적으로 새로 만들 수 있다
            const el = document.createElement('div');
            el.className = 'card';
            el.dataset.widgetId = widgetId;
            el.style.gridColumn = 'span 3';
            return el;
        }
        function applyHomeLayout() {
            const container = document.getElementById('home-sections-container');
            if (!container) return;
            loadHomeLayout().forEach(section => {
                let sectionEl = container.querySelector(`.home-section[data-section-id="${section.id}"]`);
                if (!sectionEl) sectionEl = createHomeSectionElement(section.id, section.label);
                container.appendChild(sectionEl); // 순서대로 다시 appendChild하면 섹션 순서가 그대로 재배치된다
                const titleInput = sectionEl.querySelector('[data-section-title]');
                if (titleInput && document.activeElement !== titleInput) titleInput.value = section.label;
                const grid = sectionEl.querySelector('[data-section-grid]');
                if (!grid) return;
                section.widgets.forEach(widgetId => {
                    let widgetEl = document.querySelector(`.card[data-widget-id="${widgetId}"]`);
                    if (!widgetEl) widgetEl = createHomeWidgetElement(widgetId);
                    if (widgetEl) grid.appendChild(widgetEl); // 다른 섹션에 있던 위젯도 여기로 옮겨오고, 순서대로 재배치
                });
            });
        }

        function renderHomeEditControls() {
            const layout = loadHomeLayout();
            layout.forEach((section, sIdx) => {
                const sectionEl = document.querySelector(`.home-section[data-section-id="${section.id}"]`);
                if (!sectionEl) return;
                const arrows = sectionEl.querySelector('.home-section-arrows');
                if (arrows) {
                    // 카테고리는 기본이든 사용자가 만든 것이든 자유롭게 삭제할 수 있다(deleteHomeCategory가
                    // 마지막 하나 남은 카테고리 삭제만 막고, 기본 위젯은 삭제 대신 다른 카테고리로 옮긴다).
                    arrows.innerHTML = `
                        ${sIdx > 0 ? `<button onclick="moveHomeSection('${section.id}', -1)" class="btn-sub">▲</button>` : ''}
                        ${sIdx < layout.length - 1 ? `<button onclick="moveHomeSection('${section.id}', 1)" class="btn-sub">▼</button>` : ''}
                        <button onclick="deleteHomeCategory('${section.id}')" class="btn-sub" title="카테고리 삭제">🗑</button>
                    `;
                }
                section.widgets.forEach(widgetId => {
                    const widgetEl = document.querySelector(`.card[data-widget-id="${widgetId}"]`);
                    if (!widgetEl) return;
                    widgetEl.draggable = true; // 위젯 위치는 버튼이 아니라 카드를 직접 드래그해서 옮긴다
                    let bar = widgetEl.querySelector(':scope > .widget-edit-bar');
                    if (!bar) {
                        bar = document.createElement('div');
                        bar.className = 'widget-edit-bar';
                        bar.onclick = (e) => e.stopPropagation(); // 편집 바 클릭이 카드 자체의 onclick(탭 이동 등)으로 안 새어나가게
                        widgetEl.prepend(bar);
                    }
                    // 앱 기능을 요약해 보여주는 고정 위젯(하나뿐)은 숨기기/다시 꺼내기, 사용자가 원하는 만큼
                    // 만들고 내용도 마음대로 채우는 메모/사진 위젯은 숨기기가 아니라 삭제(추가/삭제 개념)다.
                    const actionBtn = isPersonalWidgetId(widgetId)
                        ? `<button type="button" class="widget-size-btn" onclick="deletePersonalWidget('${widgetId}')" title="이 위젯 삭제">🗑</button>`
                        : `<button type="button" class="widget-size-btn" onclick="hideHomeWidget('${widgetId}')" title="이 위젯 숨기기">🙈</button>`;
                    bar.innerHTML = `
                        <span class="widget-drag-handle" title="드래그해서 옮기기">⠿</span>
                        ${actionBtn}
                    `;
                    // 크기 조절 손잡이는 리렌더할 때마다 다시 만들지 않는다 - 이미 있으면 그대로 두고
                    // (드래그 중 재생성되면 진행 중인 드래그가 끊긴다), 처음 편집 모드로 들어갔을 때만 만든다.
                    let handle = widgetEl.querySelector(':scope > .widget-resize-handle');
                    if (!handle) {
                        handle = document.createElement('span');
                        handle.className = 'widget-resize-handle';
                        handle.title = '드래그해서 크기 조절';
                        handle.textContent = '⤡';
                        widgetEl.appendChild(handle);
                        setupWidgetResizeHandle(handle, widgetId);
                    }
                });
            });
            renderHomeHiddenWidgetPicker();
        }

        function removeHomeWidgetEditBars() {
            document.querySelectorAll('#home-sections-container .widget-edit-bar').forEach(el => el.remove());
            document.querySelectorAll('#home-sections-container .widget-resize-handle').forEach(el => el.remove());
            document.querySelectorAll('#home-sections-container .home-section-arrows').forEach(el => { el.innerHTML = ''; });
            document.querySelectorAll('#home-sections-container .card[data-widget-id]').forEach(el => { el.draggable = false; });
            renderHomeHiddenWidgetPicker();
        }

        // =========================================================================
        // 위젯 숨기기/다시 보이기 (개인별 커스텀, localStorage에만 저장)
        // 위젯을 전부 꺼내놓는 대신, 필요 없는 건 숨기고 필요한 것만 골라서 보이게 한다.
        // =========================================================================
        const HOME_WIDGET_HIDDEN_KEY = 'hanilgo_home_widget_hidden';
        const HOME_WIDGET_LABELS = {
            'w-shortcuts': '🔗 바로가기', 'w-weather': '🪟 현재 날씨', 'w-missions': '🎯 오늘의 미션',
            'w-period': '🕒 지금 우리 학교는', 'w-meal': '🍱 오늘의 급식', 'w-timetable': '🗓️ 오늘의 시간표',
            'w-cleaning': '🧹 청소', 'w-report': '📊 이번 주 학습 리포트', 'w-exam': '📝 주요 과목 시험범위',
            'w-calendar': '📅 일정', 'w-planner-time': '📖 오늘의 공부', 'w-planner-tasks': '📋 오늘 할 일',
            'w-mixtape': '📼 현재 재생', 'w-poll': '🗳️ 반 설문', 'w-community': '🔥 입만사니 인기글'
        };
        function loadHiddenHomeWidgets() {
            try {
                const saved = JSON.parse(localStorage.getItem(HOME_WIDGET_HIDDEN_KEY) || '[]');
                // 숨기기는 고정 위젯 전용이다 - 메모/사진 위젯은 숨김 개념이 없으므로(추가/삭제만 한다), 예전
                // 버전이 남겨둔 숨김 기록에 메모/사진 id가 섞여 있어도 무시한다. 안 그러면 다시 꺼낼 방법이 없는
                // 채로 영원히 안 보이는 위젯이 생긴다. 존재하지 않는 위젯 id가 섞여 있어도
                // applyHomeWidgetVisibility()가 해당 DOM을 못 찾아 조용히 무시하므로 문제없다.
                return Array.isArray(saved) ? saved.filter(id => typeof id === 'string' && !isPersonalWidgetId(id)) : [];
            } catch (e) { return []; }
        }
        function saveHiddenHomeWidgets(ids) {
            try { localStorage.setItem(HOME_WIDGET_HIDDEN_KEY, JSON.stringify(ids)); } catch (e) {}
        }
        function applyHomeWidgetVisibility() {
            const hidden = new Set(loadHiddenHomeWidgets());
            document.querySelectorAll('#home-sections-container .card[data-widget-id]').forEach(el => {
                el.style.display = hidden.has(el.dataset.widgetId) ? 'none' : '';
            });
        }
        window.hideHomeWidget = function(widgetId) {
            if (isPersonalWidgetId(widgetId)) return; // 메모/사진은 숨기지 않고 삭제한다(deletePersonalWidget)
            const hidden = loadHiddenHomeWidgets();
            if (!hidden.includes(widgetId)) hidden.push(widgetId);
            saveHiddenHomeWidgets(hidden);
            applyHomeWidgetVisibility();
            renderHomeHiddenWidgetPicker();
        };
        window.showHomeWidget = function(widgetId) {
            saveHiddenHomeWidgets(loadHiddenHomeWidgets().filter(id => id !== widgetId));
            applyHomeWidgetVisibility();
            renderHomeHiddenWidgetPicker();
        };
        // 편집 모드일 때만, 숨겨둔 위젯이 있으면 "+ 이름"으로 다시 꺼낼 수 있는 버튼들을 보여준다.
        function renderHomeHiddenWidgetPicker() {
            const panel = document.getElementById('home-hidden-widgets-panel');
            if (!panel) return;
            const hidden = loadHiddenHomeWidgets();
            if (!homeSectionEditMode || hidden.length === 0) { panel.style.display = 'none'; panel.innerHTML = ''; return; }
            panel.style.display = 'flex';
            panel.innerHTML = `<span style="font-size:12px; color:var(--text-muted);">숨긴 위젯 (눌러서 다시 꺼내기):</span>` +
                hidden.map(id => `<button type="button" class="btn-sub" style="font-size:12px; padding:5px 10px;" onclick="showHomeWidget('${id}')">+ ${homeWidgetDisplayLabel(id)}</button>`).join('');
        }
        // 숨긴 위젯 버튼에 보여줄 이름 - 숨길 수 있는 건 고정 위젯뿐이라 고정 이름표(HOME_WIDGET_LABELS)만 쓴다.
        function homeWidgetDisplayLabel(id) {
            return HOME_WIDGET_LABELS[id] || id;
        }

        window.moveHomeSection = function(sectionId, dir) {
            const layout = loadHomeLayout();
            const idx = layout.findIndex(s => s.id === sectionId);
            const swapIdx = idx + dir;
            if (idx === -1 || swapIdx < 0 || swapIdx >= layout.length) return;
            [layout[idx], layout[swapIdx]] = [layout[swapIdx], layout[idx]];
            saveHomeLayout(layout);
            applyHomeLayout();
            renderHomeEditControls();
        }

        // 위젯을 어느 섹션의 몇 번째 자리로든 옮긴다 (같은 섹션 안 재배치 + 다른 섹션으로 이동 모두 이 함수 하나로 처리).
        function moveWidgetToPosition(widgetId, targetSectionId, targetIndex) {
            const layout = loadHomeLayout();
            const fromSection = layout.find(s => s.widgets.includes(widgetId));
            const toSection = layout.find(s => s.id === targetSectionId);
            if (!fromSection || !toSection) return;
            const fromIdx = fromSection.widgets.indexOf(widgetId);
            fromSection.widgets.splice(fromIdx, 1);
            if (fromSection === toSection && fromIdx < targetIndex) targetIndex -= 1; // 뺀 자리만큼 인덱스 보정
            targetIndex = Math.max(0, Math.min(targetIndex, toSection.widgets.length));
            toSection.widgets.splice(targetIndex, 0, widgetId);
            saveHomeLayout(layout);
            applyHomeLayout();
            renderHomeEditControls();
        }

        window.resetHomeLayout = function() {
            if (!confirm('위젯 배치를 기본값으로 되돌릴까요? (사용자가 직접 만든 카테고리/메모/사진 위젯도 함께 삭제됩니다)')) return;
            // 되돌리기 전에, 사용자가 직접 추가한 카테고리/위젯(기본 구성에 없는 것들)의 DOM과 저장된 데이터를
            // 먼저 정리한다 - 그냥 saveHomeLayout(기본값)만 하면 그 커스텀 요소들이 화면에 그대로 남아있게 된다.
            const currentLayout = loadHomeLayout();
            currentLayout.forEach(section => {
                const sectionEl = document.querySelector(`.home-section[data-section-id="${section.id}"]`);
                const isCustomSection = !DEFAULT_HOME_SECTION_IDS.includes(section.id);
                section.widgets.forEach(widgetId => {
                    const cardEl = document.querySelector(`.card[data-widget-id="${widgetId}"]`);
                    if (ALL_HOME_WIDGET_IDS.includes(widgetId)) {
                        // 기본 위젯(앱 기능)은 삭제하지 않는다 - 곧 지워질 커스텀 섹션의 자식으로 남아있으면
                        // 섹션째로 지워질 때 같이 사라지므로, 먼저 컨테이너 밖으로 안전하게 빼둔다.
                        // applyHomeLayout()이 잠시 후 이 카드를 기본 섹션으로 다시 옮겨 붙인다.
                        if (isCustomSection && cardEl) document.body.appendChild(cardEl);
                        return;
                    }
                    if (cardEl) cardEl.remove();
                    try { localStorage.removeItem(memoTextKey(widgetId)); } catch (e) {}
                    deleteMemoPhotoFromIndexedDB(widgetId).catch(() => {});
                });
                if (isCustomSection && sectionEl) sectionEl.remove();
            });
            saveHomeLayout(DEFAULT_HOME_LAYOUT.map(s => ({ id: s.id, label: s.label, widgets: s.widgets.slice() })));
            try { localStorage.removeItem(HOME_WIDGET_SIZE_KEY); localStorage.removeItem(HOME_WIDGET_HIDDEN_KEY); } catch (e) {}
            applyHomeLayout();
            applyHomeWidgetSizes();
            applyHomeWidgetVisibility();
            if (homeSectionEditMode) renderHomeEditControls();
        }

        // ===================== 드래그 앤 드롭: 위젯 카드를 손으로 잡아서 자유롭게 옮기기 =====================
        let draggedWidgetId = null;

        // 그리드는 여러 열이 있어서 위/아래(Y)뿐 아니라 좌/우(X)도 봐야 한다. 같은 줄(Y가 카드 높이의
        // 30% 이내로 가까움)이면 X로, 아니면 Y로 "이 카드 앞/뒤 중 어디에 놓을지"를 판단한다.
        function computeInsertBeforeFromEvent(e, rect) {
            const midY = rect.top + rect.height / 2;
            const rowTolerance = rect.height * 0.3;
            if (Math.abs(e.clientY - midY) < rowTolerance) return e.clientX < (rect.left + rect.width / 2);
            return e.clientY < midY;
        }

        (function setupHomeWidgetDrag() {
            const container = document.getElementById('home-sections-container');
            if (!container) return;

            // 편집 모드에서는 카드를 눌러도 곧바로 탭 이동이 안 되게 막는다 (편집 바 자체 클릭은 예외).
            container.addEventListener('click', (e) => {
                if (!homeSectionEditMode) return;
                // 편집 바와, 편집 모드에서만 나타나는 조작 버튼(바로가기 추가/수정 등, data-edit-control)은 막지 않는다.
                // (예전에는 카드 안의 모든 클릭을 막아서, 편집 모드에서만 보이는 "내 바로가기 추가" 버튼이 눌러지지 않았다.)
                if (e.target.closest('.widget-edit-bar, [data-edit-control]')) return;
                const card = e.target.closest('.card[data-widget-id]');
                if (card) { e.stopPropagation(); e.preventDefault(); }
            }, true);

            container.addEventListener('dragstart', (e) => {
                const card = e.target.closest('.card[data-widget-id]');
                if (!homeSectionEditMode || !card) return;
                draggedWidgetId = card.dataset.widgetId;
                e.dataTransfer.effectAllowed = 'move';
                try { e.dataTransfer.setData('text/plain', draggedWidgetId); } catch (err) {}
                requestAnimationFrame(() => card.classList.add('dragging-widget')); // 드래그 이미지가 찍힌 뒤에 숨겨야 자연스럽다
            });

            container.addEventListener('dragend', () => {
                container.querySelectorAll('.dragging-widget').forEach(el => el.classList.remove('dragging-widget'));
                container.querySelectorAll('.drag-over-target').forEach(el => el.classList.remove('drag-over-target'));
                draggedWidgetId = null;
            });

            container.addEventListener('dragover', (e) => {
                if (!homeSectionEditMode || !draggedWidgetId) return;
                e.preventDefault(); // 이게 있어야 drop 이벤트가 발생한다
                container.querySelectorAll('.drag-over-target').forEach(el => el.classList.remove('drag-over-target'));
                const overCard = e.target.closest('.card[data-widget-id]');
                if (overCard && overCard.dataset.widgetId !== draggedWidgetId) overCard.classList.add('drag-over-target');
            });

            container.addEventListener('drop', (e) => {
                if (!homeSectionEditMode || !draggedWidgetId) return;
                e.preventDefault();
                container.querySelectorAll('.drag-over-target').forEach(el => el.classList.remove('drag-over-target'));

                const overCard = e.target.closest('.card[data-widget-id]');
                if (overCard && overCard.dataset.widgetId !== draggedWidgetId) {
                    const toSection = loadHomeLayout().find(s => s.widgets.includes(overCard.dataset.widgetId));
                    if (!toSection) return;
                    const rect = overCard.getBoundingClientRect();
                    const before = computeInsertBeforeFromEvent(e, rect);
                    const overIdx = toSection.widgets.indexOf(overCard.dataset.widgetId);
                    moveWidgetToPosition(draggedWidgetId, toSection.id, before ? overIdx : overIdx + 1);
                    return;
                }

                // 카드가 아니라 섹션의 빈 공간(그리드 배경)에 놓으면 그 섹션 맨 끝으로 옮긴다.
                const overGrid = e.target.closest('[data-section-grid]');
                const overSectionEl = overGrid && overGrid.closest('.home-section');
                if (overSectionEl) moveWidgetToPosition(draggedWidgetId, overSectionEl.dataset.sectionId, Infinity);
            });
        })();

        window.renameHomeSection = function(sectionId, newLabel) {
            const layout = loadHomeLayout();
            const section = layout.find(s => s.id === sectionId);
            if (!section) return;
            section.label = newLabel.trim() || section.label;
            saveHomeLayout(layout);
            const titleInput = document.querySelector(`.home-section[data-section-id="${sectionId}"] [data-section-title]`);
            if (titleInput) titleInput.value = section.label;
        }

        // 섹션 제목 input에서 값이 바뀌면(엔터/포커스 아웃) 저장한다
        document.getElementById('home-sections-container').addEventListener('change', (e) => {
            if (!e.target.matches('[data-section-title]')) return;
            const sectionEl = e.target.closest('.home-section');
            if (sectionEl) window.renameHomeSection(sectionEl.dataset.sectionId, e.target.value);
        });

        window.toggleHomeSectionEditMode = function() {
            homeSectionEditMode = !homeSectionEditMode;
            const container = document.getElementById('home-sections-container');
            if (container) container.classList.toggle('editing-sections', homeSectionEditMode);
            document.querySelectorAll('#home-sections-container [data-section-title]').forEach(inp => { inp.readOnly = !homeSectionEditMode; });
            const btn = document.getElementById('btn-edit-home-layout');
            if (btn) btn.textContent = homeSectionEditMode ? '✅ 편집 완료' : '🧩 위젯 순서 편집';
            const resetBtn = document.getElementById('btn-reset-home-layout');
            if (resetBtn) resetBtn.style.display = homeSectionEditMode ? 'inline-flex' : 'none';
            const addCategoryBtn = document.getElementById('btn-add-home-category');
            if (addCategoryBtn) addCategoryBtn.style.display = homeSectionEditMode ? 'inline-flex' : 'none';
            const addMemoBtn = document.getElementById('btn-add-home-memo');
            if (addMemoBtn) addMemoBtn.style.display = homeSectionEditMode ? 'inline-flex' : 'none';
            const addPhotoBtn = document.getElementById('btn-add-home-photo');
            if (addPhotoBtn) addPhotoBtn.style.display = homeSectionEditMode ? 'inline-flex' : 'none';
            updateShortcutComposerVisibility(); // 바로가기 추가 버튼들도 위젯 편집 모드일 때만 보이게
            if (homeSectionEditMode) renderHomeEditControls();
            else removeHomeWidgetEditBars();
        }

        // 새 카테고리(섹션)를 맨 끝에 만든다. 이름은 나중에 카테고리 제목을 눌러 바로 바꿀 수 있다.
        window.addHomeCategory = function() {
            const name = prompt('새 카테고리 이름을 입력하세요.', '새 카테고리');
            if (!name || !name.trim()) return;
            const layout = loadHomeLayout();
            const id = 'custom-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
            layout.push({ id, label: name.trim(), widgets: [] });
            saveHomeLayout(layout);
            applyHomeLayout();
            if (homeSectionEditMode) renderHomeEditControls();
        };

        // 카테고리는 기본이든 사용자가 만든 것이든 자유롭게 삭제할 수 있다. 다만 위젯 자체(앱 기능)까지
        // 사라지면 안 되므로: 메모/사진 같은 개인 위젯은 저장된 내용과 함께 정말로 삭제되지만, 기본 위젯은
        // 삭제되지 않고 남은 카테고리 중 첫 번째로 옮겨진다. 마지막 하나 남은 카테고리는 삭제할 수 없다
        // (위젯을 놓아둘 곳이 없어지기 때문).
        window.deleteHomeCategory = function(sectionId) {
            const layout = loadHomeLayout();
            const section = layout.find(s => s.id === sectionId);
            if (!section) return;
            if (layout.length <= 1) {
                alert('마지막 남은 카테고리는 삭제할 수 없어요.');
                return;
            }
            const widgetCount = section.widgets.length;
            const confirmMsg = widgetCount > 0
                ? `"${section.label}" 카테고리를 삭제할까요? 메모/사진 위젯은 함께 삭제되고, 그 외 위젯은 다른 카테고리로 옮겨져요.`
                : `"${section.label}" 카테고리를 삭제할까요?`;
            if (!confirm(confirmMsg)) return;

            const remainingLayout = layout.filter(s => s.id !== sectionId);
            const fallbackSection = remainingLayout[0];
            section.widgets.forEach(widgetId => {
                const cardEl = document.querySelector(`.card[data-widget-id="${widgetId}"]`);
                if (ALL_HOME_WIDGET_IDS.includes(widgetId)) {
                    // 이 섹션의 DOM이 곧 통째로 지워지므로, 먼저 컨테이너 밖으로 빼둬야 카드가 같이 사라지지 않는다.
                    if (cardEl) document.body.appendChild(cardEl);
                    fallbackSection.widgets.push(widgetId);
                } else {
                    if (cardEl) cardEl.remove();
                    try { localStorage.removeItem(memoTextKey(widgetId)); } catch (e) {}
                    deleteMemoPhotoFromIndexedDB(widgetId).catch(() => {});
                }
            });
            saveHomeLayout(remainingLayout);
            const sectionEl = document.querySelector(`.home-section[data-section-id="${sectionId}"]`);
            if (sectionEl) sectionEl.remove();
            applyHomeLayout(); // 옮겨진 기본 위젯들을 fallback 카테고리의 grid로 실제로 옮겨 붙인다
            if (homeSectionEditMode) renderHomeEditControls();
        };

        applyHomeLayout(); // 로그인 여부와 무관하게, 페이지 로드 시 저장된 개인 레이아웃을 바로 적용
        applyHomeWidgetSizes(); // 저장된 위젯별 가로/세로 크기도 함께 적용
        applyHomeWidgetVisibility(); // 숨겨둔 위젯이 있으면 처음부터 숨긴 채로 시작
        initAllMemoWidgets(); // 로그인 여부와 무관한 개인 메모/사진 위젯도 바로 적용

        // =========================================================================
        // 오프라인 정보 캐시 - Firestore로 가져오는 정보(게시글/시험범위/수행평가 일정 등)는 이미
        // persistentLocalCache(위 fdb 초기화 부분 참고)가 자동으로 오프라인 캐싱을 해준다. 하지만
        // Realtime Database(반 공용/개인 일정, 청소 1인1역, 자리배치)와 외부 API(날씨, 급식)는
        // 그런 오프라인 캐시 기능이 브라우저 SDK 자체에 없어서, 여기서 직접 마지막 성공 결과를
        // localStorage에 저장해뒀다가 오프라인이거나 요청이 실패했을 때 대신 보여준다.
        // (수정은 여전히 온라인에서만 가능하지만, "확인"만큼은 오프라인에서도 할 수 있게 된다 -
        // 온라인으로 돌아오면 실시간 리스너/재요청이 알아서 최신 정보로 덮어쓴다.)
        // =========================================================================
        const INFO_CACHE_PREFIX = 'hanilgo_info_cache_';
        function saveInfoCache(key, data) {
            try { localStorage.setItem(INFO_CACHE_PREFIX + key, JSON.stringify({ data, updatedAt: Date.now() })); } catch (e) {}
        }
        function loadInfoCache(key) {
            try {
                const raw = localStorage.getItem(INFO_CACHE_PREFIX + key);
                if (!raw) return null;
                const parsed = JSON.parse(raw);
                return (parsed && typeof parsed === 'object' && typeof parsed.updatedAt === 'number' && 'data' in parsed) ? parsed : null;
            } catch (e) { return null; }
        }
        function formatInfoCacheAge(updatedAt) {
            const mins = Math.floor((Date.now() - updatedAt) / 60000);
            if (mins < 1) return '방금 전';
            if (mins < 60) return `${mins}분 전`;
            const hours = Math.floor(mins / 60);
            if (hours < 24) return `${hours}시간 전`;
            return `${Math.floor(hours / 24)}일 전`;
        }
        function infoOfflineBadgeHtml(updatedAt) {
            return `<div class="info-offline-badge">오프라인 · ${formatInfoCacheAge(updatedAt)} 기준 저장된 정보</div>`;
        }

        // 반 공용 일정(수행평가/지필평가/학교행사 등) 중 오늘 이후로 가장 가까운 5개 - 홈 위젯 전용 요약.
        function renderHomeCalendarSummary(events, fromCache) {
            const el = document.getElementById('home-calendar-summary');
            if (!el) return;
            const todayKey = getScheduleDateKey(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
            const upcoming = Object.values(events || {})
                .filter(ev => ev && ev.date && ev.title && (ev.endDate || ev.date) >= todayKey)
                .sort((a, b) => a.date.localeCompare(b.date))
                .slice(0, 5);
            el.innerHTML = upcoming.map(ev => {
                const c = scheduleTagColor((ev.tags || [])[0]);
                const dateLabel = ev.endDate && ev.endDate !== ev.date ? `${ev.date} ~ ${ev.endDate}` : ev.date;
                const dday = scheduleDDayLabel(ev.date);
                return `<div style="font-size:13px; margin-bottom:4px; display:flex; align-items:center; gap:6px;"><span class="widget-date">[${dateLabel}]</span> <span style="color:${c}; font-weight:700;">${escapeNoticeText(ev.title)}</span><span style="margin-left:auto; flex-shrink:0; font-size:11px; font-weight:800; color:${c}; background:${c}18; padding:1px 7px; border-radius:6px;">${dday}</span></div>`;
            }).join('') || '<div class="widget-text">일정 없음</div>';
            if (fromCache && !navigator.onLine) el.innerHTML += infoOfflineBadgeHtml(fromCache);
        }

        // --- 홈 대시보드 위젯 통합 동기화 ---
        function listenToHomeWidgets() {
            // 커뮤니티 인기글 (1주, 4개) - Firestore posts
            onSnapshot(collection(fdb, 'posts'), (snap) => {
                const posts = fsSnapshotToMap(snap);
                const oneWeekAgo = Date.now() - (7*24*60*60*1000);
                const popPosts = Object.entries(posts).map(([id, p]) => ({id, ...p}))
                    .filter(p => p.createdAt >= oneWeekAgo && p.likeCount > 0).sort((a,b) => b.likeCount - a.likeCount).slice(0, 4);
                document.getElementById('home-popular-posts').innerHTML = popPosts.map(p => `<div class="post-item" style="border:1px solid var(--border-color); border-radius:10px;"><span style="font-size:13px; truncate">${p.title}</span><strong style="color:#ef4444; font-size:12px;">❤️ ${p.likeCount}</strong></div>`).join('') || '<div class="widget-text">최근 인기글이 없습니다.</div>';
            });
            // 5.0: '아카이브 화제의 추억' 홈 위젯은 아카이브 페이지 삭제와 함께 없앴다.
            // (archive 컬렉션 자체와 관련 함수는 과거 데이터/업적 집계를 위해 그대로 남아있다.)
            // 시험범위
            onSnapshot(collection(fdb, 'exam_notes'), (snap) => {
                const notes = {}; snap.forEach(d => { notes[d.id] = d.data().text || ''; });
                const targets = ['국어', '영어', '수학', '통합사회', '통합과학'];
                document.getElementById('home-exam-summary').innerHTML = targets.map(sub => `<div style="margin-bottom:8px; font-size:13px;"><strong style="color:var(--primary); display:block; margin-bottom:2px;">${sub}</strong><span style="color:var(--text-main); word-break:break-word; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; text-overflow:ellipsis;">${notes[sub] || '미등록'}</span></div>`).join('');
            });
            // 반 공용 일정: RTDB는 브라우저 SDK에 오프라인 캐시가 없으므로, 리스너를 걸기 전에 마지막으로
            // 저장해둔 정보를 먼저 보여준다(오프라인이면 그 상태로 유지, 온라인이면 곧바로 최신으로 교체된다).
            const cachedSchedule = loadInfoCache('home_calendar');
            if (cachedSchedule) renderHomeCalendarSummary(cachedSchedule.data, cachedSchedule.updatedAt);
            onValue(ref(db, 'dashboard/shared_schedule'), (snap) => {
                const events = snap.val() || {};
                saveInfoCache('home_calendar', events);
                renderHomeCalendarSummary(events, null);
            });
        }

        // --- 청소 1인1역: 기본 데이터 + 관리자(엔지니어/창시자) 수정 ---
        const defaultCleaningDuties = [
            { id: 'plastic', area: '♻️ 플라스틱 분리수거', count: '2명', cycle: '주 2회 (월, 금)', students: '1219, 1208', days: '1,5' },
            { id: 'paper',   area: '♻️ 폐휴지 분리수거',   count: '2명', cycle: '주 2회 (월, 금)', students: '1213, 1218', days: '1,5' },
            { id: 'can',     area: '♻️ 캔 분리수거',       count: '1명', cycle: '주 1회 (월)',     students: '1201',       days: '1' },
            { id: 'bottle',  area: '♻️ 병 분리수거',       count: '1명', cycle: '주 1회 (월)',     students: '1225',       days: '1' },
            { id: 'bin',     area: '🗑️ 쓰레기통 청소',     count: '4명', cycle: '매일 (3명 정리 + 1명 수거 로테)', students: '1212, 1211, 1216, 1205', days: '1,2,3,4,5' },
            { id: 'locker',  area: '🗄️ 사물함 위',         count: '3명', cycle: '매일 (2명씩 복도쪽·교실 뒤쪽 분담)', students: '1222, 1202, 1215', days: '1,2,3,4,5' },
            { id: 'floor',   area: '🧹 바닥 청소',         count: '6명', cycle: '매일 (3명씩 번갈아)', students: '1223, 1214, 1204, 1209, 1206, 1210', days: '1,2,3,4,5' },
            { id: 'window',  area: '🪟 창가 청소',         count: '2명', cycle: '매일 (앞 2칸·뒤 1칸 분담)', students: '1217, 1226', days: '1,2,3,4,5' },
            { id: 'board',   area: '📝 칠판 정리',         count: '2명', cycle: '주기 자율 (매일 닦고 정리 원칙)', students: '1221, 1207', days: '1,2,3,4,5' },
            { id: 'lights',  area: '🚪 문·창·전등 관리',   count: '1명', cycle: '특별실 이동 시 전등 전부 끄기', students: '1224', days: '1,2,3,4,5' }
        ];
        let cleaningDutyOverrides = {};
        // RTDB는 오프라인 캐시가 없어서, 리스너가 값을 받아오기 전까지 쓸 마지막 저장값을 먼저 채워둔다.
        (function hydrateCleaningDutyCache(){ const c = loadInfoCache('cleaningDuties'); if (c) cleaningDutyOverrides = c.data; })();

        function renderCleaningDutyTable() {
            const tbody = document.getElementById('cleaning-duty-tbody');
            if (!tbody) return;
            const today = new Date(); today.setHours(0,0,0,0);
            const day = today.getDay();

            tbody.innerHTML = defaultCleaningDuties.map(base => {
                const o = cleaningDutyOverrides[base.id] || {};
                const duty = { ...base, ...o };
                const days = (duty.days || '').split(',').map(d => d.trim());
                const cls = days.includes(String(day)) ? 'duty-today' : 'duty-off';
                const editable = isAdmin ? 'duty-editable' : '';
                const on = (field) => isAdmin ? `onclick="editCleaningDutyField('${base.id}','${field}')"` : '';
                return `<tr class="${cls}" data-days="${duty.days}">
                    <td class="${editable}" ${on('area')}><strong>${duty.area}</strong></td>
                    <td class="${editable}" ${on('count')}>${duty.count}</td>
                    <td class="${editable}" ${on('cycle')}>${duty.cycle}</td>
                    <td class="${editable}" ${on('students')}>${duty.students}</td>
                </tr>`;
            }).join('');

            const hint = document.getElementById('cleaning-admin-hint');
            if (hint) hint.style.display = isAdmin ? 'inline' : 'none';
        }

        const cleaningFieldLabels = { area: '담당 구역 이름', count: '인원', cycle: '주기 / 방식', students: '담당 학생 번호' };

        window.editCleaningDutyField = async function(id, field) {
            if (!isAdmin) return;
            const base = defaultCleaningDuties.find(d => d.id === id);
            if (!base) return;
            const o = cleaningDutyOverrides[id] || {};
            const duty = { ...base, ...o };

            const newVal = prompt(`${cleaningFieldLabels[field]}:`, duty[field]);
            if (newVal === null) { renderCleaningDutyTable(); return; }
            const patch = { [field]: newVal.trim() };

            // 주기/방식을 바꿀 때는 반짝임 표시 요일도 함께 물어봅니다.
            if (field === 'cycle') {
                const newDays = prompt("반짝임이 표시될 요일 (일=0, 월=1, 화=2, 수=3, 목=4, 금=5, 토=6 / 쉼표로 구분, 예: 1,2,3,4,5):", duty.days);
                if (newDays !== null) patch.days = newDays.trim();
            }

            try {
                await update(ref(db, `dashboard/cleaningDuties/${id}`), patch);
            } catch (e) {
                alert("저장 중 오류가 발생했습니다: " + (e && e.message ? e.message : e) + "\n(Firebase 데이터베이스 규칙에서 관리자 쓰기 권한이 dashboard/cleaningDuties 경로에 허용되어 있는지 확인이 필요합니다)");
            } finally {
                // 브라우저 prompt 창이 뜨고 닫히는 과정에서 마우스 hover 상태가 고착되는 것을 방지하기 위해 항상 다시 그립니다.
                renderCleaningDutyTable();
            }
        }

        onValue(ref(db, 'dashboard/cleaningDuties'), (snap) => {
            cleaningDutyOverrides = snap.val() || {};
            saveInfoCache('cleaningDuties', cleaningDutyOverrides);
            renderCurrentDuty(); // 내부에서 renderCleaningDutyTable()도 함께 호출하므로 홈 위젯/탭 표가 모두 최신화된다
        });

        function renderCurrentDuty() {
            const today = new Date(); today.setHours(0,0,0,0);

            const dateEl = document.getElementById('current-date-display');
            if (dateEl) dateEl.innerText = `${today.getMonth() + 1}월 ${today.getDate()}일 기준`;

            renderCleaningDutyTable();

            // 홈 위젯: 오늘 요일에 해당하는 1인1역만 추려서 담당 학생과 함께 리스트로 보여준다
            const homeEl = document.getElementById('home-cleaning-summary');
            if (homeEl) {
                const day = today.getDay();
                const todayDuties = defaultCleaningDuties
                    .map(base => ({ ...base, ...(cleaningDutyOverrides[base.id] || {}) }))
                    .filter(duty => (duty.days || '').split(',').map(d => d.trim()).includes(String(day)));

                if (todayDuties.length === 0) {
                    homeEl.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:8px 0;">오늘 해당하는 1인1역이 없습니다.</div>`;
                } else {
                    homeEl.innerHTML = todayDuties.map((duty, i) => `
                        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:5px 0; ${i < todayDuties.length - 1 ? 'border-bottom:1px dashed var(--border-color);' : ''}">
                            <strong style="color:var(--text-main); white-space:nowrap;">${duty.area}</strong>
                            <span style="color:var(--text-muted); text-align:right;">${duty.students}</span>
                        </div>
                    `).join('');
                }
                if (!navigator.onLine) {
                    const cached = loadInfoCache('cleaningDuties');
                    if (cached) homeEl.innerHTML += infoOfflineBadgeHtml(cached.updatedAt);
                }
            }
        }

        // 실시간 체크리스트 동기화 및 날짜별 초기화
        // 버그 수정: 예전에는 todayStr을 페이지 로드 시점에 한 번만(const) 계산해서 탭을 자정 너머로 오래 켜두면
        // 그 값이 그대로 굳어 있었다. 이 값은 "다른 모든 클라이언트가 공유하는" dashboard/date에 쓰이기 때문에,
        // 자정을 넘겨 새로고침한 클라이언트가 새 날짜를 쓰면 → 오래 열려있던(자정 이전 날짜로 굳은) 클라이언트가
        // 그걸 보고 자기 딴엔 "날짜가 바뀌었다"며 다시 예전 날짜로 덮어쓰고 → 그걸 본 새 클라이언트가 다시 새
        // 날짜로 되돌리는 식으로 서로 되먹임(ping-pong)하며 8/31 ↔ 9/1이 번갈아 나타나는 원인이 됐다.
        // 수정: 이 값을 매번(리스너가 실행될 때마다) 새로 계산해서, 오래 열린 탭도 항상 "지금 실제 날짜"를 쓰도록 한다.
        // 형식도 다른 날짜 키(예: 일일 미션의 YYYY-MM-DD)와 통일되도록 0-padding한다.
        function getTodayDateStrForDuty() {
            const d = new Date();
            const pad = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        }

        const dateRef = ref(db, 'dashboard/date');
        const stateRef = ref(db, 'dashboard/state');

        const checkboxes = document.querySelectorAll('.todo-item input[type="checkbox"]');

        onValue(dateRef, (snapshot) => {
           const dbDate = snapshot.val();
           const nowDateStr = getTodayDateStrForDuty(); // 콜백이 실행될 때마다 새로 계산 - 탭이 자정을 넘겨도 항상 최신 날짜

           if (dbDate !== nowDateStr) {
              set(dateRef, nowDateStr);
        
              let resetState = {};
              checkboxes.forEach((cb, index) => {
                  resetState['chk_' + index] = false;
              });
               set(stateRef, resetState);
           }
        });

        onValue(stateRef, (snapshot) => {
            const state = snapshot.val() || {};
            checkboxes.forEach((cb, index) => {
                const isChecked = state['chk_' + index];
                cb.checked = isChecked ? true : false;
            });
        });

        checkboxes.forEach((cb, index) => {
          cb.addEventListener('change', (e) => {
              const updates = {};
             updates['chk_' + index] = e.target.checked;
               update(stateRef, updates);
          });
        });
        // --- 커스텀 시간표 ---
        const defaultTimetable = {
            1: ["대수^김수원", "영어^신지원", "국어^서인우", "통사^임흥수", "통사^배장렬"],
            2: ["국어^서인우", "인기초^구재랑", "통과^김강우", "국어^류연득", "국어^서인우"],
            3: ["영어^신소영", "통과^박영철", "한국사^전대희", "인기초^구재랑", "미술^김윤정"],
            4: ["체육^박민춘", "통사^윤형덕", "대수^김수원", "영어^신소영", "미술^김윤정"],
            5: ["인기초^구재랑", "태권도^김동화", "동아리^-", "통과^오선", "대수^신중곤"],
            6: ["한국사^윤형덕", "대수^신중곤", "동아리^-", "과탐실^오선", "영어^DAVID"],
            7: ["자율^-", "-^-", "-^-", "통사^윤형덕", "-^-"],
            8: ["-^-", "-^-", "-^-", "-^-", "-^-"]
        };
        
        function getIsoWeekNum() { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() + 3 - (d.getDay()||7)); const wkStart = new Date(d.getFullYear(),0,1); return Math.ceil((((d - wkStart)/86400000) + 1)/7); }

        // 공용(전체 학생 기본) 시간표 - 관리자가 수정하면 모든 학생에게 반영됨
        let sharedTimetableOverrides = {};
        let adminTimetableEditMode = false;

        onSnapshot(collection(fdb, 'timetable'), (snap) => {
            sharedTimetableOverrides = {}; snap.forEach(d => { sharedTimetableOverrides[d.id] = d.data().value; });
            renderTimetableTable();
            renderHomeTimetable();
        });

        window.toggleAdminTimetableMode = function() {
            if (!isAdmin) return;
            adminTimetableEditMode = !adminTimetableEditMode;
            const btn = document.getElementById('admin-timetable-toggle');
            const hint = document.getElementById('admin-timetable-hint');
            if (btn) {
                btn.innerText = `🛠️ 공용 시간표 수정 모드: ${adminTimetableEditMode ? 'ON' : 'OFF'}`;
                btn.style.background = adminTimetableEditMode ? '#dc2626' : '#f59e0b';
            }
            if (hint) hint.style.display = adminTimetableEditMode ? 'block' : 'none';
        }

        window.resetSharedTimetable = async function() {
            if (!isAdmin) return;
            if (confirm("공용 시간표를 기본값으로 되돌릴까요? (모든 학생에게 반영됩니다)")) {
                try {
                    const snap = await getDocs(collection(fdb, 'timetable'));
                    await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
                    alert("공용 시간표가 초기화되었습니다.");
                } catch (e) {
                    alert("초기화 중 오류가 발생했습니다: " + (e && e.message ? e.message : e));
                }
            }
        }

        function renderTimetableTable() {
            let myData = JSON.parse(localStorage.getItem('my_timetable')) || { week: getIsoWeekNum(), edits: {} };
            if (!myData.edits) myData.edits = {};
            if(myData.week !== getIsoWeekNum()) { myData = { week: getIsoWeekNum(), edits: {} }; localStorage.setItem('my_timetable', JSON.stringify(myData)); }
            
            let tbodyHtml = '';
            for(let period = 1; period <= 8; period++) {
                tbodyHtml += `<tr><td><strong>${period}</strong></td>`;
                for(let day = 0; day < 5; day++) {
                    const key = `${period}_${day}`;
                    const baseVal = sharedTimetableOverrides[key] || defaultTimetable[period][day];
                    const rawVal = myData.edits[key] || baseVal;
                    const parts = rawVal.split('^');
                    tbodyHtml += `<td onclick="editTimetableCell(${period}, ${day}, '${parts[0]}', '${parts[1]}')">${parts[0]}<span class="timetable-sub">${parts[1]}</span></td>`;
                }
                tbodyHtml += `</tr>`;
            }
            document.getElementById('timetable-tbody').innerHTML = tbodyHtml;
        }
        
        window.editTimetableCell = async function(period, day, oldSub, oldTch) {
            // 관리자가 '공용 시간표 수정 모드'를 켠 경우: 모든 학생의 기본 시간표를 수정
            if (isAdmin && adminTimetableEditMode) {
                const newSub = prompt(`[공용 시간표 수정] [${period}교시] 새 과목명을 입력하세요:`, oldSub);
                if (newSub === null) { renderTimetableTable(); return; }
                const newTch = prompt(`[공용 시간표 수정] [${period}교시] 선생님 또는 비고를 입력하세요:`, oldTch);
                if (newTch === null) { renderTimetableTable(); return; }
                try {
                    await setDoc(doc(fdb, 'timetable', `${period}_${day}`), { value: `${newSub.trim()}^${newTch.trim()}` });
                    alert("공용 시간표가 저장되었습니다! (모든 학생에게 반영됩니다)");
                } catch (e) {
                    alert("저장 중 오류가 발생했습니다: " + (e && e.message ? e.message : e) + "\n(Firestore 보안 규칙에서 관리자 쓰기 권한이 timetable 컬렉션에 허용되어 있는지 확인이 필요합니다)");
                } finally {
                    // 브라우저 prompt 창이 뜨고 닫히는 과정에서 마우스 hover 상태가 고착되는 것을 방지하기 위해 항상 다시 그립니다.
                    renderTimetableTable();
                }
                return;
            }

            // 일반적인 경우: 본인만의 개인 시간표 수정
            const newSub = prompt(`[${period}교시] 새 과목명을 입력하세요:`, oldSub);
            if(newSub === null) { renderTimetableTable(); return; }
            const newTch = prompt(`[${period}교시] 선생님 또는 비고를 입력하세요:`, oldTch);
            if (newTch === null) { renderTimetableTable(); return; }
            let myData = JSON.parse(localStorage.getItem('my_timetable')) || { week: getIsoWeekNum(), edits: {} };
            if (!myData.edits) myData.edits = {};
            myData.edits[`${period}_${day}`] = `${newSub.trim()}^${newTch.trim()}`;
            localStorage.setItem('my_timetable', JSON.stringify(myData));
            renderTimetableTable();
            renderHomeTimetable(); 
        }
        window.resetTimetable = function() { if(confirm("기본 시간표로 되돌릴까요?")) { localStorage.removeItem('my_timetable'); renderTimetableTable(); renderHomeTimetable(); } }

        // ===== 일일 플래너 설정 모달에서 "오늘의 커뮤니티 시간표 보기"를 누르면 호출됩니다 =====
        // 기존 커뮤니티 시간표 데이터는 읽기만 하며 절대 수정하지 않습니다.
        window.showCommunityTimetableInPlanner = function() {
            const box = document.getElementById('planner-community-timetable-box');
            if (!box) return;
            box.classList.toggle('hidden');
            if (box.classList.contains('hidden')) return;
            const myData = JSON.parse(localStorage.getItem('my_timetable')) || { edits: {} };
            const now = new Date();
            const dayIdx = now.getDay() - 1; // 0=월 ... 4=금, 그 외(주말)는 월요일 기준으로 보여줌
            const day = (dayIdx >= 0 && dayIdx <= 4) ? dayIdx : 0;
            let html = '';
            for (let period = 1; period <= 8; period++) {
                const key = `${period}_${day}`;
                const baseVal = sharedTimetableOverrides[key] || defaultTimetable[period][day];
                const rawVal = (myData.edits && myData.edits[key]) || baseVal;
                const parts = rawVal.split('^');
                if (parts[0] === '-') continue;
                html += `<div>${period}교시 — <strong>${parts[0]}</strong>${(parts[1] && parts[1] !== '-') ? ' (' + parts[1] + ')' : ''}</div>`;
            }
            box.innerHTML = html || '<div>오늘은 등록된 수업이 없어요.</div>';
        }

        function renderHomeTimetable() {
            const td = new Date(); const day = td.getDay(); 
            const dayNames = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
            const titleEl = document.getElementById('home-timetable-title');
            const summaryEl = document.getElementById('home-timetable-summary');
            if (titleEl) titleEl.innerText = `오늘의 시간표 (${dayNames[day]}) 🗓️`;
            
            if (day === 0 || day === 6) {
                if (summaryEl) summaryEl.innerHTML = `<div class="widget-text" style="text-align: center;">주말(휴일)입니다! 😎</div>`;
                return;
            }
            
            let myData = JSON.parse(localStorage.getItem('my_timetable')) || { edits: {} };
            if (!myData.edits) myData.edits = {};
            let html = `<div style="display: flex; flex-direction: column; gap: 8px; padding: 4px 0;">`;
            for(let period = 1; period <= 8; period++) {
                const dayIndex = day - 1; // 1:월 ~ 5:금 -> index 0~4
                const key = `${period}_${dayIndex}`;
                const baseVal = sharedTimetableOverrides[key] || defaultTimetable[period][dayIndex];
                const rawVal = myData.edits[key] || baseVal;
                const parts = rawVal.split('^');
                if(parts[0]) {
                    html += `<div style="display: flex; justify-content: space-between; border-bottom: 1px dashed #e5e7eb; padding-bottom: 6px; font-size: 14.5px;"><span style="font-weight: 700; color: var(--primary);">${period}교시</span><span style="color: var(--text-main); font-weight: 600;">${parts[0]}</span></div>`;
                }
            }
            html += `</div>`;
            if (summaryEl) summaryEl.innerHTML = html;
        }

        async function fetchWeather() {
            // (인증키/좌표는 서버 api-proxy 가 가지고 있다)

            // 외부 API라 브라우저 자체 오프라인 캐시가 없다 - 요청을 보내기 전에 마지막으로 성공한 날씨를 먼저 보여준다.
            const cachedWeather = loadInfoCache('weather');
            const weatherEl0 = document.getElementById('weather-widget');
            if (cachedWeather && weatherEl0) {
                weatherEl0.innerHTML = cachedWeather.data + (navigator.onLine ? '' : infoOfflineBadgeHtml(cachedWeather.updatedAt));
            }

            try {
                const url = `${API_PROXY_URL}?service=weather`;
                const res = await fetch(url);
                const data = await res.json();
            
                const temp = Math.round(data.current.temp_c);
                const desc = data.current.condition.text;
                const iconUrl = `https:${data.current.condition.icon}`; 
                const humidity = data.current.humidity;
                const windSpeed = (data.current.wind_kph / 3.6).toFixed(1); 
                const pop = data.forecast.forecastday[0].day.daily_chance_of_rain;
                const pm10 = Math.round(data.current.air_quality.pm10);
                const pm25 = Math.round(data.current.air_quality.pm2_5);

                const getPm10Status = (val) => val <= 30 ? '좋음' : val <= 80 ? '보통' : val <= 150 ? '나쁨' : '매우나쁨';
                const getPm25Status = (val) => val <= 15 ? '좋음' : val <= 35 ? '보통' : val <= 75 ? '나쁨' : '매우나쁨';
            
                const pm10Status = getPm10Status(pm10);
                const pm25Status = getPm25Status(pm25);
                const getColor = (status) => status === '좋음' ? '#16a34a' : status === '보통' ? '#d97706' : '#dc2626';
            
                const weatherHtml = `
                    <div class="weather-icon"><img src="${iconUrl}" alt="날씨 아이콘" style="width: 80px;"></div>
                    <div class="weather-temp" style="text-align: left; font-weight: 800; margin-bottom: 12px; color: var(--text-main); font-size: 20px;">공주시 ${temp}°C</div>
                    <div class="weather-desc" style="text-align: left; padding: 14px;">
                        <div style="text-align: center; font-weight: 700; margin-bottom: 12px; color: var(--primary); font-size: 15px;">${desc}</div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; font-size: 13px; color: var(--text-main); border-bottom: 1px dashed var(--border-color); padding-bottom: 10px; margin-bottom: 10px;">
                            <div>☂️ 강수확률: <strong>${pop}%</strong></div>
                            <div>💧 습도: <strong>${humidity}%</strong></div>
                            <div>💨 풍속: <strong>${windSpeed} m/s</strong></div>
                            <div>&nbsp;</div>
                            <div style="grid-column: span 2;">😷 미세먼지: <strong>${pm10} ㎍/㎥</strong> <small style="color:${getColor(pm10Status)}; font-weight:bold;">(${pm10Status})</small></div>
                            <div style="grid-column: span 2;">🌫️ 초미세먼지: <strong>${pm25} ㎍/㎥</strong> <small style="color:${getColor(pm25Status)}; font-weight:bold;">(${pm25Status})</small></div>
                        </div>
                    </div>
                `;
                document.getElementById('weather-widget').innerHTML = weatherHtml;
                saveInfoCache('weather', weatherHtml);
            } catch (error) {
                console.log("날씨 정보를 불러올 수 없습니다:", error);
                // 요청이 실패했으면(오프라인 등) 마지막으로 저장해둔 날씨라도 계속 보여준다.
                const weatherEl = document.getElementById('weather-widget');
                const cached = loadInfoCache('weather');
                if (weatherEl && cached) weatherEl.innerHTML = cached.data + infoOfflineBadgeHtml(cached.updatedAt);
            }
        }
        fetchWeather();


        // --- 급식표 (날짜 이동 지원) ---
        let mealViewDate = new Date(); // 급식표 탭에서 사용자가 보고 있는 날짜 (홈 대시보드와 독립적)
        let mealFetchToken = 0; // 이전 요청이 늦게 도착해도 최신 선택 날짜의 결과만 반영되도록 하는 토큰

        function formatMealDateLabel(d) {
            const days = ['일','월','화','수','목','금','토'];
            return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')} (${days[d.getDay()]})`;
        }

        async function fetchMealsForDate(dateObj) {
            const dateStr = `${dateObj.getFullYear()}${String(dateObj.getMonth()+1).padStart(2,'0')}${String(dateObj.getDate()).padStart(2,'0')}`;
            const cacheKey = 'meal_' + dateStr;
            let mealsHtml = { '조식': '<span>이 날짜에는 등록된 급식 정보가 없습니다.</span>', '중식': '<span>이 날짜에는 등록된 급식 정보가 없습니다.</span>', '석식': '<span>이 날짜에는 등록된 급식 정보가 없습니다.</span>' };
            let fromCacheAt = null;
            try {
                const res = await fetch(`https://open.neis.go.kr/hub/mealServiceDietInfo?Type=json&ATPT_OFCDC_SC_CODE=N10&SD_SCHUL_CODE=8140107&MLSV_YMD=${dateStr}`);
                const data = await res.json();
                if (data.mealServiceDietInfo) {
                    data.mealServiceDietInfo[1].row.forEach(m => {
                        let menuList = m.DDISH_NM.replace(/[0-9.]/g, '').replace(/\*/g, '').split('<br/>').map(i => i.trim());
                        mealsHtml[m.MMEAL_SC_NM] = menuList.map(i => `<span class="meal-menu-item">• ${i}</span>`).join('');
                    });
                }
                // 이 날짜(dateStr)의 급식 정보를 저장해둔다 - 외부 API라 브라우저 자체 오프라인 캐시가 없다.
                saveInfoCache(cacheKey, mealsHtml);
            } catch (e) {
                // 요청이 실패했으면(오프라인 등) 이 날짜에 저장해둔 마지막 급식 정보로 대신한다.
                const cached = loadInfoCache(cacheKey);
                if (cached) { mealsHtml = cached.data; fromCacheAt = cached.updatedAt; }
            }
            Object.defineProperty(mealsHtml, '__fromCacheAt', { value: fromCacheAt, enumerable: false });
            return mealsHtml;
        }

        async function fetchMealTabDisplay() {
            const myToken = ++mealFetchToken;
            const label = document.getElementById('meal-date-label');
            if (label) label.innerText = formatMealDateLabel(mealViewDate);
            const mealsHtml = await fetchMealsForDate(mealViewDate);
            if (myToken !== mealFetchToken) return; // 그 사이 다른 날짜로 이동했다면 이 응답은 버린다
            ['breakfast', 'lunch', 'dinner'].forEach((meal, idx) => {
                const map = ['조식', '중식', '석식'];
                if(document.getElementById(`meal-${meal}`)) document.getElementById(`meal-${meal}`).innerHTML = mealsHtml[map[idx]];
            });
            if (mealsHtml.__fromCacheAt && label) label.innerHTML += infoOfflineBadgeHtml(mealsHtml.__fromCacheAt);
        }

        async function updateHomeMealWidget() {
            // 홈 대시보드는 급식표 탭에서 어떤 날짜를 보고 있든 항상 실제 오늘 급식만 표시한다
            const td = new Date(); const currentHour = td.getHours();
            const mealsHtml = await fetchMealsForDate(td);
            const currentMealType = currentHour < 8 || (currentHour === 8 && td.getMinutes() < 30) ? '조식' : currentHour >= 14 || (currentHour === 13 && td.getMinutes() >= 30) ? '석식' : '중식';
            const homeMealTitle = document.getElementById('home-meal-title'); const homeMealSummary = document.getElementById('home-lunch-summary');
            const mealColors = { '조식': '#2563eb', '중식': '#d97706', '석식': '#16a34a' };
            if (homeMealTitle) homeMealTitle.innerHTML = `오늘의 급식 🍱 <span style="color: ${mealColors[currentMealType]}; font-size:15px;">(${currentMealType})</span>`;
            if (homeMealSummary) {
                homeMealSummary.innerHTML = mealsHtml[currentMealType];
                if (mealsHtml.__fromCacheAt) homeMealSummary.innerHTML += infoOfflineBadgeHtml(mealsHtml.__fromCacheAt);
            }
        }

        async function fetchMeals() {
            // 로그인 직후 최초 1회: 급식표 탭(오늘)과 홈 위젯(오늘)을 함께 채운다
            await fetchMealTabDisplay();
            await updateHomeMealWidget();
        }

        window.changeMealDate = function(delta) {
            mealViewDate.setDate(mealViewDate.getDate() + delta);
            fetchMealTabDisplay();
        }
        window.goToMealToday = function() {
            mealViewDate = new Date();
            fetchMealTabDisplay();
        }

// --- 입만사니 커뮤니티 ---
        // =========================================================================
        // 공지사항 시스템 (담임선생님 · 반장 · 부반장 · 커뮤니티 엔지니어만 작성 가능)
        //   - 작성 버튼: 홈/공지사항 페이지 우상단, 권한자에게만 표시
        //   - 전용 페이지: 카테고리(학급/기타)별로 전체 공지 열람 + 관리(수정/삭제)
        //   - 플로팅 팝업: 모든 탭 우하단, "가장 최신 공지 1건"만 표시 + 확인 기능
        // =========================================================================
        let noticesCache = {};
        let noticeReadsCache = {}; // { noticeId: { uid: timestamp, ... }, ... }

        // =========================================================================
        // 🔗 게시글/공지 공유 링크
        // - 서버 라우팅이 없는 단일 페이지 앱이라, "공유 링크"는 그냥 루트 URL에
        //   ?share=post|notice&id=... 를 붙인 것뿐이다. 페이지가 열리면 해당 게시글/공지 데이터가
        //   (실시간 리스너로) 도착하는 즉시 알맞은 탭으로 이동해서 상세보기를 자동으로 연다.
        // - 게스트(비로그인)도 커뮤니티/공지는 읽기 전용으로 볼 수 있으므로, 공유 링크는 로그인
        //   여부와 무관하게 항상 동작한다.
        // =========================================================================
        // id가 없는 대상(자리 배치처럼 페이지 하나 자체를 가리키는 링크)은 id를 생략할 수 있다.
        function buildShareUrl(type, id) {
            const url = new URL(location.href);
            url.search = id === undefined ? `?share=${type}` : `?share=${type}&id=${encodeURIComponent(id)}`;
            url.hash = '';
            return url.toString();
        }
        async function copyTextToClipboard(text) {
            if (navigator.clipboard && window.isSecureContext) {
                try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
            }
            // HTTPS가 아니거나 clipboard API를 못 쓰는 환경을 위한 대체 수단
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                const ok = document.execCommand('copy');
                document.body.removeChild(ta);
                return ok;
            } catch (e) { return false; }
        }
        window.sharePost = async function(postId) {
            const ok = await copyTextToClipboard(buildShareUrl('post', postId));
            alert(ok ? '게시글 링크가 복사되었어요! 붙여넣기로 공유해보세요.' : '링크 복사에 실패했어요. 브라우저 권한을 확인해주세요.');
        };
        window.shareNotice = async function(noticeId) {
            const ok = await copyTextToClipboard(buildShareUrl('notice', noticeId));
            alert(ok ? '공지 링크가 복사되었어요! 붙여넣기로 공유해보세요.' : '링크 복사에 실패했어요. 브라우저 권한을 확인해주세요.');
        };

        // 페이지가 공유 링크로 열렸으면 여기 기억해뒀다가, 해당 게시글/공지 데이터가 도착하는 즉시 연다.
        let pendingShareTarget = (function parseShareTargetFromURL() {
            try {
                const params = new URLSearchParams(location.search);
                const type = params.get('share');
                const id = params.get('id');
                if (type === 'seat') return { type, id: null }; // 자리 배치 페이지 자체를 가리키는 링크라 id가 없다
                if ((type === 'post' || type === 'notice') && id) return { type, id };
            } catch (e) {}
            return null;
        })();
        function tryConsumePendingShareTarget() {
            if (!pendingShareTarget) return;
            const { type, id } = pendingShareTarget;
            if (type === 'post' && latestPostsData && latestPostsData[id]) {
                pendingShareTarget = null;
                window.switchTab('community');
                window.openPostDetail(id);
                try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) {}
            } else if (type === 'notice' && noticesCache && noticesCache[id]) {
                pendingShareTarget = null;
                window.switchTab('notice');
                showNoticeDetail(id);
                try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) {}
            } else if (type === 'seat' && seatingDataReady) {
                // 자리 배치 데이터는 1-2반으로 로그인한 사람에게만 구독되므로, 데이터가 도착했다는 건
                // 이 사람이 볼 수 있다는 뜻이다(권한 없는 사람은 여기까지 오지 않고 아래 시간 초과 안내를 본다).
                pendingShareTarget = null;
                window.switchTab('seat');
                try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) {}
            }
        }
        if (pendingShareTarget) {
            // 데이터가 끝까지 안 오거나(네트워크 문제), 삭제됐거나 접근 권한이 없는 글이면
            // 8초 뒤에도 못 열었을 것 - 그때 한 번만 안내하고 포기한다(무한 대기 방지).
            setTimeout(() => {
                if (pendingShareTarget) {
                    alert(pendingShareTarget.type === 'seat'
                        ? '자리 배치는 1-2반으로 로그인한 뒤에 볼 수 있어요.'
                        : '공유된 글을 찾을 수 없어요. 삭제되었거나 더 이상 접근할 수 없는 글일 수 있어요.');
                    pendingShareTarget = null;
                }
            }, 8000);
        }

        function escapeNoticeText(str) {
            return String(str == null ? '' : str)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }
        // onclick="fn('...')" 처럼 HTML 속성 안의 작은따옴표 문자열 리터럴에 값을 넣을 때 쓴다.
        // 순서가 중요하다: 브라우저는 속성값의 HTML 엔티티를 "먼저" 풀고 그 결과를 JS로 해석하므로,
        // (1) JS용으로 \ 와 ' 를 먼저 이스케이프한 뒤 (2) HTML 이스케이프해야 한다.
        // (예전처럼 HTML 이스케이프를 먼저 하면 ' 가 &#39; 가 되어 뒤의 JS 이스케이프가 못 잡고,
        //  속성에서 다시 ' 로 풀려 곡 제목에 ' 가 들어가면 SyntaxError로 버튼이 통째로 죽는다.)
        function escapeJsAttr(str) {
            return escapeNoticeText(String(str == null ? '' : str)
                .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
                .replace(/\r/g, '\\r').replace(/\n/g, '\\n')
                .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'));
        }

        function noticeCategoryLabel(cat) { return cat === 'etc' ? '📌 기타' : '🏫 학급'; }
        function isNoticeConfirmedByMe(noticeId) { return !!(currentUser && noticeReadsCache[noticeId] && noticeReadsCache[noticeId][currentUser.uid]); }
        function noticeConfirmCount(noticeId) { return noticeReadsCache[noticeId] ? Object.keys(noticeReadsCache[noticeId]).length : 0; }

        function updateNoticeComposerVisibility() {
            ['btn-write-notice', 'btn-write-notice-2'].forEach(id => {
                const btn = document.getElementById(id);
                if (btn) btn.style.display = canPostNotice ? 'inline-flex' : 'none';
            });
        }

        // ----- 작성/수정 모달 -----
        window.openNoticeComposer = function(noticeId) {
            if (!canPostNotice) return;
            // 작성 페이지는 이제 모달이 아니라 tab-notice 안의 실제 페이지다. 다른 탭(홈 등)에서
            // 눌렀을 경우를 대비해 먼저 공지사항 탭으로 이동해야 실제로 화면에 보인다.
            if (typeof window.switchTab === 'function') window.switchTab('notice');
            document.getElementById('notice-editing-id').value = noticeId || '';
            const titleEl = document.getElementById('notice-composer-title');
            const contentEditable = document.getElementById('notice-form-content');
            if (noticeId && noticesCache[noticeId]) {
                const n = noticesCache[noticeId];
                titleEl.textContent = '📢 공지 수정';
                document.getElementById('notice-form-category').value = n.category || 'class';
                document.getElementById('notice-form-title').value = n.title || '';
                contentEditable.innerHTML = n.contentHTML && n.contentHTML.trim() ? sanitizeRichHTML(n.contentHTML) : escapeNoticeText(n.content || '').replace(/\n/g, '<br>');
                document.getElementById('notice-form-important').checked = !!n.important;
                document.getElementById('notice-form-show-popup').checked = n.showInPopup !== false;
            } else {
                titleEl.textContent = '📢 공지 작성';
                document.getElementById('notice-form-category').value = 'class';
                document.getElementById('notice-form-title').value = '';
                contentEditable.innerHTML = '';
                document.getElementById('notice-form-important').checked = false;
                document.getElementById('notice-form-show-popup').checked = true;
            }
            // 모달이 아니라 커뮤니티 글쓰기와 동일한 "페이지 전환" 방식 - 목록/상세를 숨기고 작성 페이지를 보여준다
            document.getElementById('notice-hub-feed-view').style.display = 'none';
            const detailEl = document.getElementById('notice-hub-detail-view');
            if (detailEl) detailEl.style.display = 'none';
            document.getElementById('poll-hub-write-view').style.display = 'none';
            document.getElementById('notice-hub-write-view').style.display = 'block';
        }

        window.closeNoticeComposer = function() {
            document.getElementById('notice-hub-write-view').style.display = 'none';
            document.getElementById('notice-hub-feed-view').style.display = 'block';
        }

        window.submitNoticeForm = async function() {
            if (!canPostNotice || !currentUser) return alert('공지 작성 권한이 없습니다.');
            if (isRichEditorUploadingImage('notice-form-content')) return alert('이미지를 업로드하는 중이에요. 잠시 후 다시 눌러주세요.');
            const editingId = document.getElementById('notice-editing-id').value;
            const title = document.getElementById('notice-form-title').value.trim();
            const contentEditable = document.getElementById('notice-form-content');
            const contentHTML = sanitizeRichHTML(contentEditable.innerHTML.trim());
            const content = (contentEditable.textContent || '').trim(); // 검색/기존 코드 호환용 일반 텍스트
            const category = document.getElementById('notice-form-category').value === 'etc' ? 'etc' : 'class';
            const important = document.getElementById('notice-form-important').checked;
            const showInPopup = document.getElementById('notice-form-show-popup').checked;
            if (!title || !content) return alert('제목과 내용을 모두 입력해주세요.');

            try {
                if (editingId) {
                    await updateDoc(doc(fdb, 'notices', editingId), {
                        title, content, contentHTML, category, important, showInPopup, updatedAt: Date.now()
                    });
                } else {
                    await addDoc(collection(fdb, 'notices'), {
                        title, content, contentHTML, category, important, showInPopup,
                        authorName: getAuthorName(),
                        authorUid: currentUser.uid,
                        authorOriginal: currentUser.email || '',
                        createdAt: Date.now()
                    });
                }
                closeNoticeComposer();
            } catch (e) { alert('공지 등록에 실패했습니다. (권한 또는 네트워크 오류)'); }
        }

        window.deleteNoticeConfirm = async function(noticeId) {
            if (!currentUser || !canPostNotice) return alert('삭제 권한이 없습니다.');
            if (!confirm('이 공지를 삭제하시겠습니까?')) return;
            try { await deleteDoc(doc(fdb, 'notices', noticeId)); } catch (e) {}
        }

        window.toggleNoticePopupShow = async function(noticeId, current) {
            if (!canPostNotice) return;
            try { await updateDoc(doc(fdb, 'notices', noticeId), { showInPopup: !current }); } catch (e) {}
        }

        // ----- 공지 확인(읽음) 처리 -----
        // Firestore notice_reads는 flat 컬렉션이라 문서 ID를 "{noticeId}_{uid}"로 구성하고,
        // 문서 내부에 noticeId/uid를 그대로 저장해서 나중에 noticeId별로 다시 묶을 수 있게 한다.
        window.confirmNoticeRead = async function(e) {
            if (e) e.stopPropagation();
            if (!currentUser || !currentPopupNoticeId) return;
            if (isNoticeConfirmedByMe(currentPopupNoticeId)) return;
            const noticeId = currentPopupNoticeId;
            try {
                await setDoc(doc(fdb, 'notice_reads', `${noticeId}_${currentUser.uid}`), { noticeId, uid: currentUser.uid, readAt: Date.now() });
                // 실시간 리스너를 기다리지 않고 즉시 확인 상태를 반영해
                // "오늘 하루 보지 않기"/"닫기" 버튼이 바로 나타나도록 한다.
                if (!noticeReadsCache[noticeId]) noticeReadsCache[noticeId] = {};
                noticeReadsCache[noticeId][currentUser.uid] = Date.now();
                renderNoticePopup();
                renderNotificationBell(); // 확인한 공지는 알림센터에서도 바로 사라진다
            } catch (e2) { /* 무시: 실패해도 팝업은 유지되어 재시도 가능 */ }
        }

        // ----- 5.0 통합 페이지: 전체/공지사항/설문 탭 -----
        let noticeHubTab = 'all'; // 'all' | 'notice' | 'poll'

        window.setNoticeHubTab = function(tab) {
            noticeHubTab = tab;
            gmwResetPage('noticeHub');
            document.querySelectorAll('.notice-hub-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
            renderNoticeHub();
        };

        function formatPollRange(p) {
            const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
            if (!p.createdAt) return '기간 정보 없음';
            const start = fmt(new Date(p.createdAt));
            return p.expiresAt ? `${start} ~ ${fmt(new Date(p.expiresAt))}` : `${start} ~ 상시`;
        }

        function noticeHubPreview(n) {
            return escapeNoticeText(richContentPreviewText(n, 'contentHTML', 'content', 80));
        }

        function renderNoticeHubCard(id, n) {
            const readCount = noticeConfirmCount(id);
            const popupOn = n.showInPopup !== false;
            return `
                <div class="notice-hub-card" onclick="showNoticeDetail('${id}')">
                    <div class="notice-hub-card-top">
                        <span class="notice-hub-type-badge notice-hub-type-notice">공지</span>
                        ${canPostNotice ? `
                            <div class="notice-hub-card-admin" onclick="event.stopPropagation()">
                                <span onclick="toggleNoticePopupShow('${id}', ${popupOn})">${popupOn ? '📌 팝업 ON' : '📌 팝업 OFF'}</span>
                                <span onclick="openNoticeComposer('${id}')">수정</span>
                                <span onclick="deleteNoticeConfirm('${id}')" class="danger">삭제</span>
                            </div>
                        ` : ''}
                    </div>
                    <div class="notice-hub-card-title">${escapeNoticeText(n.title)}</div>
                    <div class="notice-hub-card-preview">${noticeHubPreview(n)}</div>
                    <div class="notice-hub-card-meta">${escapeNoticeText(resolveDisplayName(n.authorName, n.authorOriginal) || '관리자')} · ${formatPostTime(n.createdAt)}${canPostNotice ? ` · 확인 ${readCount}명` : ''}</div>
                </div>
            `;
        }

        function renderImportantNoticeCard(id, n) {
            const popupOn = n.showInPopup !== false;
            return `
                <div class="notice-hub-important-card" onclick="showNoticeDetail('${id}')">
                    <div class="notice-hub-card-top">
                        <div class="notice-hub-important-badge">📌 중요 공지</div>
                        ${canPostNotice ? `
                            <div class="notice-hub-card-admin" onclick="event.stopPropagation()">
                                <span onclick="toggleNoticePopupShow('${id}', ${popupOn})">${popupOn ? '📌 팝업 ON' : '📌 팝업 OFF'}</span>
                                <span onclick="openNoticeComposer('${id}')">수정</span>
                                <span onclick="deleteNoticeConfirm('${id}')" class="danger">삭제</span>
                            </div>
                        ` : ''}
                    </div>
                    <div class="notice-hub-card-title">${escapeNoticeText(n.title)}</div>
                    <div class="notice-hub-card-preview">${noticeHubPreview(n)}</div>
                    <div class="notice-hub-card-meta">${escapeNoticeText(resolveDisplayName(n.authorName, n.authorOriginal) || '관리자')} · ${formatPostTime(n.createdAt)}</div>
                </div>
            `;
        }

        function renderPollHubCard(id, p) {
            const votes = pollVotesCache[id] || {};
            const totalVoters = Object.keys(votes).length;
            const myVote = currentUser ? votes[currentUser.uid] : null;
            const open = isPollOpen(p);
            const stateText = myVote ? '✓ 참여 완료' : (!open ? '마감됨' : '설문 참여 →');
            const stateClass = myVote ? 'done' : (!open ? 'closed' : '');
            return `
                <div class="notice-hub-card" onclick="openPollDetailModal('${id}')">
                    <div class="notice-hub-card-top">
                        <span class="notice-hub-type-badge notice-hub-type-poll">설문</span>
                        ${canPostNotice ? `
                            <div class="notice-hub-card-admin" onclick="event.stopPropagation()">
                                ${open ? `<span onclick="closePollConfirm('${id}')">마감</span>` : ''}
                                <span onclick="deletePollConfirm('${id}')" class="danger">삭제</span>
                            </div>
                        ` : ''}
                    </div>
                    <div class="notice-hub-card-title">${escapeNoticeText(p.title)}</div>
                    <div class="notice-hub-card-meta">참여 기간 ${formatPollRange(p)} · 현재 참여자 ${totalVoters}명</div>
                    <div class="notice-hub-poll-state ${stateClass}">${stateText}</div>
                </div>
            `;
        }

        // 공지 + 설문을 하나로 합쳐서 탭/검색을 적용하고, 중요 공지는 항상 상단에 고정한다.
        // 새로운 데이터 구조를 만들지 않고 기존 noticesCache/pollsCache를 그대로 읽기만 한다.
        function renderNoticeHub() {
            const importantEl = document.getElementById('notice-hub-important');
            const listEl = document.getElementById('notice-hub-list');
            if (!listEl) return;

            const noticeBtn = document.getElementById('btn-write-notice-2');
            const pollBtn = document.getElementById('btn-write-poll-notice');
            if (noticeBtn) noticeBtn.style.display = canPostNotice ? 'inline-flex' : 'none';
            if (pollBtn) pollBtn.style.display = canPostNotice ? 'inline-flex' : 'none';

            const query = (document.getElementById('notice-hub-search')?.value || '').trim().toLowerCase();

            let noticeItems = Object.entries(noticesCache).map(([id, n]) => ({ type: 'notice', id, data: n, ts: n.createdAt || 0 }));
            let pollItems = Object.entries(pollsCache).map(([id, p]) => ({ type: 'poll', id, data: p, ts: p.createdAt || 0 }));

            if (query) {
                noticeItems = noticeItems.filter(it => {
                    const authorText = resolveDisplayName(it.data.authorName, it.data.authorOriginal) || '';
                    return (it.data.title || '').toLowerCase().includes(query)
                        || (it.data.content || '').toLowerCase().includes(query)
                        || authorText.toLowerCase().includes(query);
                });
                pollItems = pollItems.filter(it => {
                    const authorText = resolveDisplayName(it.data.authorName, it.data.authorOriginal) || '';
                    return (it.data.title || '').toLowerCase().includes(query)
                        || (it.data.description || '').toLowerCase().includes(query)
                        || authorText.toLowerCase().includes(query);
                });
            }

            // 중요 공지는 탭/검색과 무관하게 항상 맨 위에 고정 (단, 검색어와 안 맞으면 안 보이는 게 자연스러우니 필터링된 noticeItems 기준)
            const importantNotices = noticeItems.filter(it => it.data.important);
            if (importantEl) {
                importantEl.innerHTML = importantNotices.map(it => renderImportantNoticeCard(it.id, it.data)).join('');
            }

            let items;
            if (noticeHubTab === 'notice') items = noticeItems;
            else if (noticeHubTab === 'poll') items = pollItems;
            else items = [...noticeItems, ...pollItems];

            // 중요 공지는 위에서 이미 고정 표시했으니 일반 목록에서는 중복으로 보여주지 않는다.
            const regularItems = items.filter(it => !(it.type === 'notice' && it.data.important));
            regularItems.sort((a, b) => b.ts - a.ts);

            if (regularItems.length === 0 && importantNotices.length === 0) {
                listEl.innerHTML = `<div class="card" style="text-align:center; color:var(--text-muted); padding:40px 20px;">아직 등록된 소식이 없습니다.<br><span style="font-size:12px;">새로운 공지나 설문이 등록되면 이곳에서 확인할 수 있습니다.</span></div>`;
                return;
            }
            listEl.innerHTML = regularItems.map(it => it.type === 'notice' ? renderNoticeHubCard(it.id, it.data) : renderPollHubCard(it.id, it.data)).join('');

            gmwResetPageIfQueryChanged('noticeHub', query);
            gmwApplyPagination('noticeHub', listEl, '.notice-hub-card');
            gmwBindImageRecalc('noticeHub', listEl, '.notice-hub-card');
        }
        window.renderNoticeHub = renderNoticeHub; // 검색창 등 인라인 이벤트 핸들러(oninput)는 window 스코프에서 찾으므로 명시적으로 노출

        // ----- 상세 보기 모달 (공지 페이지 카드 클릭 / 팝업 클릭 공용) -----
        function showNoticeDetail(id) {
            const n = noticesCache[id];
            if (!n) return;
            const detailEl = document.getElementById('notice-hub-detail-view');
            if (!detailEl) return;

            document.getElementById('notice-hub-feed-view').style.display = 'none';
            detailEl.style.display = 'block';

            const readCount = noticeConfirmCount(id);
            const popupOn = n.showInPopup !== false;

            detailEl.innerHTML = `
                <div class="community-detail-card">
                    <div class="community-back-link" onclick="closeNoticeDetailView()">← 공지사항 / 설문</div>
                    <div class="detail-meta">
                        <span>${noticeCategoryLabel(n.category)}${n.important ? ' · ⭐ 중요' : ''} · ${escapeNoticeText(resolveDisplayName(n.authorName, n.authorOriginal) || '관리자')} · ${formatPostTime(n.createdAt)}</span>
                        <span onclick="shareNotice('${id}')" style="cursor:pointer; color:var(--primary); font-weight:600; font-size:12.5px; white-space:nowrap; margin-left:auto; margin-right:${canPostNotice ? '10px' : '0'};">🔗 공유</span>
                        ${canPostNotice ? `
                            <span class="post-menu-wrap">
                                <span class="post-menu-trigger" onclick="togglePostMenu('notice-${id}')">⋯</span>
                                <div class="post-menu-dropdown" id="post-menu-notice-${id}">
                                    <div class="post-menu-item" onclick="toggleNoticePopupShow('${id}', ${popupOn})">${popupOn ? '📌 팝업 끄기' : '📌 팝업 켜기'}</div>
                                    <div class="post-menu-item" onclick="openNoticeComposer('${id}')">수정</div>
                                    <div class="post-menu-item danger" onclick="deleteNoticeConfirm('${id}'); closeNoticeDetailView();">삭제</div>
                                </div>
                            </span>
                        ` : ''}
                    </div>
                    <h2 class="detail-title">${escapeNoticeText(n.title)}</h2>
                    <div class="detail-body">${renderRichOrPlain(n, 'contentHTML', 'content')}</div>
                    ${canPostNotice ? `<div class="detail-actions" style="border-bottom:none;">✅ 확인 ${readCount}명</div>` : ''}
                </div>
            `;
        }
        window.showNoticeDetail = showNoticeDetail; // 인라인 onclick(HTML)은 window 스코프에서 찾으므로 명시적으로 노출

        window.closeNoticeDetailView = function() {
            const detailEl = document.getElementById('notice-hub-detail-view');
            if (detailEl) { detailEl.style.display = 'none'; detailEl.innerHTML = ''; }
            document.getElementById('notice-hub-feed-view').style.display = 'block';
        };

        // ----- 플로팅 팝업: "팝업으로 표시"가 켜진 공지 중 최신순으로 표시 (여러 개면 넘겨볼 수 있음) -----
        function getPopupEligibleNotices() {
            return Object.entries(noticesCache)
                .filter(([, n]) => n.showInPopup !== false)
                .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0))
                .map(([id, n]) => ({ id, ...n }));
        }

        // =========================================================================
        // 🎨 개인 UI 커스텀 (배경화면/강조색)
        // - 새로운 저장소를 만들지 않는다: 이미지는 기존 uploadImageToFreeImageHost()로 올리고,
        //   URL/색상값만 Firebase RTDB의 기존 users/{uid} 문서에 필드로 추가한다.
        // - 다른 사용자에게는 영향 없음 (본인 계정에만 적용되는 개인 설정).
        // =========================================================================
        const ACCENT_PRESETS = [
            { name: '기본 블루', color: null },        // null = 사이트 기본값 그대로 사용
            { name: '네이비', color: '#1e3a8a' },
            { name: '그린', color: '#16a34a' },
            { name: '핑크', color: '#db2777' },
            { name: '퍼플', color: '#7c3aed' },
            { name: '오렌지', color: '#ea580c' },
        ];

        function hexToRgba(hex, alpha) {
            const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
            if (!m) return null;
            const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
            return `rgba(${r},${g},${b},${alpha})`;
        }

        function applyUserCustomization(userData) {
            const root = document.documentElement;
            // 강조색: 지정돼 있으면 --primary/--primary-soft를 덮어쓰고, 없으면 기존 사이트 기본값으로 되돌린다
            if (userData && userData.accentColor) {
                root.style.setProperty('--primary', userData.accentColor);
                const soft = hexToRgba(userData.accentColor, 0.14);
                if (soft) root.style.setProperty('--primary-soft', soft);
            } else {
                root.style.removeProperty('--primary');
                root.style.removeProperty('--primary-soft');
            }
            // 배경화면은 더 이상 여기서 처리하지 않는다 (IndexedDB 기반으로 바뀌어서 로그인과 무관하게
            // applyCustomBackgroundFromIndexedDB()가 페이지 로드 시 한 번 알아서 적용한다)
        }

        // =========================================================================
        // 🖼️ 배경화면 커스텀 (IndexedDB 기반)
        // - 외부 이미지 호스팅(ImgBB)에 올리지 않는다 - 사진이 이 브라우저 밖으로 절대 나가지 않는다.
        // - Firebase 계정과도 연결하지 않는다 - "이 브라우저"에만 저장되는 개인 설정이다.
        // - 기존 mixtapeDB와 완전히 별개의 작은 IndexedDB 하나만 새로 쓴다 (딱 배경화면 1장만 저장).
        // =========================================================================
        const BG_DB_NAME = 'userBackgroundDB';
        const BG_DB_VERSION = 1;
        // 어떤 배경을 쓸지: 'default1'(사이트 기본 단색) | 'default2'(제공된 낮/밤 사진 세트) | 'custom'(직접 업로드)
        const BG_PRESET_KEY = 'hanilgo_bg_preset';
        // 'custom' 프리셋에서, 다크 모드용 사진을 따로 안 넣고 라이트 사진을 그대로 쓸 때만 적용되는 어둡게 정도(0~100)
        const BG_DARK_DIM_KEY = 'hanilgo_bg_dark_dim';
        const BG_DARK_DIM_DEFAULT = 35;
        const BACKGROUND_PRESETS = {
            default2: { light: '/assets/bg-preset2-light.webp', dark: '/assets/bg-preset2-dark.webp' }
        };
        function openBgDB() {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open(BG_DB_NAME, BG_DB_VERSION);
                req.onupgradeneeded = () => {
                    if (!req.result.objectStoreNames.contains('background')) {
                        req.result.createObjectStore('background');
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }
        // slot: 'light' | 'dark' (지난 버전엔 슬롯 구분 없이 'current' 하나뿐이었다 - migrateLegacyCustomBackground 참고)
        async function saveBgBlobToIndexedDB(blob, slot) {
            const db2 = await openBgDB();
            return new Promise((resolve, reject) => {
                const tx = db2.transaction('background', 'readwrite');
                tx.objectStore('background').put(blob, slot);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }
        async function getBgBlobFromIndexedDB(slot) {
            const db2 = await openBgDB();
            return new Promise((resolve, reject) => {
                const tx = db2.transaction('background', 'readonly');
                const req = tx.objectStore('background').get(slot);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => reject(req.error);
            });
        }
        async function deleteBgBlobFromIndexedDB(slot) {
            const db2 = await openBgDB();
            return new Promise((resolve, reject) => {
                const tx = db2.transaction('background', 'readwrite');
                tx.objectStore('background').delete(slot);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }

        // =========================================================================
        // 홈 위젯 - "나만의 메모"/"나만의 사진" (개인 커스텀 전용, 반 전체와 공유되지 않음)
        // - 메모(텍스트)와 사진은 서로 다른 위젯이다 - 메모는 텍스트만, 사진은 사진 한 장만 담는다.
        // - 텍스트는 localStorage에, 사진은 배경화면과 같은 방식으로 작은 전용 IndexedDB에 저장한다.
        // - Firebase에도, 외부 이미지 호스팅에도 올리지 않는다 - 이 브라우저에만 남는다.
        // - 기본으로 주어지는 위젯은 없다. 사용자가 편집 모드의 "+ 메모"/"+ 사진"으로 원하는 만큼 추가하고
        //   삭제한다 - 앱 기능을 요약해 보여주는 고정 위젯(하나뿐, 숨기기/다시 꺼내기)과는 다른 개념이라
        //   숨기기는 없고 추가/삭제만 있다. id는 "w-memo-<시각>-<난수>" / "w-photo-<시각>-<난수>" 형태이고
        //   id의 접두어로 위젯 종류를 구분한다. (예전 버전은 기본으로 w-memo/w-photo 하나씩을 "나만의 공간"
        //   카테고리에 줬다 - 그 흔적은 migrateLegacyPersonalSection()이 한 번 정리한다.)
        // =========================================================================
        const MEMO_TEXT_KEY = 'hanilgo_personal_memo_text';
        const MEMO_DB_NAME = 'personalMemoDB';
        const MEMO_DB_VERSION = 1;
        function memoTextKey(widgetId){
            return widgetId === 'w-memo' ? MEMO_TEXT_KEY : (MEMO_TEXT_KEY + '_' + widgetId);
        }
        function isMemoWidgetId(id){ return id === 'w-memo' || id.indexOf('w-memo-') === 0; }
        function isPhotoWidgetId(id){ return id === 'w-photo' || id.indexOf('w-photo-') === 0; }
        function isPersonalWidgetId(id){ return isMemoWidgetId(id) || isPhotoWidgetId(id); }
        function openMemoDB() {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open(MEMO_DB_NAME, MEMO_DB_VERSION);
                req.onupgradeneeded = () => {
                    if (!req.result.objectStoreNames.contains('photo')) {
                        req.result.createObjectStore('photo');
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }
        // widgetId를 키로 써서 사진 위젯마다 각자 다른 사진을 저장한다 (지난 버전엔 'current' 키 하나뿐이었다).
        async function saveMemoPhotoToIndexedDB(blob, widgetId) {
            const db2 = await openMemoDB();
            return new Promise((resolve, reject) => {
                const tx = db2.transaction('photo', 'readwrite');
                tx.objectStore('photo').put(blob, widgetId);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }
        async function getMemoPhotoFromIndexedDB(widgetId) {
            const db2 = await openMemoDB();
            return new Promise((resolve, reject) => {
                const tx = db2.transaction('photo', 'readonly');
                const req = tx.objectStore('photo').get(widgetId);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => reject(req.error);
            });
        }
        async function deleteMemoPhotoFromIndexedDB(widgetId) {
            const db2 = await openMemoDB();
            return new Promise((resolve, reject) => {
                const tx = db2.transaction('photo', 'readwrite');
                tx.objectStore('photo').delete(widgetId);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }
        // 지난 버전엔 메모와 사진이 한 위젯(w-memo)에 같이 있었고, 사진은 'current' 키 하나에만 저장했다.
        // 이제 사진은 별도 위젯(w-photo)이므로, 예전에 저장해둔 사진이 있으면 그쪽으로 옮겨준다.
        async function migrateLegacyMemoPhoto(){
            try {
                const [legacy, current] = await Promise.all([getMemoPhotoFromIndexedDB('current'), getMemoPhotoFromIndexedDB('w-photo')]);
                if (legacy && !current) {
                    await saveMemoPhotoToIndexedDB(legacy, 'w-photo');
                    await deleteMemoPhotoFromIndexedDB('current');
                }
            } catch (e) {}
        }
        const homeMemoPhotoUrls = new Map();
        async function renderHomeMemoPhotoInto(cardEl, widgetId) {
            const wrap = cardEl.querySelector('.home-memo-photo-wrap');
            const img = cardEl.querySelector('.home-memo-photo-preview');
            if (!wrap || !img) return;
            try {
                const blob = await getMemoPhotoFromIndexedDB(widgetId);
                const prevUrl = homeMemoPhotoUrls.get(widgetId);
                if (prevUrl) { URL.revokeObjectURL(prevUrl); homeMemoPhotoUrls.delete(widgetId); }
                if (blob) {
                    const url = URL.createObjectURL(blob);
                    homeMemoPhotoUrls.set(widgetId, url);
                    img.src = url;
                    wrap.style.display = '';
                } else {
                    wrap.style.display = 'none';
                }
            } catch (e) {}
        }
        // widgetId가 가리키는 위젯 카드 안을 채운다 - isMemoWidgetId면 텍스트 메모, isPhotoWidgetId면 사진 위젯.
        // 위젯 자체를 삭제하는 버튼은 카드 안이 아니라 편집 모드의 위젯 편집 바(🙈 숨기기 옆 🗑)에 있다.
        function renderPersonalWidgetInner(cardEl, widgetId) {
            if (isMemoWidgetId(widgetId)) {
                // 카드 자체를 세로 flex로 만들고 textarea를 flex:1로 채워서, 위젯을 손잡이로 늘렸을 때
                // (또는 삭제된 하단 버튼 줄만큼) 텍스트 아래에 빈 여백이 남지 않고 카드 높이만큼 꽉 차게 한다.
                cardEl.style.display = 'flex';
                cardEl.style.flexDirection = 'column';
                cardEl.innerHTML = `
                    <textarea class="home-memo-text" placeholder="여기에 메모를 남겨보세요 (이 브라우저에만 저장돼요)" style="width:100%; min-height:90px; flex:1; resize:none; box-sizing:border-box; font-family:inherit; font-size:13px; padding:8px; border-radius:8px; border:1px solid var(--border-color); background:var(--input-bg, transparent); color:inherit;"></textarea>
                `;
                const textEl = cardEl.querySelector('.home-memo-text');
                try { textEl.value = localStorage.getItem(memoTextKey(widgetId)) || ''; } catch (e) {}
                let saveTimer = null;
                textEl.addEventListener('input', () => {
                    clearTimeout(saveTimer);
                    saveTimer = setTimeout(() => {
                        try { localStorage.setItem(memoTextKey(widgetId), textEl.value); } catch (e) {}
                    }, 500);
                });
            } else if (isPhotoWidgetId(widgetId)) {
                cardEl.innerHTML = `
                    <div class="home-memo-photo-wrap" style="display:none; position:relative;">
                        <img class="home-memo-photo-preview" style="width:100%; max-height:200px; object-fit:cover; border-radius:8px; display:block;">
                        <button type="button" class="btn-sub home-memo-photo-remove" style="position:absolute; top:6px; right:6px; font-size:11px; padding:4px 8px;">✕ 사진 삭제</button>
                    </div>
                    <div style="margin-top:8px; display:flex; align-items:center; gap:8px;">
                        <label class="btn-sub" style="font-size:12px; padding:6px 12px; cursor:pointer;">
                            📷 사진 첨부
                            <input type="file" accept="image/*" class="home-memo-photo-input" style="display:none;">
                        </label>
                    </div>
                `;
                cardEl.querySelector('.home-memo-photo-input').addEventListener('change', async (event) => {
                    const file = event.target.files && event.target.files[0];
                    if (!file) return;
                    try {
                        await saveMemoPhotoToIndexedDB(file, widgetId);
                        await renderHomeMemoPhotoInto(cardEl, widgetId);
                    } catch (e) {
                        alert('사진 저장에 실패했습니다: ' + e.message);
                    } finally {
                        event.target.value = '';
                    }
                });
                cardEl.querySelector('.home-memo-photo-remove').addEventListener('click', async () => {
                    try {
                        await deleteMemoPhotoFromIndexedDB(widgetId);
                        await renderHomeMemoPhotoInto(cardEl, widgetId);
                    } catch (e) {}
                });
                renderHomeMemoPhotoInto(cardEl, widgetId);
            }
        }
        // 페이지에 이미 놓여 있는(정적 HTML이든, 새로 추가되어 만들어졌든) 메모/사진 위젯 카드들을 전부 찾아서
        // 아직 초기화 안 된 것만 채운다 - applyHomeLayout()이 카드 뼈대(빈 div)를 만든 다음 호출된다.
        async function initAllMemoWidgets() {
            await migrateLegacyMemoPhoto();
            document.querySelectorAll('#home-sections-container .card[data-widget-id]').forEach(cardEl => {
                const widgetId = cardEl.dataset.widgetId;
                if (!cardEl.dataset.memoInit && (isMemoWidgetId(widgetId) || isPhotoWidgetId(widgetId))) {
                    cardEl.dataset.memoInit = '1';
                    renderPersonalWidgetInner(cardEl, widgetId);
                }
            });
        }
        // "+ 메모 추가"/"+ 사진 추가" - 지정된 섹션에 새 개인 위젯 인스턴스를 만든다.
        window.addPersonalWidget = function(sectionId, type) {
            const id = (type === 'photo' ? 'w-photo-' : 'w-memo-') + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
            const layout = loadHomeLayout();
            const section = layout.find(s => s.id === sectionId) || layout[0];
            if (!section) return;
            section.widgets.push(id);
            saveHomeLayout(layout);
            applyHomeLayout();
            initAllMemoWidgets();
            applyHomeWidgetSizes();
            applyHomeWidgetVisibility();
            if (homeSectionEditMode) renderHomeEditControls();
        };
        // 편집 툴바 맨 위의 "+ 메모"/"+ 사진" 버튼 전용 - 카테고리마다 따로 버튼을 두지 않고 여기 하나만
        // 있으면 충분하다(일단 첫 번째 카테고리에 넣고, 원하면 드래그로 다른 카테고리에 옮기면 된다).
        window.addPersonalWidgetToFirstSection = function(type) {
            const layout = loadHomeLayout();
            if (layout.length === 0) return;
            window.addPersonalWidget(layout[0].id, type);
        };
        window.deletePersonalWidget = function(widgetId) {
            if (!isPersonalWidgetId(widgetId)) return; // 삭제는 메모/사진 위젯 전용 - 고정 위젯은 숨기기만 가능
            if (!confirm('이 위젯을 삭제할까요? 저장된 내용도 함께 삭제됩니다.')) return;
            const layout = loadHomeLayout();
            layout.forEach(s => { s.widgets = s.widgets.filter(id => id !== widgetId); });
            saveHomeLayout(layout);
            const cardEl = document.querySelector(`.card[data-widget-id="${widgetId}"]`);
            if (cardEl) cardEl.remove();
            try { localStorage.removeItem(memoTextKey(widgetId)); } catch (e) {}
            deleteMemoPhotoFromIndexedDB(widgetId).catch(() => {});
            const sizes = loadHomeWidgetSizes();
            if (sizes[widgetId]) { delete sizes[widgetId]; saveHomeWidgetSizes(sizes); }
            if (homeSectionEditMode) renderHomeEditControls();
        };

        // =========================================================================
        // 예전 버전이 모두에게 기본으로 줬던 "📝 나만의 공간 (개인)" 카테고리와 그 안의 기본 메모/사진
        // 위젯(w-memo, w-photo) 정리 - 이제 기본 위젯은 없고 사용자가 필요할 때만 추가/삭제한다.
        // 이미 그 카테고리를 쓰던 사용자의 실제 데이터(써둔 메모, 올려둔 사진)는 절대 지우지 않는다:
        //  - 내용이 비어 있는 기본 메모/사진은 그냥 삭제한다(숨겨두고 안 쓰던 경우가 대부분).
        //  - 내용이 있는 건 살려서 첫 번째 카테고리로 옮기고 다시 보이게 한다(이제 🗑로 직접 지울 수 있다).
        //  - "나만의 공간" 카테고리 자체는 없앤다. 그 안에 사용자가 다른 위젯을 옮겨 넣었다면 그것도 첫
        //    번째 카테고리로 옮겨서 위젯이 사라지지 않게 한다.
        //  - 메모/사진은 숨김 개념이 없으므로 숨김 목록에서 전부 뺀다.
        // 브라우저마다 딱 한 번만 실행된다(플래그).
        // =========================================================================
        // 순수 계산 함수 - DOM/스토리지를 건드리지 않고 "정리된 결과"만 돌려줘서 따로 테스트할 수 있다.
        // hasContent: { 'w-memo': boolean, 'w-photo': boolean } (기본 메모/사진에 저장된 내용이 있는지)
        function computeLegacyPersonalMigration(layout, hidden, sizes, hasContent) {
            const LEGACY_SECTION_ID = 'personal';
            const LEGACY_WIDGET_IDS = ['w-memo', 'w-photo'];
            const isPersonalId = (id) => /^w-(memo|photo)(-|$)/.test(id);
            let newLayout = layout.map(s => ({ id: s.id, label: s.label, widgets: s.widgets.slice() }));
            const newSizes = Object.assign({}, sizes);

            // 1) 내용이 없는 기본 메모/사진은 어디에 있든 삭제한다.
            const deleteIds = LEGACY_WIDGET_IDS.filter(id => !hasContent[id]);
            newLayout.forEach(s => { s.widgets = s.widgets.filter(id => !deleteIds.includes(id)); });
            deleteIds.forEach(id => { delete newSizes[id]; });

            // 2) "나만의 공간" 카테고리는 없앤다 - 남은 위젯은 첫 번째로 남는 카테고리로 옮긴다.
            //    (이 카테고리가 전부라 옮길 곳이 없으면 위젯이 사라지므로 그대로 둔다.)
            const legacySection = newLayout.find(s => s.id === LEGACY_SECTION_ID);
            if (legacySection) {
                const remaining = newLayout.filter(s => s.id !== LEGACY_SECTION_ID);
                if (remaining.length > 0) {
                    remaining[0].widgets.push(...legacySection.widgets);
                    newLayout = remaining;
                }
            }

            // 3) 내용이 있어서 살려둔 기본 메모/사진이 어느 카테고리에도 없으면(예전 기본 배치를 그대로 쓰던
            //    사용자) 첫 번째 카테고리 끝에 넣는다.
            LEGACY_WIDGET_IDS.forEach(id => {
                if (hasContent[id] && !newLayout.some(s => s.widgets.includes(id))) newLayout[0].widgets.push(id);
            });

            // 4) 예전엔 기본 폭이 3칸이었다. 저장된 크기가 없으면 그 폭을 유지시켜서, 살려둔 위젯의 모양이
            //    갑자기 좁아지지 않게 한다.
            LEGACY_WIDGET_IDS.forEach(id => {
                if (hasContent[id] && !newSizes[id]) newSizes[id] = { colSpan: 3, minHeight: 0 };
            });

            // 5) 메모/사진은 숨김 개념이 없다 - 숨김 목록에서 전부 뺀다(내용이 있는 위젯은 다시 보이게 된다).
            const newHidden = hidden.filter(id => !isPersonalId(id));

            return { layout: newLayout, hidden: newHidden, sizes: newSizes, deleteIds };
        }
        async function migrateLegacyPersonalSection() {
            const FLAG = 'hanilgo_home_personal_migrated_v1';
            try { if (localStorage.getItem(FLAG) === '1') return; } catch (e) { return; }
            try {
                await migrateLegacyMemoPhoto(); // 옛날 'current' 사진 키를 w-photo로 먼저 옮겨야 내용 유무를 정확히 알 수 있다
                const hasContent = {};
                // 내용 유무를 확인하다 오류가 나면 "있다"고 취급한다 - 잘못 지우는 것보다 잘못 남기는 게 안전하다.
                try { hasContent['w-memo'] = ((localStorage.getItem(memoTextKey('w-memo')) || '').trim().length > 0); } catch (e) { hasContent['w-memo'] = true; }
                try { hasContent['w-photo'] = !!(await getMemoPhotoFromIndexedDB('w-photo')); } catch (e) { hasContent['w-photo'] = true; }

                const before = { layout: loadHomeLayout(), hidden: loadHiddenHomeWidgets(), sizes: loadHomeWidgetSizes() };
                const result = computeLegacyPersonalMigration(before.layout, before.hidden, before.sizes, hasContent);

                result.deleteIds.forEach(id => {
                    const cardEl = document.querySelector(`.card[data-widget-id="${id}"]`);
                    if (cardEl) cardEl.remove();
                    try { localStorage.removeItem(memoTextKey(id)); } catch (e) {}
                    deleteMemoPhotoFromIndexedDB(id).catch(() => {});
                });
                // 섹션째로 사라질 때 옮겨질 위젯 카드까지 같이 지워지지 않도록 먼저 컨테이너 밖으로 빼둔다.
                const legacySectionEl = document.querySelector('.home-section[data-section-id="personal"]');
                if (legacySectionEl && !result.layout.some(s => s.id === 'personal')) {
                    legacySectionEl.querySelectorAll('.card[data-widget-id]').forEach(c => document.body.appendChild(c));
                    legacySectionEl.remove();
                }
                const changed = JSON.stringify(result.layout) !== JSON.stringify(before.layout)
                    || JSON.stringify(result.sizes) !== JSON.stringify(before.sizes);
                if (changed) {
                    saveHomeLayout(result.layout);
                    saveHomeWidgetSizes(result.sizes);
                }
                saveHiddenHomeWidgets(result.hidden); // 예전 숨김 기록에 남아있던 메모/사진 id까지 저장소에서 정리
                if (changed) {
                    applyHomeLayout();
                    applyHomeWidgetSizes();
                    applyHomeWidgetVisibility();
                    initAllMemoWidgets(); // 새로 자리를 옮긴/다시 보이게 된 위젯이 아직 초기화 전이면 채운다
                    if (homeSectionEditMode) renderHomeEditControls();
                }
            } catch (e) {
                console.warn('나만의 공간 정리 실패(다음 접속 때 다시 시도):', e);
                return;
            }
            try { localStorage.setItem(FLAG, '1'); } catch (e) {}
        }
        migrateLegacyPersonalSection();
        // 지난 버전엔 'current' 키 하나에만 저장했다. 'light'/'dark' 슬롯이 아직 하나도 없고 'current'만
        // 있으면, 그 사진을 라이트 슬롯으로 옮겨서 계속 "공용(라이트 사진을 다크에도 그대로)"으로 동작하게 한다.
        async function migrateLegacyCustomBackground() {
            try {
                const [light, dark, legacy] = await Promise.all([
                    getBgBlobFromIndexedDB('light'), getBgBlobFromIndexedDB('dark'), getBgBlobFromIndexedDB('current')
                ]);
                if (!light && !dark && legacy) {
                    await saveBgBlobToIndexedDB(legacy, 'light');
                    await deleteBgBlobFromIndexedDB('current');
                }
            } catch (e) {}
        }
        let currentBgObjectUrl = null;
        function isSiteDarkModeNow() { return document.body.classList.contains('gmw-site-dark'); }
        function getActiveBackgroundPreset() {
            // 처음 접속하는(아직 아무 것도 고른 적 없는) 사용자의 기본값은 기본2(제공된 낮/밤 사진 세트)로 한다.
            try { return localStorage.getItem(BG_PRESET_KEY) || 'default2'; } catch (e) { return 'default2'; }
        }
        function getBackgroundDarkDim() {
            try {
                const v = parseInt(localStorage.getItem(BG_DARK_DIM_KEY), 10);
                return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : BG_DARK_DIM_DEFAULT;
            } catch (e) { return BG_DARK_DIM_DEFAULT; }
        }
        // ⚠️ 지난 버전의 실제 버그: body에 .gmw-custom-bg 클래스만 붙이고 정작 그 클래스의
        // CSS(background-size/position/repeat)를 하나도 안 만들어놔서, 사진이 원본 크기로
        // 반복(tile)되어 이상하게 보였다. 이번에 .gmw-custom-bg 스타일을 실제로 추가했다.
        // dimAlpha(0~1)를 주면 사진 위에 반투명 검은 레이어를 겹쳐 그만큼 어둡게 만든다
        // (공용 사진을 다크 모드에서 쓸 때만 사용 - 별도의 다크용 사진이 있으면 0).
        function setPageBackgroundImageUrl(url, dimAlpha) {
            document.body.classList.add('gmw-custom-bg');
            document.body.style.backgroundImage = (dimAlpha && dimAlpha > 0)
                ? `linear-gradient(rgba(0,0,0,${dimAlpha}), rgba(0,0,0,${dimAlpha})), url("${url}")`
                : `url("${url}")`;
        }
        function clearPageBackgroundImage() {
            document.body.classList.remove('gmw-custom-bg');
            document.body.style.backgroundImage = '';
        }
        // 현재 선택된 프리셋 + 현재 라이트/다크 테마에 맞는 배경을 실제로 화면에 적용한다.
        // 로그인 여부와 무관하게 동작하고(이 브라우저에만 저장되는 개인 설정), 테마가 바뀔 때도
        // applySiteTheme()에서 다시 호출해서 그 즉시 알맞은 사진로 바뀌게 한다.
        async function applyActiveBackground() {
            if (currentBgObjectUrl) { URL.revokeObjectURL(currentBgObjectUrl); currentBgObjectUrl = null; }
            const preset = getActiveBackgroundPreset();
            const dark = isSiteDarkModeNow();

            if (preset === 'default2') {
                setPageBackgroundImageUrl(dark ? BACKGROUND_PRESETS.default2.dark : BACKGROUND_PRESETS.default2.light, 0);
                return;
            }
            if (preset === 'custom') {
                try {
                    const [lightBlob, darkBlob] = await Promise.all([getBgBlobFromIndexedDB('light'), getBgBlobFromIndexedDB('dark')]);
                    const blob = dark ? (darkBlob || lightBlob) : (lightBlob || darkBlob);
                    if (!blob) { clearPageBackgroundImage(); return; }
                    currentBgObjectUrl = URL.createObjectURL(blob);
                    const usingSharedLightInDark = dark && !darkBlob && !!lightBlob; // 다크용 없이 라이트 사진을 다크에도 그대로 쓰는 상황
                    setPageBackgroundImageUrl(currentBgObjectUrl, usingSharedLightInDark ? (getBackgroundDarkDim() / 100) : 0);
                } catch (e) { clearPageBackgroundImage(); }
                return;
            }
            clearPageBackgroundImage(); // default1: 사이트 기본 단색
        }
        window.applyActiveBackground = applyActiveBackground;
        migrateLegacyCustomBackground().then(applyActiveBackground);

        // =========================================================================
        // 배경화면 부분 잘라 쓰기(크롭): 사진을 통째로 쓰는 대신, 16:9 프레임 안에서 드래그로
        // 위치를 옮기고 슬라이더로 확대해서 원하는 부분만 잘라 저장한다. 미리보기와 실제 저장 모두
        // 같은 canvas 좌표 계산을 쓰므로 "보이는 그대로" 잘린다.
        // =========================================================================
        let bgCropImg = null;
        let bgCropObjectUrl = null;
        let bgCropMinScale = 1;
        let bgCropScale = 1;
        let bgCropOffsetX = 0;
        let bgCropOffsetY = 0;
        let bgCropFrameW = 0;
        let bgCropFrameH = 0;
        let bgCropDragging = false;
        let bgCropDragStart = null; // { x, y, offsetX, offsetY }
        let bgCropTarget = 'light'; // 크롭한 결과를 어느 슬롯('light'|'dark')에 저장할지

        function clampBgCropOffset() {
            const destW = bgCropImg.width * bgCropScale;
            const destH = bgCropImg.height * bgCropScale;
            bgCropOffsetX = Math.min(0, Math.max(bgCropFrameW - destW, bgCropOffsetX));
            bgCropOffsetY = Math.min(0, Math.max(bgCropFrameH - destH, bgCropOffsetY));
        }

        function drawBgCropPreview() {
            const canvas = document.getElementById('bg-crop-canvas');
            if (!canvas || !bgCropImg) return;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(bgCropImg, bgCropOffsetX, bgCropOffsetY, bgCropImg.width * bgCropScale, bgCropImg.height * bgCropScale);
        }

        window.openBgCropModal = function(file, target) {
            bgCropTarget = target || 'light';
            if (bgCropObjectUrl) { URL.revokeObjectURL(bgCropObjectUrl); bgCropObjectUrl = null; }
            bgCropObjectUrl = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                bgCropImg = img;
                // 모달을 먼저 보이게 해야 프레임이 실제로 레이아웃을 갖는다. display:none인 상태에서
                // getBoundingClientRect()를 재면 항상 0이 나와서 canvas가 0x0이 되고, 그러면 아무것도
                // 안 그려진 채 #bg-crop-frame의 검은 배경(#111)만 보이게 된다 - 실제로 발생했던 버그.
                document.getElementById('bg-crop-modal').style.display = 'flex';
                const frame = document.getElementById('bg-crop-frame');
                const canvas = document.getElementById('bg-crop-canvas');
                const rect = frame.getBoundingClientRect();
                // 레티나 화면에서도 또렷하게 보이도록 devicePixelRatio만큼 canvas 실제 해상도를 올린다.
                const dpr = window.devicePixelRatio || 1;
                bgCropFrameW = rect.width * dpr;
                bgCropFrameH = rect.height * dpr;
                canvas.width = bgCropFrameW;
                canvas.height = bgCropFrameH;
                // 프레임을 빈틈없이 덮는 최소 배율(=cover) - 여기서부터 확대만 가능하게 한다.
                bgCropMinScale = Math.max(bgCropFrameW / img.width, bgCropFrameH / img.height);
                bgCropScale = bgCropMinScale;
                bgCropOffsetX = (bgCropFrameW - img.width * bgCropScale) / 2;
                bgCropOffsetY = (bgCropFrameH - img.height * bgCropScale) / 2;
                document.getElementById('bg-crop-zoom').value = 0;
                drawBgCropPreview();
            };
            img.src = bgCropObjectUrl;
        };

        window.closeBgCropModal = function() {
            document.getElementById('bg-crop-modal').style.display = 'none';
            if (bgCropObjectUrl) { URL.revokeObjectURL(bgCropObjectUrl); bgCropObjectUrl = null; }
            bgCropImg = null;
            // 같은 파일을 다시 선택해도 change 이벤트가 뜨도록 두 슬롯 입력 모두 초기화
            const lightInput = document.getElementById('bg-upload-input-light');
            const darkInput = document.getElementById('bg-upload-input-dark');
            if (lightInput) lightInput.value = '';
            if (darkInput) darkInput.value = '';
        };

        window.applyCroppedBackground = async function() {
            if (!bgCropImg) return;
            const statusEl = document.getElementById('settings-bg-status');
            if (statusEl) statusEl.textContent = '저장 중...';
            try {
                // 미리보기 canvas를 그대로 저장하지 않고, 지금 보이는 영역만큼만 원본 이미지에서
                // 다시 잘라내 별도의 출력 해상도로 그린다 (미리보기가 축소돼 있어도 화질이 유지된다).
                const OUTPUT_W = 1600;
                const OUTPUT_H = Math.round(OUTPUT_W * (bgCropFrameH / bgCropFrameW));
                const srcX = -bgCropOffsetX / bgCropScale;
                const srcY = -bgCropOffsetY / bgCropScale;
                const srcW = bgCropFrameW / bgCropScale;
                const srcH = bgCropFrameH / bgCropScale;
                const outCanvas = document.createElement('canvas');
                outCanvas.width = OUTPUT_W;
                outCanvas.height = OUTPUT_H;
                const outCtx = outCanvas.getContext('2d');
                outCtx.drawImage(bgCropImg, srcX, srcY, srcW, srcH, 0, 0, OUTPUT_W, OUTPUT_H);
                const blob = await new Promise(resolve => outCanvas.toBlob(resolve, 'image/jpeg', 0.9));
                await saveBgBlobToIndexedDB(blob, bgCropTarget);
                try { localStorage.setItem(BG_PRESET_KEY, 'custom'); } catch (e) {}
                await applyActiveBackground();
                if (window.updateBgSettingsUI) window.updateBgSettingsUI();
                if (statusEl) statusEl.textContent = '배경화면이 적용되었습니다. (이 브라우저에만 저장돼요)';
                window.closeBgCropModal();
            } catch (e) {
                console.error('배경화면 저장 오류:', e);
                if (statusEl) statusEl.textContent = '저장에 실패했습니다.';
            }
        };

        (function setupBgCropInteractions() {
            const frame = document.getElementById('bg-crop-frame');
            const zoomSlider = document.getElementById('bg-crop-zoom');
            if (!frame || !zoomSlider) return;

            frame.addEventListener('pointerdown', (e) => {
                if (!bgCropImg) return;
                bgCropDragging = true;
                frame.classList.add('grabbing');
                frame.setPointerCapture(e.pointerId);
                bgCropDragStart = { x: e.clientX, y: e.clientY, offsetX: bgCropOffsetX, offsetY: bgCropOffsetY };
            });
            frame.addEventListener('pointermove', (e) => {
                if (!bgCropDragging || !bgCropImg) return;
                const dpr = window.devicePixelRatio || 1;
                bgCropOffsetX = bgCropDragStart.offsetX + (e.clientX - bgCropDragStart.x) * dpr;
                bgCropOffsetY = bgCropDragStart.offsetY + (e.clientY - bgCropDragStart.y) * dpr;
                clampBgCropOffset();
                drawBgCropPreview();
            });
            const endDrag = () => { bgCropDragging = false; frame.classList.remove('grabbing'); };
            frame.addEventListener('pointerup', endDrag);
            frame.addEventListener('pointercancel', endDrag);

            zoomSlider.addEventListener('input', () => {
                if (!bgCropImg) return;
                const t = Number(zoomSlider.value) / 100; // 0~1
                const prevScale = bgCropScale;
                bgCropScale = bgCropMinScale * (1 + t * 2); // 최대 minScale의 3배까지 확대
                // 확대/축소 중심이 프레임 한가운데가 되도록 오프셋을 같이 보정한다.
                const cx = bgCropFrameW / 2, cy = bgCropFrameH / 2;
                bgCropOffsetX = cx - (cx - bgCropOffsetX) * (bgCropScale / prevScale);
                bgCropOffsetY = cy - (cy - bgCropOffsetY) * (bgCropScale / prevScale);
                clampBgCropOffset();
                drawBgCropPreview();
            });
        })();

        window.handleCustomBackgroundUpload = function(event, target) {
            const file = event.target.files[0];
            if (!file) return;
            window.openBgCropModal(file, target);
        };

        window.resetCustomBackground = async function() {
            try {
                await Promise.all([deleteBgBlobFromIndexedDB('light'), deleteBgBlobFromIndexedDB('dark'), deleteBgBlobFromIndexedDB('current')]);
                try { localStorage.setItem(BG_PRESET_KEY, 'default2'); } catch (e) {}
                await applyActiveBackground();
                if (window.updateBgSettingsUI) window.updateBgSettingsUI();
                const statusEl = document.getElementById('settings-bg-status');
                if (statusEl) statusEl.textContent = '기본 배경으로 되돌렸습니다.';
            } catch (e) { console.error('배경화면 초기화 오류:', e); }
        };

        // 배경화면 프리셋(기본1/기본2/직접 올리기) 선택
        window.setActiveBackgroundPreset = async function(preset) {
            try { localStorage.setItem(BG_PRESET_KEY, preset); } catch (e) {}
            await applyActiveBackground();
            if (window.updateBgSettingsUI) window.updateBgSettingsUI();
        };

        // "직접 올리기" + 다크용 사진을 따로 안 넣었을 때만 쓰이는, 공용 사진의 다크 모드 어둡게 정도
        window.setBackgroundDarkDim = async function(value) {
            try { localStorage.setItem(BG_DARK_DIM_KEY, String(value)); } catch (e) {}
            await applyActiveBackground();
        };

        // 설정 모달의 배경화면 섹션을 현재 저장된 상태(프리셋 선택/다크 어둡게 슬라이더)에 맞게 다시 그린다.
        window.updateBgSettingsUI = async function() {
            const preset = getActiveBackgroundPreset();
            document.querySelectorAll('.bg-preset-option').forEach(btn => {
                btn.style.borderColor = (btn.getAttribute('data-preset') === preset) ? 'var(--primary)' : 'var(--border-color)';
            });
            const panel = document.getElementById('bg-custom-upload-panel');
            if (panel) panel.style.display = (preset === 'custom') ? 'block' : 'none';
            if (preset !== 'custom') return;
            try {
                const [lightBlob, darkBlob] = await Promise.all([getBgBlobFromIndexedDB('light'), getBgBlobFromIndexedDB('dark')]);
                const dimRow = document.getElementById('bg-dark-dim-row');
                if (dimRow) dimRow.style.display = (lightBlob && !darkBlob) ? 'block' : 'none';
                const slider = document.getElementById('bg-dark-dim-slider');
                if (slider) slider.value = getBackgroundDarkDim();
            } catch (e) {}
        };

        window.setAccentColor = async function(color) {
            if (!currentUser) return showLoginScreen(() => setAccentColor(color));
            try {
                await update(ref(db, `users/${currentUser.uid}`), { accentColor: color });
                currentUserInfo = { ...currentUserInfo, accentColor: color };
                applyUserCustomization(currentUserInfo);
                renderAccentColorSwatches();
            } catch (e) { console.error('강조색 저장 오류:', e); }
        };

        function renderAccentColorSwatches() {
            const wrap = document.getElementById('settings-accent-swatches');
            if (!wrap) return;
            const current = currentUserInfo && currentUserInfo.accentColor ? currentUserInfo.accentColor : null;
            wrap.innerHTML = ACCENT_PRESETS.map(p => {
                const isActive = p.color === current;
                const bg = p.color || '#2f6fed';
                return `<span onclick="setAccentColor(${p.color ? `'${p.color}'` : 'null'})" title="${p.name}" style="width:28px; height:28px; border-radius:50%; background:${bg}; cursor:pointer; display:inline-block; border:${isActive ? '3px solid var(--text-main)' : '2px solid var(--border-color)'}; box-sizing:border-box;"></span>`;
            }).join('');
        }
        // ⚠️ 이 파일에는 <script type="module"> 블록이 2개 있고(설정 모달을 여는 코드는 두 번째 블록에
        // 있음), ES 모듈은 서로 스코프를 공유하지 않는다. window에 명시적으로 노출해야 다른 모듈
        // 블록에서도 호출할 수 있다 (안 하면 조용히 아무 일도 안 일어나는 버그가 됨).
        window.renderAccentColorSwatches = renderAccentColorSwatches;

        function todayKey() {
            const d = new Date();
            return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
        }

        let currentPopupNoticeId = null;
        let popupNoticeIndex = 0;
        const popupDismissedIds = new Set(); // 이번 세션에서 "닫기"로 닫은 공지 id들 (새로고침 전까지 다시 안 뜸)

        window.cycleNoticePopup = function(e, delta) {
            if (e) e.stopPropagation();
            const eligible = getPopupEligibleNotices().filter(n => !popupDismissedIds.has(n.id));
            if (eligible.length === 0) return;
            popupNoticeIndex = (popupNoticeIndex + delta + eligible.length) % eligible.length;
            renderNoticePopup();
        }

        function renderNoticePopup() {
            const popup = document.getElementById('gmw-notice-popup');
            if (!popup) return;

            // 오늘 하루 보지 않기로 숨긴 것과 중요 공지 강제표시 규칙을 적용해 실제 후보를 추린다.
            let eligible = getPopupEligibleNotices().filter(n => {
                const confirmed = isNoticeConfirmedByMe(n.id);
                const hiddenToday = localStorage.getItem(`notice_hidden_${n.id}`) === todayKey();
                const forceKeepShowing = n.important && !confirmed;
                if (popupDismissedIds.has(n.id)) return false; // 이번 세션에 닫은 것은 완전히 제외
                if (!forceKeepShowing && hiddenToday) return false;
                return true;
            });

            // 5.0: 알림 벨은 팝업 위젯이 하나라도 떠 있는 동안엔 숨겨두고, 위젯을 전부 닫아야(=eligible 0) 나타난다.
            const bell = document.getElementById('gmw-notif-bell');
            if (bell) bell.style.display = eligible.length === 0 ? 'flex' : 'none';

            if (eligible.length === 0) { popup.classList.remove('visible'); currentPopupNoticeId = null; return; }
            if (popupNoticeIndex >= eligible.length) popupNoticeIndex = 0;

            const current = eligible[popupNoticeIndex];
            const confirmed = isNoticeConfirmedByMe(current.id);

            currentPopupNoticeId = current.id;
            document.getElementById('gmw-notice-popup-label').textContent = noticeCategoryLabel(current.category) + ' 공지';
            document.getElementById('gmw-notice-popup-title').textContent = current.title || '';
            // 팝업은 작은 카드라서 본문 전체(제목/사진/긴 목록)를 그리지 않고, 태그를 걷어낸 텍스트 요약만 보여준다(CSS 가 6줄에서 "…"로 자름).
            // 전체 내용은 팝업을 누르면 열리는 공지 상세에서 본다.
            document.getElementById('gmw-notice-popup-content').textContent = richContentPreviewText(current, 'contentHTML', 'content', 360);
            document.getElementById('gmw-notice-popup-important-bar').style.display = current.important ? 'block' : 'none';

            const navEl = document.getElementById('gmw-notice-popup-nav');
            if (eligible.length > 1) {
                navEl.style.display = 'flex';
                document.getElementById('gmw-notice-popup-nav-label').textContent = `${popupNoticeIndex + 1}/${eligible.length}`;
            } else {
                navEl.style.display = 'none';
            }

            const confirmBtn = document.getElementById('gmw-notice-popup-confirm-btn');
            confirmBtn.textContent = confirmed ? '✓ 확인 완료' : '확인했습니다 ✓';
            confirmBtn.classList.toggle('confirmed', confirmed);

            // "확인했습니다"를 누르기 전에는 "오늘 하루 보지 않기" / "닫기" 로 회피할 수 없도록
            // 확인 전에는 숨기고, 확인 후에만 노출한다.
            const footerRow = document.querySelector('#gmw-notice-popup .gmw-notice-popup-footer-row');
            if (footerRow) footerRow.style.display = confirmed ? 'flex' : 'none';

            const closeXBtn = document.getElementById('gmw-notice-popup-close-btn');
            if (closeXBtn) closeXBtn.style.display = confirmed ? '' : 'none';

            popup.classList.add('visible');
            adjustNoticePopupPosition();
        }

        // 우하단에 이미 떠 있는 Focus/MixTape inline 위젯과 겹치지 않도록 위치를 보정한다.
        function adjustNoticePopupPosition() {
            const popup = document.getElementById('gmw-notice-popup');
            const inlineContainer = document.querySelector('.gmw-inline-container');
            if (!popup) return;
            let offset = 20;
            if (inlineContainer) {
                const visibleCards = Array.from(inlineContainer.children).filter(el => getComputedStyle(el).display !== 'none');
                if (visibleCards.length) {
                    const rect = inlineContainer.getBoundingClientRect();
                    offset = Math.max(20, (window.innerHeight - rect.top) + 12);
                }
            }
            popup.style.bottom = offset + 'px';
        }
        window.addEventListener('resize', adjustNoticePopupPosition);
        setInterval(adjustNoticePopupPosition, 1500);

        window.openNoticeDetailFromPopup = function() {
            if (currentPopupNoticeId) showNoticeDetail(currentPopupNoticeId);
        }

        window.closeNoticePopup = function(e) {
            if (e) e.stopPropagation();
            if (currentPopupNoticeId) popupDismissedIds.add(currentPopupNoticeId);
            renderNoticePopup();
        }

        window.hideNoticeToday = function(e) {
            if (e) e.stopPropagation();
            if (currentPopupNoticeId) {
                localStorage.setItem(`notice_hidden_${currentPopupNoticeId}`, todayKey());
            }
            renderNoticePopup();
        }

        // ----- 실시간 리스너 -----
        function listenToNotices() {
            onSnapshot(collection(fdb, 'notices'), (snapshot) => {
                noticesCache = fsSnapshotToMap(snapshot);
                renderNoticeHub();
                renderNoticePopup();
                renderNotificationBell();
                tryConsumePendingShareTarget();
            }, onReadDenied('공지'));
            // notice_reads는 flat 컬렉션(문서ID "{noticeId}_{uid}")이라, 기존 코드가 기대하는
            // { noticeId: { uid: timestamp } } 모양으로 다시 묶어준다.
            onSnapshot(collection(fdb, 'notice_reads'), (snapshot) => {
                const nested = {};
                snapshot.forEach(d => {
                    const data = d.data();
                    if (!data || !data.noticeId || !data.uid) return;
                    if (!nested[data.noticeId]) nested[data.noticeId] = {};
                    nested[data.noticeId][data.uid] = data.readAt;
                });
                noticeReadsCache = nested;
                renderNoticeHub();
                renderNoticePopup();
                renderNotificationBell();
            });
        }

        // --- 5.0 전역 알림 벨: noticesCache/noticeReadsCache를 그대로 재사용해서 렌더링만 한다 ---
        window.toggleNotifPanel = function() {
            const panel = document.getElementById('gmw-notif-panel');
            if (!panel) return;
            panel.classList.toggle('visible');
            if (panel.classList.contains('visible')) renderNotificationBell();
        };

        const NOTIF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 알림센터에 보이는 공지의 최대 나이(한 달)
        function renderNotificationBell() {
            const badge = document.getElementById('gmw-notif-badge');
            const listEl = document.getElementById('gmw-notif-list');
            if (!listEl) return;
            // 알림센터에는 "아직 확인하지 않은 공지"만, 그리고 올라온 지 한 달(30일) 안의 것만 보인다.
            // 공지를 확인(확인했습니다)하면 목록에서 사라지고, 확인하지 않아도 한 달이 지나면 사라진다. (전체 공지는 공지/설문 페이지에서 계속 볼 수 있다)
            const cutoff = Date.now() - NOTIF_MAX_AGE_MS;
            const entries = Object.entries(noticesCache)
                .filter(([id, n]) => (n.createdAt || 0) >= cutoff && !isNoticeConfirmedByMe(id))
                .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0)).slice(0, 8);
            if (badge) badge.style.display = entries.length > 0 ? 'block' : 'none';
            if (entries.length === 0) {
                listEl.innerHTML = `<div class="gmw-notif-empty">새 알림이 없습니다.</div>`;
                return;
            }
            listEl.innerHTML = entries.map(([id, n]) => {
                const unread = true;
                return `
                    <div class="gmw-notif-item ${unread ? 'unread' : ''}" onclick="openNoticeFromBell('${id}')">
                        <span class="gmw-notif-item-title">${unread ? '🔴 ' : ''}${escapeNoticeText(n.title || '')}</span>
                        <span class="gmw-notif-item-meta">${noticeCategoryLabel(n.category)} · ${formatPostTime(n.createdAt)}</span>
                    </div>
                `;
            }).join('');
        }

        window.openNoticeFromBell = function(id) {
            const panel = document.getElementById('gmw-notif-panel');
            if (panel) panel.classList.remove('visible');
            switchTab('notice');
            showNoticeDetail(id);
        };

        // 벨/패널 바깥을 클릭하면 패널을 닫는다
        document.addEventListener('click', (e) => {
            const bell = document.getElementById('gmw-notif-bell');
            const panel = document.getElementById('gmw-notif-panel');
            if (!bell || !panel) return;
            if (!bell.contains(e.target) && !panel.contains(e.target)) panel.classList.remove('visible');
        });

        // =========================================================================
        // 주간 학습 리포트 (기존 플래너 기록만 사용 - PlannerApp.getWeeklyReport)
        // =========================================================================
        let weeklyReportOffset = 0;

        function fmtHM(sec) {
            sec = Math.max(0, Math.round(sec || 0));
            const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
            if (h > 0) return `${h}시간 ${m}분`;
            return `${m}분`;
        }

        function renderWeeklyReportSummary() {
            const el = document.getElementById('weekly-report-summary');
            if (!el || !window.PlannerApp || !window.PlannerApp.getWeeklyReport) return;
            const r = window.PlannerApp.getWeeklyReport(0);
            const achieveText = r.totalTargetSec > 0 ? `${Math.round((r.totalSec / r.totalTargetSec) * 100)}%` : '목표 미설정';
            let vsText = '지난주 기록 없음';
            if (r.prevTotalSec > 0) {
                const diff = Math.round(((r.totalSec - r.prevTotalSec) / r.prevTotalSec) * 100);
                vsText = (diff >= 0 ? '+' : '') + diff + '%';
            }
            const top = r.subjectBreakdown[0];
            el.innerHTML = `
                <div class="widget-text" style="display:grid; grid-template-columns:1fr 1fr; gap:8px 4px;">
                    <div>총 공부시간<br><strong style="color:var(--text-main); font-size:15px;">${fmtHM(r.totalSec)}</strong></div>
                    <div>목표 달성률<br><strong style="color:var(--text-main); font-size:15px;">${achieveText}</strong></div>
                    <div>전주 대비<br><strong style="color:var(--text-main); font-size:15px;">${vsText}</strong></div>
                    <div>최다 과목<br><strong style="color:var(--text-main); font-size:15px;">${top ? `${top.name} ${fmtHM(top.seconds)}` : '기록 없음'}</strong></div>
                </div>
                <div style="margin-top:10px; font-size:12px; color:var(--primary); font-weight:600;">상세 보기 →</div>
            `;
        }

        window.openWeeklyReportModal = function() {
            weeklyReportOffset = 0;
            document.getElementById('weekly-report-modal').style.display = 'flex';
            renderWeeklyReportDetail();
        }

        window.changeWeeklyReportWeek = function(delta) {
            if (weeklyReportOffset + delta > 0) return; // 미래 주는 이동 불가
            weeklyReportOffset += delta;
            renderWeeklyReportDetail();
        }

        function renderWeeklyReportDetail() {
            if (!window.PlannerApp || !window.PlannerApp.getWeeklyReport) return;
            const r = window.PlannerApp.getWeeklyReport(weeklyReportOffset);
            document.getElementById('weekly-report-range').textContent = `${r.mondayStr.slice(5).replace('-', '.')} ~ ${r.sundayStr.slice(5).replace('-', '.')}`;
            document.getElementById('weekly-report-next-btn').disabled = weeklyReportOffset >= 0;
            document.getElementById('weekly-report-next-btn').style.opacity = weeklyReportOffset >= 0 ? 0.4 : 1;

            const achieveText = r.totalTargetSec > 0 ? `${Math.round((r.totalSec / r.totalTargetSec) * 100)}%` : '목표 미설정';
            let vsText = '지난주 기록 없음';
            if (r.prevTotalSec > 0) {
                const diff = Math.round(((r.totalSec - r.prevTotalSec) / r.prevTotalSec) * 100);
                vsText = (diff >= 0 ? '+' : '') + diff + '%';
            }

            const maxDaySec = Math.max(1, ...r.days.map(d => d.seconds));
            const dayBars = r.days.map(d => `
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                    <div style="width:18px; font-size:12px; font-weight:700; color:${r.bestDay && r.bestDay.dateStr === d.dateStr ? 'var(--primary)' : 'var(--text-muted)'};">${d.label}</div>
                    <div style="flex:1; background:var(--surface-tertiary); border-radius:6px; height:10px; overflow:hidden;">
                        <div style="width:${(d.seconds / maxDaySec) * 100}%; height:100%; background:${r.bestDay && r.bestDay.dateStr === d.dateStr ? 'var(--primary)' : 'var(--border-strong)'};"></div>
                    </div>
                    <div style="width:64px; font-size:11px; color:var(--text-muted); text-align:right;">${d.seconds > 0 ? fmtHM(d.seconds) : '-'}</div>
                </div>
            `).join('');

            const totalForPct = r.subjectBreakdown.reduce((s, x) => s + x.seconds, 0) || 1;
            const medals = ['🥇', '🥈', '🥉'];
            const subjectBars = r.subjectBreakdown.slice(0, 5).map((s, i) => `
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                    <div style="width:20px; font-size:13px;">${medals[i] || '•'}</div>
                    <div style="width:56px; font-size:12px; font-weight:600; color:var(--text-main);">${escapeNoticeText(s.name)}</div>
                    <div style="flex:1; background:var(--surface-tertiary); border-radius:6px; height:10px; overflow:hidden;">
                        <div style="width:${Math.round((s.seconds / totalForPct) * 100)}%; height:100%; background:${s.color || 'var(--primary)'};"></div>
                    </div>
                    <div style="width:80px; font-size:11px; color:var(--text-muted); text-align:right;">${fmtHM(s.seconds)} (${Math.round((s.seconds/totalForPct)*100)}%)</div>
                </div>
            `).join('') || `<div class="widget-text">이번 주 학습 기록이 없습니다.</div>`;

            document.getElementById('weekly-report-detail').innerHTML = `
                <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:20px;">
                    <div class="card" style="padding:14px; text-align:center;">
                        <div style="font-size:11px; color:var(--text-muted); margin-bottom:4px;">총 공부시간</div>
                        <div style="font-size:16px; font-weight:800; color:var(--text-main);">${fmtHM(r.totalSec)}</div>
                    </div>
                    <div class="card" style="padding:14px; text-align:center;">
                        <div style="font-size:11px; color:var(--text-muted); margin-bottom:4px;">목표 달성률</div>
                        <div style="font-size:16px; font-weight:800; color:var(--text-main);">${achieveText}</div>
                    </div>
                    <div class="card" style="padding:14px; text-align:center;">
                        <div style="font-size:11px; color:var(--text-muted); margin-bottom:4px;">전주 대비</div>
                        <div style="font-size:16px; font-weight:800; color:var(--text-main);">${vsText}</div>
                    </div>
                </div>
                ${r.bestDay ? `<div style="margin-bottom:18px; font-size:13px; color:var(--text-main); font-weight:600;">🔥 가장 많이 공부한 날 · ${r.bestDay.label}요일 ${fmtHM(r.bestDay.seconds)}</div>` : ''}
                <div style="font-size:13px; font-weight:700; color:var(--text-main); margin-bottom:10px;">요일별 학습</div>
                <div style="margin-bottom:20px;">${dayBars}</div>
                <div style="font-size:13px; font-weight:700; color:var(--text-main); margin-bottom:10px;">과목별 학습</div>
                <div>${subjectBars}</div>
            `;
        }

        // =========================================================================
        // 반 공동 투표/설문 (담임선생님 · 반장 · 부반장 · 커뮤니티 엔지니어만 작성/관리)
        // =========================================================================
        let pollsCache = {};
        let pollVotesCache = {}; // { pollId: { uid: {optionIds:[...], votedAt} } }
        let pollOptionFieldCount = 0;

        function updatePollComposerVisibility() {
            const wrap = document.getElementById('btn-write-poll-wrap');
            if (wrap) wrap.style.display = canPostNotice ? 'inline-block' : 'none';
        }

        window.openPollComposer = function() {
            if (!canPostNotice) return;
            if (typeof window.switchTab === 'function') window.switchTab('notice');
            document.getElementById('poll-form-title').value = '';
            document.getElementById('poll-form-desc').innerHTML = '';
            document.getElementById('poll-form-multiple').checked = false;
            document.getElementById('poll-form-expires').value = '';
            const optWrap = document.getElementById('poll-form-options');
            optWrap.innerHTML = '';
            pollOptionFieldCount = 0;
            addPollOptionField(); addPollOptionField();
            // 모달이 아니라 커뮤니티 글쓰기와 동일한 "페이지 전환" 방식
            document.getElementById('notice-hub-feed-view').style.display = 'none';
            const detailEl = document.getElementById('notice-hub-detail-view');
            if (detailEl) detailEl.style.display = 'none';
            document.getElementById('notice-hub-write-view').style.display = 'none';
            document.getElementById('poll-hub-write-view').style.display = 'block';
        }

        window.closePollComposer = function() {
            document.getElementById('poll-hub-write-view').style.display = 'none';
            document.getElementById('notice-hub-feed-view').style.display = 'block';
        }

        window.addPollOptionField = function() {
            const optWrap = document.getElementById('poll-form-options');
            if (optWrap.children.length >= 10) return;
            pollOptionFieldCount++;
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; gap:6px; align-items:center;';
            row.innerHTML = `<input type="text" class="auth-input poll-option-input" placeholder="선택지 ${optWrap.children.length + 1}" style="margin-bottom:0; flex:1;">
                <span onclick="this.parentElement.remove();" style="cursor:pointer; color:var(--text-muted); font-size:16px; padding:0 4px;">✕</span>`;
            optWrap.appendChild(row);
        }

        window.submitPollForm = async function() {
            if (!canPostNotice || !currentUser) return alert('설문 작성 권한이 없습니다.');
            if (isRichEditorUploadingImage('poll-form-desc')) return alert('이미지를 업로드하는 중이에요. 잠시 후 다시 눌러주세요.');
            const title = document.getElementById('poll-form-title').value.trim();
            const descEditable = document.getElementById('poll-form-desc');
            const descriptionHTML = sanitizeRichHTML(descEditable.innerHTML.trim());
            const description = (descEditable.textContent || '').trim(); // 검색/기존 코드 호환용 일반 텍스트
            const allowMultiple = document.getElementById('poll-form-multiple').checked;
            const expiresRaw = document.getElementById('poll-form-expires').value;
            const optionInputs = Array.from(document.querySelectorAll('#poll-form-options .poll-option-input'));
            const optionTexts = optionInputs.map(i => i.value.trim()).filter(Boolean);

            if (!title) return alert('제목을 입력해주세요.');
            if (optionTexts.length < 2) return alert('선택지를 최소 2개 이상 입력해주세요.');

            const options = {};
            optionTexts.forEach((text, i) => { options['opt_' + i] = { text }; });

            try {
                await addDoc(collection(fdb, 'polls'), {
                    title, description, descriptionHTML, options, allowMultiple,
                    createdAt: Date.now(),
                    expiresAt: expiresRaw ? new Date(expiresRaw).getTime() : null,
                    authorName: getAuthorName(),
                    authorUid: currentUser.uid,
                    authorOriginal: currentUser.email || '',
                    active: true
                });
                closePollComposer();
            } catch (e) { alert('설문 등록에 실패했습니다. (권한 또는 네트워크 오류)'); }
        }

        window.closePollConfirm = async function(pollId) {
            if (!canPostNotice) return;
            if (!confirm('이 설문을 마감하시겠습니까? 이후에는 투표할 수 없고 결과만 보입니다.')) return;
            try { await updateDoc(doc(fdb, 'polls', pollId), { active: false }); } catch (e) {}
        }

        window.deletePollConfirm = async function(pollId) {
            if (!canPostNotice) return;
            if (!confirm('이 설문을 삭제하시겠습니까?')) return;
            try {
                await deleteDoc(doc(fdb, 'polls', pollId));
                // poll_votes는 flat 컬렉션(문서ID "{pollId}_{uid}")이라 pollId로 쿼리해서 관련 투표를 전부 지운다.
                const votesSnap = await getDocs(query(collection(fdb, 'poll_votes'), where('pollId', '==', pollId)));
                await Promise.all(votesSnap.docs.map(d => deleteDoc(d.ref)));
            } catch (e) {}
        }

        function getActivePoll() {
            const entries = Object.entries(pollsCache).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
            return entries.length ? { id: entries[0][0], ...entries[0][1] } : null;
        }

        function isPollExpired(poll) { return !!(poll.expiresAt && Date.now() > poll.expiresAt); }
        function isPollOpen(poll) { return poll.active !== false && !isPollExpired(poll); }

        window.togglePollOption = function(pollId, optId, allowMultiple) {
            const wrap = document.getElementById('poll-vote-options');
            if (!wrap) return;
            if (!allowMultiple) {
                wrap.querySelectorAll('.poll-vote-opt').forEach(el => el.classList.remove('selected'));
            }
            const el = wrap.querySelector(`[data-opt="${optId}"]`);
            if (el) el.classList.toggle('selected');
        }

        window.submitPollVote = async function(pollId) {
            if (!currentUser) return showLoginScreen(() => submitPollVote(pollId));
            const poll = pollsCache[pollId];
            if (!poll || !isPollOpen(poll)) return;
            const selected = Array.from(document.querySelectorAll('#poll-vote-options .poll-vote-opt.selected')).map(el => el.getAttribute('data-opt'));
            if (selected.length === 0) return alert('선택지를 하나 이상 골라주세요.');
            try {
                // poll_votes flat 컬렉션: 문서ID "{pollId}_{uid}"로 pollId/uid 관계를 그대로 보존한다.
                await setDoc(doc(fdb, 'poll_votes', `${pollId}_${currentUser.uid}`), { pollId, uid: currentUser.uid, optionIds: selected, votedAt: Date.now() });
            } catch (e) { alert('투표에 실패했습니다. (이미 투표했거나 네트워크 오류)'); }
        }

        function renderPollWidget() {
            const el = document.getElementById('poll-widget');
            if (!el) return;
            const poll = getActivePoll();
            if (!poll) { el.innerHTML = `<div class="widget-text">진행 중인 설문이 없습니다.</div>`; return; }

            const votes = pollVotesCache[poll.id] || {};
            const myVote = currentUser ? votes[currentUser.uid] : null;
            const open = isPollOpen(poll);
            const optionEntries = Object.entries(poll.options || {});
            const totalVoters = Object.keys(votes).length;

            if (myVote || !open) {
                // 결과 보기
                const counts = {};
                optionEntries.forEach(([id]) => counts[id] = 0);
                Object.values(votes).forEach(v => (v.optionIds || []).forEach(id => { counts[id] = (counts[id] || 0) + 1; }));
                const resultRows = optionEntries.map(([id, opt]) => {
                    const c = counts[id] || 0;
                    const pct = totalVoters > 0 ? Math.round((c / totalVoters) * 100) : 0;
                    return `<div style="margin-bottom:6px;">
                        <div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-main); margin-bottom:2px;"><span>${escapeNoticeText(opt.text)}</span><span>${pct}% · ${c}표</span></div>
                        <div style="background:var(--surface-tertiary); border-radius:5px; height:8px; overflow:hidden;"><div style="width:${pct}%; height:100%; background:var(--primary);"></div></div>
                    </div>`;
                }).join('');
                el.innerHTML = `
                    <div style="font-size:13px; font-weight:700; color:var(--text-main); margin-bottom:8px;">${escapeNoticeText(poll.title)}</div>
                    ${resultRows}
                    <div style="font-size:11px; color:var(--text-muted); margin-top:6px;">${!open ? '마감됨' : '투표 완료'} · 총 ${totalVoters}명 참여</div>
                    ${canPostNotice ? `<div style="margin-top:8px; display:flex; gap:8px;">${open ? `<span onclick="closePollConfirm('${poll.id}')" style="font-size:11px; color:var(--text-muted); cursor:pointer;">마감</span>` : ''}<span onclick="deletePollConfirm('${poll.id}')" style="font-size:11px; color:#ef4444; cursor:pointer;">삭제</span></div>` : ''}
                `;
            } else {
                // 투표 UI
                const optionRows = optionEntries.map(([id, opt]) => `
                    <div class="poll-vote-opt" data-opt="${id}" onclick="togglePollOption('${poll.id}','${id}',${!!poll.allowMultiple})"
                        style="padding:8px 10px; border:1px solid var(--border-color); border-radius:8px; font-size:12.5px; color:var(--text-main); cursor:pointer; margin-bottom:6px;">
                        ${escapeNoticeText(opt.text)}
                    </div>
                `).join('');
                el.innerHTML = `
                    <div style="font-size:13px; font-weight:700; color:var(--text-main); margin-bottom:4px;">${escapeNoticeText(poll.title)}</div>
                    ${poll.description || poll.descriptionHTML ? `<div style="font-size:11.5px; color:var(--text-muted); margin-bottom:8px;">${escapeNoticeText(richContentPreviewText(poll, 'descriptionHTML', 'description', 60))}</div>` : ''}
                    <div id="poll-vote-options">${optionRows}</div>
                    <button class="auth-btn" style="width:100%; margin-top:6px; padding:8px; font-size:12px;" onclick="submitPollVote('${poll.id}')">투표하기</button>
                `;
                // 선택 스타일용 클래스 토글 CSS (한 번만 주입)
                if (!document.getElementById('poll-vote-style')) {
                    const style = document.createElement('style');
                    style.id = 'poll-vote-style';
                    style.textContent = `.poll-vote-opt.selected{ border-color:var(--primary) !important; background:var(--primary-soft); font-weight:700; }`;
                    document.head.appendChild(style);
                }
            }
        }

        function listenToPolls() {
            onSnapshot(collection(fdb, 'polls'), (snapshot) => {
                pollsCache = fsSnapshotToMap(snapshot);
                renderPollWidget();
                renderNoticeHub();
                if (currentOpenPollDetailId && pollsCache[currentOpenPollDetailId]) renderPollDetailBody(currentOpenPollDetailId);
            }, onReadDenied('설문'));
            // poll_votes는 flat 컬렉션(문서ID "{pollId}_{uid}")이라, 기존 코드가 기대하는
            // { pollId: { uid: {optionIds, votedAt} } } 모양으로 다시 묶어준다.
            onSnapshot(collection(fdb, 'poll_votes'), (snapshot) => {
                const nested = {};
                snapshot.forEach(d => {
                    const data = d.data();
                    if (!data || !data.pollId || !data.uid) return;
                    if (!nested[data.pollId]) nested[data.pollId] = {};
                    nested[data.pollId][data.uid] = { optionIds: data.optionIds, votedAt: data.votedAt };
                });
                pollVotesCache = nested;
                renderPollWidget();
                renderNoticeHub();
                if (currentOpenPollDetailId) renderPollDetailBody(currentOpenPollDetailId);
            });
        }

        // =========================================================================
        // 반 설문 - 공지사항 내부 [반 설문] 카테고리 (문서6 §8-2/9)
        // 홈의 "진행 중인 설문 1개" 미니 위젯은 그대로 두고, 공지/설문 통합 페이지(renderNoticeHub)에서
        // 전체 설문 목록 + 상세/투표를 제공한다. 새로운 설문 저장 구조를 만들지 않고
        // Firestore polls, poll_votes 컬렉션을 그대로 사용한다.
        // =========================================================================
        let currentOpenPollDetailId = null;

        function pollStatusLabel(poll) {
            if (isPollOpen(poll)) return '🟢 진행중';
            return isPollExpired(poll) ? '⏰ 마감(기한 종료)' : '🔒 마감';
        }
        function formatPollDeadline(poll) {
            if (!poll.expiresAt) return '마감일 없음';
            const d = new Date(poll.expiresAt);
            return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} 마감`;
        }

        // 홈 위젯(#poll-vote-options)과 별개의 컨테이너를 사용하는 범용 투표 UI 핸들러 (설문 목록의 어떤 설문이든 상세 모달에서 투표 가능)
        window.togglePollOptionIn = function(containerId, pollId, optId, allowMultiple) {
            const wrap = document.getElementById(containerId);
            if (!wrap) return;
            if (!allowMultiple) wrap.querySelectorAll('.poll-vote-opt').forEach(el => el.classList.remove('selected'));
            const el = wrap.querySelector(`[data-opt="${optId}"]`);
            if (el) el.classList.toggle('selected');
        }
        window.submitPollVoteIn = async function(containerId, pollId) {
            if (!currentUser) return showLoginScreen(() => submitPollVoteIn(containerId, pollId));
            const poll = pollsCache[pollId];
            if (!poll || !isPollOpen(poll)) return;
            const selected = Array.from(document.querySelectorAll(`#${containerId} .poll-vote-opt.selected`)).map(el => el.getAttribute('data-opt'));
            if (selected.length === 0) return alert('선택지를 하나 이상 골라주세요.');
            try {
                await setDoc(doc(fdb, 'poll_votes', `${pollId}_${currentUser.uid}`), { pollId, uid: currentUser.uid, optionIds: selected, votedAt: Date.now() });
                if (window.completeDailyMission) window.completeDailyMission('poll', 20, '설문 참여하기');
            } catch (e) { alert('투표에 실패했습니다. (이미 투표했거나 네트워크 오류)'); }
        }

        window.openPollDetailModal = function(id) {
            const poll = pollsCache[id];
            if (!poll) return;
            currentOpenPollDetailId = id;
            document.getElementById('poll-detail-title').textContent = poll.title || '';
            document.getElementById('poll-detail-meta').textContent = `${resolveDisplayName(poll.authorName, poll.authorOriginal) || '관리자'} · ${formatPostTime(poll.createdAt)} · ${formatPollDeadline(poll)}`;
            const descEl = document.getElementById('poll-detail-desc');
            const hasDesc = (poll.description && poll.description.trim()) || (poll.descriptionHTML && poll.descriptionHTML.trim());
            descEl.innerHTML = hasDesc ? renderRichOrPlain(poll, 'descriptionHTML', 'description') : '';
            descEl.style.display = hasDesc ? 'block' : 'none';
            renderPollDetailBody(id);
            document.getElementById('poll-detail-modal').style.display = 'flex';
        }
        window.closePollDetailModal = function() {
            currentOpenPollDetailId = null;
            document.getElementById('poll-detail-modal').style.display = 'none';
        }

        function renderPollDetailBody(pollId) {
            const poll = pollsCache[pollId];
            const bodyEl = document.getElementById('poll-detail-body');
            if (!poll || !bodyEl) return;
            const votes = pollVotesCache[pollId] || {};
            const myVote = currentUser ? votes[currentUser.uid] : null;
            const open = isPollOpen(poll);
            const optionEntries = Object.entries(poll.options || {});
            const totalVoters = Object.keys(votes).length;

            if (myVote || !open) {
                const counts = {};
                optionEntries.forEach(([oid]) => counts[oid] = 0);
                Object.values(votes).forEach(v => (v.optionIds || []).forEach(oid => { counts[oid] = (counts[oid] || 0) + 1; }));
                bodyEl.innerHTML = optionEntries.map(([oid, opt]) => {
                    const c = counts[oid] || 0;
                    const pct = totalVoters > 0 ? Math.round((c / totalVoters) * 100) : 0;
                    return `<div style="margin-bottom:8px;">
                        <div style="display:flex; justify-content:space-between; font-size:13px; color:var(--text-main); margin-bottom:3px;"><span>${escapeNoticeText(opt.text)}</span><span>${pct}% · ${c}표</span></div>
                        <div style="background:var(--surface-tertiary); border-radius:6px; height:9px; overflow:hidden;"><div style="width:${pct}%; height:100%; background:var(--primary);"></div></div>
                    </div>`;
                }).join('') + `<div style="font-size:11.5px; color:var(--text-muted); margin-top:8px;">${!open ? '마감됨' : '투표 완료'} · 총 ${totalVoters}명 참여 (투표자 명단은 공개하지 않습니다)</div>`;
            } else {
                if (!document.getElementById('poll-vote-style')) {
                    const style = document.createElement('style');
                    style.id = 'poll-vote-style';
                    style.textContent = `.poll-vote-opt.selected{ border-color:var(--primary) !important; background:var(--primary-soft); font-weight:700; }`;
                    document.head.appendChild(style);
                }
                const optionRows = optionEntries.map(([oid, opt]) => `
                    <div class="poll-vote-opt" data-opt="${oid}" onclick="togglePollOptionIn('poll-detail-vote-options','${pollId}','${oid}',${!!poll.allowMultiple})"
                        style="padding:9px 12px; border:1px solid var(--border-color); border-radius:8px; font-size:13px; color:var(--text-main); cursor:pointer; margin-bottom:6px;">
                        ${escapeNoticeText(opt.text)}
                    </div>
                `).join('');
                bodyEl.innerHTML = `
                    <div id="poll-detail-vote-options">${optionRows}</div>
                    <button class="auth-btn" style="width:100%; margin-top:8px; padding:10px; font-size:13px;" onclick="submitPollVoteIn('poll-detail-vote-options','${pollId}')">투표하기</button>
                `;
            }
        }

        // =========================================================================
        // 현재 학교 시간 (기존 시간표 데이터 + 교시/자습 시간표를 연결)
        // 평일: 1~8교시 + 저녁시간 + 1~3부 자습 / 주말: 오전·오후 자습 + 저녁시간 + 1~3부 자습
        // =========================================================================
        const WEEKDAY_BLOCKS = [
            { type: 'class', period: 1, start: '08:40', end: '09:30' },
            { type: 'break', label: '쉬는시간', start: '09:30', end: '09:40' },
            { type: 'class', period: 2, start: '09:40', end: '10:30' },
            { type: 'break', label: '쉬는시간', start: '10:30', end: '10:40' },
            { type: 'class', period: 3, start: '10:40', end: '11:30' },
            { type: 'break', label: '쉬는시간', start: '11:30', end: '11:40' },
            { type: 'class', period: 4, start: '11:40', end: '12:30' },
            { type: 'break', label: '점심시간', start: '12:30', end: '13:40' },
            { type: 'class', period: 5, start: '13:40', end: '14:30' },
            { type: 'break', label: '쉬는시간', start: '14:30', end: '14:40' },
            { type: 'class', period: 6, start: '14:40', end: '15:30' },
            { type: 'break', label: '쉬는시간', start: '15:30', end: '15:40' },
            { type: 'class', period: 7, start: '15:40', end: '16:30' },
            { type: 'break', label: '쉬는시간', start: '16:30', end: '16:40' },
            { type: 'class', period: 8, start: '16:40', end: '17:30' },
            { type: 'break', label: '저녁시간', start: '17:30', end: '19:00' },
            { type: 'study', label: '1부 자습', start: '19:00', end: '21:00' },
            { type: 'break', label: '쉬는시간', start: '21:00', end: '21:30' },
            { type: 'study', label: '2부 자습', start: '21:30', end: '22:40' },
            { type: 'break', label: '쉬는시간', start: '22:40', end: '22:50' },
            { type: 'study', label: '3부 자습', start: '22:50', end: '24:00' }
        ];

        const WEEKEND_BLOCKS = [
            { type: 'study', label: '오전 자습', start: '08:00', end: '12:30' },
            { type: 'break', label: '점심시간', start: '12:30', end: '14:00' },
            { type: 'study', label: '오후 자습', start: '14:00', end: '17:30' },
            { type: 'break', label: '저녁시간', start: '17:30', end: '19:00' },
            { type: 'study', label: '1부 자습', start: '19:00', end: '21:00' },
            { type: 'break', label: '쉬는시간', start: '21:00', end: '21:30' },
            { type: 'study', label: '2부 자습', start: '21:30', end: '22:40' },
            { type: 'break', label: '쉬는시간', start: '22:40', end: '22:50' },
            { type: 'study', label: '3부 자습', start: '22:50', end: '24:00' }
        ];

        function timeStrToMin(str) { const [h, m] = str.split(':').map(Number); return h * 60 + m; }

        function getPeriodSubject(period, dayIndex) {
            try {
                const key = `${period}_${dayIndex}`;
                // 「지금 학교는」도 실제 시간표 화면과 동일하게 개인 시간표 수정값을 최우선으로 반영한다.
                // 저장된 주차가 이번 주와 다르면(예: 주가 바뀌었는데 아직 초기화 전) 개인 수정값은 무시하고
                // 공용/기본 시간표로 정상 fallback한다 - renderTimetableTable()의 주차 처리와 동일한 기준이다.
                let personalVal = null;
                try {
                    const myData = JSON.parse(localStorage.getItem('my_timetable'));
                    if (myData && myData.edits && myData.week === getIsoWeekNum()) personalVal = myData.edits[key];
                } catch (e) {}
                const raw = personalVal || (typeof sharedTimetableOverrides !== 'undefined' && sharedTimetableOverrides[key]) || (defaultTimetable[period] && defaultTimetable[period][dayIndex]);
                if (!raw) return null;
                const [subject, teacher] = raw.split('^');
                if (!subject || subject === '-') return null;
                return { subject, teacher };
            } catch (e) { return null; }
        }

        // block(교시/자습/쉬는시간) 하나를 "지금" 문구로, "다음" 문구로 각각 변환
        function blockCurrentLabel(block, dayIndex) {
            if (block.type === 'class') {
                const info = getPeriodSubject(block.period, dayIndex);
                return `${block.period}교시 · ${info ? escapeNoticeText(info.subject) : '수업'}`;
            }
            return block.label;
        }
        function blockNextLabel(block, dayIndex) {
            if (block.type === 'class') {
                const info = getPeriodSubject(block.period, dayIndex);
                return `${block.period}교시 · ${info ? escapeNoticeText(info.subject) : '-'} (${block.start} 시작)`;
            }
            return `${block.label} (${block.start} 시작)`;
        }

        function renderCurrentPeriodWidget() {
            const el = document.getElementById('current-period-widget');
            if (!el) return;
            const now = new Date();
            const hh = String(now.getHours()).padStart(2, '0');
            const mm = String(now.getMinutes()).padStart(2, '0');
            const nowMin = now.getHours() * 60 + now.getMinutes();
            const dow = now.getDay(); // 0=일 ... 6=토
            const isWeekend = (dow === 0 || dow === 6);
            const dayIndex = dow - 1; // 0=월 ... 4=금 (defaultTimetable 기준, 평일에만 사용)
            const blocks = isWeekend ? WEEKEND_BLOCKS : WEEKDAY_BLOCKS;

            let current = null, next = null;
            for (const b of blocks) {
                const s = timeStrToMin(b.start), en = timeStrToMin(b.end);
                if (nowMin >= s && nowMin < en) current = { ...b, s, en };
                else if (nowMin < s && !next) next = b;
            }

            let html = `<div class="widget-text"><strong style="font-size:20px; color:var(--text-main);">${hh}:${mm}</strong><br>`;
            if (current) {
                const pct = Math.min(100, Math.max(0, Math.round(((nowMin - current.s) / (current.en - current.s)) * 100)));
                html += `${blockCurrentLabel(current, dayIndex)}<br>
                    <div style="background:var(--surface-tertiary); border-radius:6px; height:8px; margin:6px 0; overflow:hidden;"><div style="width:${pct}%; height:100%; background:var(--primary);"></div></div>
                    <span style="font-size:11px; color:var(--text-muted);">${pct}%</span>`;
                if (next) {
                    html += `<br><span style="font-size:11px; color:var(--text-muted);">다음 · ${blockNextLabel(next, dayIndex)}</span>`;
                }
            } else if (next) {
                html += `다음 일정<br>${blockNextLabel(next, dayIndex)}`;
            } else {
                html += `오늘 일정 종료`;
            }
            html += `</div>`;

            // 예전엔 '지필평가' 태그가 붙은 일정으로 고정돼 있었는데, 이제는 사용자가 직접 고른
            // 일정들의 D-day를 보여준다 (개인별 설정, hanilgo_schoolnow_dday_ids). 삭제된 일정의
            // id가 남아있어도 scheduleCache에서 조회가 안 되면 자동으로 걸러진다.
            const selectedDdayEvents = schoolNowDdayIds
                .map(id => scheduleCache[id] ? { id, ...scheduleCache[id] } : null)
                .filter(Boolean)
                .sort((a, b) => a.date.localeCompare(b.date));
            html += `<div style="margin-top:8px; padding-top:8px; border-top:1px solid var(--border-color); font-size:12px;">`;
            if (selectedDdayEvents.length > 0) {
                html += selectedDdayEvents.map(ev =>
                    `<div style="margin-bottom:3px;"><strong style="color:#ef4444;">📌 ${escapeNoticeText(ev.title)} ${scheduleDDayLabel(ev.date)}</strong></div>`
                ).join('');
            } else {
                html += `<span style="color:var(--text-muted);">표시할 일정이 없습니다.</span>`;
            }
            html += `<span onclick="openSchoolNowDdayPicker()" style="color:var(--primary); cursor:pointer; font-weight:600; font-size:11px;">✏️ 일정 선택</span>`;
            html += `</div>`;

            el.innerHTML = html;
        }
        setInterval(renderCurrentPeriodWidget, 30000);

        // "지금 우리 학교는" 위젯에 D-day로 표시할 일정 id 목록 - 나만 보이는 개인 설정이라
        // Firebase가 아니라 이 브라우저의 localStorage에만 저장한다.
        let schoolNowDdayIds = [];
        try { schoolNowDdayIds = JSON.parse(localStorage.getItem('hanilgo_schoolnow_dday_ids') || '[]'); } catch (e) { schoolNowDdayIds = []; }

        window.openSchoolNowDdayPicker = function() {
            const modal = document.getElementById('school-now-dday-modal');
            const listEl = document.getElementById('school-now-dday-picker-list');
            if (!modal || !listEl) return;
            const todayKey = getScheduleDateKey(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
            const upcoming = Object.entries(scheduleCache)
                .filter(([, ev]) => ev && ev.date && (ev.endDate || ev.date) >= todayKey)
                .sort((a, b) => a[1].date.localeCompare(b[1].date));
            listEl.innerHTML = upcoming.length === 0
                ? `<div class="widget-text">표시할 수 있는 예정된 일정이 없습니다.</div>`
                : upcoming.map(([id, ev]) => `
                    <label style="display:flex; align-items:center; gap:8px; padding:8px 0; border-bottom:1px solid var(--border-color); cursor:pointer;">
                        <input type="checkbox" class="school-now-dday-check" value="${id}" ${schoolNowDdayIds.includes(id) ? 'checked' : ''}>
                        <span style="flex:1; font-size:13px; color:var(--text-main);">${escapeNoticeText(ev.title)}</span>
                        <span style="font-size:11px; color:var(--text-muted);">${ev.date}</span>
                    </label>
                `).join('');
            modal.style.display = 'flex';
        };
        window.closeSchoolNowDdayPicker = function() {
            document.getElementById('school-now-dday-modal').style.display = 'none';
        };
        window.saveSchoolNowDdaySelection = function() {
            const checked = Array.from(document.querySelectorAll('.school-now-dday-check:checked')).map(el => el.value);
            schoolNowDdayIds = checked;
            try { localStorage.setItem('hanilgo_schoolnow_dday_ids', JSON.stringify(checked)); } catch (e) {}
            closeSchoolNowDdayPicker();
            renderCurrentPeriodWidget();
        };

        // =========================================================================
        // 일일 미션 - 완료 상태는 계정별로 Firebase Realtime Database에 저장한다.
        //   users/{uid}/dailyMissions/{YYYY-MM-DD}/{missionKey} = true
        // 미션 XP는 기존 플래너 XP 시스템(PlannerApp.addXP → Firebase users/{uid}/xp)에 그대로 합산된다.
        // 미션 완료는 Firebase runTransaction으로 "아직 완료되지 않은 상태 → true"로 바뀌는 요청만
        // 성공하도록 만들어서, 여러 기기/중복 클릭에서도 XP가 중복 지급되지 않게 한다.
        // =========================================================================
        const DAILY_MISSIONS = [
            { key: 'attendance', label: '출석체크', xp: 10, icon: '✅' },
            { key: 'communityPost', label: '커뮤니티 게시글', xp: 30, icon: '💬' },
            { key: 'planner', label: '플래너 공부 시작', xp: 50, icon: '📖' },
            { key: 'mixtape', label: 'MixTape 재생', xp: 20, icon: '📼' },
            { key: 'likePost', label: '좋아요 누르기', xp: 10, icon: '❤️' },
            { key: 'commentPost', label: '댓글 달기', xp: 15, icon: '💬' },
            { key: 'poll', label: '설문 참여하기', xp: 20, icon: '📊' },
            { key: 'archiveView', label: '자료실 이용하기', xp: 10, icon: '📚' }
        ];

        // 1-2 담임선생님 계정은 "커뮤니티 게시글" + "좋아요 누르기" + "댓글 달기" 미션을 아예 표시/집계하지 않는다 (학생 8개 / 담임 5개).
        function getActiveDailyMissions() {
            return typeof isTeacherAccount !== 'undefined' && isTeacherAccount
                ? DAILY_MISSIONS.filter(m => !['communityPost', 'likePost', 'commentPost'].includes(m.key))
                : DAILY_MISSIONS;
        }

        // 브라우저 로컬 시간 기준 YYYY-MM-DD (Firebase 경로 키로 사용하기 위해 항상 0-padding한다)
        function missionTodayKey() {
            const d = new Date();
            const pad = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        }

        // 계정의 dailyMissions 전체를 구독한다(날짜별로 다시 구독할 필요 없이 하나의 리스너로 계속 커버된다).
        // 오늘 미션 위젯뿐 아니라, 연속 출석일수 같은 활동 업적 계산도 이 캐시를 그대로 재사용한다(데이터 중복 저장 없음).
        function subscribeDailyMissions() {
            if (!currentUser || unsubscribeDailyMissions) return;
            unsubscribeDailyMissions = onValue(ref(db, `users/${currentUser.uid}/dailyMissions`), (snap) => {
                dailyMissionsAllCache = snap.val() || {};
                dailyMissionsLoaded = true;
                syncOwnStreakMirror();
                renderDailyMissionsWidget();
                evaluateAndSyncAchievements();
            }, (err) => { console.warn('일일 미션 동기화 오류:', err); });
        }

        function loadMissionState() {
            const key = missionTodayKey();
            return { key, state: dailyMissionsAllCache[key] || {} };
        }

        function showMissionToast(text) {
            let toast = document.getElementById('mission-toast');
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'mission-toast';
                toast.style.cssText = 'position:fixed; top:20px; left:50%; transform:translateX(-50%) translateY(-16px); background:var(--card-bg); color:var(--text-main); border:1px solid var(--border-color); padding:12px 22px; border-radius:12px; font-size:13px; font-weight:700; box-shadow:0 10px 24px rgba(0,0,0,0.18); z-index:99999; opacity:0; transition:opacity .25s ease, transform .25s ease; pointer-events:none;';
                document.body.appendChild(toast);
            }
            toast.textContent = text;
            requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(-50%) translateY(0)'; });
            clearTimeout(toast._hideTimer);
            toast._hideTimer = setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(-50%) translateY(-16px)'; }, 2600);
        }

        // 어디서든(플래너/믹스테이프 등 다른 모듈 스코프 포함) 호출할 수 있도록 window에 노출한다.
        // 같은 미션은 하루에 한 번만 보상되도록 Firebase 트랜잭션으로 중복 지급을 막는다:
        // "완료 안 됨 → true"로 실제로 바뀐(committed) 요청만 XP를 지급하므로, 두 기기에서
        // 거의 동시에 같은 미션을 완료해도 딱 한 번만 XP가 들어간다.
        window.completeDailyMission = async function(missionKey, xp, label) {
            if (!currentUser) return;
            const todayKey = missionTodayKey();
            if (dailyMissionsAllCache[todayKey] && dailyMissionsAllCache[todayKey][missionKey]) return; // 로컬에 이미 완료로 알고 있으면 요청조차 보내지 않는다
            try {
                const result = await runTransaction(ref(db, `users/${currentUser.uid}/dailyMissions/${todayKey}/${missionKey}`), (curr) => {
                    if (curr === true) return; // 이미 완료됨 - 값 변경 없이 트랜잭션 중단
                    return true;
                });
                if (!result.committed || result.snapshot.val() !== true) return; // 다른 요청이 먼저 완료 처리함 - 중복 지급 방지
            } catch (e) {
                showMissionToast('⚠️ 미션 저장 중 오류가 발생했습니다.');
                return;
            }
            if (window.PlannerApp && window.PlannerApp.addXP) window.PlannerApp.addXP(xp);
            showMissionToast(`✅ ${label} 완료! +${xp} XP`);
            // 실시간 구독으로도 곧 반영되지만, 화면을 즉시 갱신하기 위해 낙관적으로 캐시도 갱신한다.
            if (!dailyMissionsAllCache[todayKey]) dailyMissionsAllCache[todayKey] = {};
            dailyMissionsAllCache[todayKey][missionKey] = true;
            renderDailyMissionsWidget();
            evaluateAndSyncAchievements();
            if (getActiveDailyMissions().every(m => dailyMissionsAllCache[todayKey][m.key])) {
                setTimeout(() => showMissionToast('🎉 오늘의 미션 올클리어!'), 900);
            }
        }

        window.checkInMission = function() {
            window.completeDailyMission('attendance', 10, '출석체크');
        }

        function renderDailyMissionsWidget() {
            const el = document.getElementById('daily-missions-widget');
            if (!el) return;
            const { state } = loadMissionState();
            const missions = getActiveDailyMissions();
            const doneCount = missions.filter(m => state[m.key]).length;
            const rows = missions.map(m => {
                const done = !!state[m.key];
                if (m.key === 'attendance' && !done) {
                    return `<div style="display:flex; justify-content:space-between; align-items:center; padding:4px 0; font-size:12.5px;">
                        <span style="color:var(--text-main);">⬜ ${m.icon} ${m.label}</span>
                        <button class="btn-sub" style="font-size:10px; padding:3px 9px;" onclick="checkInMission()">체크 +${m.xp}</button>
                    </div>`;
                }
                return `<div style="display:flex; justify-content:space-between; padding:4px 0; font-size:12.5px; ${done ? 'opacity:0.55;' : ''}">
                    <span style="color:var(--text-main);">${done ? '✅' : '⬜'} ${m.icon} ${m.label}</span>
                    <span style="color:var(--text-muted);">+${m.xp} XP</span>
                </div>`;
            }).join('');
            const pct = Math.round((doneCount / missions.length) * 100);
            el.innerHTML = `
                <div style="font-size:11px; color:var(--text-muted); text-align:right; margin-bottom:4px;">${doneCount} / ${missions.length}</div>
                ${rows}
                <div style="background:var(--surface-tertiary); border-radius:6px; height:7px; margin-top:8px; overflow:hidden;">
                    <div style="width:${pct}%; height:100%; background:var(--primary);"></div>
                </div>
            `;
        }

        // =========================================================================
        // 활동 기반 업적(Achievement) 시스템
        // - 레벨과는 완전히 별개로, 실제 활동 기록에 따라 cosmetic이 "해금"된다.
        // - 해금되어도 자동으로 적용되지 않는다 - 프로필 꾸미기에서 사용자가 직접 장착/해제해야 보인다.
        // - 새로운 XP 시스템이 아니다: 진행도는 이미 있는 데이터를 그대로 집계해서 계산한다.
        //     · 출석 연속일수  → users/{uid}/dailyMissions (attendance 필드) - Firebase 기준, 기기 무관하게 정확
        //     · 게시글(활동왕) → posts + archive 중 내가 쓴 글 가운데 좋아요 2개 이상 받은 글 수 (authorId 기준) - Firebase 기준, 기기 무관하게 정확
        //     · 공부시간/할일연속/올클리어 → PlannerApp의 로컬 기록(state.records 등) - 이 브라우저 기준
        //       (플래너 기록 자체가 아직 기기별 로컬 저장이라, 최초 달성 시점의 Firebase 반영은 그 기록이 있는
        //        브라우저에서 로그인했을 때 이루어진다. 한 번 해금되면 "해금 여부"는 계정에 영구 저장되어
        //        다른 기기에서도 선택 가능해진다.)
        // - "해금(unlocked)"은 한번 이루면 계정에 영구 기록된다(스트릭이 끊겨도 선택지에서 사라지지 않음).
        // - "활성(active)"은 스트릭형 업적(streak5)에 한해 지금도 조건을 유지하고 있는지를 뜻하며,
        //   조건이 끊기면 실제 시각 효과만 자동으로 꺼진다(해금 자체가 취소되지는 않는다).
        // =========================================================================
        const ACHIEVEMENTS = [
            { id: 'activity10',  icon: '✒️', label: '활동왕 (좋아요 2개 이상 받은 게시글 10개)',       autoDeactivate: false },
            { id: 'study10h',    icon: '◎', label: '학습가 (누적 공부 10시간)',  autoDeactivate: false },
            { id: 'study20h',    icon: '◎', label: '학습가+ (누적 공부 20시간)', autoDeactivate: false },
            { id: 'streak5',     icon: '⋯', label: '꾸준한 사람 (할일완료 5일 연속)', autoDeactivate: true },
            { id: 'allClear5',   icon: '✓', label: '올클리어 3회',              autoDeactivate: false },
            { id: 'allClear15',  icon: '✓', label: '올클리어 5회',              autoDeactivate: false },
            { id: 'allClear30',  icon: '✓', label: '올클리어 9회',     autoDeactivate: false }
        ];

        function dateKeyFor(d) {
            const pad = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        }

        // dailyMissionsAllCache(이미 구독 중인 캐시)를 그대로 재사용해 연속 출석일수를 계산한다.
        // 오늘 아직 출석 전이면 어제부터 거슬러 올라간다(출석 전이라고 스트릭이 0으로 뚝 떨어져 보이지 않도록).
        function computeAttendanceStreakInfo() {
            let days = 0, lastDate = null;
            const d = new Date();
            const todayKey = dateKeyFor(d);
            if (!(dailyMissionsAllCache[todayKey] && dailyMissionsAllCache[todayKey].attendance)) {
                d.setDate(d.getDate() - 1);
            }
            while (true) {
                const key = dateKeyFor(d);
                if (dailyMissionsAllCache[key] && dailyMissionsAllCache[key].attendance) { if (!lastDate) lastDate = key; days++; d.setDate(d.getDate() - 1); }
                else break;
            }
            return { days, lastDate };
        }
        function computeAttendanceStreak() { return computeAttendanceStreakInfo().days; }

        // ---- 연속 출석 Streak Effect용 데이터 ----
        // 내 화면은 위 실시간 계산을, 다른 사람 화면은 그 사람이 자기 프로필 문서(profiles/student_N.streak)에 남겨둔 거울 값을 쓴다
        // (다른 사람의 users/{uid}/dailyMissions는 읽지 않는다 - XP 거울과 같은 방식). 거울은 { days, lastDate }이고,
        // lastDate(그 연속의 마지막 출석일)가 어제보다 이전이면 이미 끊긴 것이라 보는 쪽에서 곧바로 0으로 본다 -
        // 그 사람이 앱을 다시 열지 않아도 끊김이 즉시 반영된다.
        function streakDaysFromMirror(mirror) {
            if (!mirror || typeof mirror.days !== 'number' || typeof mirror.lastDate !== 'string') return 0;
            const y = new Date(); y.setDate(y.getDate() - 1);
            return mirror.lastDate >= dateKeyFor(y) ? Math.max(0, mirror.days) : 0;
        }
        function syncOwnStreakMirror() {
            if (!dailyMissionsLoaded) return;
            const num = getMyStudentNum();
            if (!num) return;
            const info = computeAttendanceStreakInfo();
            const cur = (profilesData[`student_${num}`] || {}).streak;
            const want = info.days > 0 ? { days: info.days, lastDate: info.lastDate } : { days: 0, lastDate: null };
            if (!cur && want.days === 0) return; // 지울 것도 쓸 것도 없음
            if (cur && cur.days === want.days && cur.lastDate === want.lastDate) return;
            writeOwnProfileDoc(num, { streak: want });
        }

        // 활동왕 조건: "좋아요를 2개 이상 받은 내 게시글"이 10개 이상. (이미 구독 중인 posts/archive 캐시를 재사용한다 - 새로 읽지 않음)
        // 좋아요 수는 목록/상세에 보이는 숫자(likeCount)를 그대로 쓰고, 옛 글처럼 likeCount가 없으면 likes 맵의 개수로 센다.
        // 한번 해금된 업적은 이후 좋아요가 취소돼도 영구히 유지된다(evaluateAndSyncAchievements는 해금만 기록한다).
        const ACTIVITY_MIN_LIKES = 2;
        const ACTIVITY_POST_TARGET = 10;
        function postLikeCountOf(item) {
            if (!item) return 0;
            if (typeof item.likeCount === 'number') return item.likeCount;
            return item.likes ? Object.keys(item.likes).length : 0;
        }
        function computeMyActivityCount() {
            if (!currentUser) return 0;
            const isLikedEnough = item => item && item.authorId === currentUser.uid && postLikeCountOf(item) >= ACTIVITY_MIN_LIKES;
            const postsCount = Object.values(latestPostsData || {}).filter(isLikedEnough).length;
            const archiveCount = Object.values(latestArchiveData || {}).filter(isLikedEnough).length;
            return postsCount + archiveCount;
        }

        // 지금 이 순간의 실측값을 기준으로 각 업적의 "현재 조건 충족 여부"를 계산한다.
        function computeLiveAchievementStatus() {
            const activityCount = computeMyActivityCount();
            const studySeconds = (window.PlannerApp && window.PlannerApp.getTotalStudySeconds) ? window.PlannerApp.getTotalStudySeconds() : 0;
            const taskStreak = (window.PlannerApp && window.PlannerApp.getTaskCompletionStreakDays) ? window.PlannerApp.getTaskCompletionStreakDays() : 0;
            const allClearCount = (window.PlannerApp && window.PlannerApp.getAllClearCount) ? window.PlannerApp.getAllClearCount() : 0;
            return {
                activity10: activityCount >= ACTIVITY_POST_TARGET,
                study10h: studySeconds >= 10 * 3600,
                study20h: studySeconds >= 20 * 3600,
                streak5: taskStreak >= 5,
                allClear5: allClearCount >= 3,   // id는 저장된 해금 기록과의 호환을 위해 그대로 두고 기준 횟수만 3/5/9회로 낮췄다(낮추기만 하므로 기존 해금은 모두 유지)
                allClear15: allClearCount >= 5,
                allClear30: allClearCount >= 9
            };
        }

        // 계정에 영구 해금된 업적인지 (스트릭이 끊겼어도 true로 유지된다)
        function isAchievementUnlocked(id) { return !!myAchievementsUnlocked[id]; }

        // 지금 이 순간 실제로 "활성"인지 (시각 효과를 보여줄지 여부). 본인 화면에서만 정확하며,
        // 다른 사용자를 볼 때는 buildAppearanceVisuals()에 activeChecker를 넘기지 않아 이 함수 자체를 타지 않는다.
        function isMyAchievementActive(id) {
            const def = ACHIEVEMENTS.find(a => a.id === id);
            if (!def || !isAchievementUnlocked(id)) return false;
            if (!def.autoDeactivate) return true;
            const live = computeLiveAchievementStatus();
            return !!live[id];
        }

        // 이 브라우저에서 계산 가능한 최신 활동 기록을 바탕으로, 새로 조건을 충족한 업적을 Firebase에 1회 기록한다.
        function evaluateAndSyncAchievements() {
            if (!currentUser) return;
            const live = computeLiveAchievementStatus();
            const newlyUnlocked = {};
            ACHIEVEMENTS.forEach(a => {
                if (live[a.id] && !myAchievementsUnlocked[a.id]) newlyUnlocked[a.id] = true;
            });
            const ids = Object.keys(newlyUnlocked);
            if (ids.length === 0) return;
            Object.assign(myAchievementsUnlocked, newlyUnlocked); // 낙관적 갱신
            update(ref(db, `users/${currentUser.uid}/achievements`), newlyUnlocked).catch(() => {});
            ids.forEach(id => {
                const def = ACHIEVEMENTS.find(a => a.id === id);
                if (def) showMissionToast(`🏆 업적 달성: ${def.icon} ${def.label}`);
            });
            updateSidebarXP(); // 배지/효과가 바뀔 수 있으므로 사이드바 등 다시 그림
        }

        function subscribeAchievements() {
            if (!currentUser || unsubscribeAchievements) return;
            unsubscribeAchievements = onValue(ref(db, `users/${currentUser.uid}/achievements`), (snap) => {
                myAchievementsUnlocked = snap.val() || {};
                evaluateAndSyncAchievements();
                if (typeof renderDecorateModal === 'function' && document.getElementById('decorate-modal') && document.getElementById('decorate-modal').style.display === 'flex') {
                    renderDecorateModal();
                }
            }, (err) => { console.warn('업적 동기화 오류:', err); });
        }

        // 새로운 XP/레벨 저장 구조를 만들지 않는다. 레벨은 순수 cosmetic이며 어떤 권한도 부여하지 않는다.
        // =========================================================================
        let lastKnownLevelNum = null;

        function parseTierLevel(tierName) {
            const m = /Lv\.(\d+)/.exec(tierName || '');
            return m ? parseInt(m[1]) : 1;
        }
        function parseTierTitle(tierName) {
            return (tierName || '').replace(/^Lv\.\d+\s*/, '') || '새내기';
        }

        // 레인보우/홀로그램 계열 cosmetic 전체에서 공유하는 색 팔레트. 여러 곳에서 각자 다른 배열을
        // 새로 만들지 않도록 하나로 통일한다 (그라데이션 테두리, 별/크리스탈 장식, 오빗 점 색상 분배 등에 재사용).
        const RAINBOW_PALETTE = ['#f87171', '#fbbf24', '#34d399', '#38bdf8', '#a855f7'];

        // 카테고리별 해금 카탈로그.
        // - "레벨 해금" 항목(unlockLevel)은 항상 해금 레벨 오름차순으로 먼저 나열한다(화면에는 항상 레벨순으로 정렬해서 보여준다).
        // - 해금 레벨 설계: Lv.1에는 "시작 선택지"(starter:true)만 연다(프레임 모양 2, 프레임 색 2, 이름 효과 3, Glow 2) -
        //   처음 가입해도 자기 스타일을 고를 수 있게. 일반 효과는 Lv.20 안에서 대부분 열리고(Lv.21~30은 경험치 곡선만 계속 올라간다),
        //   희소한 효과는 활동 업적(achievementId)으로 따로 해금한다.
        // - "활동 업적 해금" 항목(achievementId)은 그 뒤에 나열한다. 레벨처럼 자동 적용되지 않고,
        //   사용자가 프로필 꾸미기에서 직접 선택해야만 적용된다(해금되어도 자동 장착되지 않음).
        // - 배지 카테고리는 삭제되어 모든 카테고리가 단일 선택이다.
        // 레벨/칭호는 순수 cosmetic이며 어떤 기능 권한도 부여하지 않는다.
        const MULTI_SELECT_CATEGORIES = []; // 배지 카테고리를 없앴으므로 현재는 다중 선택 카테고리가 없다(함수는 그대로 둔다)
        function isMultiSelectCategory(cat) { return MULTI_SELECT_CATEGORIES.includes(cat); }

        // 프레임 장식(별/크리스탈/과목 문양 등)의 각도 배치를 만드는 공용 헬퍼.
        // 12/3/6/9시처럼 균등한 4방향이 필요하면 fourPointDecorations(), 과목 프레임처럼
        // N개를 원형으로 고르게 분배하려면 evenDecorations()를 쓴다 - 값 자체(각도 배열)를
        // 여러 곳에 하드코딩하지 않기 위해 하나로 통일했다.
        function fourPointDecorations(icon) {
            return [0, 90, 180, 270].map(angle => ({ icon, angle }));
        }
        function evenDecorations(icons) {
            const n = icons.length;
            return icons.map((icon, i) => ({ icon, angle: -90 + (360 / n) * i }));
        }
        // 과목별 프레임 전용 - 프로필 사진의 3시~6시(0°~90°) 구간에만 문자를 고르게 배치한다.
        // textDeco:true → 렌더링 시 bold + 얇은 검정 외곽선을 적용한다. jitter:true(기본) → 문자마다 아주 살짝
        // 크기/회전을 다르게 준다(과도하지 않게). Atlas(나침반 방위)처럼 흔들림 없이 정렬돼야 하는 경우는
        // 이 헬퍼를 쓰지 않고 카탈로그에서 jitter:false를 직접 지정한다.
        function quadrantDecorations(icons) {
            const n = icons.length;
            return icons.map((icon, i) => ({ icon, angle: n > 1 ? (90 / (n - 1)) * i : 45, textDeco: true, jitter: true }));
        }

        const APPEARANCE_CATALOG = {
            // 프레임은 "모양(frameStyle)"과 "색상(frameColor)" 두 축으로 분리되어 서로 자유롭게 조합할 수 있다
            // (예: 점선 링 + 골드, 오빗 링 + 블루). 사진은 항상 원형/선명 그대로 유지되고, 아래 모양들은
            // 전부 사진 "바깥쪽"(테두리 링·장식·글로우)에만 그려진다.
            frameStyle: {
                basic:       { unlockLevel: 1,  label: '기본 링',           shape: 'basic', group: 'basic' },
                dotted:      { starter: true, unlockLevel: 1,  label: '점선 링',           shape: 'dotted', group: 'basic' },
                wave:        { unlockLevel: 5,  label: '물결 링',           shape: 'wave', group: 'decorative' },
                cornerStars: { unlockLevel: 6,  label: '별 링',             shape: 'basic', group: 'decorative', decorations: fourPointDecorations('✦') },
                segmented:   { unlockLevel: 7, label: '세그먼트 링',       shape: 'segmented', group: 'premium' },
                // 다이아몬드 링 + 크리스탈 링을 하나로 통합 - 8개의 보석이 불규칙한 각도로 원을 이뤄 "보석으로 만들어진 프레임" 느낌을 준다.
                // 크리스탈 다이아몬드 링: 정확히 4개, 12/3/6/9시(0/90/180/270°)에만 배치한다 (임의 개수/위치 금지).
                // decoStyle:'crystal'로 표시된 장식은 텍스트 ◇가 아니라 facet/highlight가 있는 작은 CSS 결정체 모양으로 렌더링된다.
                crystalDiamond: { unlockLevel: 8, label: '크리스탈 다이아몬드 링', shape: 'basic', group: 'decorative', decorations: [0, 90, 180, 270].map(angle => ({ angle, decoStyle: 'crystal' })) },
                // 과목별 문자는 프레임 전체를 도배하지 않고 정확히 4개만, 3시~6시(0°~90°) 구간에만 배치한다.
                korean:      { unlockLevel: 3,  label: '한글 문양 프레임',  shape: 'basic', group: 'subject', decorations: quadrantDecorations(['가', '나', '다', '라']) },
                english:     { unlockLevel: 10, label: 'Alphabet Frame',   shape: 'basic', group: 'subject', decorations: quadrantDecorations(['𝖂', '𝖔', '𝖗', '𝖉']) },
                math:        { unlockLevel: 12, label: 'Formula Frame',    shape: 'basic', group: 'subject', decorations: quadrantDecorations(['π', 'Σ', '√', '∞']) },
                // Atlas는 다른 과목과 달리 실제 동서남북 방위와 정확히 대응한다: N=12시(-90°), E=3시(0°), S=6시(90°), W=9시(180°).
                // 나침반처럼 보여야 하므로 다른 과목 문자와 달리 크기/회전 흔들림(jitter)을 주지 않고, 글자 크기도 더 작게(compact) 표시한다.
                social:      { unlockLevel: 14, label: 'Atlas Frame',      shape: 'basic', group: 'subject', decorations: [
                    { icon: 'N', angle: -90, textDeco: true, jitter: false, compact: true },
                    { icon: 'E', angle: 0,   textDeco: true, jitter: false, compact: true },
                    { icon: 'S', angle: 90,  textDeco: true, jitter: false, compact: true },
                    { icon: 'W', angle: 180, textDeco: true, jitter: false, compact: true }
                ] },
                science:     { unlockLevel: 24, label: 'Science Frame',   shape: 'basic', group: 'subject', decorations: quadrantDecorations(['Na', 'Cl', 'H₂', 'CO₂']) },
                neonRing:    { unlockLevel: 7, label: '네온 링',          shape: 'neon', group: 'premium' },
                orbital:     { unlockLevel: 13, label: '오빗 링',          shape: 'orbital', group: 'decorative' }
                // 폐기: 홀로그램, Electric, 이중 링, 프리미엄 다중 링 - 더 이상 카탈로그에 없으므로 이미 이 값을 쓰고 있던 사용자도
                // computeEffectiveAppearance()의 "해금 안 됐거나 존재하지 않는 값 → 안전한 기본값 폴백" 로직에 의해
                // 자동으로 기본 링으로 대체된다 (Firebase 데이터나 다른 cosmetic에는 영향 없음).
            },
            frameColor: {
                basic:   { unlockLevel: 1,  label: '기본',   color: null },
                blue:    { starter: true, unlockLevel: 1,  label: '블루',   color: '#38bdf8' },
                mint:    { unlockLevel: 4,  label: '민트',   color: '#2dd4bf' },
                orange:  { unlockLevel: 4,  label: '오렌지', color: '#fb923c' },
                red:     { unlockLevel: 6,  label: '레드',   color: '#ef4444' },
                pink:    { unlockLevel: 6,  label: '핑크',   color: '#f472b6' },
                purple:  { unlockLevel: 8, label: '퍼플',   color: '#c084fc' },
                silver:  { unlockLevel: 9, label: '실버',   color: '#cbd5e1' },
                gold:    { unlockLevel: 10, label: '골드',   color: '#fbbf24' }
                // 프레임 색상에서 Rainbow는 완전히 삭제되었다. 기존에 frameColor:"rainbow"를 저장해 둔 사용자는
                // computeEffectiveAppearance()의 "카탈로그에 없는 값 → 안전한 기본값 폴백" 로직에 의해 자동으로
                // 기본 색상으로 대체된다(다른 cosmetic/레벨/업적 데이터는 전혀 건드리지 않는다).
                // 이름 효과(Rainbow Text/Rainbow Flow)와 Aura(Rainbow Aura)의 Rainbow는 별개 시스템이므로 그대로 유지한다.
            },
            animation: {
                static:      { unlockLevel: 1,  label: '정적',            anim: '' },
                shimmer:     { unlockLevel: 3, label: 'Shimmer',         anim: 'pf-anim-shimmer' },
                breathing:   { unlockLevel: 13, label: 'Breathing Glow', anim: 'pf-anim-breathing', shadowColor: 'rgba(168,85,247,0.5)' },
                rainbowFlow: { unlockLevel: 14, label: 'Rainbow Flow',   anim: 'pf-anim-rainbow' }
                // 폐기: Electric - 카탈로그에서 제거. 기존에 이 값을 쓰던 사용자는 자동으로 "정적"으로 폴백된다.
            },
            glow: {
                none:   { unlockLevel: 1,  label: '없음',        color: null },
                mint:   { starter: true, unlockLevel: 1,  label: 'Mint Glow',   color: 'rgba(45,212,191,0.35)' },
                sky:    { unlockLevel: 3,  label: 'Sky Glow',    color: 'rgba(56,189,248,0.35)' },
                violet: { unlockLevel: 5, label: 'Violet Glow', color: 'rgba(168,85,247,0.35)' },
                rose:   { unlockLevel: 8, label: 'Rose Glow',   color: 'rgba(244,63,94,0.35)' },
                gold:   { unlockLevel: 12, label: 'Gold Glow',   color: 'rgba(251,191,36,0.4)' }
            },
            aura: {
                none:        { unlockLevel: 1,  label: '없음',           color: null, animated: false },
                softBlue:    { unlockLevel: 9,  label: 'Soft Blue Aura', color: 'rgba(56,189,248,0.3)',  animated: false },
                mintAura:    { unlockLevel: 11, label: 'Mint Aura',      color: 'rgba(45,212,191,0.3)',  animated: false },
                purpleAura:  { unlockLevel: 13, label: 'Purple Aura',   color: 'rgba(168,85,247,0.32)', animated: true },
                goldenAura:  { unlockLevel: 24, label: 'Golden Aura',   color: 'rgba(251,191,36,0.35)', animated: true },
                // Rainbow Aura 버그 수정: 예전에는 단색 rgba(핑크) 하나만 깔려 있어서 사실상 "핑크 오라"와 다를 게 없었다.
                // colors(배열)를 쓰면 여러 색의 box-shadow를 겹쳐서(층마다 반경을 다르게) 진짜 여러 색 광원이 퍼지는 것처럼 보이게 한다.
                rainbowAura: { unlockLevel: 30, label: 'Rainbow Aura',  colors: RAINBOW_PALETTE, animated: true }
            },
            // 이름 효과 설계: 초중반(Lv.1~20)은 "단순 단색 / 네온(Glow·Pulse) / 정지된 그라데이션",
            // 색이 흘러 이동하는 flow 계열(Flow·Sweep·Refraction·Spark·Singularity)은 후반 Lv.21~30의 최상위 레벨 전용 효과다.
            // 활동 업적은 이 이름들을 쓰지 않고 업적 세트(작은 전용 연출)로만 보상한다.
            nameEffect: {
                none:     { unlockLevel: 1,  label: '기본' },
                // --- 단색(글로우 없는 평범한 색 글자) ---
                solidRed:    { unlockLevel: 2,  label: '빨강', color: '#ef4444', solid: true },
                solidYellow: { unlockLevel: 2,  label: '노랑', color: '#eab308', solid: true },
                solidTeal:   { unlockLevel: 5,  label: '청록', color: '#14b8a6', solid: true },
                solidPurple: { unlockLevel: 7,  label: '보라', color: '#8b5cf6', solid: true },
                solidPink:   { unlockLevel: 7,  label: '분홍', color: '#ec4899', solid: true },
                // --- Glow (색 + 은은한 번짐) ---
                blue:     { starter: true, unlockLevel: 1, label: 'Blue Glow',   color: '#38bdf8' },
                green:    { starter: true, unlockLevel: 1, label: 'Green Glow',  color: '#34d399' },
                cyan:     { unlockLevel: 3, label: 'Cyan Glow',   color: '#22d3ee' },
                orange:   { unlockLevel: 3, label: 'Orange Glow', color: '#fb923c' },
                pink:        { unlockLevel: 8, label: 'Pink Glow',   color: '#f472b6' },
                purple:      { unlockLevel: 8, label: 'Purple Glow', color: '#a855f7' },
                gold:        { unlockLevel: 11, label: 'Gold Glow',   color: '#fbbf24' },
                // --- Pulse (Glow가 천천히 숨 쉬듯 밝아졌다 어두워짐). 텍스트 위치/크기는 절대 안 바뀐다 ---
                orangePulse: { unlockLevel: 4, label: 'Orange Pulse', color: '#fb923c', pulse: true },
                greenPulse:  { unlockLevel: 4, label: 'Green Pulse',  color: '#34d399', pulse: true },
                redPulse:    { unlockLevel: 6, label: 'Red Pulse',    color: '#ef4444', pulse: true },
                cyanPulse:   { unlockLevel: 6, label: 'Cyan Pulse',   color: '#22d3ee', pulse: true },
                bluePulse:   { unlockLevel: 9, label: 'Blue Pulse',   color: '#38bdf8', pulse: true },
                purplePulse: { unlockLevel: 9, label: 'Purple Pulse', color: '#a855f7', pulse: true },
                pinkPulse:   { unlockLevel: 11, label: 'Pink Pulse',   color: '#f472b6', pulse: true },
                // --- 정지된 그라데이션 / 한 번씩 밝아지는 Bloom (색이 이동하지는 않는다) ---
                gradient:    { unlockLevel: 10, label: 'Gradient Text', gradient: ['#6366f1', '#a855f7', '#f59e0b'] },
                solarBloom:  { unlockLevel: 14, label: 'Solar Bloom', gradient: ['#fbbf24', '#fff7ed'], bloom: true },
                rainbow:     { unlockLevel: 15, label: 'Rainbow Text',  gradient: RAINBOW_PALETTE },
                // --- 네온(밝은 글자 + 겹겹이 번지는 색 빛. 레벨이 높을수록 더 진한 색) ---
                neonMint:    { unlockLevel: 13, label: '네온 민트',   color: '#2dd4bf', core: '#ecfeff', neon: true },
                neonPink:    { unlockLevel: 16, label: '네온 핑크',   color: '#f472b6', core: '#fdf2f8', neon: true },
                neonViolet:  { unlockLevel: 17, label: '네온 바이올렛', color: '#a78bfa', core: '#f5f3ff', neon: true },
                neonYellow:  { unlockLevel: 18, label: '네온 옐로',   color: '#facc15', core: '#fefce8', neon: true },
                neonRed:     { unlockLevel: 20, label: '네온 레드',   color: '#f87171', core: '#fef2f2', neon: true },
                // --- 색이 흘러 이동하는 flow 계열: 후반 Lv.21~30의 최상위 레벨 전용 효과 (Gold Shimmer/Rainbow Flow만 조금 더 일찍) ---
                goldShimmer:     { unlockLevel: 12, label: 'Gold Shimmer', gradient: ['#fbbf24', '#fef08a', '#fbbf24'], flow: true },
                rainbowFlow:     { unlockLevel: 18, label: 'Rainbow Flow', gradient: RAINBOW_PALETTE, flow: true },
                iceFlow:         { unlockLevel: 21, label: 'Ice Flow', gradient: ['#38bdf8', '#f0f9ff'], flow: true, flowDuration: '6s' },
                prismBase:       { unlockLevel: 22, label: 'Prism Flow (Void→Cyan→White)', gradient: ['#0a0a0a', '#0e7490', '#22d3ee', '#f8fafc'], flow: true, flowDuration: '6s' },
                lunarSweep:      { unlockLevel: 24, label: 'Lunar Prism Sweep', gradient: ['#cbd5e1', '#4338ca', '#312e81'], flow: true, flowDuration: '6s', sweep: true, sweepColor: 'rgba(203,213,225,0.85)' },
                prismSweep:      { unlockLevel: 25, label: 'Prism Sweep', gradient: ['#0a0a0a', '#0e7490', '#22d3ee', '#f8fafc'], flow: true, flowDuration: '6s', sweep: true },
                prismRefraction: { unlockLevel: 27, label: 'Prism Refraction', gradient: ['#0a0a0a', '#0e7490', '#22d3ee', '#f8fafc'], flow: true, flowDuration: '6s', sweep: true, refraction: true },
                prismCrystal:    { unlockLevel: 28, label: 'Crystal Spark', gradient: ['#0a0a0a', '#0e7490', '#22d3ee', '#f8fafc'], flow: true, flowDuration: '6s', sweep: true, sparkle: true },
                singularity:     { unlockLevel: 30, label: 'Singularity', gradient: ['#000000', '#7c3aed', '#22d3ee', '#f8fafc'], flow: true, flowDuration: '7s', sweep: true, refraction: true, sparkle: true, flash: true }
            },
            // 활동 업적 "세트": 레벨 효과(성장하면 자연스럽게 얻는 꾸미기)와 달리, 특정 행동을 했을 때만 얻는 작고 정교한 전용 연출이다.
            // 색만 바꾼 Glow가 아니라 행동을 연상시키는 닉네임 연출(펜선/집중선/이음/완주 표시)이고, 같은 계열 업적은 한 단계씩 완성돼 간다.
            // 연출은 닉네임 주변의 작은 장식(CSS .pf-ach-*)이 핵심이며, 사진 바깥 장식은 최소한만 쓴다(buildAchievementAvatarLayer).
            // ※ 연속 출석은 더 이상 업적 꾸미기가 아니라 장착이 필요 없는 독립 시스템(Streak Effect)이다.
            achievementSet: {
                none:    { unlockLevel: 1, label: '없음', icon: '', desc: '' },
                pen:     { achievementId: 'activity10', label: '펜',              icon: '✒️', desc: '펜이 닉네임 아래에 밑줄을 쭉 긋고 줄 끝에 남아요',                 setIcons: { suffix: '✒️' } },
                focus10: { achievementId: 'study10h',   label: '책 넘김 · 10시간', icon: '◎',  desc: '닉네임 옆 작은 책이 펼쳐지고 페이지가 넘어가요' },
                focus20: { achievementId: 'study20h',   label: '책장 · 20시간', icon: '◎',  desc: '작은 책장에 책이 차례로 꽂혀요' },
                chain:   { achievementId: 'streak5',    label: '이음',            icon: '⋯',  desc: '닉네임 글자마다 위에 작은 점이 차례로 켜져요' },
                finish5: { achievementId: 'allClear5',  label: '완주 · 3회',      icon: '✓',  desc: '완료선이 그어지고 작은 체크가 닉네임 옆에 남아요' },
                finish15:{ achievementId: 'allClear15', label: '완주 · 5회',      icon: '✓',  desc: '체크가 강화되고 작은 빛 조각 2개가 더해져요' },
                finish30:{ achievementId: 'allClear30', label: '완주 · 9회',      icon: '✓',  desc: '가장 선명한 체크와 금빛 빛 조각 5개까지 완성돼요' }
            }
        };
        const APPEARANCE_CATEGORY_LABELS = { frameStyle: '프레임 모양', frameColor: '프레임 색상', animation: '테두리 애니메이션', glow: 'Glow', aura: 'Aura', nameEffect: '이름 효과', achievementSet: '업적 세트' };

        // 이 레벨에서 해금된 "레벨 기반" 항목 중 가장 높은 등급을 반환한다.
        // (활동 업적 항목은 unlockLevel이 없으므로 `level >= undefined` 비교가 항상 false가 되어 자동으로 폴백 후보에서 제외된다 -
        //  즉 활동 업적 cosmetic은 사용자가 명시적으로 선택했을 때만 적용되고, 레벨 폴백값으로는 절대 자동 선택되지 않는다.)
        // - starter:true 항목(Lv.1부터 고를 수 있는 "시작 선택지")은 자동 적용 후보에서 뺀다. 이런 항목은 새로 가입한 사람이
        //   직접 골라서 자기 스타일을 만들 수 있게 열어둔 것이지, 아무것도 안 고른 사람에게 기본으로 씌워지면 안 된다.
        // - 같은 레벨에 여러 개가 해금되면 카탈로그에 먼저 적힌 쪽이 아니라 "해금 레벨이 가장 높은 것"을 고르고,
        //   레벨이 같으면 나중에 적힌 쪽을 고른다.
        function highestUnlockedKey(categoryKey, level) {
            const catalog = APPEARANCE_CATALOG[categoryKey];
            let result = Object.keys(catalog)[0];
            let bestLevel = -Infinity;
            Object.keys(catalog).forEach(k => {
                const opt = catalog[k];
                if (opt.starter || !(level >= opt.unlockLevel)) return;
                if (opt.unlockLevel >= bestLevel) { result = k; bestLevel = opt.unlockLevel; }
            });
            return result;
        }

        // 이 옵션이 지금 "선택 가능"한지: 레벨 기반이면 레벨 충족 여부, 활동 업적 기반이면 (스트릭이 끊겼더라도) 한 번이라도
        // 해금된 적이 있는지로 판단한다 - 즉 스트릭형 업적도 한 번 달성하면 이후 선택 자체는 계속 가능하다(11번 요구사항).
        function isCosmeticOptionUnlocked(cat, key, level, unlockedAchievements) {
            const opt = APPEARANCE_CATALOG[cat] && APPEARANCE_CATALOG[cat][key];
            if (!opt) return false;
            if (opt.achievementId) {
                // unlockedAchievements가 아예 없으면(null/undefined) "검증할 수 없는 화면"이다 - 커뮤니티/아카이브/댓글/친구 프로필처럼
                // 다른 사람의 장착 값을 보여주는 곳은 상대의 업적 목록(users/{uid}/achievements)을 읽지 않으므로, 상대가 장착해 둔 대로
                // 그대로 보여준다(장착 자체는 본인의 프로필 꾸미기에서 해금 여부를 검증한 뒤에만 저장된다).
                // 예전에는 이 경우 항상 "미해금"으로 취급해서 활동 업적 효과(활동왕 등)가 본인 꾸미기 창 밖에서는 전혀 안 보였다.
                if (unlockedAchievements == null) return true;
                return !!unlockedAchievements[opt.achievementId];
            }
            return level >= (opt.unlockLevel || 1);
        }

        // 프로필 꾸미기 UI에서 cosmetic을 보여줄 때 항상 "낮은 해금 레벨 → 높은 해금 레벨" 순으로 표시하기 위한 공용 정렬 함수.
        // 카탈로그 자체의 등록 순서를 바꾸지 않고, 렌더링 직전에만 정렬한다. 같은 레벨끼리는 원래 등록 순서(안정 정렬)를 유지한다.
        function sortCosmeticsByUnlockOrder(keys, catalog) {
            return keys
                .map((key, idx) => ({ key, idx, level: (catalog[key] && catalog[key].unlockLevel) ?? Infinity }))
                .sort((a, b) => (a.level - b.level) || (a.idx - b.idx))
                .map(x => x.key);
        }

        // 활동 업적 기반 cosmetic은 레벨이 없으므로, ACHIEVEMENTS 배열에 이미 정리해 둔 "난이도/달성 단계" 순서를 그대로 따른다.
        function sortAchievementCosmeticsByDifficulty(keys, catalog) {
            const order = ACHIEVEMENTS.map(a => a.id);
            return keys
                .map((key, idx) => {
                    const rank = order.indexOf((catalog[key] && catalog[key].achievementId) || '');
                    return { key, idx, rank: rank < 0 ? 999 : rank };
                })
                .sort((a, b) => (a.rank - b.rank) || (a.idx - b.idx))
                .map(x => x.key);
        }

        // 저장된 장착 값(savedAppearance)이 있으면 그것을 쓰되, 실제로 해금되지 않은 값이면
        // (클라이언트/서버 값이 조작되었거나, 업적을 잃어버린 경우 등) 항상 안전한 기본값으로 대체한다.
        // 예전에는 활동 업적 효과가 Glow/배지/이름 효과/특수 효과 카테고리에 "업적별 색 변형"으로 흩어져 있었다.
        // 지금은 업적마다 하나의 "업적 세트"(achievementSet)로 묶였으므로, 예전 값을 장착해 둔 사람은 그 업적의 세트로 자동 이전해서 보여준다
        // (저장된 데이터를 일괄 수정하지 않고 읽을 때 변환한다 - 다음에 "적용하기"를 누르면 새 형식으로 저장된다).
        const LEGACY_ACHIEVEMENT_PICKS = {
            achActivity10: 'pen', achStudy10h: 'focus10', achStudy20h: 'focus20',
            achStreak5: 'chain', achAllClear5: 'finish5', achAllClear15: 'finish15', achAllClear30: 'finish30'
            // achAttendance3/7(연속 출석 업적 꾸미기)은 독립 시스템(Streak Effect)으로 옮겨졌으므로 이전하지 않는다 - 값은 안전하게 무시된다
        };
        // 세트 키 이름이 바뀐 이전 버전(책갈피/별빛 → 집중선/이음)에서 저장된 값
        const LEGACY_SET_RENAMES = { bookmark10: 'focus10', bookmark20: 'focus20', starlight: 'chain' };
        const ACHIEVEMENT_SET_PRIORITY = ['finish30', 'finish15', 'finish5', 'focus20', 'focus10', 'pen', 'chain'];
        function migrateLegacyAchievementPicks(saved) {
            if (!saved) return saved;
            if (saved.achievementSet) {
                // 이름이 바뀐 세트 키는 새 키로, 사라진 세트(불씨 등)는 그대로 두면 아래 효과 계산에서 안전하게 기본값으로 대체된다
                return LEGACY_SET_RENAMES[saved.achievementSet] ? Object.assign({}, saved, { achievementSet: LEGACY_SET_RENAMES[saved.achievementSet] }) : saved;
            }
            const picked = [];
            ['nameEffect', 'glow'].forEach(c => { if (typeof saved[c] === 'string' && LEGACY_ACHIEVEMENT_PICKS[saved[c]]) picked.push(LEGACY_ACHIEVEMENT_PICKS[saved[c]]); });
            ['badge', 'specialEffect'].forEach(c => (Array.isArray(saved[c]) ? saved[c] : []).forEach(k => { if (LEGACY_ACHIEVEMENT_PICKS[k]) picked.push(LEGACY_ACHIEVEMENT_PICKS[k]); }));
            const best = ACHIEVEMENT_SET_PRIORITY.find(id => picked.includes(id));
            return best ? Object.assign({}, saved, { achievementSet: best }) : saved;
        }

        function computeEffectiveAppearance(level, savedAppearance, unlockedAchievements) {
            savedAppearance = migrateLegacyAchievementPicks(savedAppearance);
            const result = {};
            Object.keys(APPEARANCE_CATALOG).forEach(cat => {
                if (isMultiSelectCategory(cat)) {
                    const savedArr = (savedAppearance && Array.isArray(savedAppearance[cat])) ? savedAppearance[cat] : [];
                    result[cat] = savedArr.filter(k => isCosmeticOptionUnlocked(cat, k, level, unlockedAchievements));
                    return;
                }
                const catalog = APPEARANCE_CATALOG[cat];
                const fallback = highestUnlockedKey(cat, level);
                const chosen = savedAppearance && savedAppearance[cat];
                result[cat] = (chosen && catalog[chosen] && isCosmeticOptionUnlocked(cat, chosen, level, unlockedAchievements)) ? chosen : fallback;
            });
            return result;
        }

        // 학생 번호 기준으로 "화면에 보여줄" 꾸미기 값을 계산하는 공용 함수 (프로필 카드/모달/온라인 현황/커뮤니티 작성자 등).
        // 내 프로필은 Firestore profiles의 xp(거울 값)가 아직 안 써졌거나 오래됐을 수 있으므로, 실제 XP(users/{uid}/xp)를 그대로 쓴다.
        function getStudentAppearance(num, sData) {
            sData = sData || {};
            let xp = sData.xp || 0;
            if (num && num === getMyStudentNum() && xpCloudLoaded && window.PlannerApp && window.PlannerApp.getXP) xp = window.PlannerApp.getXP();
            const ap = getProfileAppearance(xp, sData.appearance);
            // Streak Effect: 장착 정보와 무관하게 "현재 연속 출석 일수"만으로 결정된다(내 화면=실시간, 남의 화면=거울 값의 유효성 확인)
            const isMe = !!(num && num === getMyStudentNum());
            ap.streakDays = (isMe && dailyMissionsLoaded) ? computeAttendanceStreak() : streakDaysFromMirror(sData.streak);
            if (isMe ? isMyStreakOff() : sData.streakOff === true) ap.streakDays = 0; // 본인이 "연속 출석 효과"를 꺼 둔 경우
            return ap;
        }

        function getProfileAppearance(xp, savedAppearance, unlockedAchievements) {
            if (!window.PlannerApp || !window.PlannerApp.getTierInfo) {
                return { level: 1, title: '새내기', ...computeEffectiveAppearance(1, savedAppearance, unlockedAchievements) };
            }
            const tier = window.PlannerApp.getTierInfo(xp || 0);
            const level = parseTierLevel(tier.name);
            const title = parseTierTitle(tier.name);
            return { level, title, tierLabel: tier.name, ...computeEffectiveAppearance(level, savedAppearance, unlockedAchievements) };
        }

        // 장착된 cosmetic들을 실제 렌더링 값(인라인 스타일/아이콘 목록 등)으로 변환한다.
        // activeChecker(achievementId)는 "이 활동 업적이 지금도 활성 상태인지"를 묻는 콜백이다.
        //   - 본인 화면(사이드바/성장모달/프로필꾸미기)에서는 실시간 스트릭 상태를 반영하는 checker를 넘긴다.
        //   - 다른 사용자를 보여줄 때(커뮤니티/아카이브/댓글/친구 프로필)는 넘기지 않으면 항상 true로 취급해
        //     상대가 장착해 둔 대로 그대로 보여준다(다른 계정의 실시간 스트릭 데이터는 조회하지 않는다).
        function buildAppearanceVisuals(appearance, activeChecker) {
            activeChecker = activeChecker || function () { return true; };
            function optionIfActive(cat, key) {
                if (!key) return null;
                const opt = APPEARANCE_CATALOG[cat] && APPEARANCE_CATALOG[cat][key];
                if (!opt) return null;
                if (opt.achievementId && !activeChecker(opt.achievementId)) return null; // 스트릭이 끊겨 지금은 비활성
                return opt;
            }

            const frameStyleOpt = optionIfActive('frameStyle', appearance.frameStyle) || APPEARANCE_CATALOG.frameStyle.basic;
            const frameColorOpt = optionIfActive('frameColor', appearance.frameColor) || APPEARANCE_CATALOG.frameColor.basic;
            const anim = optionIfActive('animation', appearance.animation) || APPEARANCE_CATALOG.animation.static;
            const glow = optionIfActive('glow', appearance.glow) || APPEARANCE_CATALOG.glow.none;
            const aura = optionIfActive('aura', appearance.aura) || APPEARANCE_CATALOG.aura.none;
            const nameEff = optionIfActive('nameEffect', appearance.nameEffect) || APPEARANCE_CATALOG.nameEffect.none;
            const badges = []; // 배지는 삭제됨(예전에 저장된 badge 값은 무시한다)
            // 업적 세트: 장착했고 + (스트릭형이면) 지금도 조건이 유지될 때만 보인다(optionIfActive가 걸러준다).
            const achSetKey = (appearance.achievementSet && appearance.achievementSet !== 'none' && optionIfActive('achievementSet', appearance.achievementSet)) ? appearance.achievementSet : null;
            const achSetIcons = achSetKey ? (APPEARANCE_CATALOG.achievementSet[achSetKey].setIcons || {}) : {};

            // 프레임: "모양"(frameStyleOpt)과 "색상"(frameColorOpt)을 조합해서 만든다. 사진이 아니라
            // 이 링(테두리)·장식·오빗에만 적용되며, 사진 자체는 항상 원형/선명 그대로 유지된다.
            const shape = frameStyleOpt.shape || 'basic';
            const frameGradient = frameColorOpt.gradient || null; // 프레임 색상에서는 항상 null (Rainbow 삭제됨) - 다른 색상 카테고리가 나중에 그라데이션을 쓰게 되더라도 대비해 구조는 남겨둔다
            const frameColorCss = frameColorOpt.color || 'var(--border-color)';
            const ringWidth = 3;
            let frameStyle;
            if (shape === 'segmented') {
                frameStyle = `border:${ringWidth}px solid transparent; background-image: linear-gradient(var(--card-bg), var(--card-bg)), repeating-conic-gradient(${frameColorCss} 0deg 24deg, transparent 24deg 36deg); background-origin: border-box; background-clip: padding-box, border-box;`;
            } else if (frameGradient) {
                frameStyle = `border:${ringWidth}px solid transparent; background-image: linear-gradient(var(--card-bg), var(--card-bg)), linear-gradient(135deg, ${frameGradient.join(',')}); background-origin: border-box; background-clip: padding-box, border-box;`;
            } else {
                frameStyle = `border:${ringWidth}px ${shape === 'dotted' ? 'dotted' : 'solid'} ${frameColorCss};`;
            }
            if (shape === 'neon') frameStyle += ` box-shadow:0 0 10px 2px ${frameGradient ? RAINBOW_PALETTE[2] : frameColorCss};`; // 레인보우면 팔레트 색으로 - frameColorCss(단색)로 fallback해서 어두워지지 않도록
            const frameDecorations = frameStyleOpt.decorations || []; // 별/크리스탈/과목 문양 등 사진 바깥 작은 장식 (작은 아바타에서는 생략)
            const frameOrbit = shape === 'orbital';
            const frameShape = shape; // 'wave'인지 여부는 렌더 함수에서 SVG로 그릴지 판단하는 데 쓰인다

            // Glow + Aura는 아바타 wrap의 바깥 box-shadow로만 합성한다 (사진 밝기에는 전혀 영향 없음).
            // Rainbow Aura 버그 수정: aura.colors(배열)가 있으면 색상별로 반경이 다른 box-shadow를 여러 겹 쌓아서
            // 진짜 "여러 색 광원이 은은하게 퍼지는" 형태로 만든다 (예전처럼 단색 rgba 하나만 쓰지 않는다).
            const auraColors = aura.colors || (aura.color ? [aura.color] : []);
            const baseParts = [];
            if (glow.color) baseParts.push(`0 0 12px 2px ${glow.color}`);
            auraColors.forEach((c, i) => baseParts.push(`0 0 ${22 + i * 4}px ${5 + i * 2}px ${c}`));
            const wrapShadowMin = baseParts.join(', ');
            const maxParts = [];
            if (glow.color) maxParts.push(`0 0 16px 3px ${glow.color}`);
            auraColors.forEach((c, i) => maxParts.push(`0 0 ${34 + i * 5}px ${9 + i * 3}px ${c}`));
            const wrapShadowMax = maxParts.length ? maxParts.join(', ') : wrapShadowMin;

            // 이름 효과: 단색 Glow / 그라데이션 텍스트 + "움직이는" 버전(pulse=밝기 변화, flow=그라데이션 이동,
            // sweep=빛이 좌→우로 훑고 지나감, refraction=아주 약한 색수차, sparkle/flash=드문 빛 조각).
            // 텍스트 자체의 위치나 크기는 절대 바뀌지 않는다 - 전부 오버레이/그림자/배경 위치만 움직인다.
            let nameStyle = '';
            let nameClass = '';
            if (nameEff.gradient) {
                // flow 효과는 색상 stop을 한 번 더 이어붙여서(예: [Black,Cyan,White] → [Black,Cyan,White,Black,Cyan,White])
                // background-size:200%로 정확히 한 바퀴를 이동했을 때 시작 색과 끝 색이 일치해 끊김 없이(seamless) 순환하게 만든다.
                // flow가 아닌 경우(고정 그라데이션)는 원래 배열 그대로 쓴다.
                const gradientStops = nameEff.flow ? nameEff.gradient.concat(nameEff.gradient) : nameEff.gradient;
                nameStyle = `background-image: linear-gradient(90deg, ${gradientStops.join(',')});`;
                if (nameEff.flowDuration) nameStyle += ` --pf-flow-duration:${nameEff.flowDuration};`;
                if (nameEff.sweepColor) nameStyle += ` --pf-sweep-color:${nameEff.sweepColor};`;
                if (nameEff.bloom) nameStyle += ` --pf-name-glow-color:${nameEff.gradient[0]};`; // 그라데이션 텍스트에도 Bloom Glow를 씌울 수 있게(예: Solar Gold→White)
                nameClass = `pf-name-styled pf-name-gradient${nameEff.flow ? ' pf-name-flow' : ''}${nameEff.sweep ? ' pf-name-sweep' : ''}${nameEff.refraction ? ' pf-name-refraction' : ''}${nameEff.bloom ? ' pf-name-bloom' : ''}`;
            } else if (nameEff.solid) {
                // 단색: 번짐/그림자 없이 글자 색만 바꾼다
                nameStyle = `color:${nameEff.color};`;
                nameClass = 'pf-name-styled';
            } else if (nameEff.neon) {
                // 네온: 밝은 코어 글자 + 색 빛이 안쪽→바깥쪽으로 겹겹이 번진다
                nameStyle = `color:${nameEff.core || '#fff'}; text-shadow: 0 0 3px ${nameEff.color}, 0 0 8px ${nameEff.color}, 0 0 16px ${nameEff.color}aa; --pf-name-glow-color:${nameEff.color};`;
                nameClass = 'pf-name-styled pf-name-neon';
            } else if (nameEff.color) {
                nameStyle = `color:${nameEff.color}; text-shadow: 0 0 6px ${nameEff.color}88; --pf-name-glow-color:${nameEff.color};`;
                nameClass = `pf-name-styled${nameEff.pulse ? ' pf-name-pulse' : ''}${nameEff.bloom ? ' pf-name-bloom' : ''}`;
            }

            return {
                wrapShadowMin, wrapShadowMax,
                wrapAnimated: !!aura.animated && !!wrapShadowMin,
                frameClass: `pf-frame-ring ${anim.anim || ''}`.trim(),
                frameStyle, frameShape,
                frameAnimShadowColor: anim.shadowColor || '',
                frameDecorations, frameOrbit, frameColorCss,
                frameIsGradient: !!frameGradient, // true면 레인보우 - 보조 링/장식/오빗도 검정 fallback 대신 무지개 색을 써야 한다
                badgeIcons: badges.map(b => b.icon).filter(Boolean),
                prefixIcons: achSetIcons.prefix ? [achSetIcons.prefix] : [],
                suffixIcons: achSetIcons.suffix ? [achSetIcons.suffix] : [],
                achSet: achSetKey, // 지금 실제로 보여줄 업적 세트 키(없으면 null)
                nameStyle, nameClass,
                nameSparkle: !!nameEff.sparkle, // Crystal Spark / Stardust - 아주 작은 빛 조각이 드물게 스침
                nameFlash: !!nameEff.flash // Singularity Flash - 아주 드물게 중앙에서 짧은 섬광
            };
        }

        // 프로필 사진 하나를 프레임/글로우/오라/온라인 상태까지 포함해 그려주는 공용 렌더 함수.
        // small=true면 댓글/작성자 같은 아주 작은 아바타용으로, 장식·오빗 등은 생략하고
        // (너무 작은 영역에 여러 장식이 겹치면 오히려 지저분해지고 카드 레이아웃과 부딪히므로) 프레임 색상만 간소하게 보여준다.
        function renderProfileAvatarHTML(appearance, photoUrl, isOnline, small, activeChecker) {
            const v = buildAppearanceVisuals(appearance, activeChecker);
            const cssVarParts = [];
            if (!small && v.wrapShadowMin) {
                cssVarParts.push(`--pf-aura-shadow-min:${v.wrapShadowMin}`);
                cssVarParts.push(`--pf-aura-shadow-max:${v.wrapShadowMax || v.wrapShadowMin}`);
            }
            const wrapStyle = (!small && v.wrapShadowMin) ? ` style="box-shadow:${v.wrapShadowMin}; ${cssVarParts.join('; ')};"` : '';
            const wrapClass = `pf-avatar-wrap${small ? ' pf-avatar-sm' : ''}${(!small && v.wrapAnimated) ? ' pf-aura-pulse' : ''}`;
            const dotHtml = typeof isOnline === 'boolean' ? `<span class="pf-online-dot" style="background:${isOnline ? '#22c55e' : '#9ca3af'};"></span>` : '';
            const frameAnimVars = v.frameAnimShadowColor ? ` --pf-anim-shadow-a:0 0 6px 1px ${v.frameAnimShadowColor}; --pf-anim-shadow-b:0 0 16px 4px ${v.frameAnimShadowColor};` : '';

            // 프레임 "모양" 장식: 별·크리스탈·과목 문양 등 작은 장식, 오빗 링. 전부 사진 바깥에만 그려지고,
            // 온라인 점(우하단, z-index:2로 항상 최상단)과 겹치더라도 z-index 때문에 점이 항상 위에 보인다.
            // 모든 장식은 "각도(angle)" 하나로 통일해서 위치를 계산한다(12/3/6/9시의 4개든, 과목 프레임의 7~10개든 동일한 방식).
            // frameColorCss는 레인보우일 때 실제 단일 색상이 없으므로(그라데이션이라), 검정으로 fallback되는 대신
            // 보조 요소(외부 링/장식/오빗 점) 각각에 RAINBOW_PALETTE에서 색을 하나씩 배분한다.
            let decoHtml = '';
            if (!small) {
                v.frameDecorations.forEach((d, i) => {
                    // 레인보우 프레임 색상은 폐기되었으므로 항상 frameColorCss 하나로 통일한다.
                    const decoColor = v.frameColorCss;
                    const rad = (d.angle * Math.PI) / 180;
                    const x = (Math.cos(rad) * 40).toFixed(1);
                    const y = (Math.sin(rad) * 40).toFixed(1);
                    if (d.decoStyle === 'crystal') {
                        // 크리스탈 다이아몬드 링 전용 - 텍스트 ◇ 대신 facet/highlight가 있는 얇은 CSS 결정체 모양
                        decoHtml += `<span class="pf-crystal-deco" style="left:calc(50% + ${x}px); top:calc(50% + ${y}px); --pf-crystal-color:${decoColor};"></span>`;
                    } else if (d.textDeco) {
                        // 과목 프레임 문자: Bold + 얇은 외곽선(.pf-frame-deco-text). jitter가 있으면 문자마다 아주 살짝
                        // 크기/회전을 다르게 주고(과도하지 않게), Atlas의 나침반 방위(jitter:false)는 흔들림 없이 정렬한다.
                        const baseSize = d.compact ? 0.52 : 0.78; // Atlas는 다른 과목보다 확실히 작게(요청: 기존 대비 약 65~75%)
                        const sizeStep = d.compact ? 0.05 : 0.14;
                        const sizeEm = (d.jitter ? baseSize + (i % 2) * sizeStep : baseSize).toFixed(2);
                        const rotateDeg = d.jitter ? ((i % 2 === 0) ? -5 : 5) : 0;
                        const opacity = d.compact ? 0.92 : 0.88;
                        decoHtml += `<span class="pf-frame-deco pf-frame-deco-text" style="left:calc(50% + ${x}px); top:calc(50% + ${y}px); color:${decoColor}; font-size:${sizeEm}em; opacity:${opacity}; transform:translate(-50%, -50%) rotate(${rotateDeg}deg);">${d.icon}</span>`;
                    } else {
                        // 별 등 순수 심볼 장식 - 회전/크기 흔들림 없이 4개 모두 동일하게 정렬한다 (삐뚤어짐 방지)
                        decoHtml += `<span class="pf-frame-deco" style="left:calc(50% + ${x}px); top:calc(50% + ${y}px); color:${decoColor};">${d.icon}</span>`;
                    }
                });
                if (v.frameOrbit) {
                    // 궤도를 도는 요소를 1개가 아니라 5개(72°씩)를 동일 반지름에 균등 배치한다 - "하나가 돌아가는 느낌"이 아니라
                    // "5개가 궤도를 형성하는 느낌"을 위해서다. 회전 애니메이션은 이 5개를 감싼 wrap 전체에만 적용해
                    // 사진이나 프레임 링 자체는 절대 돌지 않는다.
                    const radius = 40;
                    let dotsHtml = '';
                    for (let i = 0; i < 5; i++) {
                        const angle = (i * 72) * Math.PI / 180;
                        const x = (Math.cos(angle) * radius).toFixed(1);
                        const y = (Math.sin(angle) * radius).toFixed(1);
                        const dotColor = v.frameIsGradient ? RAINBOW_PALETTE[i % RAINBOW_PALETTE.length] : v.frameColorCss;
                        dotsHtml += `<span class="pf-frame-orbit-dot" style="left:calc(50% + ${x}px); top:calc(50% + ${y}px); background:${dotColor}; box-shadow:0 0 6px 1px ${dotColor};"></span>`;
                    }
                    decoHtml += `<span class="pf-frame-orbit-wrap spin">${dotsHtml}</span>`;
                }
            }
            // 업적 세트의 사진 주변 연출(청록 링/책갈피/불씨/금색 별 프레임 등). 작은 아바타(댓글 등)에서는 지저분해지므로 생략한다.
            if (!small && v.achSet) decoHtml += buildAchievementAvatarLayer(v.achSet);
            // "물결(Wave)" 모양은 단순 border로 표현할 수 없어 실제 사인파 궤적을 가진 SVG path로 그린다.
            // 작은 아바타(댓글 등)에서는 세부 물결 대신 다른 프레임과 동일하게 간소화된 링으로 대체한다.
            const ringHtml = (v.frameShape === 'wave' && !small)
                ? buildWaveFrameSVG(v.frameIsGradient, v.frameColorCss)
                : `<div class="${v.frameClass}" style="${v.frameStyle}${frameAnimVars}"></div>`;
            return `<div class="${wrapClass}"${wrapStyle}>${decoHtml}${ringHtml}<img class="pf-photo" src="${photoUrl}">${dotHtml}</div>`;
        }

        // 업적 세트별 "사진 주변" 연출. 전부 사진 바깥쪽(링/장식/작은 입자)에만 그려지고 사진 자체는 건드리지 않는다.
        // 이름 연출(펜선/집중선/이음/완주 표시)은 renderStyledName()과 CSS(.pf-ach-*)가 맡는다.
        function buildAchievementAvatarLayer(setKey) {
            // 사진 주변 연출은 올클리어 9회에만, 가장자리에 아주 작은 반짝임 두 개. 나머지 세트는 닉네임 연출만 쓴다.
            if (setKey === 'finish30') return '<span class="pf-ach-spark" style="right:2px; top:12px;"></span><span class="pf-ach-spark" style="left:3px; bottom:14px; animation-delay:2.3s;"></span>';
            return '';
        }

        let __pfWaveSvgSeq = 0; // 인라인 SVG gradient id가 페이지 내에서 서로 겹치지 않도록 매 렌더마다 증가시키는 카운터
        // 물결(Wave) 프레임의 실제 시각 요소 - 사인파로 반지름이 흔들리는 원형 path를 그린다. 사진과는 무관하게
        // 사진 바깥의 얇은 선 하나일 뿐이라 사진의 밝기/선명도에는 전혀 영향을 주지 않는다.
        function buildWaveFrameSVG(isGradient, colorCss) {
            __pfWaveSvgSeq++;
            const size = 76, cx = size / 2, cy = size / 2, baseR = size / 2 - 2, amp = 2.2, waveCount = 10, steps = 60;
            let d = '';
            for (let i = 0; i <= steps; i++) {
                const t = (i / steps) * Math.PI * 2;
                const r = baseR + Math.sin(t * waveCount) * amp;
                const x = (cx + Math.cos(t) * r).toFixed(2);
                const y = (cy + Math.sin(t) * r).toFixed(2);
                d += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
            }
            d += 'Z';
            let defs = '', stroke;
            if (isGradient) {
                const gid = `pfWaveGrad${__pfWaveSvgSeq}`;
                const stops = RAINBOW_PALETTE.map((c, i) => `<stop offset="${(i / (RAINBOW_PALETTE.length - 1) * 100).toFixed(0)}%" stop-color="${c}"/>`).join('');
                defs = `<defs><linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%">${stops}</linearGradient></defs>`;
                stroke = `url(#${gid})`;
            } else {
                stroke = colorCss;
            }
            return `<svg class="pf-frame-wave-svg" viewBox="0 0 ${size} ${size}">${defs}<path d="${d}" fill="none" stroke="${stroke}" stroke-width="3" stroke-linejoin="round"/></svg>`;
        }

        // 닉네임에 이름 효과(색상/그라데이션) + 활동 업적 prefix/suffix 아이콘 + 배지를 함께 적용해 HTML로 반환한다.
        // 커뮤니티/아카이브/댓글/프로필 등 작성자 표시가 필요한 모든 곳에서 이 함수 하나로 통일해서 사용한다.
        // 활동왕 펜: 책/책장과 같은 네온(광택 그라데이션 + 윤곽선 + 은은한 글로우) 스타일의 작은 펜. 펜촉(왼쪽 아래)이 밑줄의 끝을 따라간다.
        function pfPenMarkup() {
            const n = ++__pfBkSeq;
            return `<i class="pf-ach-nib" role="img" aria-label="펜"><svg viewBox="0 0 16 16" aria-hidden="true"><defs><linearGradient id="bkC${n}" x1="0" y1="1" x2="1" y2="0"><stop offset="0" class="bk-st-b"/><stop offset="1" class="bk-st-a"/></linearGradient><linearGradient id="bkP${n}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="bk-st-pa"/><stop offset="1" class="bk-st-pb"/></linearGradient></defs>`
                + `<path d="M5.2 9.4 L12.6 2 L14.4 3.8 L7 11.2 Z" fill="url(#bkC${n})" stroke="var(--bk-edge)" stroke-width="0.8" stroke-linejoin="round"/>`
                + `<path d="M6.6 9.2 L12.4 3.4" stroke="rgba(255,255,255,0.7)" stroke-width="0.6" stroke-linecap="round" fill="none"/>`
                + `<path d="M12.6 2 L13.7 0.9 Q14.5 0.3 15.1 0.9 Q15.7 1.5 15.1 2.3 L14.4 3.8 Z" fill="url(#bkP${n})" stroke="var(--bk-edge)" stroke-width="0.7" stroke-linejoin="round"/>`
                + `<path d="M1.4 14.6 L5.2 9.4 L7 11.2 Z" fill="url(#bkP${n})" stroke="var(--bk-edge)" stroke-width="0.8" stroke-linejoin="round"/>`
                + `<path d="M1.4 14.6 L5.9 10.4" stroke="var(--bk-edge)" stroke-width="0.4" fill="none"/></svg></i>`;
        }

        // 완주 연출 마크업: 왼쪽 마름모 파츠 + (CSS ::after 완료선) + 오른쪽 끝 체크 + 단계별 빛 조각. tier 1=3회, 2=5회, 3=9회(내부 id는 allClear5/15/30·finish5/15/30 그대로).
        function pfFinishMarkup(tier) {
            const n = ++__pfBkSeq;
            const check = `<i class="pf-ach-fcheck"><svg viewBox="0 0 20 20" aria-hidden="true"><defs><linearGradient id="bkF${n}" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="var(--fc)"/><stop offset="1" stop-color="var(--fc2)"/></linearGradient></defs><path d="M1.6 11.6 L4.8 9.4 L8.1 12.9 L15.8 2.2 L18.6 4.3 L8.5 17.6 Z" fill="url(#bkF${n})"/></svg></i>`;
            const spk = (x, y, sz, dot) => `<i class="pf-ach-fspk${dot ? ' dot' : ''}" style="--x:${x}em;--y:${y}em;--s:${sz}em"></i>`;
            let extra = '';
            if (tier === 2) extra = spk(-0.35, 0.55, 0.2) + spk(0.1, -0.2, 0.13, true);
            if (tier === 3) extra = spk(-0.35, 0.55, 0.2) + spk(0.1, -0.2, 0.13, true) + spk(-0.5, 0.78, 0.26) + spk(-0.22, 0.24, 0.14, true) + spk(0.18, 0.66, 0.16);
            return `<i class="pf-ach-fdia"></i>${check}${extra}`;
        }

        // 학습가 닉네임 연출(책 넘김 / 책장)의 SVG. 그라데이션 id가 겹치지 않도록 인스턴스마다 번호를 붙인다.
        let __pfBkSeq = 0;
        function pfBookMarkup(isBook) {
            const n = ++__pfBkSeq;
            const grad = `<defs><linearGradient id="bkC${n}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="bk-st-a"/><stop offset="1" class="bk-st-b"/></linearGradient><linearGradient id="bkP${n}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="bk-st-pa"/><stop offset="1" class="bk-st-pb"/></linearGradient></defs>`;
            // 닉네임 밑줄: 책 넘김은 오른쪽 끝이 살짝 올라가는 호선, 책장은 직선(책이 서는 선반)
            const arc = (flat) => `<i class="pf-ach-arc"><svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="bkA${n}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">${flat ? '<stop offset="0" class="bk-ast-b"/><stop offset="0.9" class="bk-ast-b"/><stop offset="1" class="bk-ast-a"/>' : '<stop offset="0" class="bk-ast-a"/><stop offset="0.3" class="bk-ast-b"/>'}</linearGradient></defs><path d="${flat ? 'M0 5 L100 5' : 'M0 3 Q55 11 100 1'}" stroke="url(#bkA${n})"/></svg></i>`;
            if (isBook) {
                // 가운데 책등(x=20)을 기준으로 오른쪽 표지가 왼쪽으로 넘어가며(scaleX 1→-1) 펼쳐진다. 표지는 안쪽면(종이색)으로 바뀌며 왼쪽 쪽이 된다.
                const rightPath = 'M20 12 Q28 8 37 10.5 V28.5 Q28 26 20 29.5 Z';
                const coverPath = 'M20 11 Q28 7 37.6 9.5 V30.2 Q28 27 20 31 Z';
                return `<i class="pf-ach-book"><svg viewBox="0 0 40 40" aria-hidden="true">${grad}`
                    + `<g class="bk-all">`
                    + `<path d="${rightPath}" fill="url(#bkP${n})" stroke="var(--bk-edge)" stroke-width="1" stroke-linejoin="round"/>`
                    + `<path class="bk-ink bk-ink-r" d="M23 15 Q28 13.5 33.5 15 M23 18.5 Q28 17 33.5 18.5 M23 22 Q28 20.5 33.5 22"/>`
                    + `<path class="bk-cover-in" d="${rightPath}" fill="url(#bkP${n})" stroke="var(--bk-edge)" stroke-width="1" stroke-linejoin="round"/>`
                    + `<path class="bk-ink bk-ink-l" d="M6.5 15 Q12 13.5 17 15 M6.5 18.5 Q12 17 17 18.5 M6.5 22 Q12 20.5 17 22"/>`
                    + `<path class="bk-edge bk-base" style="stroke-width:1.8" d="M2.5 30 Q12 27.5 20 31 Q28 27.5 37.5 30"/>`
                    + `<g class="bk-cover"><path d="${coverPath}" fill="url(#bkC${n})" stroke="var(--bk-edge)" stroke-width="1" stroke-linejoin="round"/><path d="M20 11 Q22 10.4 23.6 10.3 V30.6 Q21.6 30.5 20 31 Z" fill="rgba(10,25,90,0.35)"/><path class="bk-ink" style="stroke:rgba(255,255,255,0.8)" d="M27 15 Q31 14 34 14.6 M27 18.5 Q30.5 17.6 33 18.2"/></g>`
                    + `<path class="bk-turn" d="M20 12 Q28 7 37 10 V28 Q28 25 20 29.5 Z" fill="url(#bkP${n})" stroke="var(--bk-pa)" stroke-width="0.8" stroke-linejoin="round"/>`
                    + `</g>`
                    + `</svg></i>${arc(false)}`;
            }
            // 책장: 책 바닥(y=36)이 닉네임 밑줄 위에 놓인다(밑줄 = 선반). 맨 오른쪽 책은 옆 책에 기대어 왼쪽으로 기운다.
            const bk = (i, x, y, w, h, extra, lines) => `<g class="bk-spine ${extra}" style="--i:${i}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="0.9" fill="url(#bkC${n})" stroke="var(--bk-edge)" stroke-width="0.8"/><path d="M${x + 0.9} ${y + 1} V${y + h - 1}" stroke="rgba(255,255,255,0.55)" stroke-width="0.7"/>${lines ? `<path d="M${x + 0.8} ${y + 4} H${x + w - 0.8} M${x + 0.8} ${y + h - 4} H${x + w - 0.8}" stroke="rgba(255,255,255,0.5)" stroke-width="0.7"/>` : ''}</g>`;
            return `<i class="pf-ach-shelf"><svg viewBox="0 0 40 40" aria-hidden="true">${grad}`
                + bk(0, 8, 18, 4.6, 18, '', true) + bk(1, 13.6, 13, 5.6, 23, '', true) + bk(2, 20.4, 17, 4.6, 19, '', true) + bk(3, 31, 19, 4.4, 17, 'bk-lean', false)
                + `<rect class="bk-wall" x="4.4" y="10" width="2" height="26" rx="0.8"/>`
                + `</svg></i>${arc(true)}`;
        }

        // 업적 세트/Streak의 추가 요소(닉네임 주변의 작은 선·점). 전부 absolute라 글자 위치에는 영향이 없다.
        // 이음: 글자마다 그 위에 점 하나. 글자 폭은 한글/전각=1, 숫자/영문/기호는 대략적인 비율로 어림해 점을 글자 가운데에 놓는다(공백은 점 없음).
        function chainDotsMarkup(rawName) {
            const chars = Array.from(String(rawName == null ? '' : rawName));
            const widthOf = (ch) => {
                if (/\s/.test(ch)) return 0.3;
                if (/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af\u3000-\u9fff\uff00-\uffef]/.test(ch)) return 1;
                if (/[0-9]/.test(ch)) return 0.58;
                if (/[A-Z]/.test(ch)) return 0.66;
                if (/[a-z]/.test(ch)) return 0.54;
                return 0.62;
            };
            const widths = chars.map(widthOf);
            const total = widths.reduce((a, b) => a + b, 0) || 1;
            let acc = 0, idx = 0, html = '';
            chars.forEach((ch, i) => {
                const w = widths[i];
                if (!/\s/.test(ch)) html += `<i class="pf-ach-dot" style="left:${((acc + w / 2) / total * 100).toFixed(2)}%; --i:${idx++}"></i>`;
                acc += w;
            });
            return html;
        }
        function achievementNameExtras(setKey, rawName) {
            switch (setKey) {
                case 'pen': return pfPenMarkup();
                case 'focus10': return pfBookMarkup(true);
                case 'focus20': return pfBookMarkup(false);
                case 'chain': return chainDotsMarkup(rawName);
                case 'finish5': return pfFinishMarkup(1);
                case 'finish15': return pfFinishMarkup(2);
                case 'finish30': return pfFinishMarkup(3);
                default: return '';
            }
        }

        // 연속 출석 Streak Effect (정확히 4단계: 3일 / 4일 / 5일 / 7일 이상). 3일 미만이면 효과 없음.
        // 장착/해금이 아니라 "현재 연속 출석 일수"만으로 자동 결정되고, 끊기면 일수가 0이 되어 곧바로 사라진다.
        function streakTierFor(days) {
            const d = Number(days) || 0;
            return d >= 7 ? 7 : (d >= 5 ? 5 : (d >= 4 ? 4 : (d >= 3 ? 3 : 0)));
        }
        // 각 단계의 빛점: [타원 위 각도(0=오른쪽, 시계방향), 지름 px, 옅은 점 여부]
        const STREAK_DOTS = {
            3: [[158, 3.5], [204, 3]],
            4: [[188, 4], [140, 3], [262, 2.6]],
            5: [[162, 4], [124, 3.4], [62, 3], [22, 4], [322, 2, true], [218, 2, true]],
            7: [[354, 4], [42, 3], [118, 3.6], [200, 3], [284, 2.6], [326, 2, true]]
        };
        function streakOrbitHTML(tier) {
            const dots = (STREAK_DOTS[tier] || []).map(([deg, size, faint], i) => {
                const rad = deg * Math.PI / 180;
                return `<i class="pf-streak-dot${faint ? ' faint' : ''}" style="left:${(50 + 50 * Math.cos(rad)).toFixed(1)}%; top:${(50 + 50 * Math.sin(rad)).toFixed(1)}%; --sz:${size}px; animation-delay:${(i * 0.9).toFixed(1)}s;"></i>`;
            }).join('');
            return `<i class="pf-streak-orbit">${dots}</i>`;
        }

        function renderStyledName(rawName, appearance, activeChecker, escapeFn) {
            const esc = escapeFn || (s => s);
            const v = buildAppearanceVisuals(appearance, activeChecker);
            const iconSpan = i => `<span class="pf-ach-icon">${i}</span>`;
            const prefix = v.prefixIcons.length ? v.prefixIcons.map(iconSpan).join('') + ' ' : '';
            // 펜 세트의 ✒️는 닉네임 밑줄을 긋는 연출(.pf-ach-nib)로 줄 끝에 놓이므로 이름 뒤에 따로 붙이지 않는다.
            const suffixIcons = v.achSet === 'pen' ? v.suffixIcons.filter(i => i !== '✒️') : v.suffixIcons;
            const suffix = suffixIcons.length ? ' ' + suffixIcons.map(iconSpan).join('') : '';
            const badgeHtml = v.badgeIcons.length ? ' ' + v.badgeIcons.map(i => `<span class="pf-badge">${i}</span>`).join('') : '';
            let nameHtml;
            if (!v.nameClass) {
                nameHtml = esc(rawName);
            } else {
                // data-text 속성은 Prism/Lunar Sweep 효과가 ::before로 글자를 한 번 더 그려서 그 위에만 빛이 지나가게 하는 데 쓰인다.
                // 이 속성값은 escapeFn을 안 넘긴 호출부(esc가 항등함수)에서도 항상 안전하게 이스케이프해서 속성이 깨지지 않게 한다.
                const attrSafeName = String(rawName == null ? '' : rawName).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                const sparkleHtml = v.nameSparkle ? '<span class="pf-name-spark s1"></span><span class="pf-name-spark s2"></span>' : '';
                const flashHtml = v.nameFlash ? '<span class="pf-name-flash"></span>' : '';
                nameHtml = `<span class="${v.nameClass}" style="${v.nameStyle}" data-text="${attrSafeName}">${esc(rawName)}${sparkleHtml}${flashHtml}</span>`;
            }
            // 업적 세트의 이름 연출(펜선/집중선/이음/완주 표시)은 이름 전체를 감싸는 래퍼에 붙인다 - 레벨 이름 효과와 겹쳐도 서로 영향을 주지 않는다.
            if (v.achSet) nameHtml = `<span class="pf-ach pf-ach-${v.achSet}">${nameHtml}${achievementNameExtras(v.achSet, rawName)}</span>`;
            // Streak Effect는 업적 세트와도 독립이라 가장 바깥에서 한 번 더 감싼다(둘 다 있어도 서로 가리지 않게 궤도는 뒤쪽 레이어).
            // 접두/접미 아이콘과 배지도 궤도 안쪽에 들어오도록, 궤도는 닉네임 + 아이콘 + 배지 전체를 감싼다.
            const streakTier = streakTierFor(appearance && appearance.streakDays);
            if (streakTier) return `<span class="pf-streak pf-streak-t${streakTier}${v.achSet ? ' has-ach' : ''}" title="연속 출석 ${Number(appearance.streakDays) || 0}일">${streakOrbitHTML(streakTier)}${prefix}${nameHtml}${suffix}${badgeHtml}</span>`;
            return `${prefix}${nameHtml}${suffix}${badgeHtml}`;
        }

        function updateSidebarXP() {
            if (!window.PlannerApp || !window.PlannerApp.getXP) return;
            const xp = window.PlannerApp.getXP();
            const tier = window.PlannerApp.getTierInfo(xp);
            const titleEl = document.getElementById('sidebar-xp-title');
            const countEl = document.getElementById('sidebar-xp-count');
            const barEl = document.getElementById('sidebar-xp-bar');
            if (!titleEl) return;
            titleEl.textContent = tier.name;
            countEl.textContent = `${xp.toLocaleString()} XP`;
            if (tier.nextXP === null) { barEl.style.width = '100%'; }
            else {
                const pct = Math.min(100, Math.max(0, Math.floor(((xp - tier.currentLevelBase) / (tier.nextXP - tier.currentLevelBase)) * 100)));
                barEl.style.width = pct + '%';
            }
        }

        window.openGrowthModal = function() {
            if (!window.PlannerApp || !window.PlannerApp.getXP) return;
            const xp = window.PlannerApp.getXP();
            const tier = window.PlannerApp.getTierInfo(xp);
            const level = parseTierLevel(tier.name);

            document.getElementById('growth-tier-name').textContent = tier.name;
            document.getElementById('growth-xp-count').textContent = `${xp.toLocaleString()} XP`;
            const pb = document.getElementById('growth-progress-bar');
            const nt = document.getElementById('growth-next-text');
            if (tier.nextXP === null) { pb.style.width = '100%'; nt.textContent = '🎉 최고 등급에 도달했습니다!'; }
            else {
                const pct = Math.min(100, Math.max(0, Math.floor(((xp - tier.currentLevelBase) / (tier.nextXP - tier.currentLevelBase)) * 100)));
                pb.style.width = pct + '%';
                nt.textContent = `다음 레벨까지 ${(tier.nextXP - xp).toLocaleString()} XP 남음 (${pct}%)`;
            }

            // 카테고리별로 해금된 효과 / 앞으로 해금될 효과를 나열한다 (레벨업 시 항상 최신 상태로 다시 그려진다).
            const unlockedEl = document.getElementById('growth-unlocked-list');
            const lockedEl = document.getElementById('growth-locked-list');
            let unlockedHtml = '', lockedHtml = '';
            Object.keys(APPEARANCE_CATALOG).forEach(cat => {
                const catalog = APPEARANCE_CATALOG[cat];
                const orderedKeys = sortCosmeticsByUnlockOrder(Object.keys(catalog).filter(k => !catalog[k].achievementId), catalog);
                orderedKeys.forEach(key => {
                    const opt = catalog[key];
                    if (!opt.label || key === 'none' || key === 'static' || key === 'basic') return; // "없음/정적/기본" 같은 기본값은 목록에서 생략
                    const label = `${APPEARANCE_CATEGORY_LABELS[cat]} · ${opt.label} (Lv.${opt.unlockLevel}~)`;
                    if (level >= opt.unlockLevel) unlockedHtml += `<div>✓ ${label}</div>`;
                    else lockedHtml += `<div>🔒 Lv.${opt.unlockLevel}에서 해금 · ${APPEARANCE_CATEGORY_LABELS[cat]} · ${opt.label}</div>`;
                });
            });
            unlockedEl.innerHTML = unlockedHtml || '<div>-</div>';
            lockedEl.innerHTML = lockedHtml || '<div style="color:var(--primary); font-weight:700;">🎉 모든 효과를 해금했습니다!</div>';

            document.getElementById('growth-modal').style.display = 'flex';
        }

        function showLevelUpToast(newLevel, title) {
            const el = document.getElementById('levelup-toast');
            if (!el) return;
            document.getElementById('levelup-title').textContent = `Lv.${newLevel}`;
            document.getElementById('levelup-subtitle').textContent = `${title} 칭호 해금!`;
            el.style.display = 'block';
            requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translate(-50%, 0)'; });
            clearTimeout(el._hideTimer);
            el._hideTimer = setTimeout(() => {
                el.style.opacity = '0'; el.style.transform = 'translate(-50%, -10px)';
                setTimeout(() => { el.style.display = 'none'; }, 320);
            }, 2200);
        }

        // Firestore profiles/student_{num} 쓰기 공용 헬퍼 - "학생번호와 UID 소유권" 정책을 지킨다.
        // 문서가 이미 존재하고 그 uid가 지금 로그인한 uid와 다르면(예: 옛 계정이 삭제되고 같은 학번 이메일로
        // 다른 사람이 새로 가입한 경우) 자동으로 덮어쓰지 않고 콘솔에 경고만 남긴 뒤 종료한다.
        // 문서에 uid 필드 자체가 없으면(기존 마이그레이션 데이터) 기존 사용자 흐름을 깨지 않기 위해 정상 진행하고,
        // 이후 보호를 위해 uid 필드를 함께 기록한다.
        // Firestore profiles/student_{num} 쓰기 공용 헬퍼. 이 프로젝트에서는 다른 사용자가 다른 학생의
        // 프로필을 수정하는 것이 기존 RTDB 시절부터 정상적인 기능이므로, uid 소유권 체크/차단은 하지 않는다.
        // (개인 활동 데이터인 users/{uid}/xp, dailyMissions, achievements만 UID 기준으로 완전히 격리된다.)
        // RTDB의 update()와 동일하게 "문서가 없으면 새로 만들고, 있으면 해당 필드만 병합"하도록 merge:true를 쓴다.
        async function writeOwnProfileDoc(num, payload) {
            if (!currentUser) return;
            try {
                await setDoc(doc(fdb, 'profiles', `student_${num}`), payload, { merge: true });
            } catch (e) { console.warn('프로필 저장 실패:', e); }
        }

        // 내 실제 XP(users/{uid}/xp)와 Firestore profiles/student_{num}.xp(다른 사람이 내 레벨을 볼 때 쓰는 거울 값)를 맞춘다.
        // 예전에는 XP가 "바뀔 때만" 거울을 갱신해서, 이미 XP가 있던 계정이나 거울 쓰기가 한 번 실패했던 계정은
        // 다른 사람 화면에서 계속 Lv.1(효과 없음)로 보였다. 로그인 직후/프로필 목록 수신 시에도 어긋나 있으면 바로잡는다.
        // (Firebase 값을 받아오기 전의 로컬 값으로 덮어쓰지 않도록 xpCloudLoaded일 때만 동작한다.)
        function syncOwnXpMirror() {
            if (!xpCloudLoaded || !window.PlannerApp || !window.PlannerApp.getXP) return;
            const num = getMyStudentNum();
            if (!num) return;
            const xp = window.PlannerApp.getXP();
            const mirrored = (profilesData[`student_${num}`] || {}).xp;
            if (mirrored === xp) return;
            writeOwnProfileDoc(num, { xp });
        }

        // 내 현재 닉네임(users/{uid}.nickname)을 profiles/student_{num}.nickname에 미러링한다. 다른 사람은 내 users 문서를 읽을 수 없어서,
        // 이 거울 값이 있어야 예전에 쓴 글/댓글에도 바뀐 닉네임이 보인다. 닉네임을 해제하면 ''로 기록한다.
        function syncOwnNicknameMirror() {
            if (!currentUser || !currentUserInfo || !Object.keys(profilesData).length) return;
            const num = getMyStudentNum();
            if (!num) return;
            const want = (currentUserInfo.nickname || '').trim();
            const cur = (profilesData[`student_${num}`] || {}).nickname;
            if (cur === want || (cur === undefined && want === '')) return;
            writeOwnProfileDoc(num, { nickname: want });
        }

        // 프로필(닉네임/꾸미기/레벨/연속 출석)이 바뀌면 이미 그려진 글·아카이브·사이드바 이름도 새 값으로 다시 그린다.
        // 매 스냅샷마다 다시 그리면 댓글을 쓰는 중에 입력이 날아가므로, 작성자 표시에 영향을 주는 값이 실제로 바뀐 때만, 입력 중이 아닐 때만 그린다.
        let authorViewsSig = null, authorViewsTimer = null;
        function authorViewsSignature() {
            const out = [];
            for (let i = 1; i <= 26; i++) {
                const sd = profilesData[`student_${i}`];
                out.push(sd ? [sd.nickname, JSON.stringify(getStudentAppearance(i, sd))] : null);
            }
            return JSON.stringify(out);
        }
        function refreshAuthorViews() {
            const sig = authorViewsSignature();
            if (sig === authorViewsSig) return;
            const ae = document.activeElement;
            if (ae && (/^(INPUT|TEXTAREA)$/.test(ae.tagName) || ae.isContentEditable)) {
                clearTimeout(authorViewsTimer);
                authorViewsTimer = setTimeout(refreshAuthorViews, 3000); // 입력이 끝난 뒤에 다시 시도
                return;
            }
            authorViewsSig = sig;
            const safe = (fn) => { try { fn(); } catch (e) { console.warn('작성자 표시 갱신 실패:', e); } };
            safe(() => renderSidebarNick());
            safe(() => { if (Object.keys(latestPostsData || {}).length) renderPostsList(latestPostsData); });
            safe(() => { if (archiveSnapshotHandler && lastArchiveSnapshot) archiveSnapshotHandler(lastArchiveSnapshot); });
        }

        // addXP()가 호출될 때마다 실행된다: 사이드바 갱신 + 레벨업 감지 + (본인 프로필이 있는 경우) Firestore profiles에 xp 미러링.
        // XP의 단일 원본(source of truth)은 이제 users/{uid}/xp이다. 이 profiles/student_{num}.xp는
        // 어디까지나 "친구 프로필 그리드"에서 다른 학생의 레벨/칭호를 한 번에 훑어보기 위한 거울(mirror) 값일 뿐이며,
        // 새로운 저장소를 만들지 않고 기존 구조를 그대로 재사용한다(다른 학생 조회 시에도 여전히 Firebase 값을 사용).
        window.onXPChanged = function(xp) {
            updateSidebarXP();
            const tier = window.PlannerApp.getTierInfo(xp);
            const level = parseTierLevel(tier.name);
            if (lastKnownLevelNum !== null && level > lastKnownLevelNum) {
                showLevelUpToast(level, parseTierTitle(tier.name));
            }
            lastKnownLevelNum = level;

            // 1~26번 학생(정회원)만 자신의 프로필 슬롯이 있으므로, 그 경우에만 xp를 동기화한다.
            if (currentUserInfo && currentUserInfo.grade === '1' && currentUserInfo.ban === '2') {
                const num = parseInt(currentUserInfo.number);
                if (num >= 1 && num <= 26) {
                    writeOwnProfileDoc(num, { xp });
                }
            }
        }

        // =========================================================================
        // 내 프로필 꾸미기 - 해금된 효과 중 사용자가 원하는 것을 직접 선택해 장착한다.
        // 장착 정보는 Firestore profiles/student_{num} 문서의 "appearance" 필드에 그대로 통합 저장한다
        // (새로운 사용자/저장 데이터 구조를 만들지 않음). 레벨보다 높은 해금 등급은 저장/렌더링 어디서도 허용하지 않는다.
        // =========================================================================
        let decorateDraftAppearance = null;
        let decorateDraftStreakOff = false; // 연속 출석 효과를 끄는지(초안) - "적용하기"를 눌러야 저장된다
        let decorateInitialStreakOff = false;
        // 연속 출석 효과 on/off: 다른 사람 화면에서도 꺼지도록 내 프로필 문서(profiles/student_N.streakOff)에 남기고,
        // 쓰기가 실패하거나 아직 반영 전이어도 내 화면은 바로 바뀌도록 이 브라우저에도 같은 값을 저장해 둔다.
        const STREAK_OFF_KEY_PREFIX = 'hanilgo_streak_off_';
        function isMyStreakOff() {
            const num = getMyStudentNum();
            let local = null;
            try { if (currentUser) local = localStorage.getItem(STREAK_OFF_KEY_PREFIX + currentUser.uid); } catch (e) {}
            if (local === '1') return true;
            if (local === '0') return false;
            return !!(num && (profilesData[`student_${num}`] || {}).streakOff === true);
        }
        function setMyStreakOffLocal(off) {
            try { if (currentUser) localStorage.setItem(STREAK_OFF_KEY_PREFIX + currentUser.uid, off ? '1' : '0'); } catch (e) {}
        }
        let decorateDraftLevel = 1;
        let decorateInitialAppearance = null; // "초기화" 버튼으로 되돌아갈 스냅샷 (모달을 연 시점의 상태)
        let decorateActiveTab = 'frameStyle'; // 지금 보고 있는 카테고리 탭

        // 1230 운영자 전용 "꾸미기 테스트 모드": 레벨/업적/연속 출석과 상관없이 모든 효과를 켜고 끄며 시험해 볼 수 있다.
        // 운영자 계정은 1~26번 학생이 아니라 profiles 문서가 없으므로 Firebase에는 아무것도 쓰지 않고, 이 기기(localStorage)에만 저장해
        // 운영자 본인 화면(사이드바 이름, 운영자가 쓴 글/댓글의 이름)에 그대로 적용해 실제 모습까지 확인할 수 있게 한다.
        const OPERATOR_TEST_KEY = 'gmw_operator_appearance_test';
        let decorateOperatorMode = false;
        let decorateOperatorStreak = 0; // 0 = 끔, 2/3/5/7 = 연속 출석 Streak Effect 단계 강제 표시
        function allAchievementsUnlockedMap() { const m = {}; ACHIEVEMENTS.forEach(a => { m[a.id] = true; }); return m; }
        function decorateUnlockedMap() { return decorateOperatorMode ? allAchievementsUnlockedMap() : myAchievementsUnlocked; }
        function decorateActiveChecker() { return decorateOperatorMode ? (() => true) : isMyAchievementActive; }
        function loadOperatorTest() {
            try { const v = JSON.parse(localStorage.getItem(OPERATOR_TEST_KEY) || 'null'); if (v && typeof v === 'object') return v; } catch (e) {}
            return { appearance: null, streakDays: 0 };
        }
        // 운영자 본인에게 보여줄 테스트 꾸미기(없으면 효과 없음). 다른 사람 화면에는 영향 없음.
        function operatorTestAppearance() {
            const saved = loadOperatorTest();
            const ap = getProfileAppearance(1e9, saved.appearance, allAchievementsUnlockedMap());
            ap.level = Math.min(30, ap.level);
            ap.streakDays = Number(saved.streakDays) || 0;
            return ap;
        }

        function getMyStudentNum() {
            if (currentUserInfo && currentUserInfo.grade === '1' && currentUserInfo.ban === '2') {
                const num = parseInt(currentUserInfo.number);
                if (num >= 1 && num <= 26) return num;
            }
            return null;
        }

        // 설정 창 안의 닉네임/연속 출석 스위치를 현재 상태로 채운다 (nickOnly: 프로필 꾸미기 대상이 아닌 계정은 닉네임만)
        function fillDecorateSettings(nickOnly) {
            document.getElementById('decorate-modal').querySelector('.deco-editor').classList.toggle('nick-only', !!nickOnly);
            document.getElementById('decorate-nick-input').value = (currentUserInfo && currentUserInfo.nickname) || '';
            const msg = document.getElementById('decorate-nick-msg'); msg.textContent = ''; msg.classList.remove('error');
            document.getElementById('decorate-streak-row').style.display = (nickOnly || decorateOperatorMode) ? 'none' : '';
            document.getElementById('decorate-streak-toggle').checked = !decorateDraftStreakOff;
        }
        window.setDecorateStreakOff = function(off) {
            decorateDraftStreakOff = !!off;
            renderDecorateModal();
        };
        window.saveDecorateNickname = async function() {
            const input = document.getElementById('decorate-nick-input');
            const msg = document.getElementById('decorate-nick-msg');
            const say = (text, error) => { msg.textContent = text; msg.classList.toggle('error', !!error); };
            if (!currentUser || !currentUserInfo) return showLoginScreen(() => setNickname());
            const nick = input.value.trim();
            if (nick.length > 10) return say('닉네임은 10자 이내로 입력해주세요.', true);
            try {
                await update(ref(db, `users/${currentUser.uid}`), { nickname: nick || null });
                say(nick ? '닉네임을 바꿨어요!' : '닉네임을 지웠어요. 학번으로 표시돼요.');
            } catch (e) { say('닉네임을 저장하지 못했어요. 잠시 후 다시 시도해주세요.', true); }
        };
        window.openDecorateModal = function() {
            if (!currentUser) return showLoginScreen(() => openDecorateModal());
            const num = getMyStudentNum();
            decorateOperatorMode = !num && isOperator;
            if (!num && !decorateOperatorMode) { // 담임/관리자/타반 계정은 꾸미기 대상이 아니라서 닉네임만 바꿀 수 있는 작은 창으로 연다
                fillDecorateSettings(true);
                document.getElementById('decorate-modal').style.display = 'flex';
                return;
            }
            if (!window.PlannerApp || !window.PlannerApp.getXP) return;
            decorateDraftStreakOff = isMyStreakOff(); decorateInitialStreakOff = decorateDraftStreakOff;
            if (decorateOperatorMode) {
                const saved = loadOperatorTest();
                decorateDraftLevel = Math.min(30, parseTierLevel(window.PlannerApp.getTierInfo(1e9).name)); // 운영자: 최고 레벨 기준으로 모든 효과 해금
                decorateDraftAppearance = computeEffectiveAppearance(decorateDraftLevel, saved.appearance, allAchievementsUnlockedMap());
                decorateOperatorStreak = Number(saved.streakDays) || 0;
                decorateInitialAppearance = JSON.parse(JSON.stringify(decorateDraftAppearance));
                decorateActiveTab = 'frameStyle';
                fillDecorateSettings(false);
                renderDecorateModal();
                document.getElementById('decorate-modal').style.display = 'flex';
                return;
            }
            const xp = window.PlannerApp.getXP();
            const level = parseTierLevel(window.PlannerApp.getTierInfo(xp).name);
            const savedAppearance = (profilesData[`student_${num}`] || {}).appearance || null;
            decorateDraftLevel = level;
            decorateDraftAppearance = computeEffectiveAppearance(level, savedAppearance, myAchievementsUnlocked);
            decorateInitialAppearance = JSON.parse(JSON.stringify(decorateDraftAppearance)); // 취소/초기화용 스냅샷 - 적용하기 전까지 Firebase에는 아무것도 쓰지 않는다
            decorateActiveTab = 'frameStyle';
            fillDecorateSettings(false);
            renderDecorateModal();
            document.getElementById('decorate-modal').style.display = 'flex';
        }
        window.closeDecorateModal = function() {
            document.getElementById('decorate-modal').style.display = 'none';
        }
        // 설정 모달과 동일하게, 블러 처리된 배경(카드 바깥 부분)을 클릭해도 닫히게 한다.
        document.getElementById('growth-modal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
        });
        document.getElementById('decorate-modal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) window.closeDecorateModal();
        });

        // "초기화": 꾸미기를 한 번도 저장하지 않은 계정과 같은 기본 상태(내 레벨/업적에 맞춰 자동으로 정해지는 값)로 되돌린다.
        // 예전에는 "모달을 열었을 때의 상태"로만 되돌려서, 열자마자 누르면 아무 변화가 없어 작동하지 않는 것처럼 보였다.
        // (이전 저장 상태로 돌아가려면 취소/닫기. 어느 쪽이든 "적용하기"를 누르기 전에는 저장되지 않는다.)
        window.resetDecorateDraft = function() {
            if (!decorateInitialAppearance) return;
            decorateDraftAppearance = computeEffectiveAppearance(decorateDraftLevel, null, decorateUnlockedMap());
            if (decorateOperatorMode) decorateOperatorStreak = 0;
            decorateDraftStreakOff = false;
            const streakToggle = document.getElementById('decorate-streak-toggle'); if (streakToggle) streakToggle.checked = true;
            renderDecorateModal();
        }

        window.switchDecorateTab = function(cat) {
            decorateActiveTab = cat;
            renderDecorateModal();
        }

        // 옵션 카드 안에 보여줄 작은 미리보기(원형 색상 샘플 / 실제 스타일이 적용된 이름 샘플 등).
        // 배지·특수효과·애니메이션은 카드 자체가 아이콘이거나 Preview에서 바로 확인 가능하므로 별도 swatch를 만들지 않는다.
        function decorateOptionSwatchHTML(cat, opt, sampleName) {
            if (cat === 'nameEffect') {
                if (opt.gradient) return `<span style="font-weight:800; font-size:12.5px; background-image:linear-gradient(90deg, ${opt.gradient.join(',')}); -webkit-background-clip:text; background-clip:text; color:transparent;">${sampleName}</span>`;
                if (opt.solid) return `<span style="font-weight:800; font-size:12.5px; color:${opt.color};">${sampleName}</span>`;
                if (opt.neon) return `<span style="font-weight:800; font-size:12.5px; color:${opt.core || '#fff'}; text-shadow:0 0 3px ${opt.color}, 0 0 8px ${opt.color}, 0 0 14px ${opt.color}aa;">${sampleName}</span>`;
                if (opt.color) return `<span style="font-weight:800; font-size:12.5px; color:${opt.color}; text-shadow:0 0 6px ${opt.color}88;">${sampleName}</span>`;
                return `<span style="font-weight:800; font-size:12.5px; color:var(--text-main);">${sampleName}</span>`;
            }
            if (cat === 'badge' || cat === 'animation') return '';
            if (cat === 'frameStyle') {
                // 장식이 있는 프레임(별/크리스탈 다이아몬드/과목 문양 등)은 실제 장식 글자를 미리 보여주고,
                // 그 외에는 색상 선택과 무관한 중립색으로 "형태" 자체만 보여준다 (색상은 옆 탭에서 따로 고른다).
                const neutral = 'var(--text-muted)';
                if (opt.decorations && opt.decorations.length) {
                    const isCrystal = opt.decorations[0].decoStyle === 'crystal';
                    const preview = isCrystal ? '◇ ◇ ◇' : opt.decorations.slice(0, 4).map(d => d.icon).join(' ');
                    return `<span style="font-size:13px; letter-spacing:1px; color:${neutral};">${preview}</span>`;
                }
                if (opt.shape === 'wave') return `<span class="deco-option-swatch" style="border:2px dashed ${neutral}; border-radius:50%;"></span>`;
                if (opt.shape === 'segmented') return `<span class="deco-option-swatch" style="background-image: repeating-conic-gradient(${neutral} 0deg 24deg, transparent 24deg 36deg);"></span>`;
                return `<span class="deco-option-swatch" style="background:transparent; border:2px ${opt.shape === 'dotted' ? 'dotted' : 'solid'} ${neutral};"></span>`;
            }
            if (cat === 'frameColor') {
                const style = opt.gradient ? `background-image: linear-gradient(135deg, ${opt.gradient.join(',')});` : `background:${opt.color || 'var(--border-color)'};`;
                return `<span class="deco-option-swatch" style="${style}"></span>`;
            }
            const color = opt.color || 'transparent'; // glow / aura
            return `<span class="deco-option-swatch" style="background:${color}; box-shadow:0 0 10px 2px ${color};"></span>`;
        }

        function renderDecorateModal() {
            const level = decorateDraftLevel;
            const num = getMyStudentNum();
            const sData = (num && profilesData[`student_${num}`]) || {};
            const photo = sData.photo || (decorateOperatorMode ? 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#94a3b8"/><circle cx="40" cy="32" r="14" fill="#e2e8f0"/><rect x="14" y="52" width="52" height="30" rx="16" fill="#e2e8f0"/></svg>') : 'data:image/svg+xml;utf8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27150%27 height=%27150%27%3E%3Crect width=%27150%27 height=%27150%27 fill=%27%23e5e7eb%27/%3E%3C/svg%3E');
            const displayName = decorateOperatorMode ? ((currentUserInfo && currentUserInfo.nickname) || '운영자') : (isRestrictedViewer ? (FIXED_PROFILE_ROSTER[num] || `${num}번`) : (sData.name || '미등록'));
            const title = parseTierTitle(window.PlannerApp.getTierInfo(decorateOperatorMode ? 1e9 : window.PlannerApp.getXP()).name);
            const isActiveNow = decorateActiveChecker();

            const previewAppearance = { level, title, ...decorateDraftAppearance, streakDays: decorateOperatorMode ? decorateOperatorStreak : ((dailyMissionsLoaded && !decorateDraftStreakOff) ? computeAttendanceStreak() : 0) };
            // 미리보기는 본인 화면이므로 실시간 활성 여부(isMyAchievementActive)를 그대로 반영한다
            // (예: 7일 연속 출석이 끊긴 상태라면 장착해 두어도 미리보기에서 자동으로 꺼져 보인다).
            // Preview와 실제 프로필/커뮤니티/아카이브/댓글은 전부 renderProfileAvatarHTML()/renderStyledName() 두 공용 함수만 사용하므로
            // 여기서 보이는 모습과 실제로 적용됐을 때의 모습이 서로 달라지지 않는다.
            document.getElementById('decorate-preview-avatar').innerHTML = renderProfileAvatarHTML(previewAppearance, photo, undefined, false, isActiveNow);
            document.getElementById('decorate-preview-name').innerHTML = renderStyledName(displayName, previewAppearance, isActiveNow);

            // 현재 장착 중인 효과 요약 태그 (탭과 무관하게 전체 카테고리를 한눈에 보여준다)
            const tagsEl = document.getElementById('decorate-equipped-tags');
            let tagsHtml = '';
            Object.keys(APPEARANCE_CATALOG).forEach(cat => {
                const catalog = APPEARANCE_CATALOG[cat];
                if (isMultiSelectCategory(cat)) {
                    (decorateDraftAppearance[cat] || []).forEach(key => {
                        const opt = catalog[key];
                        if (opt) tagsHtml += `<span class="deco-equipped-tag">${opt.icon || ''} ${opt.label}</span>`;
                    });
                } else {
                    const key = decorateDraftAppearance[cat];
                    const opt = key && catalog[key];
                    if (opt && key !== 'none' && key !== 'static' && key !== 'basic') {
                        // 연속 출석/연속 완료처럼 "지금도 조건을 유지해야" 보이는 효과가, 조건이 끊겨서 미리보기에 안 보이는 상태면 이유를 알려준다
                        // (해금 기록은 그대로이고, 조건을 다시 채우면 자동으로 다시 켜진다).
                        const off = opt.achievementId && !isActiveNow(opt.achievementId);
                        tagsHtml += `<span class="deco-equipped-tag"${off ? ' style="opacity:0.7;"' : ''}>${APPEARANCE_CATEGORY_LABELS[cat]}: ${opt.label}${off ? ` · ⏸ 지금은 꺼져 있어요 (${(ACHIEVEMENTS.find(a => a.id === opt.achievementId) || {}).label || ''} 조건이 끊겼어요)` : ''}</span>`;
                    }
                }
            });
            tagsEl.innerHTML = tagsHtml || '<span class="deco-equipped-tag" style="opacity:0.6;">장착한 효과 없음</span>';

            // 운영자 테스트 모드 패널: 연속 출석 Streak Effect(원래는 출석 일수로만 자동 결정)를 단계별로 강제로 켜고 끈다.
            const tabsHost = document.getElementById('decorate-tabs');
            let opPanel = document.getElementById('decorate-operator-panel');
            if (decorateOperatorMode) {
                if (!opPanel) { opPanel = document.createElement('div'); opPanel.id = 'decorate-operator-panel'; opPanel.className = 'deco-operator-panel'; tabsHost.parentNode.insertBefore(opPanel, tabsHost); }
                opPanel.innerHTML = `<div class="deco-operator-title">🛠 운영자 테스트 모드 — 모든 꾸미기가 열려 있고, 적용해도 이 기기에서만 보여요(다른 사람·서버에는 반영 안 됨)</div>
                    <div class="deco-operator-row"><span>연속 출석 효과</span>${[[0, '끔'], [3, '3일'], [4, '4일'], [5, '5일'], [7, '7일']].map(([d, l]) => `<button type="button" class="deco-operator-btn ${decorateOperatorStreak === d ? 'active' : ''}" onclick="setDecorateOperatorStreak(${d})">${l}</button>`).join('')}</div>`;
            } else if (opPanel) { opPanel.remove(); }

            // 카테고리 탭
            const tabsEl = document.getElementById('decorate-tabs');
            tabsEl.innerHTML = Object.keys(APPEARANCE_CATALOG).map(cat =>
                `<button type="button" class="deco-tab-btn ${decorateActiveTab === cat ? 'active' : ''}" onclick="switchDecorateTab('${cat}')">${APPEARANCE_CATEGORY_LABELS[cat]}</button>`
            ).join('');

            // 선택된 탭의 옵션만 카드 그리드로 렌더링한다 (모든 카테고리를 세로로 쭉 나열하지 않는다)
            const cat = decorateActiveTab;
            const catalog = APPEARANCE_CATALOG[cat];
            const multi = isMultiSelectCategory(cat);
            const isIconGrid = (cat === 'badge');
            // cosmetic 표시 순서는 데이터 구조(카탈로그에 적어놓은 순서)를 그대로 믿지 않고, 렌더링 시점에
            // "해금 레벨 오름차순"(레벨 보상) / "난이도 순"(활동 업적)으로 항상 다시 정렬한다.
            const levelKeys = sortCosmeticsByUnlockOrder(Object.keys(catalog).filter(k => !catalog[k].achievementId), catalog);
            const achKeys = sortAchievementCosmeticsByDifficulty(Object.keys(catalog).filter(k => catalog[k].achievementId), catalog);

            function renderOptionCard(key) {
                const opt = catalog[key];
                const unlocked = isCosmeticOptionUnlocked(cat, key, level, decorateUnlockedMap());
                const selected = multi ? (decorateDraftAppearance[cat] || []).includes(key) : decorateDraftAppearance[cat] === key;
                const lockHint = opt.achievementId
                    ? `${(ACHIEVEMENTS.find(a => a.id === opt.achievementId) || {}).label || ''} 달성 시 해금`
                    : `Lv.${opt.unlockLevel} 필요`;
                const onClickFn = multi ? `toggleDecorateMultiChoice('${cat}','${key}')` : `setDecorateChoice('${cat}','${key}')`;
                const checkMark = selected ? `<span class="deco-option-check">✓</span>` : '';
                if (isIconGrid) {
                    return `<div class="deco-badge-card ${selected ? 'selected' : ''} ${unlocked ? '' : 'locked'}" onclick="${unlocked ? onClickFn : ''}" title="${unlocked ? opt.label : lockHint}">
                        ${checkMark}
                        <div>${unlocked ? opt.icon : '🔒'}</div>
                        <span class="deco-option-sub">${unlocked ? '' : lockHint}</span>
                    </div>`;
                }
                if (cat === 'achievementSet') {
                    // 업적 세트는 "색 하나"가 아니라 여러 요소가 묶인 구성이라, 무엇이 함께 적용되는지 설명을 같이 보여준다.
                    const setOff = unlocked && selected && opt.achievementId && !isActiveNow(opt.achievementId);
                    const setSub = unlocked ? (selected ? (setOff ? '사용 중 · 지금은 꺼짐(조건이 끊김)' : '현재 사용 중') : '') : lockHint;
                    return `<div class="deco-option-card deco-set-card ${selected ? 'selected' : ''} ${unlocked ? '' : 'locked'}" onclick="${unlocked ? onClickFn : ''}">
                        ${checkMark}
                        <span style="font-size:20px; line-height:1;">${unlocked ? (opt.icon || '–') : '🔒'}</span>
                        <span class="deco-option-label">${opt.label}</span>
                        <span class="deco-option-sub">${unlocked ? (opt.desc || '') : lockHint}</span>
                        ${setSub && unlocked ? `<span class="deco-option-sub" style="color:var(--primary); font-weight:700;">${setSub}</span>` : ''}
                    </div>`;
                }
                const swatch = decorateOptionSwatchHTML(cat, opt, displayName);
                const optOff = unlocked && selected && opt.achievementId && !isActiveNow(opt.achievementId);
                const subLine = unlocked ? (selected ? (optOff ? '사용 중 · 지금은 꺼짐(조건이 끊김)' : '현재 사용 중') : (opt.unlockLevel ? `Lv.${opt.unlockLevel}~` : '')) : lockHint;
                return `<div class="deco-option-card ${selected ? 'selected' : ''} ${unlocked ? '' : 'locked'}" onclick="${unlocked ? onClickFn : ''}">
                    ${checkMark}
                    ${unlocked ? swatch : '<span style="font-size:18px;">🔒</span>'}
                    <span class="deco-option-label">${opt.label}</span>
                    <span class="deco-option-sub">${subLine}</span>
                </div>`;
            }

            const gridClass = isIconGrid ? 'deco-badge-grid' : 'deco-option-grid';
            let html = '';
            if (cat === 'frameStyle') {
                // 프레임 "모양"은 종류가 많아졌으므로 기본/장식/과목/고급 네 그룹으로 나눠서 보여준다 (다른 카테고리는 기존처럼 레벨/업적 2단 구성 유지).
                const FRAME_GROUP_LABELS = { basic: '기본', decorative: '장식', subject: '과목', premium: '고급' };
                ['basic', 'decorative', 'subject', 'premium'].forEach(groupKey => {
                    const keysInGroup = sortCosmeticsByUnlockOrder(levelKeys.filter(k => (catalog[k].group || 'basic') === groupKey), catalog);
                    if (!keysInGroup.length) return;
                    html += `<div class="deco-source-label">${FRAME_GROUP_LABELS[groupKey]}</div>`;
                    html += `<div class="${gridClass}">${keysInGroup.map(renderOptionCard).join('')}</div>`;
                });
            } else if (cat === 'achievementSet') {
                // 업적 세트: 레벨 보상과 섞지 않고 "특별 해금"만 따로 보여준다. 장착 해제(없음)는 맨 앞에 둔다.
                const myStreak = dailyMissionsLoaded ? computeAttendanceStreak() : 0;
                const myTier = streakTierFor(myStreak);
                html += `<div style="font-size:12px; color:var(--text-muted); background:var(--surface-secondary); border:1px solid var(--border-color); border-radius:10px; padding:8px 10px; margin-bottom:10px; line-height:1.5;">
                    <b style="color:var(--text-main);">연속 출석 효과</b>는 따로 장착하지 않아도 <b>현재 연속 출석 일수</b>에 따라 닉네임에 자동으로 나타나요(3·4·5·7일 단계). 연속이 끊기면 사라지고, 다시 이어가면 돌아와요.
                    <div style="margin-top:4px;">지금 연속 출석 <b style="color:var(--text-main);">${myStreak}일</b> → ${decorateDraftStreakOff ? '효과를 꺼 둔 상태예요 (왼쪽 “연속 출석 효과”에서 켤 수 있어요)' : (myTier ? `${myTier}일 단계 효과 적용 중` : '효과 없음 (3일부터 시작)')}</div>
                </div>`;
                html += `<div class="deco-source-label">🏆 활동 업적 세트 <span style="font-weight:500; opacity:0.75;">· 레벨 효과(프레임/색/Glow/이름)와 함께 쓸 수 있어요</span></div>`;
                html += `<div class="${gridClass}">${levelKeys.concat(achKeys).map(renderOptionCard).join('')}</div>`;
            } else if (levelKeys.length) {
                html += achKeys.length ? `<div class="deco-source-label">✨ 레벨 보상</div>` : '';
                html += `<div class="${gridClass}">${levelKeys.map(renderOptionCard).join('')}</div>`;
            }
            if (achKeys.length && cat !== 'achievementSet') {
                html += `<div class="deco-source-label" style="margin-top:14px;">🏆 활동 업적</div>`;
                html += `<div class="${gridClass}">${achKeys.map(renderOptionCard).join('')}</div>`;
            }
            document.getElementById('decorate-categories').innerHTML = html;
        }

        window.setDecorateChoice = function(cat, key) {
            if (!isCosmeticOptionUnlocked(cat, key, decorateDraftLevel, decorateUnlockedMap())) return; // 해금 안 된 값은 절대 선택되지 않는다 (카드도 locked 처리됨)
            decorateDraftAppearance[cat] = key;
            renderDecorateModal();
        }

        window.toggleDecorateMultiChoice = function(cat, key) {
            if (!isCosmeticOptionUnlocked(cat, key, decorateDraftLevel, decorateUnlockedMap())) return;
            const arr = decorateDraftAppearance[cat] || (decorateDraftAppearance[cat] = []);
            const idx = arr.indexOf(key);
            if (idx >= 0) arr.splice(idx, 1); else arr.push(key);
            renderDecorateModal();
        }

        // "적용하기"를 눌렀을 때만 실제로 Firebase에 저장한다. 그 전까지 draft는 이 브라우저 메모리에만 존재한다.
        window.setDecorateOperatorStreak = function(days) {
            decorateOperatorStreak = Number(days) || 0;
            renderDecorateModal();
        }
        window.saveDecorateAppearance = async function() {
            if (decorateOperatorMode && decorateDraftAppearance) {
                // 운영자 테스트: Firebase에는 쓰지 않고 이 기기에만 저장한 뒤, 운영자 본인 화면(사이드바/내가 쓴 글의 이름)을 바로 갱신한다.
                try { localStorage.setItem(OPERATOR_TEST_KEY, JSON.stringify({ appearance: decorateDraftAppearance, streakDays: decorateOperatorStreak })); } catch (e) {}
                closeDecorateModal();
                authorViewsSig = null;
                refreshAuthorViews();
                renderSidebarNick();
                return;
            }
            const num = getMyStudentNum();
            if (!num || !decorateDraftAppearance) return;
            try {
                setMyStreakOffLocal(decorateDraftStreakOff);
                await writeOwnProfileDoc(num, { appearance: decorateDraftAppearance, streakOff: decorateDraftStreakOff });
                closeDecorateModal();
                authorViewsSig = null;
                refreshAuthorViews();
                renderSidebarNick();
            } catch (e) { alert('저장 중 오류가 발생했습니다.'); }
        }

        // =========================================================================
        // 온라인 상태(Presence) - Firebase Realtime Database 공식 presence 패턴
        // 여러 탭/기기에서 접속해도 UI에는 한 명으로 표시된다.
        //
        // 온라인 현황 집계 대상은 항상 "1학년 2반 1~26번 학생"으로 고정한다 (총 26명).
        // 30번 관리자/40번 부담임/98번 담임/타반 학생 등은 Presence 자체를 만들지 않으며,
        // 혹시 예전 데이터나 다른 경로로 presence에 값이 남아있더라도 번호 범위 필터로
        // 온라인 집계에서 완전히 제외된다.
        // =========================================================================
        const CLASS_ROSTER_SIZE = 26; // 기존 프로필 그리드(1~26번)와 동일한 반 인원 수를 그대로 재사용
        let presenceData = {};
        let myPresenceConnections = [];

        // 이 계정이 실제 "1학년 2반 1~26번 학생"인지 검사한다 (역할이 아니라 번호가 기준).
        // 30/40/98번이나 타반 학생은 관리자/반장 등 권한이 있어도 여기서 걸러진다.
        function isRosterStudentInfo(info) {
            if (!info) return false;
            if (info.grade !== '1' || info.ban !== '2') return false;
            const n = Number(info.number);
            return Number.isInteger(n) && n >= 1 && n <= 26;
        }

        // 자동(연결 여부) 상태 위에 사용자가 직접 고르는 상태를 얹는다: online(기본)/away/busy/invisible.
        // invisible은 실제로는 연결돼 있어도 다른 사람에게는 offline과 똑같이 보인다(Discord의 "보이지 않음"과 동일).
        const PRESENCE_STATUS_COLORS = { online: '#22c55e', away: '#eab308', busy: '#ef4444', offline: '#9ca3af' };
        const PRESENCE_STATUS_KEY = 'hanilgo_my_presence_status';

        function setupPresence() {
            if (!currentUser || !currentUserInfo) return;
            // 온라인 현황 집계 대상 밖의 계정(관리자/부담임/담임/타반)은 Presence 자체를 등록하지 않는다.
            if (!isRosterStudentInfo(currentUserInfo)) return;
            // presence/{uid}/number는 Firebase Rules상 문자열(isString())만 허용하므로,
            // 원본 문자열 값을 그대로 저장한다(파싱된 정수를 저장하면 Rules에 막혀 쓰기가 실패한다).
            const myNumber = currentUserInfo.number;
            onValue(ref(db, '.info/connected'), (snap) => {
                if (!snap.val() || !currentUser) return;
                if (!isRosterStudentInfo(currentUserInfo)) return; // 재확인(방어적 체크)
                const conRef = push(ref(db, `presence/${currentUser.uid}/connections`));
                // onDisconnect를 먼저 등록한 뒤에 값을 쓴다 - 비정상 종료 시에도 자동 정리되도록.
                onDisconnect(conRef).remove();
                set(conRef, true).catch(() => {});
                set(ref(db, `presence/${currentUser.uid}/number`), myNumber).catch(() => {});
                // 접속할 때마다 이 브라우저에 저장해둔 마지막 상태(자리비움/다른 용무 중/보이지 않음)를 다시 적용한다.
                let savedStatus = 'online';
                try { savedStatus = localStorage.getItem(PRESENCE_STATUS_KEY) || 'online'; } catch (e) {}
                set(ref(db, `presence/${currentUser.uid}/status`), savedStatus).catch(() => {});
                myPresenceConnections.push(conRef);
            });
        }

        function teardownPresence() {
            myPresenceConnections.forEach(c => { try { remove(c); } catch (e) {} });
            myPresenceConnections = [];
        }

        function listenToPresence() {
            onValue(ref(db, 'presence'), (snap) => {
                presenceData = snap.val() || {};
                renderPresenceWidgets();
            });
        }

        // "학생 번호(1~26)" -> presence 데이터 한 명 (1~26 범위를 벗어나는 번호는 여기서 걸러진다)
        function getPresenceEntryByNumber(num) {
            return Object.values(presenceData).find(p => {
                if (!p) return false;
                const n = Number(p.number);
                return Number.isInteger(n) && n >= 1 && n <= 26 && String(n) === String(num);
            }) || null;
        }
        // 이 번호 학생이 지금 남에게 어떻게 보이는지: 'online' | 'away' | 'busy' | 'offline'.
        // 연결이 아예 없거나(진짜 오프라인), 상태를 'invisible'로 골랐으면(보이지 않음) 똑같이 'offline'으로 취급한다.
        function getPresenceStatusForNumber(num) {
            const entry = getPresenceEntryByNumber(num);
            if (!entry || !entry.connections || Object.keys(entry.connections).length === 0) return 'offline';
            const status = entry.status || 'online';
            if (status === 'away' || status === 'busy') return status;
            return status === 'invisible' ? 'offline' : 'online';
        }
        // "온라인"(정상 접속) 한 가지 상태로만 집계되는 "학생 번호" 집합.
        // 자리비움/다른 용무 중은 접속은 돼 있지만 온라인 인원수에는 포함하지 않는다(모달에서 별도 그룹으로 보여준다).
        function getOnlineNumbersSet() {
            const s = new Set();
            for (let i = 1; i <= CLASS_ROSTER_SIZE; i++) {
                if (getPresenceStatusForNumber(i) === 'online') s.add(String(i));
            }
            return s;
        }
        function isNumberOnline(num) { return getOnlineNumbersSet().has(String(num)); }
        // 온라인 인원 수. 정의상 26을 넘을 수 없지만, 안전장치로 한 번 더 clamp한다.
        function getOnlineCount() { return Math.min(CLASS_ROSTER_SIZE, getOnlineNumbersSet().size); }

        function renderPresenceWidgets() {
            const onlineCount = getOnlineCount();
            // 홈 대시보드에는 더 이상 우리 반 위젯을 표시하지 않는다 (친구들 프로필 화면 전용).
            const profileSummaryEl = document.getElementById('presence-profile-summary');
            if (profileSummaryEl) {
                profileSummaryEl.innerHTML = `총 ${CLASS_ROSTER_SIZE}명 · <span style="color:#16a34a; font-weight:700;">🟢 ${onlineCount}명 온라인</span>`;
            }
            const presModal = document.getElementById('presence-modal');
            if (presModal && presModal.style.display === 'flex') renderPresenceModalList();
            document.querySelectorAll('.profile-thumb-card').forEach(card => {
                const num = card.getAttribute('data-num');
                if (!num) return;
                const dot = card.querySelector('.pf-online-dot');
                if (dot) dot.style.background = PRESENCE_STATUS_COLORS[getPresenceStatusForNumber(num)];
            });
        }

        window.openPresenceModal = function() {
            renderPresenceModalList();
            document.getElementById('presence-modal').style.display = 'flex';
        }

        function renderPresenceModalList() {
            const groups = { online: [], away: [], busy: [], offline: [] };
            for (let i = 1; i <= CLASS_ROSTER_SIZE; i++) {
                const name = resolveStudentDisplayName(i) || `${i}번`;
                const sData = profilesData[`student_${i}`] || {};
                const appearance = getStudentAppearance(i, sData);
                const styledName = renderStyledName(name, appearance, null, escapeNoticeText); // 온라인 현황도 이름 효과/배지가 그대로 보이도록 공용 렌더러 사용
                const status = getPresenceStatusForNumber(i);
                const row = `<div style="display:flex; align-items:center; gap:8px; padding:6px 0; font-size:13px; color:var(--text-main);"><span style="width:8px; height:8px; border-radius:50%; background:${PRESENCE_STATUS_COLORS[status]}; flex-shrink:0;"></span>${i}번 ${styledName}</div>`;
                groups[status].push(row);
            }
            document.getElementById('presence-modal-list').innerHTML = `
                <div style="font-size:12px; font-weight:700; color:#16a34a; margin:8px 0 4px;">🟢 온라인 ${groups.online.length}명</div>
                ${groups.online.join('') || '<div class="widget-text">없음</div>'}
                <div style="font-size:12px; font-weight:700; color:#ca8a04; margin:16px 0 4px;">🟡 자리비움 ${groups.away.length}명</div>
                ${groups.away.join('') || '<div class="widget-text">없음</div>'}
                <div style="font-size:12px; font-weight:700; color:#dc2626; margin:16px 0 4px;">🔴 다른 용무 중 ${groups.busy.length}명</div>
                ${groups.busy.join('') || '<div class="widget-text">없음</div>'}
                <div style="font-size:12px; font-weight:700; color:var(--text-muted); margin:16px 0 4px;">⚪ 오프라인 ${groups.offline.length}명</div>
                ${groups.offline.join('') || '<div class="widget-text">없음</div>'}
            `;
        }

        // 사이드바 프로필 카드의 "온라인 상태" 선택 위젯. 반 명단(1~26번) 학생이 아니면 애초에
        // presence 자체가 없으므로 위젯 자체를 숨긴다.
        const PRESENCE_STATUS_LABELS = { online: '온라인', away: '자리 비움', busy: '다른 용무 중', invisible: '오프라인' };

        window.updatePresenceWidgetUI = function() {
            const widget = document.getElementById('sidebar-presence-widget');
            if (!widget) return;
            if (!isRosterStudentInfo(currentUserInfo)) { widget.style.display = 'none'; return; }
            widget.style.display = 'block';
            let current = 'online';
            try { current = localStorage.getItem(PRESENCE_STATUS_KEY) || 'online'; } catch (e) {}
            const dot = document.getElementById('sidebar-presence-dot');
            const label = document.getElementById('sidebar-presence-label');
            if (dot) dot.style.background = PRESENCE_STATUS_COLORS[current] || PRESENCE_STATUS_COLORS.online;
            if (label) label.textContent = PRESENCE_STATUS_LABELS[current] || PRESENCE_STATUS_LABELS.online;
            // 팝오버는 열릴 때 document.body로 옮겨지므로(아래 togglePresencePicker 참고) widget이 아니라
            // 팝오버 자신에서 옵션을 찾아야 한다.
            const popEl = document.getElementById('sidebar-presence-popover');
            if (popEl) popEl.querySelectorAll('.settings-presence-option').forEach(btn => {
                const on = btn.getAttribute('data-status') === current;
                btn.style.borderColor = on ? 'var(--primary)' : 'transparent';
                btn.style.background = on ? 'var(--primary-soft, rgba(37,99,235,0.08))' : 'transparent';
            });
        };

        // 사이드바(.sidebar-expand-only)는 overflow:hidden + transform으로 접혔다 펼쳐지므로,
        // 팝오버를 그 안에 그대로 두면 잘려서 반쯤만 보이는 버그가 생긴다. 열 때 document.body로
        // 옮겨서 뷰포트 기준 진짜 position:fixed로 띄우고, 버튼 위치를 기준으로 좌표를 계산한다.
        // 팝오버가 body로 옮겨지면 더 이상 .sidebar 안에 있지 않으므로, 옵션을 고르려고 마우스를
        // 버튼에서 팝오버 쪽으로 움직이는 순간 .sidebar:hover가 풀려 사이드바 자체가 접혀버린다.
        // 그래서 팝오버가 열려 있는 동안은 .sidebar에 강제 펼침 클래스를 붙여 그 문제를 막는다.
        function closePresencePopover() {
            const pop = document.getElementById('sidebar-presence-popover');
            if (pop) pop.style.display = 'none';
            const sidebarEl = document.querySelector('.sidebar');
            if (sidebarEl) sidebarEl.classList.remove('presence-popover-open');
        }

        window.togglePresencePicker = function(e) {
            if (e) e.stopPropagation();
            const pop = document.getElementById('sidebar-presence-popover');
            const btn = document.getElementById('sidebar-presence-btn');
            if (!pop || !btn) return;
            if (pop.style.display === 'block') { closePresencePopover(); return; }
            if (pop.parentElement !== document.body) document.body.appendChild(pop);
            const rect = btn.getBoundingClientRect();
            pop.style.top = (rect.bottom + 6) + 'px';
            pop.style.left = rect.left + 'px';
            pop.style.width = rect.width + 'px';
            pop.style.display = 'block';
            const sidebarEl = document.querySelector('.sidebar');
            if (sidebarEl) sidebarEl.classList.add('presence-popover-open');
        };

        document.addEventListener('click', (e) => {
            const widget = document.getElementById('sidebar-presence-widget');
            const pop = document.getElementById('sidebar-presence-popover');
            if (!pop || pop.style.display !== 'block') return;
            const inWidget = widget && widget.contains(e.target);
            const inPopover = pop.contains(e.target);
            if (!inWidget && !inPopover) closePresencePopover();
        });

        window.setMyPresenceStatus = function(status) {
            if (!currentUser || !isRosterStudentInfo(currentUserInfo)) return alert('온라인 상태를 설정할 수 있는 계정이 아닙니다.');
            try { localStorage.setItem(PRESENCE_STATUS_KEY, status); } catch (e) {}
            set(ref(db, `presence/${currentUser.uid}/status`), status).catch(() => {});
            window.updatePresenceWidgetUI();
            closePresencePopover();
        };

        // =========================================================================
        // 반 공용 일정 캘린더 (기존 수행평가 Firestore calendar 자동 미러링 포함)
        // =========================================================================
        const SCHEDULE_DEFAULT_TAGS = ['수행평가', '지필평가', '학교행사', '학교일정'];
        const SCHEDULE_TAG_COLORS = { '수행평가': '#3b82f6', '지필평가': '#ef4444', '학교행사': '#16a34a', '학교일정': '#f59e0b' };
        function scheduleTagColor(tag) { return SCHEDULE_TAG_COLORS[tag] || '#8b5cf6'; }

        let scheduleViewDate = new Date();
        let scheduleCache = {}; // 반 공용(dashboard/shared_schedule) + 내 개인 일정(users/{uid}/personal_schedule)을 합친 것. 각 항목에 _source: 'shared'|'personal'을 붙여 구분한다.
        let sharedScheduleData = {};
        let personalScheduleData = {};
        let scheduleSelectedDateKey = null;
        let scheduleEditingId = null;
        let scheduleActiveTagFilter = new Set(); // 비어있으면 전체 표시
        let scheduleFormSelectedTags = new Set();

        function updateScheduleComposerVisibility() {
            const btn = document.getElementById('btn-write-schedule');
            // 반 공용 일정 쓰기 권한이 없어도, 로그인만 했으면 "나만 보이는" 개인 일정은 누구나 추가할 수 있다.
            if (btn) btn.style.display = currentUser ? 'inline-flex' : 'none';
        }

        function rebuildScheduleCache() {
            scheduleCache = {};
            Object.entries(sharedScheduleData).forEach(([id, ev]) => { scheduleCache[id] = { ...ev, _source: 'shared' }; });
            Object.entries(personalScheduleData).forEach(([id, ev]) => { scheduleCache[id] = { ...ev, _source: 'personal' }; });
            renderScheduleCalendar();
            renderCurrentPeriodWidget(); // 지필고사 D-day가 이 안에서 scheduleCache를 쓰므로 즉시 갱신
            const dayModal = document.getElementById('schedule-day-modal');
            if (scheduleSelectedDateKey && dayModal && dayModal.style.display === 'flex') renderScheduleDayList();
        }

        function listenToSharedSchedule() {
            // RTDB는 오프라인 캐시가 없어서, 리스너가 값을 받기 전까지는 마지막으로 저장해둔 반 공용
            // 일정을 먼저 보여준다(반 전체가 함께 보는 정보라 uid와 무관하게 하나의 키로 캐싱한다).
            const cached = loadInfoCache('shared_schedule');
            if (cached) { sharedScheduleData = cached.data; rebuildScheduleCache(); }
            onValue(ref(db, 'dashboard/shared_schedule'), (snap) => {
                sharedScheduleData = snap.val() || {};
                saveInfoCache('shared_schedule', sharedScheduleData);
                rebuildScheduleCache();
            });
        }

        // 개인 일정은 완전히 나만 보이므로 Firebase 규칙을 새로 만들 필요 없이, 이미 본인만 읽고 쓸 수 있는
        // users/{uid} 아래에 저장한다 (users/$uid의 .read/.write가 auth.uid === $uid로 이미 제한돼 있음).
        function listenToPersonalSchedule() {
            if (!currentUser) { personalScheduleData = {}; rebuildScheduleCache(); return; }
            // 같은 브라우저를 여러 명이 쓸 수 있으므로(반 공용 기기 등), uid별로 캐시 키를 분리해서
            // 다른 사람의 개인 일정이 잘못 보이는 일이 없게 한다.
            const cacheKey = 'personal_schedule_' + currentUser.uid;
            const cached = loadInfoCache(cacheKey);
            if (cached) { personalScheduleData = cached.data; rebuildScheduleCache(); }
            onValue(ref(db, `users/${currentUser.uid}/personal_schedule`), (snap) => {
                personalScheduleData = snap.val() || {};
                saveInfoCache(cacheKey, personalScheduleData);
                rebuildScheduleCache();
            });
        }

        function getScheduleDateKey(y, m, d) { return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
        // 일정 시작일까지 며칠 남았는지 "D-n" / "D-DAY" / "D+n"(지난 일정) 형태로 표시한다.
        function scheduleDDayLabel(dateStr) {
            const today = new Date(); today.setHours(0, 0, 0, 0);
            const target = new Date(dateStr + 'T00:00:00');
            const diffDays = Math.round((target - today) / 86400000);
            if (diffDays === 0) return 'D-DAY';
            return diffDays > 0 ? `D-${diffDays}` : `D+${Math.abs(diffDays)}`;
        }
        function scheduleEventsByDate(dateKey) { return Object.entries(scheduleCache).filter(([, ev]) => dateKey >= ev.date && dateKey <= (ev.endDate || ev.date)).map(([id, ev]) => ({ id, ...ev })); }
        function scheduleEventMatchesFilter(ev) {
            if (scheduleActiveTagFilter.size === 0) return true;
            return (ev.tags || []).some(t => scheduleActiveTagFilter.has(t));
        }

        function renderScheduleCalendar() {
            const grid = document.getElementById('schedule-calendar-grid');
            const label = document.getElementById('schedule-month-label');
            if (!grid || !label) return;
            const y = scheduleViewDate.getFullYear(), m = scheduleViewDate.getMonth();
            label.innerText = `${y}년 ${m + 1}월`;
            const startWeekday = new Date(y, m, 1).getDay();
            const lastDateOfMonth = new Date(y, m + 1, 0).getDate();
            const lastDateOfPrevMonth = new Date(y, m, 0).getDate();
            const todayK = getScheduleDateKey(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
            const totalCells = Math.ceil((startWeekday + lastDateOfMonth) / 7) * 7;
            let html = '';
            for (let i = 0; i < totalCells; i++) {
                const dayOffset = i - startWeekday;
                let cellY = y, cellM = m, cellD, otherMonth = false;
                if (dayOffset < 0) { cellD = lastDateOfPrevMonth + dayOffset + 1; cellM = m - 1; if (cellM < 0) { cellM = 11; cellY = y - 1; } otherMonth = true; }
                else if (dayOffset >= lastDateOfMonth) { cellD = dayOffset - lastDateOfMonth + 1; cellM = m + 1; if (cellM > 11) { cellM = 0; cellY = y + 1; } otherMonth = true; }
                else cellD = dayOffset + 1;
                const dateKey = getScheduleDateKey(cellY, cellM, cellD);
                const allEvents = scheduleEventsByDate(dateKey);
                const hasFilterActive = scheduleActiveTagFilter.size > 0;
                const matched = hasFilterActive ? allEvents.filter(scheduleEventMatchesFilter) : allEvents;
                const dim = hasFilterActive && matched.length === 0 && allEvents.length > 0;
                const isToday = dateKey === todayK;
                let chipsHtml = ''; const maxShow = 2;
                matched.slice(0, maxShow).forEach(ev => {
                    const c = scheduleTagColor((ev.tags || [])[0]);
                    const lock = ev._source === 'personal' ? '🔒 ' : '';
                    chipsHtml += `<div class="exam-cal-event-chip" style="background:${c}22; color:${c};">${lock}${ev.subject ? `[${ev.subject}] ` : ''}${escapeNoticeText(ev.title)}</div>`;
                });
                if (matched.length > maxShow) chipsHtml += `<div class="exam-cal-more">+ ${matched.length - maxShow}개 더</div>`;
                html += `<div class="exam-cal-day ${otherMonth ? 'other-month' : ''} ${isToday ? 'today' : ''}" style="${dim ? 'opacity:0.3;' : ''}" onclick="openScheduleDayModal('${dateKey}')">
                    <div class="exam-cal-daynum">${cellD}</div>${chipsHtml}
                </div>`;
            }
            grid.innerHTML = html;
        }

        window.changeScheduleMonth = function(delta) { scheduleViewDate.setMonth(scheduleViewDate.getMonth() + delta); renderScheduleCalendar(); }

        window.openScheduleDayModal = function(dateKey) {
            scheduleSelectedDateKey = dateKey;
            const d = new Date(dateKey + 'T00:00:00');
            const weekday = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
            document.getElementById('schedule-day-modal-title').innerText = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${weekday})`;
            document.getElementById('btn-add-schedule-in-day').style.display = currentUser ? 'block' : 'none';
            renderScheduleDayList();
            document.getElementById('schedule-day-modal').style.display = 'flex';
        }

        function renderScheduleDayList() {
            const listEl = document.getElementById('schedule-day-event-list');
            const events = scheduleEventsByDate(scheduleSelectedDateKey);
            if (events.length === 0) { listEl.innerHTML = `<div style="text-align:center; color:var(--text-muted); font-size:13px; padding:14px;">등록된 일정이 없습니다.</div>`; return; }
            listEl.innerHTML = events.map(ev => {
                const tagsHtml = (ev.tags || []).map(t => `<span style="font-size:10px; padding:2px 6px; border-radius:5px; background:${scheduleTagColor(t)}22; color:${scheduleTagColor(t)}; margin-right:4px;">${t}</span>`).join('');
                const rangeHtml = (ev.endDate && ev.endDate !== ev.date) ? `<div style="font-size:11px; color:var(--text-muted); margin-top:2px;">${ev.date} ~ ${ev.endDate}</div>` : '';
                const isPersonal = ev._source === 'personal';
                const canEditThis = isPersonal || (ev._source === 'shared' && canWriteSchedule); // 개인 일정은 항상 본인 것 - 공용은 canWriteSchedule 필요
                const personalBadge = isPersonal ? `<span style="font-size:10px; padding:2px 6px; border-radius:5px; background:var(--surface-secondary); color:var(--text-muted); margin-right:4px;">🔒 개인</span>` : '';
                return `<div style="border:1px solid var(--border-color); border-radius:10px; padding:10px 12px; margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
                        <div style="font-size:14px; font-weight:700; color:var(--text-main);">${ev.subject ? `[${escapeNoticeText(ev.subject)}] ` : ''}${escapeNoticeText(ev.title)}</div>
                        ${canEditThis ? `<div style="display:flex; gap:8px; flex-shrink:0;"><span onclick="openScheduleComposer('${ev.id}')" style="cursor:pointer; font-size:12px; color:var(--primary); font-weight:600;">수정</span><span onclick="deleteScheduleEvent('${ev.id}')" style="cursor:pointer; font-size:12px; color:#ef4444; font-weight:600;">삭제</span></div>` : ''}
                    </div>
                    ${rangeHtml}
                    ${(personalBadge || tagsHtml) ? `<div style="margin-top:6px;">${personalBadge}${tagsHtml}</div>` : ''}
                    ${ev.content ? `<div style="font-size:12px; color:var(--text-muted); margin-top:6px; white-space:pre-wrap;">${escapeNoticeText(ev.content)}</div>` : ''}
                </div>`;
            }).join('');
        }

        window.openScheduleComposer = function(id) {
            if (!currentUser) return showLoginScreen(() => openScheduleComposer(id)); // 로그인만 하면 개인 일정은 누구나 추가 가능 - 공용 쓰기 권한은 아래에서 별도 처리
            const personalCheckbox = document.getElementById('schedule-form-personal');
            if (id && scheduleCache[id] && scheduleCache[id]._source === 'shared' && !canWriteSchedule) return; // 남의 공용 일정을 권한 없이 열려는 시도 방지
            scheduleEditingId = id;
            document.getElementById('schedule-editing-id').value = id || '';
            const titleEl = document.getElementById('schedule-composer-title');
            scheduleFormSelectedTags = new Set();
            if (id && scheduleCache[id]) {
                const ev = scheduleCache[id];
                titleEl.textContent = '일정 수정';
                document.getElementById('schedule-form-date').value = ev.date || '';
                document.getElementById('schedule-form-enddate').value = (ev.endDate && ev.endDate !== ev.date) ? ev.endDate : '';
                document.getElementById('schedule-form-subject').value = ev.subject || '기타';
                document.getElementById('schedule-form-title').value = ev.title || '';
                document.getElementById('schedule-form-content').value = ev.content || '';
                (ev.tags || []).forEach(t => scheduleFormSelectedTags.add(t));
                // 수정할 때는 개인/공용 구분을 바꿀 수 없다 (원래 저장된 곳에 그대로 저장)
                personalCheckbox.checked = ev._source === 'personal';
                personalCheckbox.disabled = true;
            } else {
                titleEl.textContent = '일정 추가';
                document.getElementById('schedule-form-date').value = scheduleSelectedDateKey || '';
                document.getElementById('schedule-form-enddate').value = '';
                document.getElementById('schedule-form-subject').value = '국어';
                document.getElementById('schedule-form-title').value = '';
                document.getElementById('schedule-form-content').value = '';
                // 반 공용 쓰기 권한이 없으면 개인 일정만 가능하므로 체크박스를 강제로 고정한다
                personalCheckbox.checked = !canWriteSchedule;
                personalCheckbox.disabled = !canWriteSchedule;
            }
            renderScheduleFormTags();
            document.getElementById('schedule-day-modal').style.display = 'none';
            document.getElementById('schedule-composer-modal').style.display = 'flex';
        }

        function renderScheduleFormTags() {
            const wrap = document.getElementById('schedule-form-tags');
            wrap.innerHTML = SCHEDULE_DEFAULT_TAGS.map(t => {
                const active = scheduleFormSelectedTags.has(t);
                const c = scheduleTagColor(t);
                return `<span onclick="toggleScheduleFormTag('${t}')" style="cursor:pointer; padding:5px 10px; border-radius:8px; font-size:12px; font-weight:600; border:1px solid ${active ? c : 'var(--border-color)'}; background:${active ? c + '22' : 'transparent'}; color:${active ? c : 'var(--text-muted)'};">${t}</span>`;
            }).join('');
        }
        window.toggleScheduleFormTag = function(t) {
            if (scheduleFormSelectedTags.has(t)) scheduleFormSelectedTags.delete(t); else scheduleFormSelectedTags.add(t);
            renderScheduleFormTags();
        }

        window.submitScheduleForm = async function() {
            if (!currentUser) return showLoginScreen(() => submitScheduleForm());
            const date = document.getElementById('schedule-form-date').value;
            const endDateInput = document.getElementById('schedule-form-enddate').value;
            const subject = document.getElementById('schedule-form-subject').value;
            const title = document.getElementById('schedule-form-title').value.trim();
            const content = document.getElementById('schedule-form-content').value.trim();
            const isPersonal = document.getElementById('schedule-form-personal').checked;
            if (!isPersonal && !canWriteSchedule) return alert('반 공용 일정 작성 권한이 없습니다. "개인 일정으로 등록"을 체크해주세요.');
            if (!date || !title) return alert('날짜와 제목을 입력해주세요.');
            if (endDateInput && endDateInput < date) return alert('종료일은 시작 날짜보다 빠를 수 없습니다.');
            const endDate = endDateInput || date;
            const tags = Array.from(scheduleFormSelectedTags);
            try {
                if (scheduleEditingId) {
                    const existing = scheduleCache[scheduleEditingId];
                    const path = existing && existing._source === 'personal'
                        ? `users/${currentUser.uid}/personal_schedule/${scheduleEditingId}`
                        : `dashboard/shared_schedule/${scheduleEditingId}`;
                    await update(ref(db, path), { date, endDate, subject, title, content, tags, updatedAt: Date.now() });
                } else if (isPersonal) {
                    await push(ref(db, `users/${currentUser.uid}/personal_schedule`), {
                        date, endDate, subject, title, content, tags, createdAt: Date.now()
                    });
                } else {
                    await push(ref(db, 'dashboard/shared_schedule'), {
                        date, endDate, subject, title, content, tags, source: 'manual',
                        authorName: getAuthorName(), authorUid: currentUser.uid, authorOriginal: currentUser.email || '', createdAt: Date.now()
                    });
                }
                document.getElementById('schedule-composer-modal').style.display = 'none';
            } catch (e) { alert('저장에 실패했습니다. (권한 또는 네트워크 오류)'); }
        }

        window.deleteScheduleEvent = async function(id) {
            if (!currentUser) return;
            const ev = scheduleCache[id];
            if (!ev) return;
            if (ev._source === 'shared' && !canWriteSchedule) return;
            if (!confirm('이 일정을 삭제하시겠습니까?')) return;
            const path = ev._source === 'personal' ? `users/${currentUser.uid}/personal_schedule/${id}` : `dashboard/shared_schedule/${id}`;
            try { await remove(ref(db, path)); renderScheduleDayList(); } catch (e) {}
        }

        // 팝오버가 열려 있는 동안의 "임시 선택 상태". `완료`를 눌러야 scheduleActiveTagFilter에 확정 반영된다.
        // 바깥 클릭/ESC로 닫으면 이 임시 상태는 버려지고 기존 필터가 유지된다.
        let scheduleTagFilterPending = new Set();

        function updateScheduleTagFilterBtnLabel() {
            const btn = document.getElementById('schedule-tag-filter-btn');
            if (!btn) return;
            const n = scheduleActiveTagFilter.size;
            btn.textContent = n > 0 ? `🏷 태그 · ${n}` : '🏷 태그';
        }

        function isScheduleTagFilterOpen() {
            const popup = document.getElementById('schedule-tag-filter-popup');
            return !!popup && popup.classList.contains('visible');
        }

        function closeScheduleTagFilterPopover() {
            const popup = document.getElementById('schedule-tag-filter-popup');
            if (popup) popup.classList.remove('visible');
        }

        window.toggleScheduleTagFilter = function(e) {
            if (e) e.stopPropagation();
            const popup = document.getElementById('schedule-tag-filter-popup');
            if (!popup) return;
            if (isScheduleTagFilterOpen()) { closeScheduleTagFilterPopover(); return; }

            scheduleTagFilterPending = new Set(scheduleActiveTagFilter);
            document.getElementById('schedule-tag-filter-options').innerHTML = SCHEDULE_DEFAULT_TAGS.map(t => `
                <label class="tag-filter-chip">
                    <input type="checkbox" class="schedule-tag-filter-cb" value="${t}" ${scheduleTagFilterPending.has(t) ? 'checked' : ''} style="accent-color:${scheduleTagColor(t)};" onchange="window.__scheduleTagFilterToggle(this)">
                    <span>${t}</span>
                </label>`).join('');
            popup.classList.add('visible');
        }

        window.__scheduleTagFilterToggle = function(cb) {
            if (cb.checked) scheduleTagFilterPending.add(cb.value); else scheduleTagFilterPending.delete(cb.value);
        }

        window.applyScheduleTagFilter = function(e) {
            if (e) e.stopPropagation();
            scheduleActiveTagFilter = new Set(scheduleTagFilterPending);
            closeScheduleTagFilterPopover();
            updateScheduleTagFilterBtnLabel();
            renderScheduleCalendar();
        }

        // 팝오버 바깥 클릭 시 닫기 (완료를 누르지 않았다면 필터 변경은 확정하지 않는다)
        document.addEventListener('click', (e) => {
            if (!isScheduleTagFilterOpen()) return;
            const anchor = document.getElementById('schedule-tag-filter-anchor');
            if (anchor && !anchor.contains(e.target)) closeScheduleTagFilterPopover();
        });
        // ESC로 닫기 (역시 완료 없이는 필터를 확정하지 않는다)
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && isScheduleTagFilterOpen()) closeScheduleTagFilterPopover();
        });

        // 기존 수행평가(Firestore calendar)를 반 공용 일정에 자동 반영한다.
        // push()가 아닌 결정적 키(assess_{examId})로 set()하여, 다시 열어도 중복 생성되지 않고
        // 원본 수행평가를 수정/삭제하면 그대로 갱신/삭제된다 (원본이 source of truth).
        function mirrorAssessmentToSchedule(examId, examEvent) {
            if (!examEvent) return;
            set(ref(db, `dashboard/shared_schedule/assess_${examId}`), {
                date: examEvent.date,
                subject: examEvent.subject || '',
                title: examEvent.title || examEvent.text || '수행평가',
                content: examEvent.description || '',
                tags: ['수행평가'],
                source: 'assessment',
                sourceId: examId,
                authorName: examEvent.teacher || '수행평가 자동 연동',
                createdAt: examEvent.createdAt || Date.now()
            }).catch(() => {});
        }
        function unmirrorAssessmentFromSchedule(examId) {
            remove(ref(db, `dashboard/shared_schedule/assess_${examId}`)).catch(() => {});
        }

        // =========================================================================
        // NEIS 학사일정 자동 연동 (한일고등학교)
        // - 기존 dashboard/shared_schedule / scheduleCache / renderScheduleCalendar()를 그대로 재사용한다.
        // - 이 블록이 관리하는 것은 source === 'neis' 인 항목뿐이며, manual/assessment 일정은 절대 건드리지 않는다.
        // - NEIS 인증키는 서버(Edge Function api-proxy)에만 있다. 브라우저는 프록시에 경로/조건만 보낸다.
        // =========================================================================
        const NEIS_SCHOOL_NAME = "한일고등학교";
        const neisProxyUrl = (path) => { const u = new URL(API_PROXY_URL); u.searchParams.set('service', 'neis'); u.searchParams.set('path', path); return u; };
        const NEIS_SCHOOL_INFO_CACHE_KEY = "hanilgo_neis_school_info";
        const NEIS_LAST_SYNC_KEY = "hanilgo_neis_last_sync";
        const NEIS_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6시간 - 열 때마다 과도하게 호출하지 않기 위한 최소 간격(브라우저별)
        const NEIS_RESULT_MESSAGES = {
            'INFO-200': '조회된 데이터가 없습니다.',
            'ERROR-290': '인증키가 유효하지 않습니다.',
            'ERROR-300': '필수 파라미터가 누락되었습니다.',
            'ERROR-336': '한 번에 요청 가능한 최대 건수(1,000건)를 초과했습니다.',
            'ERROR-337': '일일 트래픽 제한을 초과했습니다.'
        };
        let neisSyncTriggered = false;

        function neisResultMessage(code) { return NEIS_RESULT_MESSAGES[code] || `알 수 없는 응답 코드 (${code})`; }

        // NEIS 응답은 정상일 땐 [rootKey][0].head[1].RESULT, 오류/데이터없음일 땐 최상위 RESULT로 내려온다.
        function parseNeisResponse(json, rootKey) {
            const topResult = json && json.RESULT;
            if (topResult && topResult.CODE) return { code: topResult.CODE, rows: [] };
            const block = json && json[rootKey];
            const head = block && block[0] && block[0].head;
            const resultCode = (head && head[1] && head[1].RESULT && head[1].RESULT.CODE) || 'INFO-000';
            const rows = (block && block[1] && block[1].row) || [];
            return { code: resultCode, rows };
        }

        // 문자열을 안정적인 짧은 해시로 변환한다 (같은 입력 → 항상 같은 출력, Firebase key로 쓸 수 있는 문자만 사용).
        function stableHash(str) {
            let hash = 0;
            for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
            return hash.toString(36);
        }

        // 같은 NEIS 일정이면 재동기화해도 항상 같은 key가 나오도록 하는 결정적 ID (push() 대신 이걸 set 키로 쓴다).
        function makeNeisEventId(aaYmd, eventNm, eventCntnt) {
            return `neis_${aaYmd}_${stableHash(`${eventNm || ''}|${eventCntnt || ''}`)}`;
        }

        // 한일고등학교의 교육청 코드(ATPT_OFCDC_SC_CODE)/학교 코드(SD_SCHUL_CODE)를 조회한다.
        // 브라우저 localStorage에 캐시해서, 매번 학교 코드부터 다시 찾지 않도록 한다.
        async function fetchNeisSchoolInfo() {
            try {
                const cached = JSON.parse(localStorage.getItem(NEIS_SCHOOL_INFO_CACHE_KEY) || 'null');
                if (cached && cached.officeCode && cached.schoolCode) return cached;
            } catch (e) {}

            const url = neisProxyUrl('schoolInfo');
            url.searchParams.set('pIndex', '1');
            url.searchParams.set('pSize', '100');
            url.searchParams.set('SCHUL_NM', NEIS_SCHOOL_NAME);

            const json = await (await fetch(url.toString())).json();
            const { code, rows } = parseNeisResponse(json, 'schoolInfo');
            if (code === 'INFO-200') throw new Error(`NEIS ${code}: "${NEIS_SCHOOL_NAME}" 학교를 찾지 못했습니다.`);
            if (code !== 'INFO-000') throw new Error(`NEIS ${code}: ${neisResultMessage(code)}`);

            const exact = rows.find(r => r.SCHUL_NM === NEIS_SCHOOL_NAME) || rows[0];
            if (!exact) throw new Error(`NEIS: "${NEIS_SCHOOL_NAME}" 학교를 찾지 못했습니다.`);
            const info = { officeCode: exact.ATPT_OFCDC_SC_CODE, schoolCode: exact.SD_SCHUL_CODE, schoolName: exact.SCHUL_NM };
            try { localStorage.setItem(NEIS_SCHOOL_INFO_CACHE_KEY, JSON.stringify(info)); } catch (e) {}
            return info;
        }

        // 지정한 기간의 학사일정을 조회한다. 1,000건 제한을 지키기 위해 필요하면 pIndex를 늘려가며 페이지네이션한다.
        async function fetchNeisSchedule(officeCode, schoolCode, fromYmd, toYmd) {
            const pSize = 1000;
            let pIndex = 1;
            let all = [];
            while (pIndex <= 10) { // 안전장치: 최대 10페이지(1만 건)까지만
                const url = neisProxyUrl('SchoolSchedule');
                url.searchParams.set('pIndex', String(pIndex));
                url.searchParams.set('pSize', String(pSize));
                url.searchParams.set('ATPT_OFCDC_SC_CODE', officeCode);
                url.searchParams.set('SD_SCHUL_CODE', schoolCode);
                url.searchParams.set('AA_FROM_YMD', fromYmd);
                url.searchParams.set('AA_TO_YMD', toYmd);

                const json = await (await fetch(url.toString())).json();
                const { code, rows } = parseNeisResponse(json, 'SchoolSchedule');
                if (code === 'INFO-200') break; // 정상: 해당 기간에 데이터 없음
                if (code !== 'INFO-000') throw new Error(`NEIS ${code}: ${neisResultMessage(code)}`);

                all = all.concat(rows);
                if (rows.length < pSize) break; // 더 가져올 페이지 없음
                pIndex++;
            }
            return all;
        }

        // NEIS 학사일정을 기존 반 공용 일정(dashboard/shared_schedule)에 병합한다.
        // - source: 'neis' 인 항목만 이 함수가 관리하고, 'manual'/'assessment' 일정은 절대 건드리지 않는다.
        // - 결정적 key(makeNeisEventId)로 set() 하므로 여러 번 실행해도 중복 생성되지 않고 내용만 갱신된다.
        // - 이번 동기화 결과에 더 이상 없는 과거 NEIS 일정(source==='neis')은 삭제해 학사일정 변경/취소를 반영한다.
        async function syncNeisSchedules() {
            try {
                const { officeCode, schoolCode, schoolName } = await fetchNeisSchoolInfo();
                console.log(`✓ NEIS 학교정보 연결됨 (${schoolName})`);

                const year = new Date().getFullYear();
                const rows = await fetchNeisSchedule(officeCode, schoolCode, `${year}0101`, `${year}1231`);

                // 루트(ref(db))에 대한 멀티패스 update()는 Firebase 규칙에 따라 permission_denied가 날 수 있으므로,
                // 기존 mirrorAssessmentToSchedule/unmirrorAssessmentFromSchedule과 동일하게 경로별 set()/remove()를 쓴다.
                const seenIds = new Set();
                const writes = [];
                rows.forEach(row => {
                    const aaYmd = row.AA_YMD;
                    if (!aaYmd || aaYmd.length !== 8) return;
                    const date = `${aaYmd.slice(0, 4)}-${aaYmd.slice(4, 6)}-${aaYmd.slice(6, 8)}`;
                    const id = makeNeisEventId(aaYmd, row.EVENT_NM, row.EVENT_CNTNT);
                    seenIds.add(id);
                    writes.push(set(ref(db, `dashboard/shared_schedule/${id}`), {
                        date,
                        subject: '',
                        title: row.EVENT_NM || '학교 일정',
                        content: row.EVENT_CNTNT || '',
                        tags: ['학교일정', 'NEIS'],
                        source: 'neis',
                        school: NEIS_SCHOOL_NAME,
                        neisYmd: aaYmd,
                        createdAt: Date.now(), // shared_schedule의 RTDB 검증 규칙이 date/title/createdAt을 필수로 요구해서, 이게 없으면 매번 permission_denied로 조용히 실패해 캘린더에 하나도 안 뜨게 된다.
                        updatedAt: Date.now()
                    }));
                });

                // manual/assessment는 절대 건드리지 않고, source==='neis'인데 이번 응답에 없는 것만 삭제 대상으로 삼는다.
                Object.entries(scheduleCache).forEach(([id, ev]) => {
                    if (ev && ev.source === 'neis' && !seenIds.has(id)) writes.push(remove(ref(db, `dashboard/shared_schedule/${id}`)));
                });

                await Promise.all(writes);
                try { localStorage.setItem(NEIS_LAST_SYNC_KEY, String(Date.now())); } catch (e) {}
                console.log(`✓ ${NEIS_SCHOOL_NAME} 일정 ${seenIds.size}개 동기화`);
            } catch (e) {
                console.warn('⚠ NEIS 학사일정을 불러오지 못했습니다. 인증키 또는 API 요청 상태를 확인해주세요.');
                console.error('NEIS 동기화 실패:', e && e.message ? e.message : e);
            }
        }

        // 페이지를 열 때마다 과도하게 호출하지 않도록, 브라우저별로 최근 동기화 후 일정 시간 내에는 건너뛴다.
        // (여러 사용자가 같은 Firebase 데이터를 보므로, 어느 한 사용자가 동기화하면 나머지는 그 결과를 그대로 읽는다.)
        function shouldSyncNeisNow() {
            try {
                const last = parseInt(localStorage.getItem(NEIS_LAST_SYNC_KEY) || '0', 10);
                return (Date.now() - last) > NEIS_SYNC_INTERVAL_MS;
            } catch (e) { return true; }
        }

        // freeimage.host는 브라우저에서 직접 fetch하면 CORS로 100% 차단된다(콘솔에서 "No
        // 'Access-Control-Allow-Origin' header" 확인됨) - 요청 형식이 아니라 서버가 CORS 헤더를 아예
        // 안 보내는 문제라 클라이언트 코드로는 절대 우회 불가능하다. 그래서 자료실 업로드와 같은 방식으로,
        // Supabase Edge Function(upload-freeimage)이 서버에서 대신 업로드해준다(서버-서버 요청은 CORS
        // 제약이 없음). ⚠️ 이 Edge Function은 반드시 Supabase 프로젝트에 별도로 배포해야 동작한다 -
        // 배포 전까지는 이 함수가 항상 실패한다.
        const IMAGE_UPLOAD_MAX_SIZE = 60 * 1024 * 1024; // 60MB - freeimage.host 업로드 용량 제한
        async function uploadImageToFreeImageHost(file) {
            if (!currentUser) throw new Error('로그인이 필요합니다.');
            if (file.size > IMAGE_UPLOAD_MAX_SIZE) throw new Error('이미지 용량은 최대 60MB까지 업로드할 수 있습니다.');
            const idToken = await currentUser.getIdToken();
            const formData = new FormData();
            formData.append('firebaseIdToken', idToken);
            formData.append('source', file);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000);
            try {
                const resp = await fetch(FREEIMAGE_UPLOAD_FUNCTION_URL, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${SUPABASE_PUBLISHABLE_KEY}` }, // 파일 전송이라 Content-Type은 브라우저가 자동 설정하게 둔다
                    body: formData,
                    signal: controller.signal
                });
                const json = await resp.json().catch(() => ({}));
                if (!resp.ok || !json.url) {
                    console.error('freeimage.host 프록시 업로드 실패:', resp.status, json);
                    throw new Error(json.error || '업로드 실패');
                }
                return json.url;
            } catch (e) {
                if (e && e.name === 'AbortError') throw new Error('업로드 시간이 초과되었습니다 (네트워크 확인 필요)');
                throw e;
            } finally {
                clearTimeout(timeoutId);
            }
        }

        // 리치 본문(contentHTML) 안에 인라인으로 삽입된 <img>들의 src만 순서대로 뽑아낸다.
        // 리치 본문 속 <img> 엘리먼트 자체를 뽑아낸다 (src뿐 아니라 작성 시 조절한 width 스타일도 함께 보존하기 위해)
        function extractImageElsFromHTML(html) {
            if (!html) return [];
            const tmp = document.createElement('div');
            tmp.innerHTML = sanitizeRichHTML(html);
            return Array.from(tmp.querySelectorAll('img'));
        }

        // 상세화면 전용: 리치 본문이 있으면 이미지가 이미 본문 안에 자연스럽게 표시되므로,
        // 아래에 별도 그리드로 또 보여주면 중복이 된다. 그래서 리치 본문이 있으면 빈 배열을 돌려주고,
        // 레거시(첨부 방식) 게시글에서만 기존처럼 imageUrls/img를 그리드로 보여준다.
        function getLegacyAttachedImages(post) {
            if (Array.isArray(post.imageUrls) && post.imageUrls.length > 0) return post.imageUrls.filter(Boolean);
            if (post.img) return [post.img];
            return [];
        }
        function getPostImages(post) {
            if (post.contentHTML && post.contentHTML.trim()) return [];
            return getLegacyAttachedImages(post);
        }

        // 피드(목록) 전용 미리보기: 글 전문이 아니라 "줄글 기준 앞 3줄"까지만 보여준다.
        // 예전에는 본문 텍스트는 짧게 줄이면서 본문 속 사진은 전부 원래 크기로 아래에 펼쳐서, 사진이 많은 글 하나가 한 페이지를 다 차지했다.
        //  - 본문이 글로 시작하면: 앞 3줄만(사진은 목록에서 숨김, 상세화면에서 본다).
        //  - 본문이 사진으로 시작하면: 그 사진 한 장만 3줄 높이로 축소한 썸네일로 보여주고, 이어지는 글이 있으면 그 옆에 3줄까지 보여준다.
        // "처음이 글인지 사진인지"는 본문 순서(문서 순서)를 그대로 따라 첫 의미 있는 노드로 판단한다.
        function buildFeedPreview(post) {
            let thumb = '', count = 0;
            const html = post && post.contentHTML && post.contentHTML.trim() ? post.contentHTML : '';
            if (html) {
                const tmp = document.createElement('div');
                tmp.innerHTML = sanitizeRichHTML(html);
                const imgs = [...tmp.querySelectorAll('img[src]')];
                count = imgs.length;
                if (imgs.length) thumb = imgs[0].getAttribute('src'); // 본문 어디에 있든 첫 사진을 작게 보여준다
            }
            if (!thumb) {
                // 레거시(첨부 방식) 글의 첨부 사진
                const imgs = getLegacyAttachedImages(post);
                count = imgs.length;
                if (imgs.length) thumb = imgs[0];
            }
            return { thumb, count, text: richContentPreviewText(post, 'contentHTML', 'content', 400) };
        }
        function renderFeedPreview(post) {
            const { thumb, count, text } = buildFeedPreview(post);
            const bodyHtml = text ? `<p class="feed-post-body">${escapeNoticeText(text)}</p>` : '';
            if (!thumb) return bodyHtml;
            const more = count > 1 ? `<span class="feed-post-thumb-count">+${count - 1}</span>` : '';
            return `<div class="feed-post-preview has-thumb" data-fit-thumb="1"><span class="feed-post-thumb-wrap"><img class="feed-post-thumb" src="${escapeNoticeText(thumb)}" loading="lazy" onerror="this.style.display='none'">${more}</span>${bodyHtml}</div>`;
        }
        // 사진은 목록에서 아주 작게(글 2줄 높이) 보여주되, 글 + 사진이 합쳐 6줄 높이 이상이 되면(= 글이 4줄 이상) 사진은 빼고 글만 보여준다.
        // 줄 수는 실제로 그려진 글의 높이로 판단한다(화면 폭/글자 크기에 따라 달라지므로). 사진이 차지하는 줄 수만큼 글 영역이 좁아진 상태에서 잰다.
        const FEED_THUMB_LINES = 2, FEED_MAX_LINES = 6;
        function fitFeedPreviews(root) {
            (root || document).querySelectorAll('.feed-post-preview[data-fit-thumb]').forEach(box => {
                const body = box.querySelector('.feed-post-body');
                if (!body) return; // 글이 없고 사진만 있는 글은 사진 그대로
                const lh = parseFloat(getComputedStyle(body).lineHeight) || 21;
                const h = body.scrollHeight; // 줄 수 제한(clamp)과 상관없이 전체 글 높이
                if (!h) return; // 숨겨져 있어서 잴 수 없을 때는 그대로 둔다
                const textLines = Math.round(h / lh);
                box.classList.toggle('thumb-hidden', textLines + FEED_THUMB_LINES >= FEED_MAX_LINES);
            });
        }
        let fitFeedTimer = null;
        window.addEventListener('resize', () => { clearTimeout(fitFeedTimer); fitFeedTimer = setTimeout(() => fitFeedPreviews(), 150); });

        function renderPostImageGrid(images) {
            if (!images || images.length === 0) return '';
            const countClass = `count-${Math.min(images.length, 4)}`;
            return `<div class="post-img-grid ${countClass}">${images.map(url => `<img src="${url}" onerror="this.style.display='none'">`).join('')}</div>`;
        }

        let communityEditingPostId = null; // null이면 새 글 작성, 값이 있으면 해당 게시글을 수정 중

        window.handlePostSubmit = async function() {
            const titleInput = document.getElementById('post-title'); const contentInput = document.getElementById('post-content');
            if (isRichEditorUploadingImage('post-content')) return alert('이미지를 업로드하는 중이에요. 잠시 후 다시 눌러주세요.');
            const rawHTML = contentInput.innerHTML.trim();
            const plainText = (contentInput.textContent || '').trim();
            if(!titleInput.value.trim() || !plainText) return alert("제목과 내용을 모두 입력해주세요.");
            if (!currentUser) return showLoginScreen(() => handlePostSubmit());
            if (currentUserInfo.role !== 'class2_member') return alert("권한이 없습니다.");

            const submitBtn = document.querySelector("button[onclick='handlePostSubmit()']");
            try {
                if (communityEditingPostId) {
                    // 수정: 작성자/좋아요/댓글/작성일 등은 그대로 두고 제목·본문만 바꾼다.
                    const original = latestPostsData[communityEditingPostId];
                    if (!original || (original.authorId !== currentUser.uid && !isAdmin && !isSubAdmin && !isOperator)) return alert("수정 권한이 없습니다.");
                    await updateDoc(doc(fdb, 'posts', communityEditingPostId), {
                        title: titleInput.value,
                        content: plainText,
                        contentHTML: sanitizeRichHTML(rawHTML),
                        updatedAt: Date.now()
                    });
                } else {
                    await addDoc(collection(fdb, 'posts'), {
                        title: titleInput.value,
                        content: plainText, // 검색/업적 등 기존 코드가 읽는 일반 텍스트 (하위호환용)
                        contentHTML: sanitizeRichHTML(rawHTML), // 서식 + 본문 내 이미지가 함께 들어있는 리치 콘텐츠
                        imageUrls: [], // 5.0: 별도 사진 첨부 방식은 제거하고 리치 에디터의 이미지 삽입으로 통합
                        authorId: currentUser.uid, 
                        authorName: getAuthorName(), 
                        authorOriginal: currentUser.email || getAuthorOriginal(),
                        createdAt: Date.now(), likeCount: 0
                    });
                    if (window.completeDailyMission) window.completeDailyMission('communityPost', 30, '커뮤니티 게시글');
                }
                titleInput.value = ""; contentInput.innerHTML = "";
                communityEditingPostId = null;
                if (submitBtn) submitBtn.innerText = "게시하기";
                if (window.closeCommunityCompose) closeCommunityCompose();
            } catch(e) { if (submitBtn) submitBtn.innerText = "게시하기"; alert(communityEditingPostId ? "게시글 수정 실패" : "글 등록 실패"); }
        }

        // ⋯ 메뉴 > 수정: 기존 글쓰기 화면을 그대로 재사용하되, 현재 내용을 채워 넣고 "수정" 모드로 연다.
        window.editPost = function(postId) {
            const post = latestPostsData[postId];
            const canEdit = post && currentUser && (post.authorId === currentUser.uid || isAdmin || isSubAdmin || isOperator);
            if (!canEdit) return alert("수정 권한이 없습니다.");
            document.querySelectorAll('.post-menu-dropdown.open').forEach(el => el.classList.remove('open'));
            communityEditingPostId = postId;
            openCommunityCompose();
            document.getElementById('post-title').value = post.title || '';
            const contentEditable = document.getElementById('post-content');
            contentEditable.innerHTML = post.contentHTML && post.contentHTML.trim()
                ? sanitizeRichHTML(post.contentHTML)
                : escapeNoticeText(post.content || '').replace(/\n/g, '<br>');
            const composeTitleEl = document.querySelector('.community-compose-title');
            if (composeTitleEl) composeTitleEl.textContent = '게시글 수정';
            const submitBtn = document.querySelector("button[onclick='handlePostSubmit()']");
            if (submitBtn) submitBtn.innerText = "수정하기";
        };

        // ⋯ 게시글 메뉴 (삭제 등). 한 번에 하나만 열리도록 나머지는 닫는다.
        window.togglePostMenu = function(postId) {
            const target = document.getElementById(`post-menu-${postId}`);
            const wasOpen = target && target.classList.contains('open');
            document.querySelectorAll('.post-menu-dropdown.open').forEach(el => el.classList.remove('open'));
            if (target && !wasOpen) target.classList.add('open');
        };
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.post-menu-wrap')) {
                document.querySelectorAll('.post-menu-dropdown.open').forEach(el => el.classList.remove('open'));
            }
        });

        window.deletePost = async function(postId, authorId) {
            if (!currentUser) return;
            const canDel = currentUser.uid === authorId || isAdmin || isSubAdmin;
            if (!canDel) return alert("본인의 글만 삭제할 수 있습니다. (관리자 예외)");
            if (confirm("정말 이 게시글을 삭제하시겠습니까?")) {
                try {
                    await deleteDoc(doc(fdb, 'posts', postId));
                } catch (e) {
                    alert("삭제 실패: " + (e && e.message ? e.message : e) + "\n(Firestore 보안 규칙에서 관리자 권한 삭제가 허용되어 있는지 확인이 필요합니다)");
                }
            }
        }

        // 좋아요/좋아요 수: 클릭 즉시 화면부터 바꾸고(낙관적 UI), 그 다음 Firestore 트랜잭션으로 실제 반영한다.
        // 실패하면 원래 상태로 되돌린다. (RTDB 시절과 동일한 원칙 - 실제 추가/취소 결과에 따라서만 likeCount를 ±1 한다.)
        window.toggleLike = async function(postId) {
            if (!currentUser) return showLoginScreen(() => toggleLike(postId));
            const btn = document.getElementById(`like-btn-${postId}`);
            let optimisticLiked = null;
            if (btn) {
                optimisticLiked = !btn.classList.contains('liked');
                const countEl = btn.querySelector('.like-count');
                const prevCount = countEl ? parseInt(countEl.textContent) || 0 : 0;
                btn.classList.toggle('liked', optimisticLiked);
                btn.innerHTML = `${optimisticLiked ? '❤️' : '🤍'} <span class="like-count">${Math.max(0, prevCount + (optimisticLiked ? 1 : -1))}</span>`;
            }
            try {
                const postRef = doc(fdb, 'posts', postId);
                await fsRunTransaction(fdb, async (tx) => {
                    const snap = await tx.get(postRef);
                    if (!snap.exists()) return;
                    const data = snap.data();
                    const likes = data.likes || {};
                    const liked = !likes[currentUser.uid];
                    if (liked) likes[currentUser.uid] = true; else delete likes[currentUser.uid];
                    const likeCount = Math.max(0, (typeof data.likeCount === 'number' ? data.likeCount : 0) + (liked ? 1 : -1));
                    tx.update(postRef, { likes, likeCount });
                });
                // 미션: 좋아요 처리가 실제로 성공했고, "새로 누른" 경우(취소 아님)이면서, 본인 글이 아닐 때만 인정
                const postData = latestPostsData[postId];
                if (optimisticLiked && postData && postData.authorId !== currentUser.uid && window.completeDailyMission) {
                    window.completeDailyMission('likePost', 10, '좋아요 누르기');
                }
                // 성공하면 곧 onSnapshot이 실제 값으로 다시 렌더링해준다.
            } catch (e) {
                console.warn('좋아요 처리 중 오류:', e);
                if (btn && optimisticLiked !== null) {
                    // 실패했으니 되돌린다
                    btn.classList.toggle('liked', !optimisticLiked);
                    const countEl = btn.querySelector('.like-count');
                    const cur = countEl ? parseInt(countEl.textContent) || 0 : 0;
                    btn.innerHTML = `${!optimisticLiked ? '❤️' : '🤍'} <span class="like-count">${Math.max(0, cur - (optimisticLiked ? 1 : -1))}</span>`;
                }
            }
        }

        window.addComment = async function(postId) {
            if (!currentUser) return showLoginScreen(() => addComment(postId));
            const commentInput = document.getElementById(`reply-${postId}`);
            if (!commentInput || !commentInput.value.trim()) return;
            await addDoc(collection(fdb, 'posts', postId, 'comments'), {
                authorId: currentUser.uid, 
                authorName: getAuthorName(), 
                authorOriginal: currentUser.email || getAuthorOriginal(), 
                content: commentInput.value, createdAt: Date.now()
            });
            commentInput.value = "";
            // 미션: 댓글이 정상 저장됐고, 본인 글이 아닐 때만 인정
            const postData = latestPostsData[postId];
            if (postData && postData.authorId !== currentUser.uid && window.completeDailyMission) {
                window.completeDailyMission('commentPost', 15, '댓글 달기');
            }
        }

        window.deleteComment = async function(postId, commentId, commentAuthorId) {
            if (!currentUser) return;
            const canDel = currentUser.uid === commentAuthorId || isAdmin || isSubAdmin;
            if (!canDel) return alert("권한이 없습니다.");
            if (confirm("댓글을 삭제하시겠습니까?")) {
                try {
                    await deleteDoc(doc(fdb, 'posts', postId, 'comments', commentId));
                } catch (e) {
                    alert("삭제 실패: " + (e && e.message ? e.message : e) + "\n(Firestore 보안 규칙에서 관리자 권한 삭제가 허용되어 있는지 확인이 필요합니다)");
                }
            }
        }

        window.editComment = async function(postId, commentId) {
            if (!currentUser) return;
            const cRef = doc(fdb, 'posts', postId, 'comments', commentId);
            const snap = await getDoc(cRef);
            const comment = snap.exists() ? snap.data() : null;
            if (!comment) return;
            if (currentUser.uid !== comment.authorId) return alert("본인 댓글만 수정할 수 있습니다.");
            const newContent = prompt("댓글 수정:", comment.content);
            if (newContent === null) return;
            if (!newContent.trim()) return alert("내용을 입력해주세요.");
            await updateDoc(cRef, { content: newContent.trim(), editedAt: Date.now() });
        }

        // authorOriginal은 대부분 로그인 이메일 형식("20261206@hanilgo.cnehs.kr" = 연도+학년+반+번호)이고,
        // 이메일이 없을 때만 과거 호환용으로 "6번" 같은 문자열이 들어온다. 두 형식 모두에서 학년/반/번호를 뽑아낸다.
        function parseIdentityFromOriginal(authorOriginal) {
            if (!authorOriginal) return null;
            const emailMatch = /^\d{4}(\d)(\d)(\d{2})@hanilgo\.cnehs\.kr$/i.exec(authorOriginal.trim());
            if (emailMatch) return { grade: emailMatch[1], ban: emailMatch[2], number: parseInt(emailMatch[3]) };
            const numMatch = /^(\d+)\s*번$/.exec(authorOriginal.trim());
            if (numMatch) return { grade: '1', ban: '2', number: parseInt(numMatch[1]) }; // "N번" 형식은 항상 1-2반 표기이므로 이 반으로 간주
            return null;
        }

        const TEACHER_98_DISPLAY_NAME = '신중곤 선생님';
        // 1학년 2반 98번(담임교사) 계정인지 판별한다. Firebase의 실제 email/grade/ban/number는 전혀 건드리지 않고,
        // "화면에 보여줄 이름"을 결정할 때만 사용한다.
        function isTeacher98Identity(grade, ban, number) {
            return grade === '1' && ban === '2' && parseInt(number) === 98;
        }
        function isTeacher98Original(authorOriginal) {
            const p = parseIdentityFromOriginal(authorOriginal);
            return !!p && isTeacher98Identity(p.grade, p.ban, p.number);
        }
        // 담임교사 계정은 학번 형식 이메일을 쓰지 않아 authorOriginal 파싱이 실패할 수 있다(원가입 이메일이
        // 학생용 4자리+학년+반+번호 패턴이 아님). 이 경우를 대비해, 닉네임을 따로 설정하지 않았을 때 자동으로
        // 채워지는 "2반 98번" 형식의 원본 표시 문자열 자체도 함께 검사한다.
        function isTeacher98RawName(rawName) {
            if (!rawName) return false;
            const m = /^(\d+)\s*반\s*(\d+)\s*번$/.exec(String(rawName).trim());
            return !!m && m[1] === '2' && parseInt(m[2]) === 98;
        }
        // 공용 표시명 함수 - 98번 담임교사는 항상 "신중곤 선생님"으로 강제하고, 그 외에는 기존 닉네임을 그대로 쓴다.
        // 커뮤니티/아카이브/댓글/공지/일정/온라인현황 등 이름을 보여주는 모든 곳에서 원본 닉네임 대신 이 함수를 거친다.
        // (이름 효과/배지 같은 cosmetic은 이 함수가 반환한 표시명 위에 그대로 적용되므로 별도 처리가 필요 없다.)
        // 글/댓글에는 쓴 시점의 닉네임(authorName)이 박제되어 있다. 닉네임을 바꾼 뒤에도 예전 글에 바뀐 이름이 보이도록,
        // 작성자가 본인 profiles/student_{번호}.nickname에 미러링해 둔 현재 닉네임이 있으면 그 값을 우선한다(''이면 닉네임 해제 = 반/번호 표기).
        // 아직 미러링한 적 없는 작성자는 예전처럼 박제된 이름을 그대로 쓴다.
        function mirroredNicknameFor(authorOriginal) {
            const p = parseIdentityFromOriginal(authorOriginal);
            if (!p || p.grade !== '1' || p.ban !== '2' || p.number < 1 || p.number > 26) return null;
            const nick = (profilesData[`student_${p.number}`] || {}).nickname;
            if (typeof nick !== 'string') return null;
            return nick || `${p.ban}반 ${p.number}번`;
        }
        function resolveDisplayName(rawName, authorOriginal) {
            if (isTeacher98Original(authorOriginal) || isTeacher98RawName(rawName)) return TEACHER_98_DISPLAY_NAME;
            return mirroredNicknameFor(authorOriginal) || rawName;
        }

        // authorOriginal에서 학생 번호를 뽑아 그 학생의 프로필 cosmetic을 계산한다.
        // 커뮤니티/아카이브/댓글 작성자 표시에 공통으로 사용한다 - 새로운 데이터를 읽지 않고 이미 구독 중인
        // profilesData(Firestore profiles)를 그대로 재사용한다.
        function appearanceForAuthorOriginal(authorOriginal) {
            const p = parseIdentityFromOriginal(authorOriginal);
            if (p && p.grade === '1' && p.ban === '2' && p.number >= 1 && p.number <= 26) {
                const sData = profilesData[`student_${p.number}`] || {};
                return getStudentAppearance(p.number, sData);
            }
            // 1230 운영자 본인이 자기 화면에서 볼 때만: 꾸미기 테스트 모드에서 적용해 둔 값을 보여준다(다른 사람 화면에는 영향 없음).
            if (isOperator && authorOriginal && authorOriginal.trim().toLowerCase() === OPERATOR_EMAIL.toLowerCase()) return operatorTestAppearance();
            return getProfileAppearance(0, null); // 담임/타반 등은 기본값(효과 없음)으로 표시
        }

        // 관리자 화면에서만 보이는 "[원본 식별자]" 표시 - 98번 담임교사는 이메일/학번이 그대로 노출되지 않도록
        // 관리자에게도 원본 대신 "[담임교사]"만 보여준다 (표시명 강제와 동일한 원칙).
        function adminOriginalTag(authorOriginal) {
            return isTeacher98Original(authorOriginal) ? '담임교사' : authorOriginal;
        }

        // Firestore에서는 댓글이 posts/{postId}/comments 서브컬렉션이라 posts 문서 자체에는 포함되지 않는다.
        // (RTDB 시절엔 posts/{id} 안에 comments가 통째로 들어있어 한 번의 onValue로 다 읽혔지만, Firestore
        // 서브컬렉션은 부모 문서를 읽어도 같이 딸려오지 않는다.) 그래서 게시글 목록과는 별개로,
        // 게시글마다 comments 서브컬렉션을 각각 구독해서 캐시에 모아두고 같이 렌더링한다.
        let postsCommentsCache = {}; // { postId: { commentId: commentData } }
        let postsCommentUnsubscribers = {}; // { postId: unsubscribeFn } - 더 이상 없는 게시글의 구독은 해제한다

        // 5.0 커뮤니티 전면 재설계: 서버에서 새로 읽지 않고, 이미 구독 중인 postsData를 클라이언트에서
        // 필터링/정렬만 다시 한다. 데이터 구조(Firestore 스키마)는 전혀 바꾸지 않는다.
        let communityTab = 'all'; // 'all' | 'latest' | 'popular' (사진은 별도 탭이 아니라 게시글 콘텐츠로만 표현한다)
        window.setCommunityTab = function(tab) {
            communityTab = tab;
            gmwResetPage('communityFeed');
            document.querySelectorAll('.community-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
            renderPostsList(latestPostsData);
        };

        // ===================== 공용 목록 페이지네이션 (커뮤니티/공지/자료실/공유음악 공용) =====================
        // 목록이 누적 3000px를 넘으면 다음 페이지로 나눈다. 글/자료마다 이미지 유무·길이가 달라서
        // 페이지당 개수는 고정이 아니라 실제 렌더링된 높이를 매번 재서 계산한다.
        // 2열 그리드(자료실/공유음악)도 같은 알고리즘으로 처리하기 위해, 개별 아이템이 아니라
        // 화면에 실제로 같은 줄(row)로 놓인 아이템들을 offsetTop으로 묶어서 "행" 단위로 누적한다 -
        // 세로 1열 목록(커뮤니티/공지)에서는 각 아이템이 그 자체로 한 행이 되어 동일하게 동작한다.
        const GMW_PAGE_HEIGHT_LIMIT = 3000;
        const gmwPaginationState = {}; // listId -> { page, lastQuery }
        const gmwPaginationRecalcTimers = {};
        const gmwPageListConfig = {}; // listId -> { rerender, scrollHostId } - registered per list below

        function gmwPageState(listId) {
            return gmwPaginationState[listId] || (gmwPaginationState[listId] = { page: 1, lastQuery: '' });
        }
        function gmwResetPage(listId) { gmwPageState(listId).page = 1; }
        function gmwResetPageIfQueryChanged(listId, query) {
            const state = gmwPageState(listId);
            if (query !== state.lastQuery) { state.lastQuery = query; state.page = 1; }
        }

        function gmwApplyPagination(listId, container, itemSelector) {
            const state = gmwPageState(listId);
            const oldBar = container.querySelector('.gmw-pagination-bar');
            if (oldBar) oldBar.remove();
            const items = Array.from(container.querySelectorAll(itemSelector));
            if (items.length === 0) return;

            // 같은 top에 놓인 아이템들을 한 행으로 묶는다 (그리드면 여러 개, 1열 목록이면 항상 1개).
            const rows = [];
            items.forEach(el => {
                const top = Math.round(el.offsetTop);
                let row = rows.find(r => Math.abs(r.top - top) < 2);
                if (!row) { row = { top, items: [] }; rows.push(row); }
                row.items.push(el);
            });
            rows.sort((a, b) => a.top - b.top);

            let cumulative = 0, page = 1;
            const pageOfRow = [];
            rows.forEach((row, i) => {
                // 다음 행과의 top 차이를 쓰면 margin이든 grid gap이든 실제 화면 간격이 그대로 반영된다.
                // 마지막 행은 다음 행이 없으니 그냥 자기 내용 높이를 쓴다.
                let rowHeight;
                if (i < rows.length - 1) {
                    rowHeight = rows[i + 1].top - row.top;
                } else {
                    rowHeight = Math.max(...row.items.map(el => el.offsetHeight));
                }
                if (cumulative > 0 && cumulative + rowHeight > GMW_PAGE_HEIGHT_LIMIT) { page++; cumulative = 0; }
                cumulative += rowHeight;
                pageOfRow.push(page);
            });
            const totalPages = page;

            if (state.page > totalPages) state.page = totalPages;
            if (state.page < 1) state.page = 1;

            rows.forEach((row, i) => {
                const show = pageOfRow[i] === state.page;
                row.items.forEach(el => { el.style.display = show ? '' : 'none'; });
            });

            if (totalPages > 1) {
                container.insertAdjacentHTML('beforeend', gmwPaginationBarHTML(listId, state.page, totalPages));
            }
        }

        function gmwPaginationBarHTML(listId, currentPage, totalPages) {
            const groupSize = 5;
            const groupStart = Math.floor((currentPage - 1) / groupSize) * groupSize + 1;
            const groupEnd = Math.min(groupStart + groupSize - 1, totalPages);
            let html = '<div class="gmw-pagination-bar community-pagination">';
            if (groupStart > 1) {
                html += `<button class="community-page-arrow" onclick="gmwGoToPage('${listId}', ${groupStart - 1})">&lt;</button>`;
            }
            for (let p = groupStart; p <= groupEnd; p++) {
                html += `<button class="community-page-btn ${p === currentPage ? 'active' : ''}" onclick="gmwGoToPage('${listId}', ${p})">${p}</button>`;
            }
            if (groupEnd < totalPages) {
                html += `<button class="community-page-arrow" onclick="gmwGoToPage('${listId}', ${groupEnd + 1})">&gt;</button>`;
            }
            html += '</div>';
            return html;
        }

        window.gmwGoToPage = function(listId, page) {
            gmwPageState(listId).page = page;
            const cfg = gmwPageListConfig[listId];
            if (cfg && cfg.rerender) cfg.rerender();
            const scrollHost = cfg && cfg.scrollHostId ? document.getElementById(cfg.scrollHostId) : null;
            if (scrollHost) scrollHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };

        // 이미지가 로드되기 전엔 높이를 알 수 없어서 페이지 경계 계산이 틀어질 수 있다.
        // 이미지 로드가 끝날 때마다 페이지네이션을 다시 계산해서 보정한다.
        function gmwBindImageRecalc(listId, container, itemSelector) {
            container.querySelectorAll('img:not([data-pgbound])').forEach((img) => {
                img.dataset.pgbound = '1';
                if (img.complete) return; // 이미 캐시돼서 로드 완료 상태면 최초 measurement에 이미 반영돼 있다
                const handler = () => {
                    if (gmwPaginationRecalcTimers[listId]) clearTimeout(gmwPaginationRecalcTimers[listId]);
                    gmwPaginationRecalcTimers[listId] = setTimeout(() => {
                        if (document.body.contains(container)) gmwApplyPagination(listId, container, itemSelector);
                    }, 150);
                };
                img.addEventListener('load', handler, { once: true });
                img.addEventListener('error', handler, { once: true });
            });
        }

        // 목록별 등록: 페이지 버튼을 누르면 어떤 함수를 다시 불러서 다시 그릴지, 페이지 이동 시 어디로
        // 스크롤할지. 실제 등록된 시점과 무관하게 클릭 시점에만 호출되므로 아래에서 선언되는 함수를
        // 참조해도 안전하다.
        gmwPageListConfig.communityFeed = { rerender: () => renderPostsList(latestPostsData), scrollHostId: 'community-feed-view' };
        gmwPageListConfig.noticeHub = { rerender: () => renderNoticeHub(), scrollHostId: 'notice-hub-feed-view' };
        gmwPageListConfig.materials = { rerender: () => renderMergedMaterials(), scrollHostId: 'tab-materials' };
        gmwPageListConfig.sharedMusic = { rerender: () => renderSharedMusicList(), scrollHostId: 'music-panel-shared' };

        // --- 피드 / 글쓰기 / 상세 화면 전환 ---
        let communityView = 'feed'; // 'feed' | 'compose' | 'detail'
        let communityDetailPostId = null;

        // "+ 글쓰기" / 빠른 글쓰기 트리거는 항상 새 글 작성으로 시작한다 (수정 중이던 상태가 있으면 초기화)
        window.startNewPost = function() {
            if (!currentUser) return showLoginScreen(() => startNewPost());
            if (currentUserInfo.role !== 'class2_member') return alert("권한이 없습니다.");
            communityEditingPostId = null;
            const titleInput = document.getElementById('post-title');
            const contentEditable = document.getElementById('post-content');
            if (titleInput) titleInput.value = '';
            if (contentEditable) contentEditable.innerHTML = '';
            const composeTitleEl = document.querySelector('.community-compose-title');
            if (composeTitleEl) composeTitleEl.textContent = '글쓰기';
            const submitBtn = document.querySelector("button[onclick='handlePostSubmit()']");
            if (submitBtn) submitBtn.innerText = "게시하기";
            openCommunityCompose();
        };

        window.openCommunityCompose = function() {
            if (!currentUser) return showLoginScreen(() => openCommunityCompose());
            if (currentUserInfo.role !== 'class2_member') return alert("권한이 없습니다.");
            communityView = 'compose';
            document.getElementById('community-feed-view').style.display = 'none';
            document.getElementById('community-detail-view').style.display = 'none';
            document.getElementById('community-compose-view').style.display = 'block';
        };
        window.closeCommunityCompose = function() {
            communityView = 'feed';
            communityEditingPostId = null; // 취소/닫기 시 수정 상태도 초기화
            document.getElementById('community-compose-view').style.display = 'none';
            document.getElementById('community-detail-view').style.display = 'none';
            document.getElementById('community-feed-view').style.display = 'block';
            renderPostsList(latestPostsData);
        };
        window.openPostDetail = function(postId) {
            communityView = 'detail';
            communityDetailPostId = postId;
            document.getElementById('community-feed-view').style.display = 'none';
            document.getElementById('community-compose-view').style.display = 'none';
            document.getElementById('community-detail-view').style.display = 'block';
            renderPostsList(latestPostsData);
        };
        window.closePostDetail = function() {
            communityView = 'feed';
            communityDetailPostId = null;
            document.getElementById('community-detail-view').style.display = 'none';
            document.getElementById('community-compose-view').style.display = 'none';
            document.getElementById('community-feed-view').style.display = 'block';
            renderPostsList(latestPostsData);
        };

        function listenToPosts() {
            onSnapshot(collection(fdb, 'posts'), (snapshot) => {
                const postsData = fsSnapshotToMap(snapshot);
                latestPostsData = postsData; // 활동 업적(게시글 합계) 계산용 캐시
                evaluateAndSyncAchievements();
                tryConsumePendingShareTarget();

                // 새로 생긴 게시글은 댓글 구독을 새로 걸고, 삭제된 게시글의 댓글 구독은 정리한다.
                Object.keys(postsData).forEach(postId => {
                    if (postsCommentUnsubscribers[postId]) return;
                    postsCommentUnsubscribers[postId] = onSnapshot(collection(fdb, 'posts', postId, 'comments'), (csnap) => {
                        postsCommentsCache[postId] = fsSnapshotToMap(csnap);
                        renderPostsList(postsData);
                    });
                });
                Object.keys(postsCommentUnsubscribers).forEach(postId => {
                    if (!postsData[postId]) {
                        postsCommentUnsubscribers[postId]();
                        delete postsCommentUnsubscribers[postId];
                        delete postsCommentsCache[postId];
                    }
                });

                renderPostsList(postsData);
            }, onReadDenied('커뮤니티 글'));
        }

        const COMMUNITY_SPECIAL_EMAIL = "20261211@hanilgo.cnehs.kr";

        function communityAuthorHTML(authorName, authorOriginal) {
            const isGod = (authorOriginal && authorOriginal.toLowerCase().includes(COMMUNITY_SPECIAL_EMAIL.toLowerCase()));
            if (isGod) return `<span class="god-mode-text">👑 ${authorName}</span>`; // 기존 11번 특수효과 - 그대로 유지
            const displayName = resolveDisplayName(authorName, authorOriginal);
            const styledName = renderStyledName(displayName, appearanceForAuthorOriginal(authorOriginal), null, escapeNoticeText);
            const isOperatorAuthor = authorOriginal && authorOriginal.toLowerCase().includes(OPERATOR_EMAIL.toLowerCase());
            if (isOperatorAuthor) return `${styledName} <strong style="color:var(--primary); font-size:11px;">[운영자]</strong>`; // 이메일은 노출하지 않고 역할 배지만 표시 (모든 사용자에게 보임)
            return (isAdmin || isSubAdmin) && authorOriginal ? `${styledName} <strong style="color:#ef4444; font-size:11px;">[${adminOriginalTag(authorOriginal)}]</strong>` : styledName;
        }

        // 댓글 목록 + 댓글 작성창을 상세 화면용으로 렌더링 (피드에는 댓글을 펼쳐두지 않는다 - 개수만 표시)
        function renderCommentsHTML(postId) {
            const postComments = postsCommentsCache[postId] || {};
            const entries = Object.entries(postComments).sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
            let html = `<div class="detail-comments-title">댓글 ${entries.length}개</div>`;
            if (entries.length === 0) {
                html += `<div style="color:var(--text-muted); font-size:13px; padding:6px 0 14px;">아직 댓글이 없습니다. 첫 댓글을 남겨보세요.</div>`;
            } else {
                entries.forEach(([commentId, comment]) => {
                    const isMyComment = currentUser && currentUser.uid === comment.authorId;
                    const canDelComment = isMyComment || isAdmin || isSubAdmin || isOperator;
                    const cAuthor = communityAuthorHTML(comment.authorName, comment.authorOriginal);
                    html += `
                        <div class="detail-comment-item">
                            <span class="detail-comment-name">${cAuthor}</span><span class="detail-comment-time">${formatCommentTime(comment.createdAt)}${comment.editedAt ? ' · 수정됨' : ''}</span>
                            <span class="detail-comment-actions">
                                ${isMyComment ? `<span onclick="editComment('${postId}', '${commentId}')" style="color:var(--primary);">수정</span>` : ''}
                                ${canDelComment ? `<span onclick="deleteComment('${postId}', '${commentId}', '${comment.authorId}')" style="color:#ef4444;">삭제</span>` : ''}
                            </span>
                            <div class="detail-comment-body">${renderContentWithEmojis(comment.content)}</div>
                        </div>
                    `;
                });
            }
            html += `
                <div class="detail-comment-composer">
                    <input type="text" id="reply-${postId}" placeholder="댓글을 남겨주세요...">
                    <button class="primary" onclick="addComment('${postId}')">등록</button>
                </div>
            `;
            return html;
        }

        function communityEmptyStateHTML(hasSearchOrFilter) {
            if (hasSearchOrFilter) {
                return `<div class="community-empty-state">해당하는 게시글이 없습니다.</div>`;
            }
            return `
                <div class="community-empty-state">
                    <div style="font-size:15px; font-weight:700; color:var(--text-main); margin-bottom:6px;">아직 이야기가 없어요.</div>
                    <div style="font-size:13.5px;">첫 번째 글을 남겨보세요.</div>
                    <button class="community-write-btn cta" onclick="startNewPost()">+ 글쓰기</button>
                </div>
            `;
        }

        // 게시글 목록/상세를 총괄하는 렌더러. 현재 communityView 상태에 따라 피드 목록 또는 상세 화면 하나를 그린다.
        function renderPostsList(postsData) {
            postsData = postsData || latestPostsData; // 인라인 HTML(oninput 등)에서 인자 없이 호출해도 항상 최신 캐시를 쓴다
            if (communityView === 'detail' && communityDetailPostId) {
                const feedContainer = document.getElementById('posts-container');
                if (feedContainer) feedContainer.innerHTML = ''; // 피드는 숨겨져 있으니 비워서 좋아요 버튼 id 중복을 막는다
                renderPostDetailView(postsData);
                return;
            }
            const detailEl = document.getElementById('community-detail-view');
            if (detailEl) detailEl.innerHTML = ''; // 상세화면은 숨겨져 있으니 비워서 좋아요 버튼 id 중복을 막는다
            renderFeedList(postsData);
        }
        window.renderPostsList = renderPostsList; // 검색창 등 인라인 이벤트 핸들러(oninput)는 window 스코프에서 찾으므로 명시적으로 노출

        function renderFeedList(postsData) {
                const container = document.getElementById('posts-container');
                if (!container) return;
                if (!postsData || Object.keys(postsData).length === 0) {
                    container.innerHTML = communityEmptyStateHTML(false);
                    return;
                }

                const searchInput = document.getElementById('community-search-input');
                const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
                let entries = Object.entries(postsData);
                if (query) {
                    entries = entries.filter(([, p]) => {
                        const authorText = resolveDisplayName(p.authorName, p.authorOriginal) || '';
                        return (p.title || '').toLowerCase().includes(query)
                            || (p.content || '').toLowerCase().includes(query)
                            || authorText.toLowerCase().includes(query);
                    });
                }

                if (communityTab === 'popular') {
                    entries.sort((a, b) => (b[1].likeCount || 0) - (a[1].likeCount || 0)); // 이미 좋아요 많은 순 - 뒤에서 reverse() 안 함
                } else {
                    entries.sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0)).reverse(); // 오래된순으로 정렬 후 뒤집어서 최신이 위로
                }

                if (entries.length === 0) {
                    container.innerHTML = communityEmptyStateHTML(true);
                    return;
                }

                let html = `<div class="feed-list">`;
                entries.forEach(([postId, post], idx) => {
                    const isMyPost = currentUser && currentUser.uid === post.authorId;
                    const hasLiked = post.likes && post.likes[currentUser.uid];
                    const canDelete = isMyPost || isAdmin || isSubAdmin || isOperator;
                    const displayAuthor = communityAuthorHTML(post.authorName, post.authorOriginal);
                    const commentCount = Object.keys(postsCommentsCache[postId] || {}).length;

                    html += `
                        <article class="feed-post" data-post-idx="${idx}" onclick="openPostDetail('${postId}')">
                            <div class="feed-post-meta">
                                <span class="feed-post-author">${displayAuthor}</span>
                                <span class="feed-post-date">${formatPostTimeOrDash(post.createdAt)}</span>
                            </div>
                            <div class="feed-post-title">${escapeNoticeText(post.title)}</div>
                            ${renderFeedPreview(post)}
                            <div class="feed-post-footer">
                                <span onclick="event.stopPropagation()">
                                    <span id="like-btn-${postId}" onclick="toggleLike('${postId}')" class="like-btn ${hasLiked ? 'liked' : ''}">${hasLiked ? '❤️' : '🤍'} <span class="like-count">${post.likeCount != null ? post.likeCount : '—'}</span></span>
                                    <span class="feed-comment-count" onclick="openPostDetail('${postId}')">💬 ${commentCount}</span>
                                </span>
                                ${canDelete ? `
                                    <span class="post-menu-wrap" onclick="event.stopPropagation()">
                                        <span class="post-menu-trigger" onclick="togglePostMenu('${postId}')">⋯</span>
                                        <div class="post-menu-dropdown" id="post-menu-${postId}">
                                            ${canDelete ? `<div class="post-menu-item" onclick="editPost('${postId}')">수정</div>` : ''}
                                            <div class="post-menu-item danger" onclick="deletePost('${postId}', '${post.authorId}')">삭제</div>
                                        </div>
                                    </span>
                                ` : ''}
                            </div>
                        </article>
                        ${idx < entries.length - 1 ? '<div class="feed-divider"></div>' : ''}
                    `;
                });
                html += `</div>`;
                container.innerHTML = html;
                fitFeedPreviews(container); // 쪽 나누기가 글 높이를 재기 전에 사진 표시 여부(글 4줄 이상이면 사진 숨김)를 먼저 정한다

                gmwResetPageIfQueryChanged('communityFeed', query);
                gmwApplyPagination('communityFeed', container, '.feed-post');
                gmwBindImageRecalc('communityFeed', container, '.feed-post');
        }

        function renderPostDetailView(postsData) {
            const detailEl = document.getElementById('community-detail-view');
            if (!detailEl) return;
            const post = postsData ? postsData[communityDetailPostId] : null;
            if (!post) { closePostDetail(); return; } // 삭제된 글이면 피드로 되돌아간다

            const postId = communityDetailPostId;
            const isMyPost = currentUser && currentUser.uid === post.authorId;
            const hasLiked = post.likes && post.likes[currentUser.uid];
            const canDelete = isMyPost || isAdmin || isSubAdmin || isOperator;
            const displayAuthor = communityAuthorHTML(post.authorName, post.authorOriginal);
            const commentCount = Object.keys(postsCommentsCache[postId] || {}).length;

            detailEl.innerHTML = `
                <div class="community-detail-card">
                    <div class="community-back-link" onclick="closePostDetail()">← 커뮤니티</div>
                    <div class="detail-meta">
                        <span>${displayAuthor} · ${formatPostTimeOrDash(post.createdAt)}</span>
                        <span onclick="sharePost('${postId}')" style="cursor:pointer; color:var(--primary); font-weight:600; font-size:12.5px; white-space:nowrap; margin-left:auto; margin-right:${canDelete ? '10px' : '0'};">🔗 공유</span>
                        ${canDelete ? `
                            <span class="post-menu-wrap">
                                <span class="post-menu-trigger" onclick="togglePostMenu('${postId}')">⋯</span>
                                <div class="post-menu-dropdown" id="post-menu-${postId}">
                                    ${canDelete ? `<div class="post-menu-item" onclick="editPost('${postId}')">수정</div>` : ''}
                                    <div class="post-menu-item danger" onclick="deletePost('${postId}', '${post.authorId}'); closePostDetail();">삭제</div>
                                </div>
                            </span>
                        ` : ''}
                    </div>
                    <h2 class="detail-title">${escapeNoticeText(post.title)}</h2>
                    <div class="detail-body">${renderRichOrPlain(post, 'contentHTML', 'content')}</div>
                    ${renderPostImageGrid(getPostImages(post))}
                    <div class="detail-actions">
                        <span id="like-btn-${postId}" onclick="toggleLike('${postId}')" class="like-btn ${hasLiked ? 'liked' : ''}">${hasLiked ? '❤️' : '🤍'} <span class="like-count">${post.likeCount != null ? post.likeCount : '—'}</span></span>
                        <span style="color:var(--text-muted); font-weight:600;">💬 댓글 ${commentCount}개</span>
                    </div>
                    ${renderCommentsHTML(postId)}
                </div>
            `;
        }

        // 게시글/댓글 본문을 안전하게 이스케이프한다. (맞춤 이모티콘 기능은 삭제되어 더 이상
        // [custom_emoji:ID] 토큰을 이미지로 치환하지 않는다 - 함수 이름은 다른 곳(댓글 렌더링)의
        // 호출부를 안 건드리기 위해 그대로 유지한다.)
        function renderContentWithEmojis(rawText) {
            return escapeNoticeText(rawText);
        }

        // =========================================================================
        // 📝 공용 리치 콘텐츠 시스템 (커뮤니티 / 공지사항 / 설문이 공유)
        //
        // 원칙:
        //  - 기존 일반 텍스트 필드(content, description 등)는 그대로 둔다. 새로 리치 텍스트로 작성된
        //    글만 별도 필드(예: contentHTML)에 저장하고, 렌더링 시 contentHTML이 있으면 그걸 쓰고
        //    없으면 기존 방식(renderContentWithEmojis)으로 자연스럽게 폴백한다. → 기존 데이터 100% 호환.
        //  - 저장/렌더링 전에 반드시 sanitizeRichHTML()을 거친다. script, on*, javascript: 등은 전부 제거.
        //  - 목록/위젯/PIP처럼 작은 공간에서는 richContentPreviewText()로 텍스트만 뽑아 짧게 자른다.
        // =========================================================================

        // 허용 태그/속성 화이트리스트 기반 sanitizer. contenteditable에서 나온 HTML만 통과시킨다.
        const RICH_ALLOWED_TAGS = new Set(['B','STRONG','I','EM','U','S','STRIKE','P','DIV','BR','SPAN','A','IMG','UL','OL','LI','BLOCKQUOTE']);
        const RICH_ALLOWED_STYLE_PROPS = new Set(['color', 'font-size', 'text-align', 'width', 'max-width', 'height', 'clear']);
        const RICH_FONT_SIZE_MAP = { 1: 10, 2: 13, 3: 16, 4: 18, 5: 24, 6: 32, 7: 48 }; // 예전 <font size> 값 → px
        const RICH_FONT_MIN = 8, RICH_FONT_MAX = 72;
        function sanitizeRichHTML(html) {
            if (!html) return '';
            const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
            const root = doc.body.firstChild;

            function cleanNode(node) {
                // 자식부터 먼저 정리(라이브 NodeList라 배열로 복사해서 순회)
                Array.from(node.childNodes).forEach(cleanNode);

                if (node.nodeType === Node.COMMENT_NODE) { node.remove(); return; }
                if (node.nodeType !== Node.ELEMENT_NODE) return; // 텍스트 노드는 그대로 둔다

                // execCommand('fontSize')가 만드는 <font size=1~7>은 허용 태그가 아니라 크기가 사라지므로, px 크기의 span으로 바꿔서 살린다.
                if (node.tagName === 'FONT') {
                    const span = node.ownerDocument.createElement('span');
                    const sz = parseInt(node.getAttribute('size'), 10);
                    const px = RICH_FONT_SIZE_MAP[sz];
                    const col = node.getAttribute('color');
                    let st = '';
                    if (px) st += `font-size:${px}px;`;
                    if (col && /^#?[0-9a-z]{3,20}$/i.test(col)) st += `color:${col};`;
                    if (st) span.setAttribute('style', st);
                    while (node.firstChild) span.appendChild(node.firstChild);
                    node.replaceWith(span);
                    node = span;
                }
                if (!RICH_ALLOWED_TAGS.has(node.tagName)) {
                    // 허용 안 된 태그(script, iframe 등)는 태그만 제거하고 내부 텍스트만 남긴다
                    while (node.firstChild) node.parentNode.insertBefore(node.firstChild, node);
                    node.remove();
                    return;
                }

                // 속성 화이트리스트: href(a), src(img), style(안전한 프로퍼티만)
                Array.from(node.attributes).forEach(attr => {
                    const name = attr.name.toLowerCase();
                    if (name === 'href' && node.tagName === 'A') {
                        const val = attr.value.trim();
                        if (/^(javascript|data|vbscript):/i.test(val)) node.removeAttribute('href');
                        else { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
                        return;
                    }
                    if (name === 'src' && node.tagName === 'IMG') {
                        const val = attr.value.trim();
                        if (/^(javascript|vbscript):/i.test(val)) node.removeAttribute('src');
                        return;
                    }
                    if (name === 'style') {
                        const safeDecls = attr.value.split(';').map(d => d.trim()).filter(d => {
                            const prop = d.split(':')[0]?.trim().toLowerCase();
                            if (prop === 'font-size') { // 글자 크기는 8~72px만(너무 크거나 이상한 값으로 화면이 깨지는 것을 막는다)
                                const m = /^font-size\s*:\s*(\d+(?:\.\d+)?)px$/i.exec(d);
                                return !!m && parseFloat(m[1]) >= RICH_FONT_MIN && parseFloat(m[1]) <= RICH_FONT_MAX;
                            }
                            return RICH_ALLOWED_STYLE_PROPS.has(prop) && !/expression|url\(|javascript/i.test(d);
                        });
                        if (safeDecls.length) node.setAttribute('style', safeDecls.join('; '));
                        else node.removeAttribute('style');
                        return;
                    }
                    if (name === 'alt' || name === 'title') return; // 유지
                    // 사진 배치(왼쪽/오른쪽에 붙여서 글이 옆으로 흐르게 함): float를 style로 직접 받지 않고 data-layout 값 두 가지만 허용한다
                    if (name === 'data-layout' && node.tagName === 'IMG') {
                        if (attr.value !== 'left' && attr.value !== 'right') node.removeAttribute(attr.name);
                        return;
                    }
                    node.removeAttribute(attr.name); // 그 외(on*, id, class 등)는 전부 제거
                });
            }
            cleanNode(root);
            return root.innerHTML;
        }

        // htmlField(예: 'contentHTML')가 있으면 리치 콘텐츠로, 없으면 기존 일반 텍스트 필드(plainField)로 렌더링한다.
        // → 기존 글(plain)과 새 글(rich)이 동일한 화면에서 자연스럽게 함께 표시된다.
        function renderRichOrPlain(item, htmlField, plainField) {
            const html = item && item[htmlField];
            if (html && html.trim()) {
                return `<div class="rich-content">${sanitizeRichHTML(html)}</div>`;
            }
            return renderContentWithEmojis(item ? item[plainField] : '');
        }

        // 목록/위젯/PIP용 짧은 미리보기: 리치 HTML이든 일반 텍스트든 태그/이미지를 다 걷어내고 순수 텍스트만 자른다.
        function richContentPreviewText(item, htmlField, plainField, maxLen) {
            const html = item && item[htmlField];
            let text;
            if (html && html.trim()) {
                const tmp = document.createElement('div');
                tmp.innerHTML = sanitizeRichHTML(html);
                text = tmp.textContent || '';
            } else {
                text = (item ? item[plainField] : '') || '';
            }
            text = text.replace(/\[custom_emoji:[a-zA-Z0-9_-]+\]/g, '🙂').replace(/\s+/g, ' ').trim();
            return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
        }

        // --- 공용 리치 텍스트 에디터 (contenteditable + 툴바). 커뮤니티/공지/설문이 전부 이 함수로 만든다. ---
        // targetId: contenteditable div의 id. 이미지 업로드는 uploadImageToFreeImageHost()(Edge Function 경유)를 쓴다.
        function richEditorToolbarHTML(targetId) {
            return `
                <div class="rich-toolbar" data-target="${targetId}">
                    <button type="button" onclick="richExec('${targetId}','bold')" title="굵게"><b>B</b></button>
                    <button type="button" onclick="richExec('${targetId}','italic')" title="기울임"><i>I</i></button>
                    <button type="button" onclick="richExec('${targetId}','underline')" title="밑줄"><u>U</u></button>
                    <button type="button" onclick="richExec('${targetId}','strikeThrough')" title="취소선"><s>S</s></button>
                    <span class="rich-toolbar-sep"></span>
                    <button type="button" onmousedown="event.preventDefault()" onclick="richStepFontSize('${targetId}',-2)" title="글자 작게 (2px씩)" style="font-size:11px;">가−</button>
                    <input type="number" class="rich-fs-input" min="8" max="72" step="1" value="14" onchange="richApplyFontSize('${targetId}', this.value)" title="글자 크기(px) — 직접 입력하거나 ▲▼로 자유롭게 조절 (8~72)">
                    <button type="button" onmousedown="event.preventDefault()" onclick="richStepFontSize('${targetId}',2)" title="글자 크게 (2px씩)" style="font-size:15px;">가+</button>
                    <input type="color" onchange="richExec('${targetId}','foreColor', this.value)" title="글자색" class="rich-color-input">
                    <span class="rich-toolbar-sep"></span>
                    <button type="button" onclick="richExec('${targetId}','justifyLeft')" title="왼쪽 정렬">⯇</button>
                    <button type="button" onclick="richExec('${targetId}','justifyCenter')" title="가운데 정렬">≡</button>
                    <button type="button" onclick="richExec('${targetId}','justifyRight')" title="오른쪽 정렬">⯈</button>
                    <span class="rich-toolbar-sep"></span>
                    <button type="button" onclick="richInsertLink('${targetId}')" title="링크">🔗</button>
                    <button type="button" onclick="richInsertImage('${targetId}')" title="이미지 삽입 (여러 장을 한 번에 고르면 가로로 나란히 배치돼요)">🖼</button>
                    <button type="button" onclick="richSetImageLayout('${targetId}','block')" title="선택한 사진: 한 줄을 차지 (기본)">▭</button>
                    <button type="button" onclick="richSetImageLayout('${targetId}','left')" title="선택한 사진: 왼쪽에 붙이고 글이 오른쪽으로 흐르게 / 여러 장이면 가로로 나란히">◧</button>
                    <button type="button" onclick="richSetImageLayout('${targetId}','right')" title="선택한 사진: 오른쪽에 붙이고 글이 왼쪽으로 흐르게">◨</button>
                    <button type="button" onclick="richInsertClear('${targetId}')" title="여기서부터 사진 옆 흐름을 끊고 아래 줄에서 이어쓰기">↧</button>
                    <span class="rich-toolbar-sep"></span>
                    <div class="rich-size-wrap">
                        <span class="rich-img-size-label">크기</span>
                        <input type="range" min="10" max="100" value="100" step="5" oninput="richResizeImageLive('${targetId}', this.value)" class="rich-size-slider" title="클릭해서 선택한 이미지의 크기를 세밀하게 조절합니다">
                    </div>
                    <span class="rich-toolbar-sep"></span>
                    <div class="rich-toolbar-history">
                        <button type="button" onclick="richExec('${targetId}','undo')" title="실행 취소">↶</button>
                        <button type="button" onclick="richExec('${targetId}','redo')" title="다시 실행">↷</button>
                    </div>
                </div>
            `;
        }

        window.richExec = function(targetId, command, value) {
            const el = document.getElementById(targetId);
            if (el) el.focus();
            document.execCommand(command, false, value || null);
        };

        // ---- 글자 크기 자유 조절 (8~72px) ----
        // 크기 입력칸으로 포커스가 옮겨가면 에디터의 선택 영역이 사라지므로, 에디터 안의 마지막 선택 영역을 따로 기억해 둔다.
        let richSavedRange = null, richSavedTarget = null;
        document.addEventListener('selectionchange', () => {
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) return;
            const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
            const ed = node && node.closest ? node.closest('[contenteditable="true"]') : null;
            if (!ed || !ed.id || document.activeElement !== ed) return; // 포커스가 툴바 입력칸 등으로 옮겨간 뒤의 선택 변화는 무시
            richSavedRange = sel.getRangeAt(0).cloneRange(); richSavedTarget = ed.id;
            // 지금 커서/선택 위치의 글자 크기를 해당 툴바 입력칸에 보여준다
            const input = document.querySelector(`.rich-toolbar[data-target="${ed.id}"] .rich-fs-input`);
            if (input && document.activeElement !== input) {
                // 선택 경계가 요소 사이에 걸쳐 있으면(예: span 전체 선택) 선택 안의 첫 글자가 속한 요소의 크기를 쓴다
                let target = sel.getRangeAt(0).startContainer;
                if (target.nodeType === 1) { target = target.childNodes[sel.getRangeAt(0).startOffset] || target; while (target.firstChild) target = target.firstChild; }
                const el = target.nodeType === 1 ? target : target.parentElement;
                input.value = Math.round(parseFloat(getComputedStyle(el || node).fontSize) || 14);
            }
        });
        document.addEventListener('focusout', (e) => { // 에디터를 떠나는 순간의 선택 영역을 확실히 저장한다
            const ed = e.target && e.target.closest ? e.target.closest('[contenteditable="true"]') : null;
            const sel = window.getSelection();
            if (ed && ed.id && sel && sel.rangeCount && ed.contains(sel.anchorNode)) { richSavedRange = sel.getRangeAt(0).cloneRange(); richSavedTarget = ed.id; }
        });
        window.richApplyFontSize = function(targetId, value) {
            const el = document.getElementById(targetId);
            if (!el) return;
            const px = Math.min(RICH_FONT_MAX, Math.max(RICH_FONT_MIN, Math.round(parseFloat(value) || 14)));
            const input = document.querySelector(`.rich-toolbar[data-target="${targetId}"] .rich-fs-input`);
            if (input) input.value = px;
            el.focus();
            const sel = window.getSelection();
            if (richSavedRange && richSavedTarget === targetId && el.contains(richSavedRange.commonAncestorContainer)) { sel.removeAllRanges(); sel.addRange(richSavedRange); }
            if (!sel.rangeCount || !el.contains(sel.anchorNode)) return;
            if (sel.isCollapsed) {
                // 선택한 글이 없으면: 이 위치부터 새로 입력하는 글에 적용(보이지 않는 공백이 든 span 안에 커서를 둔다)
                document.execCommand('insertHTML', false, `<span style="font-size:${px}px">&#8203;</span>`);
                return;
            }
            document.execCommand('fontSize', false, '7'); // 임시로 <font size=7>을 만들고, 아래에서 원하는 px의 span으로 바꾼다
            const made = [];
            el.querySelectorAll('font[size="7"]').forEach(f => {
                const span = document.createElement('span');
                span.style.fontSize = px + 'px';
                while (f.firstChild) span.appendChild(f.firstChild);
                span.querySelectorAll('[style*="font-size"]').forEach(c => { c.style.fontSize = ''; if (!c.getAttribute('style')) c.removeAttribute('style'); }); // 안쪽 span의 예전 크기가 덮어쓰지 않게
                f.replaceWith(span);
                made.push(span);
            });
            if (made.length) {
                const r = document.createRange(); r.setStartBefore(made[0]); r.setEndAfter(made[made.length - 1]);
                sel.removeAllRanges(); sel.addRange(r); richSavedRange = r.cloneRange(); richSavedTarget = targetId;
            }
        };
        window.richStepFontSize = function(targetId, delta) {
            const input = document.querySelector(`.rich-toolbar[data-target="${targetId}"] .rich-fs-input`);
            richApplyFontSize(targetId, (parseInt(input && input.value, 10) || 14) + delta);
        };

        window.richInsertLink = function(targetId) {
            const url = prompt('연결할 링크 주소를 입력하세요 (https://...)');
            if (!url) return;
            if (/^(javascript|data|vbscript):/i.test(url.trim())) return alert('허용되지 않는 링크입니다.');
            document.getElementById(targetId).focus();
            document.execCommand('createLink', false, url);
        };

        // 업로드 자체는 성공했는데(imgbb가 URL을 돌려줌) 네트워크가 불안정해서 그 URL을 불러오는
        // 데 실패하면 깨진 이미지 아이콘만 덩그러니 남는다 - 무슨 일이 있었는지 알기 어려우므로,
        // 작성 중(에디터에 막 삽입한 시점)에는 이유를 알려주는 문구로 바꿔치기한다.
        // ⚠️ 저장 시 sanitizeRichHTML이 on* 속성을 전부 제거하므로, 이 onerror는 지금 작성 중인
        // 화면에만 적용되고 저장된 게시글을 "나중에 보는" 화면에는 남지 않는다 (의도된 동작 - 보안상
        // on* 속성을 허용목록에 추가하지 않는다).
        window.handleRichImgLoadError = function(imgEl) {
            const span = document.createElement('span');
            span.textContent = '⚠️ 이미지를 불러오지 못했어요 (네트워크 확인 후 다시 첨부해보세요)';
            span.style.cssText = 'color:#ef4444; font-size:12px; display:inline-block; padding:4px 8px; border:1px dashed #ef4444; border-radius:6px;';
            imgEl.replaceWith(span);
        };
        // 에디터 안에서 마지막으로 클릭한 이미지를 기억해뒀다가, 크기 슬라이더가 그 이미지에 적용되게 한다.
        let richLastClickedImage = null;
        // targetId별로 지금 이미지 업로드가 진행 중인지 추적한다. 업로드는 비동기(imgbb 요청)라서,
        // 업로드가 끝나기 전에 "게시하기"를 눌러버리면 방금 고른 이미지가 본문에 삽입되기도 전에
        // 글이 저장되고(이미지 없이), 그 직후 업로드가 뒤늦게 끝나면서 이미 닫히거나 초기화된
        // 에디터에 이미지를 끼워넣어봐야 아무 데도 저장되지 않는다 - "imgbb에는 쌓이는데 게시글에는
        // 안 보인다"는 문제의 원인이 바로 이 경쟁 상태였다. 그래서 (1) 업로드 중에는 자리표시자를
        // 눈에 보이게 넣어두고, (2) 각 글쓰기 제출 함수는 이 Set을 확인해서 업로드가 끝날 때까지
        // 제출 자체를 막는다.
        const richImageUploadsInFlight = new Set();
        function isRichEditorUploadingImage(targetId) { return richImageUploadsInFlight.has(targetId); }
        // 여러 장을 한 번에 고르면 왼쪽 정렬(left) + 장수에 맞춘 폭으로 넣어서 가로로 나란히 배치되게 한다
        // (2장=48%, 3장=32%, 4장 이상=23% - 이미지 사이 여백 1.2%까지 합쳐 한 줄에 들어간다). 1장은 예전처럼 한 줄 전체.
        function richBatchImageWidth(count) { return count <= 1 ? 100 : (count === 2 ? 48 : (count === 3 ? 32 : 23)); }
        window.richInsertImage = function(targetId) {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
            input.onchange = async () => {
                const files = Array.from(input.files || []);
                if (!files.length) return;
                const el = document.getElementById(targetId);
                el.focus();
                richImageUploadsInFlight.add(targetId);
                // 자리표시자를 한 번에(순서대로) 먼저 넣어두고, 업로드가 끝나는 대로 각자 자기 자리의 이미지로 바꾼다
                const placeholderIds = files.map(() => `rich-img-uploading-${Date.now()}-${Math.random().toString(36).slice(2)}`);
                document.execCommand('insertHTML', false, placeholderIds.map((pid, i) => `<span id="${pid}" contenteditable="false" style="display:inline-block; padding:4px 8px; border:1px dashed var(--border-color); border-radius:6px; color:var(--text-muted); font-size:12px;">⏳ 이미지 업로드 중... (${i + 1}/${files.length})</span>`).join(''));
                const width = richBatchImageWidth(files.length);
                try {
                    await Promise.all(files.map(async (file, i) => {
                        const placeholderId = placeholderIds[i];
                        try {
                            const url = await uploadImageToFreeImageHost(file);
                            const img = document.createElement('img');
                            img.src = url;
                            img.alt = '첨부 이미지';
                            img.style.width = width + '%';
                            img.style.maxWidth = '100%';
                            if (files.length > 1) img.setAttribute('data-layout', 'left');
                            img.setAttribute('onerror', 'handleRichImgLoadError(this)');
                            const placeholder = document.getElementById(placeholderId);
                            if (placeholder) placeholder.replaceWith(img); else el.appendChild(img);
                        } catch (e) {
                            console.error('게시글 이미지 업로드 오류:', e);
                            const placeholder = document.getElementById(placeholderId);
                            if (placeholder) placeholder.remove();
                            alert(e.message && e.message.includes('60MB') ? e.message : '이미지 업로드 중 오류가 발생했습니다.');
                        }
                    }));
                } finally {
                    richImageUploadsInFlight.delete(targetId);
                }
            };
            input.click();
        };
        // 선택한(마지막으로 클릭한) 사진의 배치를 바꾼다: block=한 줄 차지(기본), left/right=그쪽에 붙고 글이 옆으로 흐름.
        // 폭이 거의 100%인 사진을 left/right로 바꾸면 옆에 글이 들어갈 자리가 없으므로 절반 폭으로 줄여준다.
        window.richSetImageLayout = function(targetId, mode) {
            const el = document.getElementById(targetId);
            if (!el) return;
            const img = richLastClickedImage && el.contains(richLastClickedImage) ? richLastClickedImage : el.querySelector('img:last-of-type');
            if (!img) { alert('먼저 배치를 바꿀 사진을 클릭해서 선택해주세요.'); return; }
            if (mode === 'left' || mode === 'right') {
                img.setAttribute('data-layout', mode);
                if ((parseInt(img.style.width) || 100) >= 90) img.style.width = '50%';
            } else {
                img.removeAttribute('data-layout');
            }
            img.style.maxWidth = '100%'; img.style.height = 'auto';
            const slider = document.querySelector(`.rich-toolbar[data-target="${targetId}"] .rich-size-slider`);
            if (slider) slider.value = parseInt(img.style.width) || 100;
            el.focus();
        };
        // 사진 옆으로 흐르던 글을 여기서 끊고 아래에서 이어쓰게 하는 "줄 내리기" 구분자(clear:both)를 커서 위치에 넣는다.
        window.richInsertClear = function(targetId) {
            const el = document.getElementById(targetId);
            if (!el) return;
            el.focus();
            document.execCommand('insertHTML', false, '<div style="clear:both"><br></div>');
        };
        // 슬라이더를 움직일 때마다 실시간으로 선택된 이미지 크기를 반영한다 (10%~100%, 5% 단위로 세밀하게 조절 가능)
        window.richResizeImageLive = function(targetId, percent) {
            const el = document.getElementById(targetId);
            const img = richLastClickedImage && el.contains(richLastClickedImage) ? richLastClickedImage : el.querySelector('img:last-of-type');
            if (!img) return;
            img.style.width = percent + '%';
            img.style.maxWidth = '100%';
            img.style.height = 'auto';
        };
        // 에디터 영역의 이미지를 클릭하면 그 이미지를 크기 조절 대상으로 기억하고, 슬라이더도 현재 크기에 맞춰 동기화한다.
        document.addEventListener('click', (e) => {
            if (e.target.tagName === 'IMG' && e.target.closest('.rich-editable')) {
                richLastClickedImage = e.target;
                const editable = e.target.closest('.rich-editable');
                editable.querySelectorAll('img.rich-img-selected').forEach(i => i.classList.remove('rich-img-selected'));
                e.target.classList.add('rich-img-selected'); // 어떤 사진이 크기/배치 조절 대상인지 보이게 (class는 저장 시 sanitize에서 제거된다)
                const slider = document.querySelector(`.rich-toolbar[data-target="${editable.id}"] .rich-size-slider`);
                if (slider) slider.value = parseInt(e.target.style.width) || 100;
            }
        });

// (게임/게임 커뮤니티 기능은 앱스토어로 대체되어 제거됨 - 앱스토어 모듈은 id="appstore-module" 스크립트 참고)

// --- 2반 아카이브 ---
        window.handleArchiveSubmit = async function() {
            const titleInput = document.getElementById('archive-title'); 
            const contentInput = document.getElementById('archive-content'); 
            const fileInput = document.getElementById('archive-img-file'); 
            if(!titleInput.value.trim() || !contentInput.value.trim()) return alert("제목과 내용을 모두 입력해주세요.");
            if (!currentUser) return showLoginScreen(() => handleArchiveSubmit());
            if(currentUserInfo.role !== 'class2_member') return alert("권한이 없습니다.");

            let imageUrl = ""; 
            if (fileInput.files.length > 0) {
                try {
                    document.querySelector("button[onclick='handleArchiveSubmit()']").innerText = "업로드 중...⏳";
                    imageUrl = await uploadImageToFreeImageHost(fileInput.files[0]); // 이미지 호스팅 키는 서버(Edge Function)에만 있다
                } catch (e) { return alert((e && e.message) || "업로드 실패"); }
                finally { document.querySelector("button[onclick='handleArchiveSubmit()']").innerText = "추억 등록하기"; }
            }

            try {
                await addDoc(collection(fdb, 'archive'), {
                    title: titleInput.value, content: contentInput.value, img: imageUrl, 
                    authorName: getAuthorName(), 
                    authorOriginal: currentUser.email, 
                    authorId: currentUser.uid, 
                    createdAt: Date.now()
                });
                titleInput.value = ""; contentInput.value = ""; fileInput.value = "";
                alert("🎉 소중한 추억이 성공적으로 보관되었습니다!");
            } catch(e) { 
                alert("추억 등록 오류가 발생했습니다."); 
            } 
        };
        window.deleteArchive = async function(archiveId, authorId) {
            const canDel = currentUser && (currentUser.uid === authorId || isAdmin || isSubAdmin);
            if(!canDel) return alert("권한이 없습니다.");
            if(confirm("이 추억 카드를 정말 삭제하시겠습니까?")) await deleteDoc(doc(fdb, 'archive', archiveId));
        }

        let archiveSnapshotHandler = null, lastArchiveSnapshot = null; // 프로필이 바뀌면 같은 스냅샷으로 목록만 다시 그리기 위해 보관
        function listenToArchive() {
            onSnapshot(collection(fdb, 'archive'), archiveSnapshotHandler = (snapshot) => {
                lastArchiveSnapshot = snapshot;
                const data = fsSnapshotToMap(snapshot); 
                latestArchiveData = data; // 활동 업적(게시글 합계) 계산용 캐시
                evaluateAndSyncAchievements();
                const container = document.getElementById('archive-container');
                if(!container) return;
                if(!data || Object.keys(data).length === 0) { 
                    container.innerHTML = `<div class="card" style="grid-column: span 2; text-align:center; color:var(--text-muted);">아직 등록된 우리들의 추억이 없습니다.</div>`; 
                    return; 
                }
                
                let html = "";
                const SPECIAL_EMAIL = "20261211@hanilgo.cnehs.kr";

                Object.entries(data).reverse().forEach(([id, item]) => {
                    const isMyPost = currentUser && currentUser.uid === item.authorId;
                    const canDelete = isMyPost || isAdmin || isSubAdmin || isOperator;
                    
                    const isGodArchive = (item.authorOriginal && item.authorOriginal.includes(SPECIAL_EMAIL));
                    
                    const archiveDisplayName = resolveDisplayName(item.authorName, item.authorOriginal);
                    const archiveStyledName = renderStyledName(archiveDisplayName, appearanceForAuthorOriginal(item.authorOriginal), null, escapeNoticeText);
                    let displayAuthor = (isAdmin || isSubAdmin) && item.authorOriginal ? `${archiveStyledName} <strong style="color:#ef4444; font-size:10px;">[${adminOriginalTag(item.authorOriginal)}]</strong>` : archiveStyledName;
                    
                    if (isGodArchive) {
                        displayAuthor = `<span class="god-mode-text">👑 ${item.authorName}</span>`; // 기존 11번 특수효과 - 그대로 유지
                    }

                    html += `
                        <div class="card" style="padding: 16px; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.02);">
                            ${item.img ? `<img src="${item.img}" style="width:100%; height:160px; object-fit:cover; border-radius:12px;" onerror="this.style.display='none'">` : ''}
                            <strong style="font-size: 15px; color: var(--text-main);">${item.title}</strong>
                            <p style="font-size: 13px; color: var(--text-secondary); white-space: pre-wrap; flex: 1; line-height:1.4;">${item.content}</p>
                            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--text-muted); border-top: 1px dashed var(--border-color); padding-top: 8px; margin-top: 6px;">
                                <span>✍️ ${displayAuthor}</span>
                                ${canDelete ? `<span onclick="deleteArchive('${id}', '${item.authorId}')" style="color: #ef4444; cursor: pointer; font-weight: 600;">삭제</span>` : ''}
                            </div>
                        </div>
                    `;
                });
                container.innerHTML = html;
            });
        }

        // =========================================================================
        // 🗄 아카이브 → 커뮤니티 마이그레이션 (일회성, 관리자 전용)
        //
        // 원칙:
        //  - 기존 archive 문서는 절대 삭제/수정하지 않는다. 오직 posts에 "복사"만 한다.
        //  - 이미 옮겨진 글은 legacyArchiveId로 식별해서 다시 만들지 않는다 (몇 번을 눌러도 안전).
        //  - 없는 값(게시일 등)을 임의로 지어내지 않는다. createdAt이 없으면 null 그대로 저장하고,
        //    화면(formatPostTimeOrDash)에서 '—'로 표시한다.
        //  - 좋아요는 이 통합 이후로 새로 시작하는 기능이라 0으로 초기화한다 (과거 데이터 조작이 아님).
        // =========================================================================
        window.migrateArchiveToCommunity = async function() {
            if (!isAdmin) return alert('권한이 없습니다.');
            if (!confirm('기존 아카이브 게시글을 커뮤니티로 가져옵니다.\n이미 가져온 글은 중복으로 만들어지지 않고, 기존 아카이브 데이터는 그대로 남습니다.\n계속할까요?')) return;

            const btn = document.getElementById('btn-archive-migrate');
            const originalLabel = btn ? btn.innerText : '';
            if (btn) btn.innerText = '가져오는 중...⏳';

            try {
                const archiveSnap = await getDocs(collection(fdb, 'archive'));
                const migratedSnap = await getDocs(query(collection(fdb, 'posts'), where('migratedFrom', '==', 'archive')));
                const alreadyMigratedIds = new Set(migratedSnap.docs.map(d => d.data().legacyArchiveId).filter(Boolean));

                let migrated = 0, skipped = 0, failed = 0;
                const failedItems = [];

                for (const archiveDoc of archiveSnap.docs) {
                    if (alreadyMigratedIds.has(archiveDoc.id)) { skipped++; continue; }
                    const a = archiveDoc.data();
                    try {
                        await addDoc(collection(fdb, 'posts'), {
                            title: a.title || '(제목 없음)',
                            content: a.content || '',
                            imageUrls: a.img ? [a.img] : [],
                            authorId: a.authorId || null,
                            authorName: a.authorName || null,
                            authorOriginal: a.authorOriginal || null,
                            createdAt: a.createdAt || null, // 원본에 없으면 임의로 채우지 않는다
                            likeCount: 0,
                            migratedFrom: 'archive',
                            legacyArchiveId: archiveDoc.id
                        });
                        migrated++;
                    } catch (e) {
                        failed++;
                        failedItems.push(a.title || archiveDoc.id);
                    }
                }

                alert(
                    `아카이브 → 커뮤니티 가져오기 완료\n\n` +
                    `전체 아카이브 글: ${archiveSnap.size}개\n` +
                    `새로 가져옴: ${migrated}개\n` +
                    `이미 가져와서 건너뜀: ${skipped}개\n` +
                    `실패: ${failed}개` +
                    (failed > 0 ? `\n실패 항목: ${failedItems.join(', ')}` : '')
                );
            } catch (e) {
                alert('마이그레이션 중 오류가 발생했습니다: ' + (e && e.message ? e.message : e));
            } finally {
                if (btn) btn.innerText = originalLabel || '🗄 기존 아카이브 글 가져오기';
                checkArchiveMigrationStatus();
            }
        };

        // 관리자에게만, 아직 커뮤니티로 옮기지 않은 아카이브 글이 남아있을 때만 버튼을 보여준다.
        window.checkArchiveMigrationStatus = async function() {
            const btn = document.getElementById('btn-archive-migrate');
            if (!btn) return;
            if (!isAdmin) { btn.style.display = 'none'; return; }
            try {
                const archiveSnap = await getDocs(collection(fdb, 'archive'));
                if (archiveSnap.empty) { btn.style.display = 'none'; return; }
                const migratedSnap = await getDocs(query(collection(fdb, 'posts'), where('migratedFrom', '==', 'archive')));
                const migratedIds = new Set(migratedSnap.docs.map(d => d.data().legacyArchiveId).filter(Boolean));
                const remaining = archiveSnap.docs.filter(d => !migratedIds.has(d.id)).length;
                if (remaining > 0) {
                    btn.style.display = 'inline-flex';
                    btn.innerText = `🗄 기존 아카이브 글 가져오기 (${remaining}개 남음)`;
                } else {
                    btn.style.display = 'none';
                }
            } catch (e) { btn.style.display = 'none'; }
        };
        // 카테고리(자유 입력 필드)로 분류/필터링한다. 기존 archiveStudy/archiveEtc 두 컬렉션과
        // 데이터는 그대로 유지하고(과거 자료 보존), 화면에서만 하나로 합쳐서 보여준다.
        // 새로 등록하는 자료는 전부 archiveStudy 컬렉션에 저장된다 (컬렉션을 굳이 두 개로 나눌 이유가
        // 없어졌기 때문 - 카테고리 필드 자체가 분류 역할을 한다).
        //
        // 지금은 클라우드 저장소 연동이 정해지지 않았으므로, 실제 업로드 함수는 자리만
        // 잡아둔 스텁(stub)이다. 연동 방식이 정해지면 uploadFileToCloudStorage() 하나만
        // 실제 업로드 로직으로 교체하면 되고, 나머지 코드(저장/렌더링/삭제)는 그대로 재사용된다.
        //
        //   파일 선택 → uploadFileToCloudStorage(file) → { fileUrl, fileName, fileType, fileSize }
        //                                                        ↓
        //                                  Firestore에는 이 메타데이터만 저장 (archiveStudy / archiveEtc)
        // =========================================================================
        const MATERIALS_ALLOWED_EXT = ['pdf','doc','docx','ppt','pptx','xls','xlsx','hwp','hwpx','zip','jpg','jpeg','png','gif','txt'];
        const MATERIALS_MAX_SIZE = 50 * 1024 * 1024; // 50MB

        function materialsFileIcon(ext) {
            const map = { pdf:'📕', doc:'📘', docx:'📘', ppt:'📙', pptx:'📙', xls:'📗', xlsx:'📗', hwp:'📄', hwpx:'📄', zip:'🗜️', jpg:'🖼️', jpeg:'🖼️', png:'🖼️', gif:'🖼️', txt:'📄' };
            return map[(ext || '').toLowerCase()] || '📄';
        }
        function safeFileName(name) { return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_'); }

        function formatFileSize(bytes) {
            if (!bytes && bytes !== 0) return '';
            if (bytes < 1024) return `${bytes}B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
            return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
        }

        // 신규 자료 등록: anon 키로 Storage/DB에 직접 쓰지 않는다. 대신 Firebase ID 토큰을 담아
        // Edge Function(upload-material)에 보내고, 그 안에서 토큰을 검증한 뒤 service_role로
        // Storage 업로드 + materials INSERT를 대신 수행한다. (익명 사용자가 API를 직접 호출해서
        // 무단으로 자료를 올리는 걸 막기 위해, anon 키에는 write 권한을 아예 주지 않는다 - SQL 참고)
        window.openMaterialUploadModal = function() {
            if (!currentUser) return showLoginScreen(() => openMaterialUploadModal());
            if (currentUserInfo.role !== 'class2_member') return alert("권한이 없습니다.");
            document.getElementById('material-upload-modal').style.display = 'flex';
        };
        window.closeMaterialUploadModal = function() {
            document.getElementById('material-upload-modal').style.display = 'none';
        };

        window.handleArchiveStudySubmit = async function() {
            const titleInput = document.getElementById('archive-study-title');
            const categoryInput = document.getElementById('archive-study-category');
            const descInput = document.getElementById('archive-study-desc');
            const fileInput = document.getElementById('archive-study-file');
            const progressEl = document.getElementById('materials-upload-progress');
            const submitBtn = document.getElementById('materials-submit-btn');
            if (!titleInput.value.trim()) return alert("제목을 입력해주세요.");
            if (!currentUser) return showLoginScreen(() => handleArchiveStudySubmit());
            if (currentUserInfo.role !== 'class2_member') return alert("권한이 없습니다.");

            const file = fileInput.files.length > 0 ? fileInput.files[0] : null;

            // 파일 형식/용량은 서버(Edge Function)에서도 다시 검사하지만, 큰 파일을 무의미하게
            // 업로드부터 시도하지 않도록 클라이언트에서도 미리 걸러서 바로 알려준다.
            if (file) {
                const ext = (file.name.split('.').pop() || '').toLowerCase();
                if (!MATERIALS_ALLOWED_EXT.includes(ext)) return alert(`허용되지 않는 파일 형식입니다.\n허용 형식: ${MATERIALS_ALLOWED_EXT.join(', ')}`);
                if (file.size > MATERIALS_MAX_SIZE) return alert('파일 용량은 50MB를 넘을 수 없습니다.');
            }

            const originalBtnText = submitBtn ? submitBtn.textContent : '';
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '자료 등록 중...'; }
            if (progressEl) { progressEl.style.display = 'block'; progressEl.textContent = file ? '파일 업로드 중...' : '등록 중...'; }

            try {
                const idToken = await currentUser.getIdToken();
                const formData = new FormData();
                formData.append('firebaseIdToken', idToken);
                formData.append('title', titleInput.value);
                formData.append('category', categoryInput.value.trim() || '기타');
                formData.append('description', descInput.value || '');
                formData.append('ownerName', getAuthorName() || '');
                if (file) formData.append('file', file);

                const res = await fetch(MATERIALS_UPLOAD_FUNCTION_URL, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${SUPABASE_PUBLISHABLE_KEY}` }, // 파일 전송이라 Content-Type은 브라우저가 자동 설정하게 둔다
                    body: formData
                });
                const result = await res.json().catch(() => ({}));

                if (!res.ok) {
                    console.error("자료 업로드 실패 응답:", res.status, result);
                    // 서버(Edge Function)가 이미 사람이 읽을 수 있는 메시지를 주면 그걸 그대로 보여주고,
                    // 인증 오류(401)처럼 서버가 이유를 안 줬을 때만 일반적인 문구로 보완한다.
                    if (result.error) throw new Error(result.error);
                    if (res.status === 401) throw new Error("로그인 정보가 유효하지 않습니다.\n다시 로그인해주세요.");
                    throw new Error("자료 등록에 실패했습니다.\n잠시 후 다시 시도해주세요.");
                }

                titleInput.value = ""; categoryInput.value = ""; descInput.value = ""; fileInput.value = "";
                closeMaterialUploadModal();
                if (window.completeDailyMission) window.completeDailyMission('archiveStudyPost', 20, '자료 등록');
                await loadSupabaseMaterials();
                alert("자료가 등록되었습니다.");
            } catch (e) {
                console.error("자료 업로드 오류:", e);
                alert(e.message || "자료 등록에 실패했습니다.\n잠시 후 다시 시도해주세요.");
            } finally {
                if (progressEl) progressEl.style.display = 'none';
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalBtnText; }
            }
        };

        // 다운로드: Private 버킷이므로 임시 서명 URL을 발급받아 연다. 성공하면 다운로드 횟수를 늘린다.
        // 이미지/PDF/TXT만 미리보기를 지원한다 (HWP/DOCX/PPTX 등은 브라우저에서 억지로 미리보기하지 않는다).
        // 다운로드가 아니라 "보기"이므로 download_count는 늘리지 않는다.
        window.previewSupabaseMaterial = async function(id) {
            const row = supabaseMaterialsCache[id];
            if (!row || !row.storage_path) return alert("미리보기를 지원하지 않는 파일입니다.\n다운로드해서 확인해주세요.");
            try {
                const { data, error } = await sb.storage.from(MATERIALS_BUCKET).createSignedUrl(row.storage_path, 60);
                if (error) throw error;
                window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
            } catch (e) {
                console.error("Supabase 미리보기 오류:", e);
                alert("미리보기에 실패했습니다.\n잠시 후 다시 시도해주세요.");
            }
        };

        window.downloadSupabaseMaterial = async function(id) {
            const row = supabaseMaterialsCache[id];
            if (!row || !row.storage_path) return alert("다운로드할 파일이 없습니다.");
            try {
                const { data, error } = await sb.storage.from(MATERIALS_BUCKET).createSignedUrl(row.storage_path, 60);
                if (error) throw error;
                window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
                if (window.completeDailyMission) window.completeDailyMission('archiveView', 10, '자료실 이용하기');
                // 동시에 여러 명이 눌러도 안전하도록, 클라이언트에서 값을 계산해 더하지 않고 DB 함수(increment_download_count)로 처리한다.
                // (RPC 함수는 supabase_setup.sql에 정의되어 있음 - 대시보드에서 먼저 만들어야 동작한다)
                const { error: rpcErr } = await sb.rpc('increment_download_count', { material_id: id });
                if (!rpcErr) { row.download_count = (row.download_count || 0) + 1; renderMergedMaterials(); }
            } catch (e) {
                console.error("Supabase 다운로드 오류:", e);
                alert("다운로드에 실패했습니다.\n잠시 후 다시 시도해주세요.");
            }
        };

        // ⚠️ RLS 정책상 브라우저(anon key)는 materials 테이블/Storage에서 직접 delete를 할 수 없다 (의도된 것).
        // 실제 삭제는 Edge Function이 Firebase ID 토큰을 서버에서 검증한 뒤 service_role로 대신 처리한다.
        // (Edge Function을 아직 배포하지 않았다면 이 기능은 "함수를 찾을 수 없음" 오류가 뜨는 게 정상이다 - 배포 안내는 답변 참고)
        window.deleteSupabaseMaterial = async function(id) {
            const row = supabaseMaterialsCache[id];
            if (!row) return;
            // ⚠️ verify-delete-material Edge Function은 현재 "본인 자료인지"만 검증한다 (관리자 삭제는 TODO).
            // 그래서 여기서도 UI와 동일하게 본인 소유일 때만 시도한다 - 실패할 걸 알면서 요청을 보내지 않는다.
            const isOwner = currentUser && currentUser.uid === row.owner_uid;
            if (!isOwner) return alert("본인이 등록한 자료만 삭제할 수 있습니다.");
            if (!confirm("이 자료를 정말 삭제하시겠습니까?\n삭제하면 파일도 함께 삭제됩니다.")) return;
            try {
                const idToken = await currentUser.getIdToken();
                const res = await fetch(MATERIALS_DELETE_FUNCTION_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_PUBLISHABLE_KEY}` },
                    body: JSON.stringify({ materialId: id, firebaseIdToken: idToken })
                });
                const result = await res.json().catch(() => ({}));
                if (!res.ok) {
                    console.error("자료 삭제 실패 응답:", res.status, result);
                    if (result.error) throw new Error(result.error);
                    if (res.status === 401) throw new Error("로그인 정보가 유효하지 않습니다.\n다시 로그인해주세요.");
                    throw new Error("자료 삭제에 실패했습니다.\n잠시 후 다시 시도해주세요.");
                }
                delete supabaseMaterialsCache[id];
                renderMergedMaterials();
            } catch (e) {
                console.error("자료 삭제 오류:", e);
                alert(e.message || "자료 삭제에 실패했습니다.\n잠시 후 다시 시도해주세요.");
            }
        };

        window.deleteArchiveFile = async function(collectionName, docId, authorId) {
            const canDel = currentUser && (currentUser.uid === authorId || isAdmin || isSubAdmin);
            if (!canDel) return alert("권한이 없습니다.");
            if (confirm("이 자료를 정말 삭제하시겠습니까?")) await deleteDoc(doc(fdb, collectionName, docId));
        };

        // 자료 수정: 제목/카테고리/설명만 고칠 수 있다(파일 자체를 바꾸려면 삭제 후 재등록해야 한다 -
        // 업로드 당시의 storage_path/서명 URL 발급 로직을 다시 타야 해서 수정만으로는 안전하게 처리하기 어렵다).
        // source: 'supabase'(신규 업로드, Edge Function 경유) | 'legacy'(archiveStudy/archiveEtc, Firestore 직접 수정)
        let materialEditTarget = null; // { source, id, collectionName? }
        window.openMaterialEditModal = function(source, id, collectionName) {
            if (!currentUser) return showLoginScreen(() => openMaterialEditModal(source, id, collectionName));
            let title, category, desc, canEdit;
            if (source === 'supabase') {
                const row = supabaseMaterialsCache[id];
                if (!row) return;
                canEdit = currentUser.uid === row.owner_uid;
                title = row.title || ''; category = row.category || ''; desc = row.description || '';
            } else {
                const cache = collectionName === 'archiveEtc' ? materialsEtcCache : materialsStudyCache;
                const item = cache[id];
                if (!item) return;
                canEdit = currentUser.uid === item.authorId || isAdmin || isSubAdmin;
                title = item.title || ''; category = item.category || ''; desc = item.desc || '';
            }
            if (!canEdit) return alert("본인이 등록한 자료만 수정할 수 있습니다.");
            materialEditTarget = { source, id, collectionName };
            document.getElementById('material-edit-title').value = title;
            document.getElementById('material-edit-category').value = category;
            document.getElementById('material-edit-desc').value = desc;
            const statusEl = document.getElementById('material-edit-status');
            if (statusEl) statusEl.style.display = 'none';
            document.getElementById('material-edit-modal').style.display = 'flex';
        };
        window.closeMaterialEditModal = function() {
            document.getElementById('material-edit-modal').style.display = 'none';
            materialEditTarget = null;
        };
        window.submitMaterialEdit = async function() {
            if (!materialEditTarget) return;
            const titleInput = document.getElementById('material-edit-title');
            const categoryInput = document.getElementById('material-edit-category');
            const descInput = document.getElementById('material-edit-desc');
            const statusEl = document.getElementById('material-edit-status');
            const submitBtn = document.getElementById('material-edit-submit-btn');
            if (!titleInput.value.trim()) return alert("제목을 입력해주세요.");
            const title = titleInput.value.trim();
            const category = categoryInput.value.trim() || '기타';
            const description = descInput.value;

            const originalText = submitBtn ? submitBtn.textContent : '';
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '저장 중...'; }
            if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = '저장 중...'; }
            try {
                const { source, id, collectionName } = materialEditTarget;
                if (source === 'supabase') {
                    const idToken = await currentUser.getIdToken();
                    const res = await fetch(MATERIALS_EDIT_FUNCTION_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_PUBLISHABLE_KEY}` },
                        body: JSON.stringify({ materialId: id, title, category, description, firebaseIdToken: idToken })
                    });
                    const result = await res.json().catch(() => ({}));
                    if (!res.ok) {
                        if (result.error) throw new Error(result.error);
                        if (res.status === 401) throw new Error("로그인 정보가 유효하지 않습니다.\n다시 로그인해주세요.");
                        throw new Error("자료 수정에 실패했습니다.\n잠시 후 다시 시도해주세요.");
                    }
                    const row = supabaseMaterialsCache[id];
                    if (row) { row.title = title; row.category = category; row.description = description; }
                    renderMergedMaterials();
                } else {
                    // 레거시(archiveStudy/archiveEtc)는 Firestore 규칙상 본인 글이면 클라이언트에서 직접 수정할 수 있다(삭제와 동일한 권한 구조).
                    await updateDoc(doc(fdb, collectionName, id), { title, category, desc: description });
                }
                closeMaterialEditModal();
            } catch (e) {
                console.error("자료 수정 오류:", e);
                alert(e.message || "자료 수정에 실패했습니다.\n잠시 후 다시 시도해주세요.");
            } finally {
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalText; }
                if (statusEl) statusEl.style.display = 'none';
            }
        };

        // --- 자료실 병합 렌더링: 기존 Firestore(archiveStudy/archiveEtc, 과거 데이터만) + 신규 Supabase(실제 파일)를 하나의 목록으로 합친다 ---
        let materialsStudyCache = {};
        let materialsEtcCache = {};
        let supabaseMaterialsCache = {}; // id -> row
        let materialsCategoryFilter = '전체';
        let materialsSortMode = 'latest'; // 'latest' | 'oldest' | 'downloads' | 'title'

        window.setMaterialsSortMode = function(mode) {
            materialsSortMode = mode;
            gmwResetPage('materials');
            renderMergedMaterials();
        };

        window.setMaterialsCategoryFilter = function(cat) {
            materialsCategoryFilter = cat;
            gmwResetPage('materials');
            renderMergedMaterials();
        };

        let supabaseLoadFailed = false;

        async function loadSupabaseMaterials() {
            const statusEl = document.getElementById('materials-conn-status');
            try {
                const { data, error } = await sb.from('materials').select('*').eq('status', 'active').order('created_at', { ascending: false });
                if (error) throw error;
                supabaseMaterialsCache = {};
                (data || []).forEach(row => { supabaseMaterialsCache[row.id] = row; });
                supabaseLoadFailed = false;
                if (statusEl) statusEl.style.display = 'none';
            } catch (e) {
                console.warn('자료실(Supabase) 연결 오류:', e);
                supabaseLoadFailed = true;
                if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = '● 자료실 서버 연결 오류'; }
            }
            renderMergedMaterials();
        }

        // =========================================================================
        // 🎵 1-2 Music
        //
        // 원칙:
        //  - 기존 MixTape 엔진(.mixtape-app, window.MixTapeApp, IndexedDB "mixtapeDB")은 전혀 건드리지 않는다.
        //    "내 음악 · 플레이리스트" 패널은 기존 mixtape-app-root를 그대로 보여주기만 한다.
        //  - 개인 음악 라이브러리 = 기존 mixtapeDB(IndexedDB)를 그대로 재사용 (새 DB 안 만듦)
        //  - 공유 음악/좋아요/재생기록 = 새 Supabase 프로젝트(1-2-music)
        //  - anon 키로는 절대 직접 insert/update/delete하지 않는다 (자료실과 동일한 원칙).
        //    공유/좋아요/다운로드기록/재생기록은 전부 music-write Edge Function을 통해서만 이루어진다.
        // =========================================================================

        // Music 탭의 아무 화면이나 보여주는 대신, 지금 재생 중인 바로 그 플레이리스트의 실제 재생
        // 화면으로 바로 이동한다. 홈 위젯("현재 재생")과 인라인 미니 위젯 둘 다 이 함수를 쓴다.
        window.goToNowPlayingPlaylist = function() {
            window.switchTab('mixtape');
            const nowPlaying = window.MixTapeApp && window.MixTapeApp.getNowPlaying ? window.MixTapeApp.getNowPlaying() : null;
            // "내 음악"에서 재생 중(다음 곡 랜덤 재생 포함)이면 플레이리스트 목록이 아니라
            // 내 음악 탭으로 바로 이동한다 - 애초에 플레이리스트가 아니라 내 음악 라이브러리에서
            // 재생 중인 곡이므로, 거길 눌러도 "재생 중인 걸 볼 수 있는 곳"이 아니면 의미가 없다.
            if (nowPlaying && nowPlaying.isMyMusicAutoNext) {
                window.switchMusicSection('mymusic');
                return;
            }
            window.switchMusicSection('library');
            const currentId = window.MixTapeApp && window.MixTapeApp.getCurrentPlaylistId ? window.MixTapeApp.getCurrentPlaylistId() : null;
            // 임시 재생(공유 음악 등을 바로 듣는 것)은 특정 플레이리스트에 속하지 않으므로
            // (getNowPlaying().index === -1) 이때는 목록 화면까지만 이동한다.
            if (nowPlaying && nowPlaying.index !== -1 && currentId != null) {
                window.openPlaylistPlayer(currentId);
            }
        };

        window.switchMusicSection = function(section) {
            document.querySelectorAll('.music-subnav-item').forEach(el => el.classList.toggle('active', el.dataset.section === section));
            document.querySelectorAll('.music-panel').forEach(el => el.classList.toggle('active', el.id === `music-panel-${section}`));
            if (section === 'home') renderMusicHome();
            if (section === 'shared') loadSharedMusic();
            else if (section === 'likes') loadMusicLikes();
            else if (section === 'mymusic') renderMyMusicList();
            else if (section === 'library') {
                // 문서 요구사항: 플레이리스트 섹션에 들어오면 항상 "이름 목록"부터 먼저 보여준다
                // (재생 중이던 곡을 멈추지는 않는다 - 화면 전환만 할 뿐 audio는 그대로 재생된다)
                document.getElementById('playlist-player-wrapper').style.display = 'none';
                document.getElementById('playlist-browse-wrapper').style.display = 'none';
                document.getElementById('playlist-name-list-view').style.display = 'block';
                window.__inPlaylistPlayScreen = false;
                if (window.GlobalMiniController) window.GlobalMiniController.handleGesture(); // PiP 억제 해제 반영
                renderPlaylistNameList();
            }
            // 플레이리스트 섹션을 벗어나 다른 섹션으로 가는 경우에도 "재생 화면" 억제 플래그는 꺼둔다
            // (그 다른 화면들에선 기존처럼 PiP가 정상적으로 떠야 하므로)
            if (section !== 'library') {
                if (window.__inPlaylistPlayScreen) {
                    window.__inPlaylistPlayScreen = false;
                    if (window.GlobalMiniController) window.GlobalMiniController.handleGesture();
                }
            }
        };

        // --- 📁 플레이리스트 이름 목록 / 음악 플레이 화면 전환 ---
        window.renderPlaylistNameList = async function() {
            const listEl = document.getElementById('playlist-name-list');
            if (!listEl) return;
            try {
                const playlists = await musicDbGetAllPlaylists();
                if (playlists.length === 0) {
                    listEl.innerHTML = '<div class="widget-text">아직 플레이리스트가 없습니다.<br>"+ 새 플레이리스트"로 만들어보세요.</div>';
                    return;
                }
                const nowPlayingId = window.MixTapeApp && window.MixTapeApp.getCurrentPlaylistId ? window.MixTapeApp.getCurrentPlaylistId() : null;
                const nowPlaying = window.MixTapeApp && window.MixTapeApp.getNowPlaying ? window.MixTapeApp.getNowPlaying() : null;
                listEl.innerHTML = playlists.map(p => {
                    const isPlayingThis = nowPlayingId === p.id && nowPlaying && nowPlaying.playing;
                    const safeName = escapeJsAttr(p.name || '');
                    return `
                        <div style="display:flex; align-items:center; justify-content:space-between; padding:14px 16px; margin-bottom:8px; background:var(--card-bg); border:1px solid var(--border-color); border-radius:12px;">
                            <span onclick="openPlaylistPlayer(${p.id})" style="flex:1; min-width:0; cursor:pointer; display:flex; align-items:center; justify-content:space-between; gap:8px;">
                                <span style="font-size:14.5px; font-weight:700; color:var(--text-main); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">🎵 ${escapeNoticeText(p.name || '이름없음')}</span>
                                <span style="font-size:12px; color:var(--text-muted); white-space:nowrap;">${isPlayingThis ? '▶ 재생 중' : `${(p.trackIds || []).length}곡`}</span>
                            </span>
                            <span style="display:flex; gap:10px; margin-left:12px; font-size:13px; flex-shrink:0;">
                                <span onclick="openRenamePlaylistModal(${p.id}, '${safeName}')" style="cursor:pointer;" title="이름 수정">✏️</span>
                                <span onclick="deletePlaylistFromList(${p.id}, '${safeName}')" style="cursor:pointer;" title="삭제">🗑</span>
                            </span>
                        </div>
                    `;
                }).join('');
            } catch (e) {
                console.error('플레이리스트 목록 로딩 오류:', e);
                listEl.innerHTML = '<div class="widget-text">불러오지 못했습니다.</div>';
            }
        };

        // ⚠️ 지금 다른 곡이 재생 중인데, 그 곡이 들어있지 않은 다른 플레이리스트를 열면 - 예전엔
        // switchToPlaylist()가 무조건 재생을 멈추고 그 플레이리스트로 갈아탔다. 그러면 "재생 중인
        // 플레이리스트가 아닌 다른 걸 들어가도 원래 곡이 계속 재생되면서 PiP로 보여야 한다"는
        // 요구사항과 맞지 않는다. 그래서 재생 중인 곡이 있고 그게 이 플레이리스트가 아니면, 재생
        // 엔진은 건드리지 않고 "보기 전용" 화면(#playlist-browse-wrapper)만 연다 - 그래야 재생이
        // 끊기지 않고, __inPlaylistPlayScreen이 false로 남아 전역 PiP도 계속 보인다.
        window.openPlaylistPlayer = async function(playlistId) {
            const currentId = window.MixTapeApp && window.MixTapeApp.getCurrentPlaylistId ? window.MixTapeApp.getCurrentPlaylistId() : null;
            const nowPlaying = window.MixTapeApp && window.MixTapeApp.getNowPlaying ? window.MixTapeApp.getNowPlaying() : null;
            const isSomethingElsePlaying = !!(nowPlaying && nowPlaying.playing) && currentId !== playlistId;

            document.getElementById('playlist-name-list-view').style.display = 'none';

            if (isSomethingElsePlaying) {
                document.getElementById('playlist-player-wrapper').style.display = 'none';
                document.getElementById('playlist-browse-wrapper').style.display = 'block';
                window.__inPlaylistPlayScreen = false;
                await renderPlaylistBrowseView(playlistId);
                if (window.GlobalMiniController) window.GlobalMiniController.handleGesture();
                return;
            }

            try {
                // ⚠️ switchPlaylist()는 호출될 때마다 무조건 재생을 멈추고 처음부터 다시 불러온다.
                // 그래서 "이미 열려있는 바로 그 플레이리스트"를 다시 클릭했을 때는 아예 호출하지 않는다 -
                // 이래야 재생 중이던 곡이 화면 전환 때문에 끊기지 않는다.
                if (currentId !== playlistId && window.MixTapeApp && window.MixTapeApp.switchToPlaylist) {
                    await window.MixTapeApp.switchToPlaylist(playlistId);
                }
            } catch (e) { console.error('플레이리스트 열기 오류:', e); }
            document.getElementById('playlist-browse-wrapper').style.display = 'none';
            document.getElementById('playlist-player-wrapper').style.display = 'block';
            resetPlaylistSelectModeUI(); // 문서 요구사항: 플레이리스트를 바꾸면 선택 모드는 항상 종료된 상태로 시작
            window.__inPlaylistPlayScreen = true;
            if (window.GlobalMiniController) window.GlobalMiniController.handleGesture(); // 재생화면 진입 - PiP 억제 반영
        };

        // 보기 전용 화면: 다른 곡이 재생 중일 때 열어본 "재생 중이 아닌" 플레이리스트.
        // 재생 엔진(MixTapeApp)의 playlist/currentIndex는 전혀 건드리지 않고, IndexedDB에서
        // 트랙만 직접 읽어와 보여준다. 곡을 누르면 그때 실제로 재생을 이 플레이리스트로 전환한다.
        // 실제 카세트 플레이어(#mixtape-app-root)와 똑같은 CSS 클래스(.cassette/.tracks/.track-*)를
        // 그대로 재사용해서 겉모습을 동일하게 만든다 - id는 전부 다르고, 이 DOM은 재생 엔진과
        // 완전히 분리돼 있어서 재생 중인 다른 곡에는 아무 영향이 없다.
        async function renderPlaylistBrowseView(playlistId) {
            const labelEl = document.getElementById('playlist-browse-tape-label');
            const countEl = document.getElementById('playlist-browse-trackcount');
            const listEl = document.getElementById('playlist-browse-tracklist');
            try {
                const playlists = await musicDbGetAllPlaylists();
                const pl = playlists.find(p => p.id === playlistId);
                if (labelEl) labelEl.textContent = pl ? escapeNoticeText(pl.name || '이름없음') : '플레이리스트';
                const tracks = (window.MixTapeApp && window.MixTapeApp.getTracksForPlaylist) ? await window.MixTapeApp.getTracksForPlaylist(playlistId) : [];
                if (countEl) countEl.textContent = `${tracks.length}곡`;
                if (!listEl) return;
                if (tracks.length === 0) {
                    listEl.innerHTML = '<li><div class="empty-state" style="width:100%;">아직 추가된 곡이 없어요</div></li>';
                    return;
                }
                listEl.innerHTML = tracks.map((t, i) => `
                    <li onclick="playTrackFromBrowse(${playlistId}, ${i})">
                        <div class="track-num">${String(i + 1).padStart(2, '0')}</div>
                        <div class="track-info"><div class="track-name">${escapeNoticeText(t.name || '이름없음')}</div></div>
                        <div class="track-dur">--:--</div>
                        <div class="track-move">
                            <button type="button" onclick="event.stopPropagation(); moveTrackInBrowse(${playlistId}, ${i}, -1);" title="위로 이동" ${i === 0 ? 'disabled' : ''}>▲</button>
                            <button type="button" onclick="event.stopPropagation(); moveTrackInBrowse(${playlistId}, ${i}, 1);" title="아래로 이동" ${i === tracks.length - 1 ? 'disabled' : ''}>▼</button>
                        </div>
                        <button type="button" class="track-remove" onclick="event.stopPropagation(); removeTrackFromBrowse(${playlistId}, ${t.id});" title="이 플레이리스트에서 빼기">✕</button>
                    </li>
                `).join('');
            } catch (e) {
                console.error('플레이리스트 미리보기 로딩 오류:', e);
                if (listEl) listEl.innerHTML = '<li><div class="empty-state" style="width:100%;">불러오지 못했습니다.</div></li>';
            }
        }

        window.playTrackFromBrowse = async function(playlistId, index) {
            try {
                if (window.MixTapeApp && window.MixTapeApp.playTrackInPlaylist) {
                    await window.MixTapeApp.playTrackInPlaylist(playlistId, index);
                }
            } catch (e) { console.error('플레이리스트 트랙 재생 오류:', e); }
            openPlaylistPlayer(playlistId); // 이제 이 플레이리스트가 재생 중이니, 실제 재생 화면으로 전환한다
        };

        window.removeTrackFromBrowse = async function(playlistId, trackId) {
            try {
                if (window.MixTapeApp && window.MixTapeApp.removeTrackFromPlaylist) {
                    await window.MixTapeApp.removeTrackFromPlaylist(playlistId, trackId);
                }
                await renderPlaylistBrowseView(playlistId);
            } catch (e) { console.error('플레이리스트 트랙 제거 오류:', e); }
        };

        window.moveTrackInBrowse = async function(playlistId, index, dir) {
            try {
                if (!window.MixTapeApp || !window.MixTapeApp.getTracksForPlaylist || !window.MixTapeApp.reorderPlaylistTracks) return;
                const tracks = await window.MixTapeApp.getTracksForPlaylist(playlistId);
                const j = index + dir;
                if (j < 0 || j >= tracks.length) return;
                [tracks[index], tracks[j]] = [tracks[j], tracks[index]];
                await window.MixTapeApp.reorderPlaylistTracks(playlistId, tracks.map(t => t.id));
                await renderPlaylistBrowseView(playlistId);
            } catch (e) { console.error('플레이리스트 순서 변경 오류:', e); }
        };

        window.closePlaylistBrowse = function() {
            document.getElementById('playlist-browse-wrapper').style.display = 'none';
            document.getElementById('playlist-name-list-view').style.display = 'block';
            renderPlaylistNameList();
        };

        window.closePlaylistPlayer = function() {
            document.getElementById('playlist-player-wrapper').style.display = 'none';
            document.getElementById('playlist-name-list-view').style.display = 'block';
            resetPlaylistSelectModeUI(); // 선택 모드 상태로 남아있지 않도록 항상 초기화
            window.__inPlaylistPlayScreen = false; // 재생은 멈추지 않고, 화면만 목록으로 돌아간다
            if (window.GlobalMiniController) window.GlobalMiniController.handleGesture(); // PiP 억제 해제 반영
            renderPlaylistNameList(); // 방금 재생 중이던 곡 표시가 최신화되도록 다시 그린다
        };

        // 선택 모드 관련 UI만 화면상 원상복구한다 (곡 삭제 등 데이터 작업은 하지 않음)
        function resetPlaylistSelectModeUI() {
            const manageToolbar = document.getElementById('playlist-manage-toolbar');
            const selectToolbar = document.getElementById('playlist-select-toolbar');
            if (manageToolbar) manageToolbar.style.display = 'flex';
            if (selectToolbar) selectToolbar.style.display = 'none';
            if (window.MixTapeApp && window.MixTapeApp.exitSelectMode) window.MixTapeApp.exitSelectMode();
        }

        // 기존 플레이리스트 드로어의 "+ 새 플레이리스트" 버튼과 동일한 생성 로직을 그대로 재사용한다
        // (새 생성 로직을 따로 만들지 않고, 이미 있는 버튼을 프로그램적으로 눌러주는 방식)
        window.createNewPlaylistFromList = function() {
            const btn = document.getElementById('newPlaylistBtn');
            if (btn) btn.click();
            setTimeout(renderPlaylistNameList, 300); // 생성 직후 목록에 바로 반영
        };

        // --- 기존 MixTape의 IndexedDB("mixtapeDB")를 그대로 재사용하는 최소 헬퍼 ---
        // (MixTape 엔진의 스키마를 그대로 신뢰하고, 여기서는 onupgradeneeded를 만들지 않는다 -
        //  잘못 건드리면 기존 곡/플레이리스트가 깨질 수 있어서, 읽기/추가만 하는 최소 기능만 둔다)
        const MUSIC_DB_NAME = "mixtapeDB";
        const MUSIC_DB_VERSION = 3; // v3: 플레이리스트가 trackIds로 track을 참조하는 구조 (엔진 스크립트의 DB_VERSION과 반드시 맞춰야 함)
        function openMusicDB() {
            return new Promise((resolve, reject) => {
                if (!window.indexedDB) return reject(new Error('IndexedDB 미지원'));
                const req = indexedDB.open(MUSIC_DB_NAME, MUSIC_DB_VERSION);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }
        async function musicDbCountTracks() {
            try {
                const db = await openMusicDB();
                return await new Promise((resolve, reject) => {
                    const req = db.transaction('tracks', 'readonly').objectStore('tracks').count();
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });
            } catch (e) { return 0; }
        }
        // =========================================================================
        // 🎵 Step 4: ID3v2 태그 파서 (외부 라이브러리 없이 가볍게 직접 구현)
        //
        // ID3v2.3/2.4의 가장 흔한 프레임(TIT2=제목, TPE1=아티스트, TALB=앨범, TYER/TDRC=연도,
        // TCON=장르, APIC=앨범아트)을 읽는다. 태그가 없거나 형식이 다르면 조용히 null들을 반환하고,
        // 호출하는 쪽에서 파일명을 fallback으로 쓴다 (문서 4-5 요구사항: "확실하지 않으면 추측해서
        // 확정하지 않는다"). artworkBlob은 object URL이 아니라 원본 Blob 그대로 반환한다 - 그래야
        // IndexedDB에 저장했다가 나중에 다시 열어도(새로고침 이후에도) 유효한 URL을 새로 만들 수 있다.
        // =========================================================================
        async function parseId3Tags(file) {
            const empty = { title: null, artist: null, album: null, year: null, genre: null, artworkBlob: null };
            try {
                // ID3v2 헤더는 파일 맨 앞에 있고, 태그 전체 크기를 알려주므로 그만큼만 읽으면 충분하다
                // (전체 파일을 다 읽지 않아도 돼서 큰 파일에서도 빠르다)
                const headerBuf = await file.slice(0, 10).arrayBuffer();
                const header = new Uint8Array(headerBuf);
                if (header[0] !== 0x49 || header[1] !== 0x44 || header[2] !== 0x33) return empty; // "ID3"로 시작 안 하면 태그 없음

                const size = ((header[6] & 0x7f) << 21) | ((header[7] & 0x7f) << 14) | ((header[8] & 0x7f) << 7) | (header[9] & 0x7f);
                const tagBuf = await file.slice(10, 10 + size).arrayBuffer();
                const data = new Uint8Array(tagBuf);
                const decoder = (bytes, encodingByte) => {
                    try {
                        if (encodingByte === 1 || encodingByte === 2) return new TextDecoder('utf-16').decode(bytes).replace(/\u0000/g, '').trim();
                        return new TextDecoder('utf-8').decode(bytes).replace(/\u0000/g, '').trim();
                    } catch (e) { return ''; }
                };

                const result = { ...empty };
                let offset = 0;
                while (offset + 10 <= data.length) {
                    const frameId = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
                    if (!/^[A-Z0-9]{4}$/.test(frameId)) break; // 더 이상 유효한 프레임이 아니면 중단 (패딩 영역 등)
                    const frameSize = (data[offset + 4] << 24) | (data[offset + 5] << 16) | (data[offset + 6] << 8) | data[offset + 7];
                    if (frameSize <= 0 || offset + 10 + frameSize > data.length) break;
                    const frameStart = offset + 10;
                    const frameBytes = data.slice(frameStart, frameStart + frameSize);

                    if (['TIT2', 'TPE1', 'TALB', 'TYER', 'TDRC', 'TCON'].includes(frameId) && frameBytes.length > 1) {
                        const text = decoder(frameBytes.slice(1), frameBytes[0]);
                        if (frameId === 'TIT2') result.title = text || null;
                        else if (frameId === 'TPE1') result.artist = text || null;
                        else if (frameId === 'TALB') result.album = text || null;
                        else if (frameId === 'TYER' || frameId === 'TDRC') result.year = (text.match(/\d{4}/) || [null])[0];
                        else if (frameId === 'TCON') result.genre = text || null;
                    } else if (frameId === 'APIC' && frameBytes.length > 4 && !result.artworkBlob) {
                        // APIC 구조: [인코딩 1B][MIME 문자열 + null][그림종류 1B][설명 문자열 + null(들)][원본 이미지 바이너리]
                        // 이미지가 여러 개(앞표지/뒷표지 등)면 맨 처음 것만 쓴다.
                        try {
                            const encByte = frameBytes[0];
                            let pos = 1;
                            let mimeEnd = pos;
                            while (mimeEnd < frameBytes.length && frameBytes[mimeEnd] !== 0) mimeEnd++;
                            const mime = decoder(frameBytes.slice(pos, mimeEnd), 0);
                            pos = mimeEnd + 1; // null 종료 바이트 건너뛰기
                            pos += 1; // 그림 종류(picture type) 1바이트 건너뛰기
                            if (encByte === 1 || encByte === 2) {
                                while (pos + 1 < frameBytes.length && !(frameBytes[pos] === 0 && frameBytes[pos + 1] === 0)) pos += 2;
                                pos += 2;
                            } else {
                                while (pos < frameBytes.length && frameBytes[pos] !== 0) pos++;
                                pos += 1;
                            }
                            const imageBytes = frameBytes.slice(pos);
                            if (mime && mime !== '-->' && imageBytes.length > 0) {
                                result.artworkBlob = new Blob([imageBytes], { type: mime });
                            }
                        } catch (e) {
                            console.warn('앨범아트(APIC) 파싱 실패(무시):', e);
                        }
                    }

                    offset = frameStart + frameSize;
                }
                return result;
            } catch (e) {
                console.warn('ID3 태그 파싱 실패(무시하고 파일명으로 대체):', e);
                return empty;
            }
        }

        async function musicDbGetDefaultPlaylistId() {
            const db = await openMusicDB();
            return new Promise((resolve, reject) => {
                const req = db.transaction('playlists', 'readonly').objectStore('playlists').getAll();
                req.onsuccess = () => {
                    const list = (req.result || []).sort((a, b) => (a.order || 0) - (b.order || 0));
                    resolve(list.length ? list[0].id : null);
                };
                req.onerror = () => reject(req.error);
            });
        }
        // 공유 음악을 다운로드해서 "내 음악"(기존 MixTape 라이브러리)에 저장한다.
        async function musicDbAddTrackBlob(blob, name) {
            const playlistId = await musicDbGetDefaultPlaylistId();
            if (playlistId == null) throw new Error('저장할 플레이리스트를 찾을 수 없습니다.');
            return musicDbAddTrackBlobToPlaylist(playlistId, blob, name);
        }

        // v3: 완전히 "새로운" 음악 파일을 tracks에 1회 저장하고, 지정한 플레이리스트에 참조를 추가한다.
        // (이미 tracks에 있는 곡을 다른 플레이리스트에 추가할 때는 이 함수를 쓰지 않는다 - 아래
        // musicDbAddTrackRefToPlaylist를 쓴다. 이 함수는 blob 자체가 새로 생기는 경우에만 사용한다.)
        // sharedTrackId: 공유 음악에서 받아온 경우, 원본 공유곡의 id를 같이 저장해둔다 -
        // "내 음악에 있음" 여부를 이 브라우저의 실제 라이브러리 기준으로 판단하기 위해 필요하다.
        async function musicDbAddTrackBlobToPlaylist(playlistId, blob, name, sourceType, sharedTrackId) {
            const db = await openMusicDB();
            // 1) tracks에 이 blob을 "한 번만" 저장한다 (playlistId/order 필드 없음 - 더 이상 특정
            //    플레이리스트를 소유하지 않는다)
            const trackId = await new Promise((resolve, reject) => {
                const rec = {
                    name, blob,
                    sourceType: sourceType || 'local',
                    createdAt: Date.now()
                };
                if (sharedTrackId != null) rec.sharedTrackId = sharedTrackId;
                const req = db.transaction('tracks', 'readwrite').objectStore('tracks').add(rec);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            // 2) 지정한 플레이리스트의 trackIds 배열에 방금 만든 track의 id만 추가한다 (참조)
            await musicDbAddTrackRefToPlaylist(playlistId, trackId);
            return trackId;
        }

        // v3 신규: 이미 tracks에 존재하는 곡(blob 복사 없이)을 지정한 플레이리스트에 참조로 추가한다.
        // "내 음악에서 추가" 기능이 이 함수를 사용한다 - 같은 곡을 여러 플레이리스트에 넣어도 blob은
        // 하나만 존재한다. 같은 플레이리스트에 이미 있으면 중복 추가하지 않는다.
        async function musicDbAddTrackRefToPlaylist(playlistId, trackId) {
            const db = await openMusicDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction('playlists', 'readwrite');
                const store = tx.objectStore('playlists');
                const getReq = store.get(playlistId);
                getReq.onsuccess = () => {
                    const rec = getReq.result;
                    if (!rec) { resolve(false); return; }
                    if (!Array.isArray(rec.trackIds)) rec.trackIds = [];
                    if (rec.trackIds.includes(trackId)) { resolve(false); return; } // 중복 방지
                    rec.trackIds.push(trackId);
                    const putReq = store.put(rec);
                    putReq.onsuccess = () => resolve(true);
                    putReq.onerror = () => reject(putReq.error);
                };
                getReq.onerror = () => reject(getReq.error);
            });
        }

        async function musicDbGetAllPlaylists() {
            const db = await openMusicDB();
            return new Promise((resolve, reject) => {
                const req = db.transaction('playlists', 'readonly').objectStore('playlists').getAll();
                req.onsuccess = () => resolve((req.result || []).sort((a, b) => (a.order || 0) - (b.order || 0)));
                req.onerror = () => reject(req.error);
            });
        }

        // 순수하게 "내 음악"에만 저장한다 - 어떤 플레이리스트에도 자동으로 연결하지 않는다.
        // (기존 musicDbAddTrackBlobToPlaylist는 항상 특정 플레이리스트에 바로 연결했지만,
        // MP3 직접 추가는 "내 음악" 라이브러리에만 저장되고 플레이리스트 추가는 별도 동작이다)
        async function musicDbAddTrackOnly(blob, title, artist, sourceType, artworkBlob) {
            const db = await openMusicDB();
            const name = artist ? `${title} - ${artist}` : title; // 기존 엔진(마퀴/테이프 라벨 등)이 쓰는 단일 표시문자열과 호환
            const rec = {
                name, title, artist: artist || '', blob,
                sourceType: sourceType || 'local',
                createdAt: Date.now()
            };
            if (artworkBlob) rec.artwork = artworkBlob; // ID3 APIC에서 추출한 앨범아트 (있을 때만 저장)
            return new Promise((resolve, reject) => {
                const req = db.transaction('tracks', 'readwrite').objectStore('tracks').add(rec);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }

        async function musicDbRenameTrack(trackId, newTitle, newArtist) {
            const db = await openMusicDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction('tracks', 'readwrite');
                const store = tx.objectStore('tracks');
                const getReq = store.get(trackId);
                getReq.onsuccess = () => {
                    const rec = getReq.result;
                    if (!rec) { resolve(); return; }
                    rec.title = newTitle;
                    rec.artist = newArtist || '';
                    rec.name = newArtist ? `${newTitle} - ${newArtist}` : newTitle; // 마퀴/테이프 라벨 등 기존 표시문자열도 같이 갱신
                    const putReq = store.put(rec);
                    putReq.onsuccess = () => resolve();
                    putReq.onerror = () => reject(putReq.error);
                };
                getReq.onerror = () => reject(getReq.error);
            });
        }

        async function musicDbRenamePlaylist(id, newName) {
            const db = await openMusicDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction('playlists', 'readwrite');
                const store = tx.objectStore('playlists');
                const getReq = store.get(id);
                getReq.onsuccess = () => {
                    const rec = getReq.result;
                    if (!rec) { resolve(); return; }
                    rec.name = newName; // id는 절대 바꾸지 않는다
                    const putReq = store.put(rec);
                    putReq.onsuccess = () => resolve();
                    putReq.onerror = () => reject(putReq.error);
                };
                getReq.onerror = () => reject(getReq.error);
            });
        }

        // 플레이리스트 레코드만 삭제한다 (v3 원칙: tracks는 절대 연쇄 삭제하지 않음)
        async function musicDbDeletePlaylist(id) {
            const db = await openMusicDB();
            return new Promise((resolve, reject) => {
                const req = db.transaction('playlists', 'readwrite').objectStore('playlists').delete(id);
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
        }

        // 특정 플레이리스트의 trackIds 순서대로 실제 track(제목/가수 포함) 정보를 가져온다 (다중 선택 UI용)
        async function musicDbGetTracksByPlaylist(playlistId) {
            const db = await openMusicDB();
            const playlistRec = await new Promise((resolve, reject) => {
                const req = db.transaction('playlists', 'readonly').objectStore('playlists').get(playlistId);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            const trackIds = (playlistRec && Array.isArray(playlistRec.trackIds)) ? playlistRec.trackIds : [];
            if (trackIds.length === 0) return [];
            return new Promise((resolve, reject) => {
                const store = db.transaction('tracks', 'readonly').objectStore('tracks');
                const results = [];
                let pending = trackIds.length;
                let hadError = false;
                trackIds.forEach((id, order) => {
                    const req = store.get(id);
                    req.onsuccess = () => {
                        if (req.result) results.push({ ...req.result, order });
                        pending--;
                        if (pending === 0 && !hadError) resolve(results.sort((a, b) => a.order - b.order));
                    };
                    req.onerror = () => { hadError = true; reject(req.error); };
                });
            });
        }

        // 선택된 여러 곡을 "이 플레이리스트에서만" 제거한다 (내 음악의 track 자체는 절대 건드리지 않음)
        async function musicDbRemoveTracksFromPlaylist(playlistId, trackIds) {
            const db = await openMusicDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction('playlists', 'readwrite');
                const store = tx.objectStore('playlists');
                const getReq = store.get(playlistId);
                getReq.onsuccess = () => {
                    const rec = getReq.result;
                    if (!rec || !Array.isArray(rec.trackIds)) { resolve(); return; }
                    const removeSet = new Set(trackIds);
                    rec.trackIds = rec.trackIds.filter(id => !removeSet.has(id));
                    const putReq = store.put(rec);
                    putReq.onsuccess = () => resolve();
                    putReq.onerror = () => reject(putReq.error);
                };
                getReq.onerror = () => reject(getReq.error);
            });
        }

        // 내가 가진 전체 트랙 목록(=tracks 스토어 전체). v3부터는 곡마다 blob이 하나씩만 존재하므로
        // 같은 곡이 여러 플레이리스트에 있어도 여기엔 한 번만 나온다.
        async function musicDbGetAllTracks() {
            const db = await openMusicDB();
            return new Promise((resolve, reject) => {
                const req = db.transaction('tracks', 'readonly').objectStore('tracks').getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });
        }

        // 이 트랙을 참조하고 있는 플레이리스트 목록 (내 음악에서 삭제하기 전 고아 참조 방지용 확인)
        async function musicDbGetPlaylistsReferencing(trackId) {
            const playlists = await musicDbGetAllPlaylists();
            return playlists.filter(p => Array.isArray(p.trackIds) && p.trackIds.includes(trackId));
        }

        // 내 음악에서 완전히 삭제: 모든 플레이리스트의 trackIds에서 먼저 참조를 제거한 뒤 tracks에서 삭제한다
        // (참조가 남은 채로 blob만 지워지는 "고아 참조"가 생기지 않도록 순서를 반드시 지킨다)
        async function musicDbDeleteTrackEverywhere(trackId) {
            const db = await openMusicDB();
            const refs = await musicDbGetPlaylistsReferencing(trackId);
            for (const p of refs) {
                await new Promise((resolve, reject) => {
                    const store = db.transaction('playlists', 'readwrite').objectStore('playlists');
                    const rec = { ...p, trackIds: p.trackIds.filter(id => id !== trackId) };
                    const req = store.put(rec);
                    req.onsuccess = () => resolve();
                    req.onerror = () => reject(req.error);
                });
            }
            await new Promise((resolve, reject) => {
                const req = db.transaction('tracks', 'readwrite').objectStore('tracks').delete(trackId);
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
        }

        // 내 음악 트랙 카드 하나의 HTML. mymusic-list와 Music Home 검색 결과 둘 다에서 재사용한다.
        // 앨범아트를 Blob에서 object URL로 새로 만들 때마다 호출부가 나중에 해제할 수 있도록
        // artworkUrlsSink 배열에 push해둔다 (호출부마다 자기 화면 영역의 URL을 따로 관리).
        function myMusicTrackCardHTML(t, artworkUrlsSink, selectable) {
            const title = t._title != null ? t._title : (t.title || t.name || '제목 없음');
            const artist = t._artist != null ? t._artist : (t.artist || '');
            const safeName = escapeJsAttr(title);
            const safeArtist = escapeJsAttr(artist);
            let artHtml = musicTrackIcon();
            if (t.artwork) {
                const artUrl = URL.createObjectURL(t.artwork);
                artworkUrlsSink.push(artUrl);
                artHtml = `<img src="${artUrl}" onerror="this.parentElement.textContent='${musicTrackIcon()}'">`;
            }
            // 다중 선택(내 음악 탭 전용)이 켜져 있을 때만 체크박스를 보여준다 - Music Home 검색 결과 등
            // 이 카드를 재사용하는 다른 화면에는 selectable을 안 넘기므로 영향 없다.
            const checkboxHtml = selectable
                ? `<input type="checkbox" class="mymusic-select-checkbox" data-track-id="${t.id}" ${myMusicSelectedIds.has(t.id) ? 'checked' : ''} onclick="event.stopPropagation()" onchange="toggleMyMusicTrackSelected(${t.id}, this.checked)" style="width:18px; height:18px; flex-shrink:0; cursor:pointer;">`
                : '';
            // 선택(다중 삭제) 모드에서는 카드 아무 곳이나 눌렀을 때 실수로 재생이 시작되면 안 되므로
            // (체크박스 토글하려던 걸 방해함), 그때만 카드 전체 클릭 재생을 꺼둔다.
            const cardClickAttr = selectable ? '' : ` onclick="playMyMusicTrack(${t.id}, '${safeName}')"`;
            return `
                <div class="music-track-card mymusic-card"${cardClickAttr} style="margin-bottom:8px; ${selectable ? '' : 'cursor:pointer;'}">
                    <div class="music-track-top">
                        ${checkboxHtml}
                        <div class="music-track-art">${artHtml}</div>
                        <div style="min-width:0; flex:1;">
                            <div class="music-track-title">${escapeNoticeText(title)}</div>
                            <div class="music-track-artist">${artist ? escapeNoticeText(artist) : (t.sourceType === 'community' ? '친구 공유 음악' : '아티스트 미상')}</div>
                        </div>
                    </div>
                    <div class="music-track-actions">
                        <span onclick="event.stopPropagation(); playMyMusicTrack(${t.id}, '${safeName}')" style="color:var(--primary); font-weight:700;">▶ 재생</span>
                        <span onclick="event.stopPropagation(); openAddSingleTrackModal(${t.id})">＋ 플레이리스트</span>
                        <span onclick="event.stopPropagation(); openMyMusicRenameModal(${t.id}, '${safeName}', '${safeArtist}')">✏️ 수정</span>
                        ${t.artwork ? '' : `<span onclick="event.stopPropagation(); openMyMusicRenameModal(${t.id}, '${safeName}', '${safeArtist}', true)">🖼 앨범아트 추가</span>`}
                        <span onclick="event.stopPropagation(); deleteMyMusicTrack(${t.id})" style="color:#ef4444;">삭제</span>
                    </div>
                </div>
            `;
        }

        // --- 내 음악 다중 선택(한 번에 삭제) ---
        let myMusicSelectMode = false;
        let myMusicSelectedIds = new Set();
        window.toggleMyMusicSelectMode = function() {
            myMusicSelectMode = !myMusicSelectMode;
            if (!myMusicSelectMode) myMusicSelectedIds.clear();
            updateMyMusicSelectModeUI();
            renderMyMusicList();
        };
        function updateMyMusicSelectModeUI() {
            const toggleBtn = document.getElementById('mymusic-select-toggle-btn');
            const selectAllBtn = document.getElementById('mymusic-select-all-btn');
            const deleteBtn = document.getElementById('mymusic-delete-selected-btn');
            if (toggleBtn) toggleBtn.textContent = myMusicSelectMode ? '✕ 선택 취소' : '☑️ 선택';
            if (selectAllBtn) selectAllBtn.style.display = myMusicSelectMode ? 'inline-flex' : 'none';
            if (deleteBtn) {
                deleteBtn.style.display = myMusicSelectMode ? 'inline-flex' : 'none';
                deleteBtn.textContent = `선택 삭제 (${myMusicSelectedIds.size})`;
                deleteBtn.disabled = myMusicSelectedIds.size === 0;
                deleteBtn.style.opacity = myMusicSelectedIds.size === 0 ? '0.5' : '1';
            }
        }
        window.toggleMyMusicTrackSelected = function(trackId, checked) {
            if (checked) myMusicSelectedIds.add(trackId); else myMusicSelectedIds.delete(trackId);
            updateMyMusicSelectModeUI();
        };
        // 지금 화면에 실제로 렌더링된(검색/정렬이 반영된) 카드들 기준으로 전체선택/전체해제를 토글한다
        window.toggleMyMusicSelectAll = function() {
            const ids = Array.from(document.querySelectorAll('#mymusic-list .mymusic-select-checkbox')).map(el => parseInt(el.dataset.trackId, 10));
            const allSelected = ids.length > 0 && ids.every(id => myMusicSelectedIds.has(id));
            if (allSelected) ids.forEach(id => myMusicSelectedIds.delete(id));
            else ids.forEach(id => myMusicSelectedIds.add(id));
            renderMyMusicList();
        };
        window.deleteSelectedMyMusicTracks = async function() {
            if (myMusicSelectedIds.size === 0) return;
            const ids = Array.from(myMusicSelectedIds);
            if (!confirm(`선택한 ${ids.length}곡을 내 음악에서 완전히 삭제할까요?\n플레이리스트에 포함된 곡이 있다면 거기서도 함께 제거돼요.`)) return;
            let successCount = 0, failCount = 0;
            for (const id of ids) {
                try { await musicDbDeleteTrackEverywhere(id); successCount++; }
                catch (e) { console.error('내 음악 일괄 삭제 오류:', id, e); failCount++; }
            }
            myMusicSelectedIds.clear();
            myMusicSelectMode = false;
            updateMyMusicSelectModeUI();
            renderMyMusicList();
            alert(failCount === 0 ? `${successCount}곡을 삭제했습니다.` : `${successCount}곡 삭제 완료, ${failCount}곡은 삭제하지 못했습니다.`);
        };

        // 🎵 내 음악 (플레이리스트와 무관한 전체 라이브러리 뷰)
        // 렌더링할 때마다 앨범아트용 object URL을 새로 만드므로, 이전 것들을 여기 모아뒀다가
        // 다음 렌더링 직전에 해제한다 (안 그러면 검색/정렬할 때마다 URL이 계속 쌓여서 샌다).
        let myMusicArtworkUrls = [];
        // 한 줄에 몇 곡씩 보여줄지(1/3/4) - 개인 취향이라 이 브라우저에만 저장한다.
        const MYMUSIC_COLUMNS_KEY = 'hanilgo_mymusic_columns';
        function loadMyMusicColumns() {
            const saved = localStorage.getItem(MYMUSIC_COLUMNS_KEY);
            return (saved === '3' || saved === '4') ? saved : '1';
        }
        window.setMyMusicColumns = function(value) {
            try { localStorage.setItem(MYMUSIC_COLUMNS_KEY, value); } catch (e) {}
            applyMyMusicColumnsClass();
        };
        function applyMyMusicColumnsClass() {
            const listEl = document.getElementById('mymusic-list');
            const select = document.getElementById('mymusic-columns');
            const cols = loadMyMusicColumns();
            if (select) select.value = cols;
            if (!listEl) return;
            listEl.classList.toggle('mymusic-grid', cols !== '1');
            listEl.classList.remove('mymusic-cols-3', 'mymusic-cols-4');
            if (cols !== '1') listEl.classList.add(`mymusic-cols-${cols}`);
        }
        window.renderMyMusicList = async function() {
            const listEl = document.getElementById('mymusic-list');
            if (!listEl) return;
            applyMyMusicColumnsClass();
            updateMyMusicSelectModeUI();
            try {
                const tracks = await musicDbGetAllTracks();
                const q = (document.getElementById('mymusic-search')?.value || '').trim().toLowerCase();
                const sort = document.getElementById('mymusic-sort')?.value || 'latest';
                // 마이그레이션: title이 없는 기존 레코드(name만 있던 시절)는 표시 시점에 title=name, artist=''로 취급한다
                // (DB에 실제로 다시 쓰지는 않는다 - 표시할 때만 안전하게 폴백해서 기존 데이터를 건드리지 않는다)
                const withDisplay = tracks.map(t => ({ ...t, _title: t.title || t.name || '제목 없음', _artist: t.artist || '' }));
                let filtered = withDisplay;
                if (q) filtered = filtered.filter(t => t._title.toLowerCase().includes(q) || t._artist.toLowerCase().includes(q));
                if (sort === 'title') filtered.sort((a, b) => a._title.localeCompare(b._title, 'ko'));
                else if (sort === 'artist') filtered.sort((a, b) => {
                    // 가수 정보가 없는(미상) 곡은 목록 맨 뒤로 - 앞쪽에서 실제 가수 이름끼리 먼저 깔끔하게 묶여 보이도록.
                    const artA = a._artist || '￿', artB = b._artist || '￿';
                    return artA.localeCompare(artB, 'ko') || a._title.localeCompare(b._title, 'ko');
                });
                else filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

                if (filtered.length === 0) {
                    listEl.innerHTML = `<div class="card" style="text-align:center; color:var(--text-muted);">${tracks.length === 0 ? '아직 내 음악이 없습니다.<br>+ MP3 추가로 곡을 넣거나 공유 음악을 저장해보세요.' : '검색 결과가 없습니다.'}</div>`;
                    return;
                }
                myMusicArtworkUrls.forEach(url => URL.revokeObjectURL(url));
                myMusicArtworkUrls = [];
                listEl.innerHTML = filtered.map(t => myMusicTrackCardHTML(t, myMusicArtworkUrls, myMusicSelectMode)).join('');
            } catch (e) {
                console.error('내 음악 로딩 오류:', e);
                listEl.innerHTML = `<div class="card" style="text-align:center; color:var(--text-muted);">불러오지 못했습니다.<br>잠시 후 다시 시도해주세요.</div>`;
            }
        };

        window.playMyMusicTrack = async function(trackId, name) {
            if (!window.MixTapeApp || !window.MixTapeApp.playAdHocWithAutoNext) return alert("재생 엔진을 불러오지 못했습니다.");
            try {
                const db = await openMusicDB();
                const rec = await new Promise((resolve, reject) => {
                    const req = db.transaction('tracks', 'readonly').objectStore('tracks').get(trackId);
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });
                if (!rec) return alert("곡을 찾을 수 없습니다.");
                const url = URL.createObjectURL(rec.blob);
                const playName = name || rec.title || rec.name;
                myMusicLastAutoPlayedId = trackId;
                window.MixTapeApp.playAdHocWithAutoNext(url, playName, rec.artwork || null, myMusicPickRandomNext);
            } catch (e) {
                console.error('내 음악 재생 오류:', e);
                alert("재생에 실패했습니다.");
            }
        };

        // "내 음악"에서 재생 중이던 곡이 끝났을 때 다음 곡을 랜덤으로 골라준다 - 매번 최신 전체
        // 곡 목록에서 고르므로 재생 중에 곡이 추가/삭제돼도 자연스럽게 반영되고, 곡이 2개 이상이면
        // 방금 들은 곡이 바로 다시 나오지는 않는다.
        let myMusicLastAutoPlayedId = null;
        async function myMusicPickRandomNext() {
            const tracks = await musicDbGetAllTracks();
            if (!tracks || tracks.length === 0) return null;
            const pool = tracks.length > 1 ? tracks.filter(t => t.id !== myMusicLastAutoPlayedId) : tracks;
            const next = pool[Math.floor(Math.random() * pool.length)];
            myMusicLastAutoPlayedId = next.id;
            return { url: URL.createObjectURL(next.blob), name: next.title || next.name, artwork: next.artwork || null };
        }

        // 문서 §7: 참조 중인 플레이리스트가 있으면 사용자에게 명확히 안내한 뒤 진행 (고아 참조 방지)
        window.deleteMyMusicTrack = async function(trackId) {
            try {
                const refs = await musicDbGetPlaylistsReferencing(trackId);
                const msg = refs.length > 0
                    ? `이 음악은 ${refs.length}개의 플레이리스트(${refs.map(p => p.name).join(', ')})에서 사용 중입니다.\n삭제하면 해당 플레이리스트에서도 함께 제거돼요. 계속할까요?`
                    : "이 음악을 내 음악에서 완전히 삭제할까요?";
                if (!confirm(msg)) return;
                await musicDbDeleteTrackEverywhere(trackId);
                renderMyMusicList();
                renderMusicHome();
            } catch (e) {
                console.error('내 음악 삭제 오류:', e);
                alert("삭제에 실패했습니다.\n잠시 후 다시 시도해주세요.");
            }
        };

        // --- 🎵 내 음악에 MP3 추가 (제목/가수를 사용자가 직접 입력) ---
        let myMusicAddArtworkBlob = null; // 파일 선택 시(1개일 때) ID3에서 추출한 앨범아트 - 제출할 때 같이 저장한다
        let myMusicBatchArtworkBlobs = {}; // 여러 개일 때는 파일 순서(index)별로 보관한다
        window.openMyMusicAddModal = function() {
            document.getElementById('mymusic-add-file').value = '';
            document.getElementById('mymusic-add-title').value = '';
            document.getElementById('mymusic-add-artist').value = '';
            document.getElementById('mymusic-add-filename').textContent = '';
            document.getElementById('mymusic-add-single-fields').style.display = 'block';
            document.getElementById('mymusic-add-batch-note').style.display = 'none';
            const batchList = document.getElementById('mymusic-add-batch-list');
            batchList.style.display = 'none';
            batchList.innerHTML = '';
            myMusicAddArtworkBlob = null;
            myMusicBatchArtworkBlobs = {};
            myMusicSetArtPreview('mymusic-add-art-preview', null);
            document.getElementById('mymusic-add-art').value = ''; document.getElementById('mymusic-add-art-msg').textContent = '';
            document.getElementById('mymusic-add-modal').style.display = 'flex';
        };
        window.closeMyMusicAddModal = function() {
            document.getElementById('mymusic-add-modal').style.display = 'none';
            myMusicSetArtPreview('mymusic-add-art-preview', null);
        };
        // 파일명에서 확장자를 떼서 제목 기본값으로 쓴다 ("01. 좋은 노래.mp3" -> "01. 좋은 노래")
        function stripFileExtension(filename) {
            const idx = filename.lastIndexOf('.');
            return idx > 0 ? filename.slice(0, idx) : filename;
        }
        // 파일 선택 시 ID3 태그가 있으면 제목/가수/앨범아트를 미리 채운다 (없으면 파일명만 안내로 보여줌 - 억지로 채우지 않음).
        // 여러 개를 고르면 곡마다 개별 제목/가수 입력칸을 만들어서(태그가 있으면 미리 채워두고) 하나씩
        // 직접 고쳐서 추가할 수 있게 한다.
        window.handleMyMusicFileSelected = async function(event) {
            const files = Array.from(event.target.files || []);
            const filenameEl = document.getElementById('mymusic-add-filename');
            const singleFields = document.getElementById('mymusic-add-single-fields');
            const batchNote = document.getElementById('mymusic-add-batch-note');
            const batchList = document.getElementById('mymusic-add-batch-list');
            myMusicAddArtworkBlob = null;
            myMusicBatchArtworkBlobs = {};
            if (files.length === 0) return;

            if (files.length > 1) {
                filenameEl.textContent = `📎 ${files.length}개 파일 선택됨`;
                singleFields.style.display = 'none';
                batchNote.style.display = 'block';
                batchList.style.display = 'block';
                batchList.innerHTML = files.map((f, i) => `
                    <div class="mymusic-batch-row" style="margin-bottom:10px;">
                        <div style="font-size:11px; color:var(--text-muted); margin-bottom:3px; word-break:break-all;">📎 ${escapeNoticeText(f.name)}</div>
                        <div style="display:flex; gap:6px;">
                            <input type="text" class="auth-input mymusic-batch-title" data-idx="${i}" placeholder="제목 (비우면 파일명)" style="flex:1; margin-bottom:0; padding:8px 10px; font-size:13px;">
                            <input type="text" class="auth-input mymusic-batch-artist" data-idx="${i}" placeholder="가수 (비우면 미상)" style="flex:1; margin-bottom:0; padding:8px 10px; font-size:13px;">
                        </div>
                    </div>
                `).join('');
                // ID3 태그는 파일마다 비동기로 읽어서, 있으면 해당 입력칸을 미리 채워준다(없으면 빈 채로 둬서
                // 제출 시 파일명/'미상'으로 대체되게 한다). 사용자가 이미 손으로 값을 넣었다면 덮어쓰지 않는다.
                files.forEach(async (file, i) => {
                    try {
                        const tags = await parseId3Tags(file);
                        const titleInput = batchList.querySelector(`.mymusic-batch-title[data-idx="${i}"]`);
                        const artistInput = batchList.querySelector(`.mymusic-batch-artist[data-idx="${i}"]`);
                        if (titleInput && !titleInput.value.trim() && tags.title) titleInput.value = tags.title;
                        if (artistInput && !artistInput.value.trim() && tags.artist) artistInput.value = tags.artist;
                        myMusicBatchArtworkBlobs[i] = tags.artworkBlob || null;
                    } catch (e) { /* 태그 없으면 그냥 빈 채로 둔다 */ }
                });
                return;
            }

            singleFields.style.display = 'block';
            batchNote.style.display = 'none';
            batchList.style.display = 'none';
            batchList.innerHTML = '';
            const file = files[0];
            filenameEl.textContent = `📎 ${file.name}`;
            const titleInput = document.getElementById('mymusic-add-title');
            const artistInput = document.getElementById('mymusic-add-artist');
            try {
                const tags = await parseId3Tags(file);
                if (!titleInput.value.trim() && tags.title) titleInput.value = tags.title;
                if (!artistInput.value.trim() && tags.artist) artistInput.value = tags.artist;
                myMusicAddArtworkBlob = tags.artworkBlob || null;
                myMusicSetArtPreview('mymusic-add-art-preview', myMusicAddArtworkBlob); // 태그에서 찾은 앨범아트(있으면)를 보여준다
            } catch (e) { /* 태그 없으면 사용자가 직접 입력하거나 비워둔다(빈 값은 파일명/'미상'으로 채워진다) */ }
        };
        window.submitMyMusicAdd = async function() {
            const fileInput = document.getElementById('mymusic-add-file');
            const files = Array.from(fileInput.files || []);
            if (files.length === 0) return alert('MP3 파일을 선택해주세요.');

            if (files.length === 1) {
                const file = files[0];
                const title = document.getElementById('mymusic-add-title').value.trim() || stripFileExtension(file.name);
                const artist = document.getElementById('mymusic-add-artist').value.trim() || '미상';
                try {
                    await musicDbAddTrackOnly(file, title, artist, 'local', myMusicAddArtworkBlob);
                    closeMyMusicAddModal();
                    renderMyMusicList();
                    alert('내 음악에 추가되었습니다.');
                } catch (e) {
                    console.error('내 음악 추가 오류:', e);
                    alert('추가에 실패했습니다.\n잠시 후 다시 시도해주세요.');
                }
                return;
            }

            // 여러 곡 한꺼번에 추가: 곡마다 사용자가 입력해둔(또는 태그로 자동 채워진) 제목/가수를 쓰고,
            // 비어있으면 제목은 파일명/가수는 '미상'으로 저장한다.
            let successCount = 0, failCount = 0;
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                try {
                    const titleInput = document.querySelector(`.mymusic-batch-title[data-idx="${i}"]`);
                    const artistInput = document.querySelector(`.mymusic-batch-artist[data-idx="${i}"]`);
                    const title = (titleInput && titleInput.value.trim()) || stripFileExtension(file.name);
                    const artist = (artistInput && artistInput.value.trim()) || '미상';
                    const artworkBlob = myMusicBatchArtworkBlobs[i] || null;
                    await musicDbAddTrackOnly(file, title, artist, 'local', artworkBlob);
                    successCount++;
                } catch (e) {
                    console.error('내 음악 일괄 추가 오류:', file.name, e);
                    failCount++;
                }
            }
            closeMyMusicAddModal();
            renderMyMusicList();
            alert(failCount === 0
                ? `${successCount}곡이 내 음악에 추가되었습니다.`
                : `${successCount}곡 추가 완료, ${failCount}곡은 추가하지 못했습니다.`);
        };

        // --- 🖼 앨범아트: 이미지 파일을 골라 곡에 붙인다 (MP3 안에 앨범아트가 없는 곡용) ---
        // 곡 기록(IndexedDB tracks)의 artwork 필드에 이미지 Blob 을 저장한다. MP3 파일 자체(오디오/ID3 태그)는 수정하지 않는다.
        // 큰 사진이 저장소를 차지하지 않도록 긴 변 600px 이하 JPEG 로 줄여서 저장한다.
        const MY_MUSIC_ART_MAX_INPUT = 10 * 1024 * 1024, MY_MUSIC_ART_MAX_SIDE = 600;
        const myMusicArtUrls = {}; // 미리보기 object URL 을 칸(id)별로 관리해서 바꿀 때마다 해제한다
        function myMusicSetArtPreview(elId, blob) {
            const el = document.getElementById(elId); if (!el) return;
            if (myMusicArtUrls[elId]) { URL.revokeObjectURL(myMusicArtUrls[elId]); delete myMusicArtUrls[elId]; }
            if (blob) {
                const url = URL.createObjectURL(blob); myMusicArtUrls[elId] = url;
                el.innerHTML = `<img src="${url}" alt="">`;
            } else el.textContent = '🎵';
        }
        async function myMusicPrepareArtwork(file) {
            if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('PNG·JPG·WEBP·GIF 이미지만 쓸 수 있어요.');
            if (file.size > MY_MUSIC_ART_MAX_INPUT) throw new Error('10MB 이하 이미지만 쓸 수 있어요.');
            const bmp = await createImageBitmap(file).catch(() => null);
            if (!bmp) throw new Error('이미지를 읽지 못했어요. 다른 파일을 골라주세요.');
            const scale = Math.min(1, MY_MUSIC_ART_MAX_SIDE / Math.max(bmp.width, bmp.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(bmp.width * scale)); canvas.height = Math.max(1, Math.round(bmp.height * scale));
            const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
            if (bmp.close) bmp.close();
            const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.9));
            if (!blob) throw new Error('이미지를 변환하지 못했어요.');
            return blob;
        }
        async function musicDbSetTrackArtwork(trackId, blobOrNull) {
            const db = await openMusicDB();
            return new Promise((resolve, reject) => {
                const store = db.transaction('tracks', 'readwrite').objectStore('tracks');
                const getReq = store.get(trackId);
                getReq.onsuccess = () => {
                    const rec = getReq.result;
                    if (!rec) { resolve(); return; }
                    if (blobOrNull) rec.artwork = blobOrNull; else delete rec.artwork;
                    const putReq = store.put(rec);
                    putReq.onsuccess = () => resolve();
                    putReq.onerror = () => reject(putReq.error);
                };
                getReq.onerror = () => reject(getReq.error);
            });
        }
        async function musicDbGetTrackArtwork(trackId) {
            const db = await openMusicDB();
            return new Promise((resolve) => {
                const req = db.transaction('tracks', 'readonly').objectStore('tracks').get(trackId);
                req.onsuccess = () => resolve((req.result && req.result.artwork) || null);
                req.onerror = () => resolve(null);
            });
        }
        // 이미지 고르기: where = 'rename'(수정 창) | 'add'(추가 창)
        window.handleMyMusicArtPick = async function(input, where) {
            const msg = document.getElementById(where === 'rename' ? 'mymusic-rename-art-msg' : 'mymusic-add-art-msg');
            msg.textContent = '';
            const file = input.files && input.files[0];
            if (!file) return;
            try {
                const blob = await myMusicPrepareArtwork(file);
                if (where === 'rename') {
                    myMusicRenameArt = blob;
                    document.getElementById('mymusic-rename-art-remove').checked = false;
                    myMusicSetArtPreview('mymusic-rename-art-preview', blob);
                    document.getElementById('mymusic-rename-art-remove-row').style.display = 'flex';
                } else {
                    myMusicAddArtworkBlob = blob;
                    myMusicSetArtPreview('mymusic-add-art-preview', blob);
                }
            } catch (e) { input.value = ''; msg.textContent = e.message || '이미지를 쓸 수 없어요.'; }
        };
        window.handleMyMusicArtRemove = function(checked) {
            if (checked) { myMusicRenameArt = null; myMusicSetArtPreview('mymusic-rename-art-preview', null); document.getElementById('mymusic-rename-art').value = ''; }
            else { myMusicRenameArt = undefined; musicDbGetTrackArtwork(myMusicRenameTrackId).then(b => myMusicSetArtPreview('mymusic-rename-art-preview', b)); }
        };

        // --- 🎵 내 음악 제목/가수/앨범아트 수정 (이미 추가된 곡을 나중에 언제든 바꿀 수 있게) ---
        let myMusicRenameTrackId = null;
        let myMusicRenameArt = undefined; // undefined = 앨범아트 그대로, Blob = 새 이미지로 교체, null = 지우기
        window.openMyMusicRenameModal = async function(trackId, currentTitle, currentArtist, focusArt) {
            myMusicRenameTrackId = trackId;
            myMusicRenameArt = undefined;
            document.getElementById('mymusic-rename-title').value = currentTitle || '';
            document.getElementById('mymusic-rename-artist').value = currentArtist || '';
            document.getElementById('mymusic-rename-art').value = '';
            document.getElementById('mymusic-rename-art-msg').textContent = '';
            document.getElementById('mymusic-rename-art-remove').checked = false;
            document.getElementById('mymusic-rename-modal').style.display = 'flex';
            const current = await musicDbGetTrackArtwork(trackId);
            if (myMusicRenameTrackId !== trackId) return; // 그 사이 창을 닫았거나 다른 곡을 열었다
            myMusicSetArtPreview('mymusic-rename-art-preview', current);
            document.getElementById('mymusic-rename-art-remove-row').style.display = current ? 'flex' : 'none';
            if (focusArt) document.getElementById('mymusic-rename-art').focus();
        };
        window.closeMyMusicRenameModal = function() {
            document.getElementById('mymusic-rename-modal').style.display = 'none';
            myMusicRenameTrackId = null; myMusicRenameArt = undefined;
            myMusicSetArtPreview('mymusic-rename-art-preview', null);
        };
        window.submitMyMusicRename = async function() {
            if (myMusicRenameTrackId == null) return;
            const title = document.getElementById('mymusic-rename-title').value.trim() || '제목 없음';
            const artist = document.getElementById('mymusic-rename-artist').value.trim() || '미상';
            try {
                await musicDbRenameTrack(myMusicRenameTrackId, title, artist);
                if (myMusicRenameArt !== undefined) await musicDbSetTrackArtwork(myMusicRenameTrackId, myMusicRenameArt);
                closeMyMusicRenameModal();
                renderMyMusicList();
                if (window.renderMusicHome) renderMusicHome(); // 재생 중 표시 등 다른 화면에도 새 이름이 바로 반영되게
            } catch (e) {
                console.error('내 음악 수정 오류:', e);
                alert('수정에 실패했습니다.\n잠시 후 다시 시도해주세요.');
            }
        };

        // --- 특정 한 곡을 플레이리스트에 추가 ---
        let addSingleTrackId = null;
        window.openAddSingleTrackModal = async function(trackId) {
            addSingleTrackId = trackId;
            const select = document.getElementById('add-single-track-target');
            select.innerHTML = '<option>불러오는 중...</option>';
            document.getElementById('add-single-track-modal').style.display = 'flex';
            try {
                const playlists = await musicDbGetAllPlaylists();
                select.innerHTML = playlists.length
                    ? playlists.map(p => `<option value="${p.id}">${escapeNoticeText(p.name)}</option>`).join('')
                    : '<option value="">플레이리스트가 없습니다</option>';
            } catch (e) {
                select.innerHTML = '<option value="">불러오지 못했습니다</option>';
            }
        };
        window.closeAddSingleTrackModal = function() {
            document.getElementById('add-single-track-modal').style.display = 'none';
            addSingleTrackId = null;
        };
        window.submitAddSingleTrack = async function() {
            const targetId = parseInt(document.getElementById('add-single-track-target').value, 10);
            if (!targetId) return alert('플레이리스트를 선택해주세요.');
            try {
                await musicDbAddTrackRefToPlaylist(targetId, addSingleTrackId);
                closeAddSingleTrackModal();
                if (window.MixTapeApp && window.MixTapeApp.refreshIfCurrent) window.MixTapeApp.refreshIfCurrent(targetId);
                alert('플레이리스트에 추가했습니다.');
            } catch (e) {
                console.error('플레이리스트 추가 오류:', e);
                alert('추가에 실패했습니다.\n잠시 후 다시 시도해주세요.');
            }
        };

        // --- ✏️ 플레이리스트 이름 수정 ---
        let renamingPlaylistId = null;
        window.openRenamePlaylistModal = function(playlistId, currentName) {
            renamingPlaylistId = playlistId;
            document.getElementById('rename-playlist-input').value = currentName || '';
            document.getElementById('rename-playlist-modal').style.display = 'flex';
        };
        window.closeRenamePlaylistModal = function() {
            document.getElementById('rename-playlist-modal').style.display = 'none';
            renamingPlaylistId = null;
        };
        window.submitRenamePlaylist = async function() {
            const newName = document.getElementById('rename-playlist-input').value.trim();
            if (!newName) return alert('플레이리스트 이름을 입력해주세요.');
            try {
                await musicDbRenamePlaylist(renamingPlaylistId, newName);
                closeRenamePlaylistModal();
                renderPlaylistNameList();
            } catch (e) {
                console.error('이름 수정 오류:', e);
                alert('수정에 실패했습니다.\n잠시 후 다시 시도해주세요.');
            }
        };

        window.deletePlaylistFromList = async function(playlistId, name) {
            if (!confirm(`"${name}" 플레이리스트를 삭제할까요?\n(안에 있던 곡들은 내 음악에 그대로 남아요)`)) return;
            try {
                await musicDbDeletePlaylist(playlistId);
                renderPlaylistNameList();
            } catch (e) {
                console.error('플레이리스트 삭제 오류:', e);
                alert('삭제에 실패했습니다.\n잠시 후 다시 시도해주세요.');
            }
        };

        // --- 📁 플레이리스트 곡 다중 선택 모드 ---
        // 별도 화면을 새로 만들지 않고, 기존 엔진의 트랙리스트(#trackList)에 체크박스만 조건부로
        // 붙인다(엔진의 renderList() 안에서 처리). 선택 상태 자체도 엔진(MixTapeApp) 쪽에서 관리한다.

        // 문서 요구사항: 선택 모드는 별도 화면이 아니라 기존 트랙리스트에 체크박스로 직접 나타난다.
        window.enterPlaylistSelectMode = function() {
            if (!window.MixTapeApp || !window.MixTapeApp.enterSelectMode) return;
            document.getElementById('playlist-manage-toolbar').style.display = 'none';
            document.getElementById('playlist-select-toolbar').style.display = 'flex';
            window.MixTapeApp.enterSelectMode(); // 기존 트랙리스트를 다시 그리면서 체크박스가 나타난다
            updatePlaylistSelectUI();
        };

        window.exitPlaylistSelectMode = function() {
            document.getElementById('playlist-manage-toolbar').style.display = 'flex';
            document.getElementById('playlist-select-toolbar').style.display = 'none';
            if (window.MixTapeApp && window.MixTapeApp.exitSelectMode) window.MixTapeApp.exitSelectMode();
        };

        window.toggleSelectAllPlaylistTracks = function() {
            if (!window.MixTapeApp) return;
            const total = window.MixTapeApp.getTrackCount();
            const selected = window.MixTapeApp.getSelectedCount();
            if (selected >= total && total > 0) window.MixTapeApp.deselectAllTracks();
            else window.MixTapeApp.selectAllTracks();
            updatePlaylistSelectUI();
        };

        // 체크박스를 클릭할 때마다 엔진(mixtape 엔진)이 이 콜백을 호출해서 상단 개수 표시를 갱신한다
        window.onPlaylistSelectionChanged = function() { updatePlaylistSelectUI(); };

        function updatePlaylistSelectUI() {
            if (!window.MixTapeApp) return;
            const count = window.MixTapeApp.getSelectedCount();
            const total = window.MixTapeApp.getTrackCount();
            document.getElementById('playlist-select-count').textContent = `${count}곡 선택됨`;
            document.getElementById('playlist-select-all-checkbox').textContent = (count >= total && total > 0) ? '☑' : '☐';
            const delBtn = document.getElementById('playlist-select-delete-btn');
            delBtn.disabled = count === 0;
            delBtn.style.opacity = count === 0 ? '0.5' : '1';
            delBtn.textContent = count > 0 ? `🗑 ${count}곡 삭제` : '🗑 삭제';
        }

        // 문서 요구사항: "플레이리스트에서 삭제 ≠ 내 음악에서 삭제" - 기존 엔진의 removeTrack이
        // 이미 이 원칙대로 동작한다(트랙 자체가 아니라 참조만 지움). 그걸 그대로 재사용한다.
        window.deleteSelectedPlaylistTracks = function() {
            if (!window.MixTapeApp) return;
            const count = window.MixTapeApp.getSelectedCount();
            if (count === 0) return;
            if (!confirm(`선택한 ${count}곡을 이 플레이리스트에서 삭제할까요?`)) return;
            window.MixTapeApp.deleteSelectedTracks();
            updatePlaylistSelectUI();
        };

        // "+ 내 음악에서 추가"를 재생화면에서 누르면 지금 열려있는 플레이리스트를 기본 대상으로 미리 선택해둔다
        window.openAddFromLibraryModalForCurrent = async function() {
            await openAddFromLibraryModal();
            const currentId = window.MixTapeApp && window.MixTapeApp.getCurrentPlaylistId ? window.MixTapeApp.getCurrentPlaylistId() : null;
            if (currentId != null) {
                const select = document.getElementById('add-from-library-target');
                if (select) select.value = String(currentId);
            }
        };

        // 오늘 날짜를 시드로 써서 매일 다른(하지만 하루 동안은 고정된) 순서로 섞는다 - "오늘의 추천"용
        function seededShuffle(arr, seedStr) {
            let seed = 0;
            for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
            const a = arr.slice();
            for (let i = a.length - 1; i > 0; i--) {
                seed = (seed * 1103515245 + 12345) >>> 0;
                const j = seed % (i + 1);
                [a[i], a[j]] = [a[j], a[i]];
            }
            return a;
        }

        // --- Step 3: 내 음악에서 추가 (파일 선택창 대신 이미 가진 음악을 체크박스로 선택) ---
        let addFromLibraryTracks = [];

        window.openAddFromLibraryModal = async function() {
            const targetSelect = document.getElementById('add-from-library-target');
            const listEl = document.getElementById('add-from-library-list');
            const searchInput = document.getElementById('add-from-library-search');
            if (searchInput) searchInput.value = '';
            targetSelect.innerHTML = '<option>불러오는 중...</option>';
            listEl.innerHTML = '';
            document.getElementById('add-from-library-modal').style.display = 'flex';
            try {
                const [playlists, tracks] = await Promise.all([musicDbGetAllPlaylists(), musicDbGetAllTracks()]);
                targetSelect.innerHTML = playlists.map(p => `<option value="${p.id}">${escapeNoticeText(p.name)}</option>`).join('') || '<option value="">플레이리스트가 없습니다</option>';
                addFromLibraryTracks = tracks;
                renderAddFromLibraryList();
            } catch (e) {
                console.error('내 음악 목록 로딩 오류:', e);
                listEl.innerHTML = '<div style="padding:10px; color:var(--text-muted); font-size:13px;">내 음악을 불러오지 못했습니다.</div>';
            }
        };
        window.closeAddFromLibraryModal = function() {
            document.getElementById('add-from-library-modal').style.display = 'none';
        };
        window.renderAddFromLibraryList = function() {
            const listEl = document.getElementById('add-from-library-list');
            const selectAllEl = document.getElementById('add-from-library-select-all');
            if (selectAllEl) selectAllEl.checked = false; // 목록이 다시 그려지면(검색 등) 전체선택 상태도 초기화한다
            const q = (document.getElementById('add-from-library-search')?.value || '').trim().toLowerCase();
            let tracks = addFromLibraryTracks;
            if (q) tracks = tracks.filter(t => (t.name || '').toLowerCase().includes(q));
            if (tracks.length === 0) {
                listEl.innerHTML = '<div style="padding:10px; color:var(--text-muted); font-size:13px;">내 음악이 없습니다.</div>';
                return;
            }
            listEl.innerHTML = tracks.map(t => `
                <label style="display:flex; align-items:center; gap:8px; padding:7px 6px; font-size:13.5px; cursor:pointer; border-bottom:1px solid var(--border-color);">
                    <input type="checkbox" value="${t.id}" class="add-from-library-check">
                    <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeNoticeText(t.name || '제목 없음')}</span>
                </label>
            `).join('');
        };
        // 지금 화면에 보이는(검색으로 필터된) 곡들만 대상으로 전체 선택/해제한다.
        window.toggleSelectAllAddFromLibrary = function(checked) {
            document.querySelectorAll('.add-from-library-check').forEach(cb => { cb.checked = checked; });
        };
        window.submitAddFromLibrary = async function() {
            const targetId = parseInt(document.getElementById('add-from-library-target').value, 10);
            const checked = Array.from(document.querySelectorAll('.add-from-library-check:checked')).map(el => parseInt(el.value, 10));
            if (!targetId) return alert('플레이리스트를 선택해주세요.');
            if (checked.length === 0) return alert('추가할 곡을 선택해주세요.');
            try {
                // v3: blob을 복사하지 않는다. 이미 tracks에 있는 곡의 id만 대상 플레이리스트에 참조로 추가한다.
                for (const trackId of checked) {
                    await musicDbAddTrackRefToPlaylist(targetId, trackId);
                }
                closeAddFromLibraryModal();

                // 새로고침 없이 즉시 반영: 목록 화면의 곡 수를 바로 갱신하고, 지금 보고 있는 플레이어가
                // 방금 추가한 그 플레이리스트라면 목록도 즉시 새로 그린다. refreshIfCurrent()는
                // switchToPlaylist()와 달리 재생을 멈추지 않으므로 재생 중이어도 안전하게 부를 수 있다.
                await renderPlaylistNameList();
                if (window.MixTapeApp && window.MixTapeApp.refreshIfCurrent) window.MixTapeApp.refreshIfCurrent(targetId);

                alert('선택한 곡을 플레이리스트에 추가했습니다.');
            } catch (e) {
                console.error('플레이리스트 추가 오류:', e);
                alert('추가에 실패했습니다.\n잠시 후 다시 시도해주세요.');
            }
        };

        // 재생 화면의 트랙 사이 "+" 버튼 전용 - 새 파일을 올리는 게 아니라 "내 음악"에서 곡을 골라
        // 그 정확한 위치(insertIndex)에 끼워 넣는다. add-from-library-modal과 달리 대상 플레이리스트를
        // 고를 필요가 없다(지금 열려 있는 플레이리스트가 곧 대상이다).
        let insertTrackModalIndex = null;
        let insertFromLibraryTracks = [];
        window.openInsertFromLibraryModal = async function(insertIndex) {
            insertTrackModalIndex = insertIndex;
            const listEl = document.getElementById('insert-track-list');
            const searchInput = document.getElementById('insert-track-search');
            if (searchInput) searchInput.value = '';
            listEl.innerHTML = '불러오는 중...';
            document.getElementById('insert-track-modal').style.display = 'flex';
            try {
                insertFromLibraryTracks = await musicDbGetAllTracks();
                renderInsertTrackList();
            } catch (e) {
                console.error('내 음악 목록 로딩 오류:', e);
                listEl.innerHTML = '<div style="padding:10px; color:var(--text-muted); font-size:13px;">내 음악을 불러오지 못했습니다.</div>';
            }
        };
        window.closeInsertTrackModal = function() {
            document.getElementById('insert-track-modal').style.display = 'none';
            insertTrackModalIndex = null;
        };
        window.renderInsertTrackList = function() {
            const listEl = document.getElementById('insert-track-list');
            const selectAllEl = document.getElementById('insert-track-select-all');
            if (selectAllEl) selectAllEl.checked = false;
            const q = (document.getElementById('insert-track-search')?.value || '').trim().toLowerCase();
            let tracks = insertFromLibraryTracks;
            if (q) tracks = tracks.filter(t => (t.name || '').toLowerCase().includes(q));
            if (tracks.length === 0) {
                listEl.innerHTML = `<div style="padding:10px; color:var(--text-muted); font-size:13px;">${insertFromLibraryTracks.length === 0 ? '내 음악이 없습니다.' : '검색 결과가 없습니다.'}</div>`;
                return;
            }
            listEl.innerHTML = tracks.map(t => `
                <label style="display:flex; align-items:center; gap:8px; padding:7px 6px; font-size:13.5px; cursor:pointer; border-bottom:1px solid var(--border-color);">
                    <input type="checkbox" value="${t.id}" class="insert-track-check">
                    <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeNoticeText(t.name || '제목 없음')}</span>
                </label>
            `).join('');
        };
        // 지금 화면에 보이는(검색으로 필터된) 곡들만 대상으로 전체 선택/해제한다.
        window.toggleSelectAllInsertTrack = function(checked) {
            document.querySelectorAll('.insert-track-check').forEach(cb => { cb.checked = checked; });
        };
        window.confirmInsertFromLibrary = async function() {
            const checked = Array.from(document.querySelectorAll('.insert-track-check:checked')).map(el => parseInt(el.value, 10));
            if (checked.length === 0) return alert('추가할 곡을 선택해주세요.');
            if (!window.MixTapeApp || !window.MixTapeApp.insertLibraryTracksAtIndex) return;
            try {
                const tracks = checked.map(id => insertFromLibraryTracks.find(t => t.id === id)).filter(Boolean);
                await window.MixTapeApp.insertLibraryTracksAtIndex(tracks, insertTrackModalIndex);
                window.closeInsertTrackModal();
            } catch (e) {
                console.error('트랙 삽입 오류:', e);
                alert('추가에 실패했습니다.\n잠시 후 다시 시도해주세요.');
            }
        };

        function musicTrackIcon() { return '🎵'; }

        function renderMusicTrackRow(tracks, likedIds, downloadedIds) {
            if (!tracks || tracks.length === 0) return '<div class="widget-text">아직 음악이 없습니다.</div>';
            return `<div class="music-track-grid" style="display:grid; grid-template-columns:repeat(2,1fr); gap:12px;">${tracks.map(t => renderMusicTrackCard(t, likedIds, downloadedIds)).join('')}</div>`;
        }

        function renderMusicTrackCard(t, likedIds, downloadedIds) {
            const liked = likedIds && likedIds.has(t.id);
            const downloaded = downloadedIds && downloadedIds.has(t.id);
            const safeTitle = escapeJsAttr(t.title || '');
            const isOwner = !!(currentUser && t.uploader_id && currentUser.uid === t.uploader_id);
            return `
                <div class="music-track-card">
                    <div class="music-track-top">
                        <div class="music-track-art">${t.artwork_url ? `<img src="${t.artwork_url}" onerror="this.parentElement.textContent='${musicTrackIcon()}'">` : musicTrackIcon()}</div>
                        <div style="min-width:0; flex:1;">
                            <div class="music-track-title">${escapeNoticeText(t.title || '제목 없음')}</div>
                            <div class="music-track-artist">${escapeNoticeText(t.artist || '아티스트 미상')}</div>
                        </div>
                        ${isOwner ? `<span onclick="deleteSharedMusicTrack('${t.id}')" title="이 곡 삭제" style="cursor:pointer; color:var(--text-muted); font-size:16px; flex-shrink:0;">🗑</span>` : ''}
                    </div>
                    <div class="music-track-actions">
                        ${t.storage_path ? `<span onclick="playSharedTrackNow('${t.id}', '${safeTitle}')" style="color:var(--primary); font-weight:700;">▶ 재생</span>` : ''}
                        ${downloaded
                            ? `<span style="color:var(--text-muted);">✓ 내 음악에 있음</span>`
                            : `<span onclick="downloadSharedTrack('${t.id}')">⬇ 내 음악에 저장</span>`}
                        <span id="music-like-${t.id}" class="${liked ? 'liked' : ''}" onclick="toggleMusicLike('${t.id}')">${liked ? '❤️' : '🤍'} ${t.like_count || 0}</span>
                    </div>
                </div>
            `;
        }

        // music 버킷은 private이라 audio_url을 미리 저장해두지 않는다. 재생/다운로드가 필요한
        // "그 순간"에 storage_path로 짧게 유효한 서명 URL을 새로 발급받는다 (자료실과 동일한 패턴).
        async function getMusicSignedUrl(storagePath) {
            const { data, error } = await sbMusic.storage.from(MUSIC_BUCKET).createSignedUrl(storagePath, 3600);
            if (error) throw error;
            return data.signedUrl;
        }

        // 클릭 즉시 재생 (SoundCloud처럼 다운로드 없이 바로 스트리밍) + 재생기록(20초 이상 재생시 1회)
        let musicPlayRecordTimer = null;
        window.playSharedTrackNow = async function(trackId, title) {
            if (!window.MixTapeApp || !window.MixTapeApp.playAdHoc) return alert("재생 엔진을 불러오지 못했습니다.");
            const track = sharedMusicCache[trackId];
            if (!track || !track.storage_path) return alert("재생할 수 없는 곡입니다.");
            try {
                const url = await getMusicSignedUrl(track.storage_path);
                window.MixTapeApp.playAdHoc(url, title || track.title);
            } catch (e) {
                console.error('재생 URL 발급 오류:', e);
                return alert("재생에 실패했습니다.\n잠시 후 다시 시도해주세요.");
            }

            // 곡이 바뀔 때마다 이전 예약을 취소하고 새로 20초 뒤 재생 기록을 남긴다 (매 재생마다 기록하지 않음)
            if (musicPlayRecordTimer) clearTimeout(musicPlayRecordTimer);
            if (currentUser) {
                musicPlayRecordTimer = setTimeout(async () => {
                    try {
                        const idToken = await currentUser.getIdToken();
                        // record_play 액션이 재생기록 저장 + play_count 증가를 서버(Edge Function)에서 한 번에 처리한다
                        // (클라이언트에서 별도로 increment_play_count를 또 부르면 카운트가 중복 증가하므로 부르지 않는다)
                        fetch(MUSIC_WRITE_FUNCTION_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_MUSIC_KEY}` },
                            body: JSON.stringify({ action: 'record_play', trackId, firebaseIdToken: idToken })
                        }).catch(() => {});
                    } catch (e) { /* 로그인 안 된 상태에서도 재생 자체는 계속 되게 조용히 무시 */ }
                }, 20000);
            }
        };

        async function getMyLikedTrackIds() {
            if (!currentUser) return new Set();
            try {
                const { data, error } = await sbMusic.from('music_likes').select('track_id').eq('user_id', currentUser.uid);
                if (error) throw error;
                return new Set((data || []).map(r => r.track_id));
            } catch (e) { return new Set(); }
        }

        // 이미 "내 음악에 저장"한 공유곡 id 목록.
        // ⚠️ 예전엔 Supabase music_downloads(계정 전체에 영구히 남는 다운로드 기록)로 판단했는데,
        // "내 음악"은 이 브라우저의 로컬 IndexedDB일 뿐이라 다른 기기에서 받았거나 내 음악에서
        // 삭제한 뒤에도 "이미 있음"으로 잘못 표시되면서 다시 받을 방법이 없는 버그가 있었다.
        // 지금 이 브라우저의 실제 라이브러리(로컬 tracks의 sharedTrackId)를 기준으로 판단한다.
        async function getMyDownloadedTrackIds() {
            try {
                const tracks = await musicDbGetAllTracks();
                return new Set(tracks.filter(t => t.sharedTrackId != null).map(t => t.sharedTrackId));
            } catch (e) { return new Set(); }
        }

        // Music Home 검색: 다른 탭으로 이동시키지 않고, 공유 음악/내 음악 양쪽 결과를 이 화면 안에서
        // 구분해서 보여준다. sharedMusicCache가 아직 한 번도 안 불러와졌으면(공유 음악 탭에 들어간
        // 적 없으면) 먼저 채워두고, 그 다음부터는 매 입력마다 캐시를 그대로 필터링만 한다.
        let musicHomeSearchArtworkUrls = [];
        window.runMusicHomeSearch = async function() {
            const q = (document.getElementById('music-home-search')?.value || '').trim().toLowerCase();
            const resultsEl = document.getElementById('music-home-search-results');
            const defaultEl = document.getElementById('music-home-default-sections');
            if (!resultsEl || !defaultEl) return;

            if (!q) {
                resultsEl.style.display = 'none';
                resultsEl.innerHTML = '';
                defaultEl.style.display = 'block';
                return;
            }
            defaultEl.style.display = 'none';
            resultsEl.style.display = 'block';
            resultsEl.innerHTML = '<div class="widget-text">검색 중...</div>';

            if (Object.keys(sharedMusicCache).length === 0) {
                try { await loadSharedMusic(); } catch (e) { /* loadSharedMusic이 자체적으로 에러 UI를 처리 */ }
            }
            const sharedMatches = Object.values(sharedMusicCache).filter(t =>
                (t.title || '').toLowerCase().includes(q) || (t.artist || '').toLowerCase().includes(q)
            );

            let myMatches = [];
            try {
                const myTracks = await musicDbGetAllTracks();
                myMatches = myTracks
                    .map(t => ({ ...t, _title: t.title || t.name || '제목 없음', _artist: t.artist || '' }))
                    .filter(t => t._title.toLowerCase().includes(q) || t._artist.toLowerCase().includes(q));
            } catch (e) { console.warn('내 음악 검색 오류:', e); }

            // 이번 검색 결과에서 새로 만든 앨범아트 URL이 이전 검색 결과 것을 대체하므로, 교체 직전에 해제한다.
            musicHomeSearchArtworkUrls.forEach(url => URL.revokeObjectURL(url));
            musicHomeSearchArtworkUrls = [];

            let html = `<div class="dashboard-section-title">👥 공유 음악 (${sharedMatches.length})</div>`;
            html += sharedMatches.length
                ? `<div class="music-track-grid" style="display:grid; grid-template-columns:repeat(2,1fr); gap:14px; margin-bottom:22px;">${sharedMatches.map(t => renderMusicTrackCard(t, sharedMusicLikedIds, sharedMusicDownloadedIds)).join('')}</div>`
                : `<div class="widget-text" style="margin-bottom:22px;">일치하는 공유 음악이 없습니다.</div>`;

            html += `<div class="dashboard-section-title">🎵 내 음악 (${myMatches.length})</div>`;
            html += myMatches.length
                ? myMatches.map(t => myMusicTrackCardHTML(t, musicHomeSearchArtworkUrls)).join('')
                : `<div class="widget-text">일치하는 내 음악이 없습니다.</div>`;

            resultsEl.innerHTML = html;
        };

        async function renderMusicHome() {
            const myCountEl = document.getElementById('music-home-mycount');
            if (myCountEl) myCountEl.textContent = `${await musicDbCountTracks()}곡 보유 중`;

            const likeCountEl = document.getElementById('music-home-likecount');
            if (likeCountEl) {
                if (!currentUser) { likeCountEl.textContent = '—'; }
                else {
                    try {
                        const { count, error } = await sbMusic.from('music_likes').select('*', { count: 'exact', head: true }).eq('user_id', currentUser.uid);
                        likeCountEl.textContent = error ? '불러오지 못했습니다' : `${count || 0}곡`;
                    } catch (e) { likeCountEl.textContent = '불러오지 못했습니다'; }
                }
            }

            const likedIds = await getMyLikedTrackIds();
            const downloadedIds = await getMyDownloadedTrackIds();

            // 🔥 인기 음악 (커뮤니티 공유 음악 중 재생수 상위 5곡)
            const popEl = document.getElementById('music-home-popular');
            if (popEl) {
                try {
                    const { data, error } = await sbMusic.from('music_tracks').select('*').eq('status', 'active').order('play_count', { ascending: false }).limit(5);
                    if (error) throw error;
                    popEl.innerHTML = (data && data.length > 0) ? renderMusicTrackRow(data, likedIds, downloadedIds) : '<div class="widget-text">아직 반응이 쌓인 음악이 없습니다.</div>';
                } catch (e) { console.warn('인기 음악 로딩 오류:', e); popEl.innerHTML = '<div class="widget-text">인기 음악을 불러오지 못했습니다.</div>'; }
            }

            // 👥 친구들이 공유한 음악 (최신순 미리보기 4곡)
            const sharedEl = document.getElementById('music-home-shared');
            if (sharedEl) {
                try {
                    const { data, error } = await sbMusic.from('music_tracks').select('*').eq('status', 'active').order('created_at', { ascending: false }).limit(4);
                    if (error) throw error;
                    sharedEl.innerHTML = (data && data.length > 0)
                        ? renderMusicTrackRow(data, likedIds, downloadedIds)
                        : '<div class="widget-text">아직 공유된 음악이 없습니다.<br>내 음악을 공유해보세요.</div>';
                } catch (e) { console.warn('공유 음악 로딩 오류:', e); sharedEl.innerHTML = '<div class="widget-text">공유 음악을 불러오지 못했습니다.</div>'; }
            }
        }

        // --- ③ 공유 음악 ---
        let sharedMusicCache = {};
        let sharedMusicLikedIds = new Set();
        let sharedMusicDownloadedIds = new Set();

        async function loadSharedMusic() {
            const listEl = document.getElementById('music-shared-list');
            if (!listEl) return;
            try {
                const { data, error } = await sbMusic.from('music_tracks').select('*').eq('status', 'active').order('created_at', { ascending: false });
                if (error) throw error;
                sharedMusicCache = {};
                (data || []).forEach(t => { sharedMusicCache[t.id] = t; });
                sharedMusicLikedIds = await getMyLikedTrackIds();
                sharedMusicDownloadedIds = await getMyDownloadedTrackIds();
                renderSharedMusicList();
            } catch (e) {
                console.warn('공유 음악 로딩 오류:', e);
                listEl.innerHTML = `<div class="card" style="grid-column:span 2; text-align:center; color:var(--text-muted);">음악을 불러오지 못했습니다.<br>잠시 후 다시 시도해주세요.</div>`;
            }
        }
        window.renderSharedMusicList = function() {
            const listEl = document.getElementById('music-shared-list');
            if (!listEl) return;
            const q = (document.getElementById('music-shared-search')?.value || '').trim().toLowerCase();
            let tracks = Object.values(sharedMusicCache);
            if (q) tracks = tracks.filter(t => (t.title || '').toLowerCase().includes(q) || (t.artist || '').toLowerCase().includes(q));
            tracks.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            if (tracks.length === 0) {
                listEl.innerHTML = `<div class="card" style="grid-column:span 2; text-align:center; color:var(--text-muted);">${Object.keys(sharedMusicCache).length === 0 ? '아직 공유된 음악이 없습니다.<br>첫 곡을 공유해보세요.' : '검색 결과가 없습니다.'}</div>`;
                return;
            }
            listEl.innerHTML = tracks.map(t => renderMusicTrackCard(t, sharedMusicLikedIds, sharedMusicDownloadedIds)).join('');

            gmwResetPageIfQueryChanged('sharedMusic', q);
            gmwApplyPagination('sharedMusic', listEl, '.music-track-card');
            gmwBindImageRecalc('sharedMusic', listEl, '.music-track-card');
        };

        // Step 4-1/4-5: 파일 선택 즉시 ID3 태그를 읽어서 제목/아티스트를 미리 채운다.
        // 사용자가 업로드 전에 확인/수정할 수 있고, 태그가 없으면 파일명만 자동으로 채운다.
        window.handleMusicShareFileSelected = async function(event) {
            const file = event.target.files[0];
            if (!file) return;
            const titleInput = document.getElementById('music-share-title');
            const artistInput = document.getElementById('music-share-artist');
            // 사용자가 이미 직접 입력해둔 값이 있으면 덮어쓰지 않는다
            const fallbackTitle = file.name.replace(/\.[^/.]+$/, '');
            try {
                const tags = await parseId3Tags(file);
                if (!titleInput.value.trim()) titleInput.value = tags.title || fallbackTitle;
                if (!artistInput.value.trim() && tags.artist) artistInput.value = tags.artist;
            } catch (e) {
                if (!titleInput.value.trim()) titleInput.value = fallbackTitle;
            }
        };

        // 직접 파일을 올리는 대신, 이미 "내 음악"에 있는 곡을 그대로 공유할 수도 있게 한다.
        let musicShareMode = 'upload'; // 'upload' | 'mymusic'
        let musicShareLibraryTracks = [];
        window.openMusicShareModal = async function() {
            if (!currentUser) return showLoginScreen(() => openMusicShareModal());
            if (currentUserInfo.role !== 'class2_member') return alert("권한이 없습니다.");
            document.getElementById('music-share-title').value = '';
            document.getElementById('music-share-artist').value = '';
            document.getElementById('music-share-file').value = '';
            window.setMusicShareMode('upload');
            const quotaEl = document.getElementById('music-share-quota');
            quotaEl.textContent = '공유 개수를 확인하는 중...';
            document.getElementById('music-share-modal').style.display = 'flex';
            try {
                const { count, error } = await sbMusic.from('music_tracks').select('*', { count: 'exact', head: true }).eq('uploader_id', currentUser.uid).eq('status', 'active');
                if (error) throw error;
                quotaEl.textContent = `현재 ${count || 0} / ${MUSIC_SHARE_LIMIT}곡 공유 중`;
            } catch (e) { quotaEl.textContent = ''; }
            try {
                musicShareLibraryTracks = await musicDbGetAllTracks();
                const select = document.getElementById('music-share-mymusic-select');
                select.innerHTML = musicShareLibraryTracks.length
                    ? musicShareLibraryTracks.map(t => `<option value="${t.id}">${escapeNoticeText(t.name || '제목 없음')}</option>`).join('')
                    : '<option value="">내 음악이 없습니다</option>';
            } catch (e) { console.error('내 음악 목록 로딩 오류:', e); }
        };
        window.closeMusicShareModal = function() {
            document.getElementById('music-share-modal').style.display = 'none';
        };
        window.setMusicShareMode = function(mode) {
            musicShareMode = mode;
            document.getElementById('music-share-upload-fields').style.display = mode === 'upload' ? 'block' : 'none';
            document.getElementById('music-share-mymusic-fields').style.display = mode === 'mymusic' ? 'block' : 'none';
            const uploadBtn = document.getElementById('music-share-mode-upload-btn');
            const mymusicBtn = document.getElementById('music-share-mode-mymusic-btn');
            if (uploadBtn) { uploadBtn.style.borderColor = mode === 'upload' ? 'var(--primary)' : ''; uploadBtn.style.color = mode === 'upload' ? 'var(--primary)' : ''; }
            if (mymusicBtn) { mymusicBtn.style.borderColor = mode === 'mymusic' ? 'var(--primary)' : ''; mymusicBtn.style.color = mode === 'mymusic' ? 'var(--primary)' : ''; }
            if (mode === 'mymusic') handleMusicShareLibraryTrackSelected();
        };
        // 내 음악에서 곡을 고르면, 아직 직접 입력하지 않은 제목/아티스트 칸만 그 곡 정보로 채워준다
        // (이미 사용자가 손으로 고친 값은 덮어쓰지 않는다).
        window.handleMusicShareLibraryTrackSelected = function() {
            const select = document.getElementById('music-share-mymusic-select');
            const trackId = parseInt(select.value, 10);
            const track = musicShareLibraryTracks.find(t => t.id === trackId);
            if (!track) return;
            const titleInput = document.getElementById('music-share-title');
            const artistInput = document.getElementById('music-share-artist');
            if (!titleInput.value.trim()) titleInput.value = track.title || track.name || '';
            if (!artistInput.value.trim() && track.artist) artistInput.value = track.artist;
        };

        // 🔧 개발자용 진단 함수 (UI 버튼 없음 - 브라우저 개발자도구 콘솔에서 직접 호출해서 확인).
        // 예: 콘솔에 testMusicWriteConnection() 입력하면 OPTIONS/POST 중 어디서 막히는지 알려준다.
        window.testMusicWriteConnection = async function() {
            console.log('[Music Share 진단] 대상 URL:', MUSIC_WRITE_FUNCTION_URL);
            console.log('[Music Share 진단] 현재 페이지 origin:', location.origin || `${location.protocol}//(파일 또는 null origin)`);
            try {
                const optRes = await fetch(MUSIC_WRITE_FUNCTION_URL, {
                    method: 'OPTIONS',
                    headers: {
                        'Access-Control-Request-Method': 'POST',
                        'Access-Control-Request-Headers': 'authorization, content-type'
                    }
                });
                console.log('[Music Share 진단] OPTIONS 응답:', optRes.status, {
                    'access-control-allow-origin': optRes.headers.get('access-control-allow-origin'),
                    'access-control-allow-headers': optRes.headers.get('access-control-allow-headers'),
                    'access-control-allow-methods': optRes.headers.get('access-control-allow-methods')
                });
            } catch (e) {
                console.error('[Music Share 진단] ❌ OPTIONS 단계에서 이미 실패했습니다 (Failed to fetch면 대부분 여기가 원인). '
                    + 'Edge Function이 --no-verify-jwt로 배포됐는지, URL이 정확한지 확인하세요.', { name: e.name, message: e.message });
                return;
            }
            try {
                const idToken = currentUser ? await currentUser.getIdToken() : null;
                const postRes = await fetch(MUSIC_WRITE_FUNCTION_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_MUSIC_KEY}` },
                    body: JSON.stringify({ action: 'record_play', trackId: '00000000-0000-0000-0000-000000000000', firebaseIdToken: idToken || 'no-login' })
                });
                const body = await postRes.json().catch(() => ({}));
                console.log('[Music Share 진단] POST 응답 (존재하지 않는 trackId라 실패하는 게 정상 - 여기까지 도달했다면 통신 자체는 성공):', postRes.status, body);
            } catch (e) {
                console.error('[Music Share 진단] ❌ POST 단계에서 실패했습니다', { name: e.name, message: e.message });
            }
        };

        window.handleMusicShareSubmit = async function() {
            const titleInput = document.getElementById('music-share-title');
            const artistInput = document.getElementById('music-share-artist');
            const fileInput = document.getElementById('music-share-file');
            const progressEl = document.getElementById('music-share-progress');
            const submitBtn = document.getElementById('music-share-submit-btn');
            if (!currentUser) return showLoginScreen(() => handleMusicShareSubmit());
            if (!titleInput.value.trim()) return alert("제목을 입력해주세요.");

            let file;
            if (musicShareMode === 'mymusic') {
                // 이미 "내 음악"에 저장돼 있던 곡이라 blob이 그대로 있다 - 새로 업로드할 필요 없이 그 blob을 그대로 공유한다.
                const trackId = parseInt(document.getElementById('music-share-mymusic-select').value, 10);
                const track = musicShareLibraryTracks.find(t => t.id === trackId);
                if (!track) return alert("공유할 곡을 선택해주세요.");
                file = track.blob;
            } else {
                file = fileInput.files.length > 0 ? fileInput.files[0] : null;
                if (!file) return alert("MP3 파일을 선택해주세요.");
                if (!/audio\//.test(file.type) && !/\.(mp3|m4a|wav|ogg)$/i.test(file.name)) return alert("오디오 파일만 공유할 수 있습니다.");
            }
            if (file.size > MAX_SHARED_MUSIC_SIZE) return alert("이 음악은 30MB를 초과하여 공유할 수 없습니다.");

            const original = submitBtn.textContent;
            submitBtn.disabled = true; submitBtn.textContent = '공유 중...';
            if (progressEl) { progressEl.style.display = 'block'; progressEl.textContent = '업로드 중...'; }
            try {
                // 재생시간은 브라우저에서 간단히 추출 (ID3 태그 전체 파싱은 하지 않음 - 범위 밖)
                const duration = await new Promise((resolve) => {
                    const a = new Audio(URL.createObjectURL(file));
                    a.addEventListener('loadedmetadata', () => resolve(a.duration || null));
                    a.addEventListener('error', () => resolve(null));
                });

                const idToken = await currentUser.getIdToken();
                const formData = new FormData();
                formData.append('action', 'share');
                formData.append('firebaseIdToken', idToken);
                formData.append('title', titleInput.value);
                formData.append('artist', artistInput.value || '');
                formData.append('duration', duration ? String(Math.round(duration)) : '');
                formData.append('ownerName', getAuthorName() || '');
                formData.append('file', file);

                let res;
                try {
                    res = await fetch(MUSIC_WRITE_FUNCTION_URL, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${SUPABASE_MUSIC_KEY}` },
                        body: formData
                    });
                } catch (networkErr) {
                    // fetch() 자체가 던진 에러(TypeError: Failed to fetch 등) - 즉 응답을 아예 못 받은 경우.
                    // 민감정보(토큰/service_role) 없이 진단에 필요한 정보만 남긴다.
                    console.error('[Music Share] 네트워크 요청 자체가 실패했습니다 (CORS 또는 함수 미배포 가능성이 높음)', {
                        url: MUSIC_WRITE_FUNCTION_URL,
                        action: 'share',
                        errorName: networkErr && networkErr.name,
                        errorMessage: networkErr && networkErr.message,
                        pageOrigin: location.origin || location.protocol
                    });
                    throw new Error(
                        "음악 공유 서버에 연결하지 못했습니다.\n" +
                        "잠시 후 다시 시도해도 계속 안 되면 관리자에게 문의해주세요.\n" +
                        "(개발자용: music-write Edge Function이 --no-verify-jwt로 배포되었는지 확인 필요)"
                    );
                }

                const result = await res.json().catch(() => ({}));
                if (!res.ok) {
                    console.error('[Music Share] 서버가 오류 응답을 반환했습니다', {
                        url: MUSIC_WRITE_FUNCTION_URL,
                        action: 'share',
                        status: res.status,
                        body: result
                    });
                    throw new Error(result.error || '음악 공유에 실패했습니다.\n잠시 후 다시 시도해주세요.');
                }
                closeMusicShareModal();
                await loadSharedMusic();
                alert('음악이 공유되었습니다.');
            } catch (e) {
                console.error('음악 공유 오류:', e);
                alert(e.message || '음악 공유에 실패했습니다.\n잠시 후 다시 시도해주세요.');
            } finally {
                submitBtn.disabled = false; submitBtn.textContent = original;
                if (progressEl) progressEl.style.display = 'none';
            }
        };

        // 공유곡을 다운로드해서 "내 음악"(기존 MixTape IndexedDB)에 저장한다. 10곡 제한은 "공유"에만 적용되고
        // 다운로드/개인 라이브러리에는 제한이 없다.
        window.downloadSharedTrack = async function(trackId) {
            const track = sharedMusicCache[trackId] || (await sbMusic.from('music_tracks').select('*').eq('id', trackId).single()).data;
            if (!track || !track.storage_path) return alert("다운로드할 수 없는 곡입니다.");
            if (sharedMusicDownloadedIds.has(trackId)) return; // 이미 내 음악에 있으면 다시 받지 않는다 (버튼 자체도 숨겨지지만 이중 안전장치)
            try {
                const signedUrl = await getMusicSignedUrl(track.storage_path);
                const res = await fetch(signedUrl);
                if (!res.ok) throw new Error('파일을 가져오지 못했습니다.');
                const blob = await res.blob();
                const targetPlaylistId = await musicDbGetDefaultPlaylistId();
                if (targetPlaylistId == null) throw new Error('저장할 플레이리스트를 찾을 수 없습니다.');
                await musicDbAddTrackBlobToPlaylist(targetPlaylistId, blob, track.title || 'untitled', 'community', trackId);
                if (currentUser) {
                    const idToken = await currentUser.getIdToken();
                    fetch(MUSIC_WRITE_FUNCTION_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_MUSIC_KEY}` },
                        body: JSON.stringify({ action: 'record_download', trackId, firebaseIdToken: idToken })
                    }).catch(() => {});
                }
                sharedMusicDownloadedIds.add(trackId); // 화면을 즉시 "내 음악에 있음"으로 갱신
                renderSharedMusicList();
                renderMusicHome();
            } catch (e) {
                console.error('음악 다운로드 오류:', e);
                alert("다운로드에 실패했습니다.\n잠시 후 다시 시도해주세요.");
            }
        };

        // 본인이 공유한 곡만 삭제할 수 있다 - 소유권은 music-delete Edge Function이 uploader_id로 서버에서
        // 다시 확인한다(클라이언트의 uploader_id === currentUser.uid 체크는 버튼 노출용일 뿐, 신뢰하지 않는다).
        window.deleteSharedMusicTrack = async function(trackId) {
            if (!currentUser) return showLoginScreen(() => deleteSharedMusicTrack(trackId));
            const track = sharedMusicCache[trackId];
            if (!confirm(`"${track ? track.title || '이 곡' : '이 곡'}"을(를) 삭제할까요? 공유된 곡이 사라지고 되돌릴 수 없습니다.`)) return;
            try {
                const idToken = await currentUser.getIdToken();
                const res = await fetch(MUSIC_DELETE_FUNCTION_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_MUSIC_KEY}` },
                    body: JSON.stringify({ trackId, firebaseIdToken: idToken })
                });
                const result = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(result.error || '삭제에 실패했습니다.');
                delete sharedMusicCache[trackId];
                renderSharedMusicList();
                renderMusicHome();
            } catch (e) {
                console.error('공유 음악 삭제 오류:', e);
                alert(e.message || '삭제에 실패했습니다.\n잠시 후 다시 시도해주세요.');
            }
        };

        // 좋아요: optimistic UI - 클릭 즉시 반영 후 서버 요청, 실패하면 되돌린다.
        window.toggleMusicLike = async function(trackId) {
            if (!currentUser) return showLoginScreen(() => toggleMusicLike(trackId));
            const btn = document.getElementById(`music-like-${trackId}`);
            const track = sharedMusicCache[trackId];
            const wasLiked = sharedMusicLikedIds.has(trackId);
            const nowLiked = !wasLiked;
            if (btn) {
                btn.classList.toggle('liked', nowLiked);
                const prevCount = track ? (track.like_count || 0) : 0;
                btn.innerHTML = `${nowLiked ? '❤️' : '🤍'} ${Math.max(0, prevCount + (nowLiked ? 1 : -1))}`;
            }
            if (nowLiked) sharedMusicLikedIds.add(trackId); else sharedMusicLikedIds.delete(trackId);
            if (track) track.like_count = Math.max(0, (track.like_count || 0) + (nowLiked ? 1 : -1));

            try {
                const idToken = await currentUser.getIdToken();
                const res = await fetch(MUSIC_WRITE_FUNCTION_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_MUSIC_KEY}` },
                    body: JSON.stringify({ action: nowLiked ? 'like' : 'unlike', trackId, firebaseIdToken: idToken })
                });
                if (!res.ok) throw new Error('요청 실패');
            } catch (e) {
                console.warn('좋아요 처리 오류:', e);
                // 실패 시 되돌린다
                if (nowLiked) sharedMusicLikedIds.delete(trackId); else sharedMusicLikedIds.add(trackId);
                if (track) track.like_count = Math.max(0, (track.like_count || 0) + (nowLiked ? -1 : 1));
                if (btn) btn.innerHTML = `${wasLiked ? '❤️' : '🤍'} ${track ? track.like_count : 0}`;
                if (btn) btn.classList.toggle('liked', wasLiked);
            }
        };

        // --- ⑤ 좋아요 목록 ---
        async function loadMusicLikes() {
            const listEl = document.getElementById('music-likes-list');
            if (!listEl) return;
            if (!currentUser) { listEl.innerHTML = `<div class="card" style="grid-column:span 2; text-align:center; color:var(--text-muted);">로그인이 필요합니다.</div>`; return; }
            try {
                const { data: likeRows, error: likeErr } = await sbMusic.from('music_likes').select('track_id').eq('user_id', currentUser.uid);
                if (likeErr) throw likeErr;
                const ids = (likeRows || []).map(r => r.track_id);
                if (ids.length === 0) {
                    listEl.innerHTML = `<div class="card" style="grid-column:span 2; text-align:center; color:var(--text-muted);">아직 좋아요한 음악이 없습니다.</div>`;
                    return;
                }
                const { data: tracks, error: trackErr } = await sbMusic.from('music_tracks').select('*').in('id', ids);
                if (trackErr) throw trackErr;
                const downloadedIds = await getMyDownloadedTrackIds();
                listEl.innerHTML = renderMusicTrackRow(tracks, new Set(ids), downloadedIds);
            } catch (e) {
                console.warn('좋아요 목록 로딩 오류:', e);
                listEl.innerHTML = `<div class="card" style="grid-column:span 2; text-align:center; color:var(--text-muted);">불러오지 못했습니다.<br>잠시 후 다시 시도해주세요.</div>`;
            }
        }

        function renderMergedMaterials() {
            const filterEl = document.getElementById('materials-category-filter');
            const container = document.getElementById('materials-container');
            if (!container) return;

            const merged = [
                ...Object.entries(materialsStudyCache).map(([id, item]) => ({
                    id, source: 'legacy', collectionName: 'archiveStudy',
                    title: item.title, category: item.category || '미분류', desc: item.desc,
                    fileName: item.fileName, fileSize: item.fileSize, fileUrl: item.fileUrl,
                    authorId: item.authorId, authorDisplay: resolveDisplayName(item.authorName, item.authorOriginal),
                    createdAtMs: item.createdAt || 0, downloadCount: null
                })),
                ...Object.entries(materialsEtcCache).map(([id, item]) => ({
                    id, source: 'legacy', collectionName: 'archiveEtc',
                    title: item.title, category: item.category || '미분류', desc: item.desc,
                    fileName: item.fileName, fileSize: item.fileSize, fileUrl: item.fileUrl,
                    authorId: item.authorId, authorDisplay: resolveDisplayName(item.authorName, item.authorOriginal),
                    createdAtMs: item.createdAt || 0, downloadCount: null
                })),
                ...Object.values(supabaseMaterialsCache).map(row => ({
                    id: row.id, source: 'supabase',
                    title: row.title || row.original_file_name || row.file_name || '(제목 없음)',
                    category: row.category || '기타', desc: row.description,
                    fileName: row.original_file_name || row.file_name, fileSize: row.file_size,
                    authorId: row.owner_uid, authorDisplay: row.owner_name || '알 수 없음',
                    createdAtMs: row.created_at ? new Date(row.created_at).getTime() : 0,
                    downloadCount: row.download_count || 0
                }))
            ];

            const categories = Array.from(new Set(merged.map(m => m.category || '미분류'))).sort();
            if (filterEl) {
                const chips = ['전체', ...categories];
                filterEl.innerHTML = chips.map(cat => `
                    <div class="archive-subnav-item ${materialsCategoryFilter === cat ? 'active' : ''}" onclick="setMaterialsCategoryFilter('${escapeJsAttr(cat)}')">${escapeNoticeText(cat)}</div>
                `).join('');
            }

            const searchInput = document.getElementById('materials-search-input');
            const q = searchInput ? searchInput.value.trim().toLowerCase() : '';

            let filtered = materialsCategoryFilter === '전체' ? merged : merged.filter(m => (m.category || '미분류') === materialsCategoryFilter);
            if (q) {
                filtered = filtered.filter(m =>
                    (m.title || '').toLowerCase().includes(q) ||
                    (m.desc || '').toLowerCase().includes(q) ||
                    (m.fileName || '').toLowerCase().includes(q) ||
                    (m.authorDisplay || '').toLowerCase().includes(q)
                );
            }

            // 정렬: 최신순 / 오래된순 / 다운로드순 / 제목순
            if (materialsSortMode === 'oldest') filtered.sort((a, b) => a.createdAtMs - b.createdAtMs);
            else if (materialsSortMode === 'downloads') filtered.sort((a, b) => (b.downloadCount || 0) - (a.downloadCount || 0));
            else if (materialsSortMode === 'title') filtered.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ko'));
            else filtered.sort((a, b) => b.createdAtMs - a.createdAtMs); // 'latest' 기본값

            if (filtered.length === 0) {
                let emptyMsg;
                if (supabaseLoadFailed && Object.keys(supabaseMaterialsCache).length === 0) {
                    emptyMsg = '자료를 불러오지 못했습니다.<br>잠시 후 다시 시도해주세요.';
                } else if (merged.length === 0) {
                    emptyMsg = '아직 등록된 자료가 없습니다.<br>첫 번째 자료를 등록해보세요.';
                } else {
                    emptyMsg = '해당하는 자료가 없습니다.';
                }
                container.innerHTML = `<div class="card" style="grid-column: span 2; text-align:center; color:var(--text-muted);">${emptyMsg}</div>`;
                return;
            }

            const PREVIEWABLE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'pdf', 'txt'];

            container.innerHTML = filtered.map(m => {
                const isOwner = currentUser && currentUser.uid === m.authorId;
                const canDeleteLegacy = m.source !== 'supabase' && currentUser && (isOwner || isAdmin || isSubAdmin);
                // ⚠️ Supabase 자료 삭제는 verify-delete-material Edge Function이 "본인 자료인지"만 검증한다
                // (관리자 삭제는 아직 TODO). 그래서 프론트엔드에서 관리자에게 삭제 버튼을 임의로 보여주지
                // 않는다 - 눌러도 실패하는 버튼을 보여주는 대신, 명확하게 "준비 중"이라고 표시한다.
                const showAdminPendingNote = m.source === 'supabase' && !isOwner && (isAdmin || isSubAdmin);
                const canDelete = m.source === 'supabase' ? isOwner : canDeleteLegacy;
                const deleteAction = m.source === 'supabase' ? `deleteSupabaseMaterial('${m.id}')` : `deleteArchiveFile('${m.collectionName}', '${m.id}', '${m.authorId}')`;
                // 수정 가능 여부는 삭제와 같은 권한 구조를 따른다 (본인 글 + 레거시는 관리자도).
                const canEdit = canDelete;
                const editAction = m.source === 'supabase' ? `openMaterialEditModal('supabase', '${m.id}')` : `openMaterialEditModal('legacy', '${m.id}', '${m.collectionName}')`;
                const ext = (m.fileName || '').split('.').pop().toLowerCase();
                const canPreview = m.source === 'supabase' && PREVIEWABLE_EXT.includes(ext);
                return `
                    <div class="archive-file-card">
                        <div class="archive-file-badge">${escapeNoticeText(m.category || '미분류')}</div>
                        <div style="display:flex; align-items:center; gap:10px;">
                            <span class="archive-file-icon">${materialsFileIcon(ext)}</span>
                            <strong style="font-size: 15px; color: var(--text-main);">${escapeNoticeText(m.title)}</strong>
                        </div>
                        ${m.desc ? `<p style="font-size: 13px; color: var(--text-secondary); white-space: pre-wrap; line-height:1.4;">${escapeNoticeText(m.desc)}</p>` : ''}
                        ${m.fileName ? `
                            <div style="font-size:12px; color:var(--text-muted); display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                                ${m.source === 'supabase'
                                    ? `<span onclick="downloadSupabaseMaterial('${m.id}')" style="color:var(--primary); font-weight:700; cursor:pointer;">⬇ ${escapeNoticeText(m.fileName)} · ${ext ? ext.toUpperCase() : ''} · ${formatFileSize(m.fileSize)}</span>`
                                    : (m.fileUrl
                                        ? `<a href="${m.fileUrl}" target="_blank" onclick="if(window.completeDailyMission) window.completeDailyMission('archiveView', 10, '자료실 이용하기')" style="color:var(--primary); font-weight:700;">⬇ ${escapeNoticeText(m.fileName)} · ${ext ? ext.toUpperCase() : ''} · ${formatFileSize(m.fileSize)}</a>`
                                        : `<span>📎 ${escapeNoticeText(m.fileName)} (${formatFileSize(m.fileSize)}) · 업로드 대기 중(구버전 자료)</span>`)
                                }
                                ${canPreview ? `<span onclick="previewSupabaseMaterial('${m.id}')" style="color:var(--text-muted); cursor:pointer;">👁 미리보기</span>` : ''}
                                ${m.downloadCount != null ? `<span>· 다운로드 ${m.downloadCount}회</span>` : ''}
                            </div>
                        ` : ''}
                        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--text-muted); border-top: 1px dashed var(--border-color); padding-top: 8px; margin-top: 6px;">
                            <span>✍️ ${escapeNoticeText(m.authorDisplay)} · ${formatPostTimeOrDash(m.createdAtMs)}</span>
                            <span style="display:flex; gap:10px;">
                                ${canEdit ? `<span onclick="${editAction}" style="color: var(--primary); cursor: pointer; font-weight: 600;">수정</span>` : ''}
                                ${canDelete ? `<span onclick="${deleteAction}" style="color: #ef4444; cursor: pointer; font-weight: 600;">삭제</span>` : ''}
                                ${showAdminPendingNote ? `<span style="color: var(--text-muted); font-style: italic;">관리자 삭제 준비 중</span>` : ''}
                            </span>
                        </div>
                    </div>
                `;
            }).join('');

            gmwResetPageIfQueryChanged('materials', q);
            gmwApplyPagination('materials', container, '.archive-file-card');
            gmwBindImageRecalc('materials', container, '.archive-file-card');
        }
        window.renderMergedMaterials = renderMergedMaterials; // 검색창 등 인라인 이벤트 핸들러(oninput)는 window 스코프에서 찾으므로 명시적으로 노출

        function listenToArchiveStudy() {
            onSnapshot(collection(fdb, 'archiveStudy'), (snapshot) => {
                materialsStudyCache = fsSnapshotToMap(snapshot);
                renderMergedMaterials();
            }, onReadDenied('공부 자료'));
        }

        function listenToArchiveEtc() {
            onSnapshot(collection(fdb, 'archiveEtc'), (snapshot) => {
                materialsEtcCache = fsSnapshotToMap(snapshot);
                renderMergedMaterials();
            }, onReadDenied('기타 자료'));
        }
    
        // --- 스쿼드 메이커 ---
         const formationsMap = {
            "4-4-2": [{id:'st1',lbl:'ST',x:35,y:20}, {id:'st2',lbl:'ST',x:65,y:20}, {id:'lm',lbl:'LM',x:20,y:50}, {id:'cm1',lbl:'CM',x:40,y:50}, {id:'cm2',lbl:'CM',x:60,y:50}, {id:'rm',lbl:'RM',x:80,y:50}, {id:'lb',lbl:'LB',x:20,y:80}, {id:'cb1',lbl:'CB',x:40,y:80}, {id:'cb2',lbl:'CB',x:60,y:80}, {id:'rb',lbl:'RB',x:80,y:80}, {id:'gk',lbl:'GK',x:50,y:93}],
            "4-3-3": [{id:'lw',lbl:'LW',x:25,y:20}, {id:'st',lbl:'ST',x:50,y:15}, {id:'rw',lbl:'RW',x:75,y:20}, {id:'lcm',lbl:'LCM',x:30,y:50}, {id:'cm',lbl:'CM',x:50,y:55}, {id:'rcm',lbl:'RCM',x:70,y:50}, {id:'lb',lbl:'LB',x:20,y:80}, {id:'cb1',lbl:'CB',x:40,y:80}, {id:'cb2',lbl:'CB',x:60,y:80}, {id:'rb',lbl:'RB',x:80,y:80}, {id:'gk',lbl:'GK',x:50,y:93}],
            "4-2-3-1": [{id:'st',lbl:'ST',x:50,y:15}, {id:'lam',lbl:'LAM',x:25,y:35}, {id:'cam',lbl:'CAM',x:50,y:35}, {id:'ram',lbl:'RAM',x:75,y:35}, {id:'ldm',lbl:'LDM',x:35,y:60}, {id:'rdm',lbl:'RDM',x:65,y:60}, {id:'lb',lbl:'LB',x:20,y:80}, {id:'cb1',lbl:'CB',x:40,y:80}, {id:'cb2',lbl:'CB',x:60,y:80}, {id:'rb',lbl:'RB',x:80,y:80}, {id:'gk',lbl:'GK',x:50,y:93}],
            "3-5-2": [{id:'st1',lbl:'ST',x:40,y:15}, {id:'st2',lbl:'ST',x:60,y:15}, {id:'lm',lbl:'LM',x:15,y:45}, {id:'lcm',lbl:'LCM',x:35,y:50}, {id:'cam',lbl:'CAM',x:50,y:40}, {id:'rcm',lbl:'RCM',x:65,y:50}, {id:'rm',lbl:'RM',x:85,y:45}, {id:'lcb',lbl:'LCB',x:25,y:80}, {id:'cb',lbl:'CB',x:50,y:80}, {id:'rcb',lbl:'RCB',x:75,y:80}, {id:'gk',lbl:'GK',x:50,y:93}],
            "3-4-3": [{id:'lw',lbl:'LW',x:25,y:20}, {id:'st',lbl:'ST',x:50,y:15}, {id:'rw',lbl:'RW',x:75,y:20}, {id:'lm',lbl:'LM',x:20,y:50}, {id:'cm1',lbl:'CM',x:40,y:50}, {id:'cm2',lbl:'CM',x:60,y:50}, {id:'rm',lbl:'RM',x:80,y:50}, {id:'lcb',lbl:'LCB',x:25,y:80}, {id:'cb',lbl:'CB',x:50,y:80}, {id:'rcb',lbl:'RCB',x:75,y:80}, {id:'gk',lbl:'GK',x:50,y:93}],
            "5-3-2": [{id:'st1',lbl:'ST',x:40,y:15}, {id:'st2',lbl:'ST',x:60,y:15}, {id:'lcm',lbl:'LCM',x:30,y:50}, {id:'cm',lbl:'CM',x:50,y:55}, {id:'rcm',lbl:'RCM',x:70,y:50}, {id:'lwb',lbl:'LWB',x:15,y:70}, {id:'lcb',lbl:'LCB',x:30,y:80}, {id:'cb',lbl:'CB',x:50,y:80}, {id:'rcb',lbl:'RCB',x:70,y:80}, {id:'rwb',lbl:'RWB',x:85,y:70}, {id:'gk',lbl:'GK',x:50,y:93}]
        };

        let currentActivePos = null;
        let squadDataCache = {};

        // 학생 번호를 기준으로 표시 이름을 계산한다: 담임선생님 계정은 고정 명단, 학생 계정은 각자 저장한 실제 이름을
        // 그때그때 반영한다. 즉 데이터 자체는 "몇 번 학생"인지만 저장하고, 화면에 어떤 이름으로 보일지는 보는 사람에 따라 달라진다.
        function resolveStudentDisplayName(num) {
            const n = parseInt(num);
            if (isNaN(n)) return null;
            if (isTeacher98Identity('1', '2', n)) return TEACHER_98_DISPLAY_NAME; // 담임교사(98번)는 좌석표/스쿼드 등에 배정되더라도 항상 이 이름으로 표시
            return isRestrictedViewer ? (FIXED_PROFILE_ROSTER[n] || `${n}번`) : (profilesData[`student_${n}`]?.name || `${n}번`);
        }

        // squad는 두 컬렉션으로 나뉜다: squad_players(포지션별 배정 학생 번호) + squad_config/formation(현재 포메이션).
        // 기존 코드가 기대하는 { formation, players: {posId: num} } 모양으로 합쳐서 squadDataCache에 넣어준다.
        let squadFormationValue = "4-4-2";
        let squadPlayersMap = {};
        function rebuildSquadDataCache() {
            squadDataCache = { formation: squadFormationValue, players: squadPlayersMap };
            renderSquadPitch();
        }
        function listenToSquad() {
            onSnapshot(doc(fdb, 'squad_config', 'formation'), (snap) => {
                squadFormationValue = (snap.exists() && snap.data().value) || "4-4-2";
                rebuildSquadDataCache();
            });
            onSnapshot(collection(fdb, 'squad_players'), (snap) => {
                squadPlayersMap = {};
                snap.forEach(d => { squadPlayersMap[d.id] = d.data().value; });
                rebuildSquadDataCache();
            });
        }

        function renderSquadPitch() {
            const pitch = document.getElementById('squad-pitch');
            if (!pitch) return;
            const formation = squadDataCache.formation || "4-4-2";
            const formationSelect = document.getElementById('squad-formation-select');
            if (formationSelect) formationSelect.value = formation;

            let html = '';
            formationsMap[formation].forEach(pos => {
                const assigned = squadDataCache.players?.[pos.id];
                let pName = pos.lbl;
                if (assigned !== undefined && assigned !== null && assigned !== '') {
                    // 숫자(학생 번호)로 저장된 경우 보는 사람에 맞는 이름으로 변환, 예전에 이름 문자열로 저장된 데이터는 그대로 표시(호환)
                    const resolved = /^\d+$/.test(assigned) ? resolveStudentDisplayName(assigned) : null;
                    pName = resolved || assigned;
                }
                html += `<div class="player-pos" style="top:${pos.y}%; left:${pos.x}%;" onclick="openSquadModal('${pos.id}', '${pos.lbl}')"><span class="pos-label">${pos.lbl}</span><span class="player-name">${pName}</span></div>`;
            });
            pitch.innerHTML = html;
        }

        window.changeFormation = function(fmt) { setDoc(doc(fdb, 'squad_config', 'formation'), { value: fmt }); }
        
        window.openSquadModal = function(posId, lbl) {
            currentActivePos = posId;
            document.getElementById('squad-modal-title').innerText = `[${lbl}] 선수 선택`;
            const listEl = document.getElementById('squad-student-list'); listEl.innerHTML = '';
            for(let i=1; i<=26; i++) {
                const pName = resolveStudentDisplayName(i) || `${i}번`;
                listEl.innerHTML += `<button class="squad-member-btn" onclick="updateSquadPlayer(${i})">${i}. ${pName}</button>`;
            }
            document.getElementById('squad-modal').style.display = 'flex';
        }

        window.updateSquadPlayer = function(num) {
            if(currentActivePos) {
                if(num === '' || num === null || num === undefined) deleteDoc(doc(fdb, 'squad_players', currentActivePos)); 
                else setDoc(doc(fdb, 'squad_players', currentActivePos), { value: num });
            }
            document.getElementById('squad-modal').style.display = 'none';
        }

        // --- 시험 범위 & 실제 월간 수행평가 캘린더 ---
        const subjects = ["국어", "수학", "영어", "한국사", "통합과학", "통합사회"]; // exam_meta/subjects 문서가 아직 없을 때 쓰는 최초 시드 값
        // 과목 "이름 수정"이 가능해지면서, 기본 과목 목록 자체를 더 이상 하드코딩 상수로 고정해두지 않고
        // Firestore(exam_meta/subjects)에서 실시간으로 읽어온다 - 그래야 이름을 바꾸면 모두에게 반영된다.
        let examSubjectNames = [...subjects];
        let examNotesDataCache = {};
        function escapeHtml(str) {
            return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        }
        // 시험 탭이 display:none인 동안(로그인 직후 기본 탭은 홈이므로 거의 항상 그렇다)
        // scrollHeight가 0으로 계산되어 textarea가 한 줄 높이에 고정되는 문제가 있었다.
        // 그래서 값 자체를 계산하는 이 함수를 따로 빼서, 탭이 실제로 보일 때 다시 호출한다.
        function autoResizeExamNoteTextarea(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
        window.resizeExamNoteTextareas = function() {
            document.querySelectorAll('#exam-notes-container .subject-input').forEach(autoResizeExamNoteTextarea);
        };
        function renderExamNotes() {
            const container = document.getElementById('exam-notes-container'); if (!container) return;
            container.innerHTML = '';
            const data = examNotesDataCache;
            // 기본 과목(exam_meta/subjects) + 누군가 "+ 과목 추가"로 새로 만든 과목(exam_notes에 문서가 있으면) 전부 보여준다.
            // 홈 위젯(listenToHomeWidgets의 targets)은 별도의 고정 5과목 배열을 그대로 쓰므로 새 과목/이름 변경이 거기엔 안 뜬다.
            const allSubjects = [...examSubjectNames];
            Object.keys(data).forEach(sub => { if (!allSubjects.includes(sub)) allSubjects.push(sub); });
            allSubjects.forEach(sub => {
                const row = document.createElement('div'); row.className = 'subject-row';
                const escSub = escapeJsAttr(sub);
                row.innerHTML = `<span class="subject-name">${escapeHtml(sub)}</span><button type="button" onclick="renameExamSubject('${escSub}')" class="btn-sub" style="font-size:11px; padding:3px 7px;" title="과목 이름 수정">✏️</button><textarea class="subject-input" id="note-${sub}" rows="1" placeholder="${escapeHtml(sub)} 범위를 업데이트하세요.">${escapeHtml(data[sub] || '')}</textarea><button onclick="saveExamNote('${escSub}')" class="btn-sub" style="color:var(--primary); border-color:var(--primary);">저장</button>`;
                container.appendChild(row);
                const ta = row.querySelector('textarea');
                ta.addEventListener('input', () => autoResizeExamNoteTextarea(ta));
                autoResizeExamNoteTextarea(ta);
            });
        }
        function listenToExamNotes() {
            onSnapshot(doc(fdb, 'exam_meta', 'subjects'), (snap) => {
                if (snap.exists() && Array.isArray(snap.data().names) && snap.data().names.length) {
                    examSubjectNames = snap.data().names;
                } else {
                    examSubjectNames = [...subjects];
                    setDoc(doc(fdb, 'exam_meta', 'subjects'), { names: subjects }, { merge: true }).catch(() => {}); // 최초 1회 시드
                }
                renderExamNotes();
            });
            onSnapshot(collection(fdb, 'exam_notes'), (snap) => {
                examNotesDataCache = {}; snap.forEach(d => { examNotesDataCache[d.id] = d.data().text || ''; });
                renderExamNotes();
            });
        }
        window.saveExamNote = async function(sub) { try { await setDoc(doc(fdb, 'exam_notes', sub), { text: document.getElementById(`note-${sub}`).value.trim() }); alert(`저장 완료`); } catch(e) {} }
        // 과목 이름 수정: exam_notes 문서 id 자체가 과목명이라 "이름만 바꾸는" 게 불가능해서,
        // 새 이름으로 문서를 새로 만들고(기존 범위 텍스트는 그대로 옮김) 기존 문서를 지우는 방식으로 처리한다.
        // 기본 과목(exam_meta/subjects에 들어있는 이름)이면 그 목록의 이름도 함께 바꿔서, 모두에게 실시간 반영된다.
        window.renameExamSubject = async function(oldName) {
            const newName = (prompt(`"${oldName}" 과목의 새 이름을 입력하세요.`, oldName) || '').trim();
            if (!newName || newName === oldName) return;
            const allCurrentNames = [...new Set([...examSubjectNames, ...Object.keys(examNotesDataCache)])];
            if (allCurrentNames.includes(newName)) return alert('이미 있는 과목 이름입니다.');
            try {
                const oldSnap = await getDoc(doc(fdb, 'exam_notes', oldName));
                const text = oldSnap.exists() ? (oldSnap.data().text || '') : '';
                await setDoc(doc(fdb, 'exam_notes', newName), { text });
                await deleteDoc(doc(fdb, 'exam_notes', oldName));
                if (examSubjectNames.includes(oldName)) {
                    const updatedNames = examSubjectNames.map(s => s === oldName ? newName : s);
                    await setDoc(doc(fdb, 'exam_meta', 'subjects'), { names: updatedNames });
                }
            } catch (e) {
                alert('과목 이름 수정 중 오류가 발생했습니다.');
            }
        };
        // 새 과목을 exam_notes에 빈 문서로 만들어 목록에 추가한다 (2반 정회원이면 누구나 - 기존 시험범위 쓰기 권한과 동일).
        window.addExamSubject = async function() {
            const name = (prompt('추가할 과목명을 입력하세요.') || '').trim();
            if (!name) return;
            try { await setDoc(doc(fdb, 'exam_notes', name), { text: '' }, { merge: true }); }
            catch (e) { alert('과목 추가 중 오류가 발생했습니다.'); }
        }

        // 기존 calendar 구조(각 이벤트에 date 필드)를 그대로 유지하면서
        // 날짜/과목별로 그룹핑해 보여준다. 기존 {date, text} 형태의 옛날 게시물도 호환된다.
        let examCalendarCache = {}; // { 'YYYY-MM-DD' | '__nodate__': [ {id, ...event}, ... ] }

        // =========================================================================
        // 수행평가 기록 - 과목별 입력행 UI (Firestore calendar 저장소를 그대로 재사용)
        // 새로운 저장 구조를 만들지 않는다. id/date/subject/title/description/createdAt/updatedAt만 사용하며,
        // "학교 공용 일정 캘린더" 미러링(mirrorAssessmentToSchedule/unmirrorAssessmentFromSchedule)도 그대로 활용한다.
        // =========================================================================
        const ASSESSMENT_SUBJECTS = ['국어', '영어', '수학', '과학', '사회', '한국사', '인기초', '미술', '체육'];
        // 과목별로 "+ 추가"를 눌러 늘어난, 아직 Firebase에 저장되지 않은 빈 입력행 개수
        let assessmentBlankRowCount = {};
        ASSESSMENT_SUBJECTS.forEach(s => assessmentBlankRowCount[s] = 0);

        function getAllAssessmentRecords() {
            const list = [];
            Object.values(examCalendarCache).forEach(evs => evs.forEach(ev => list.push(ev)));
            return list;
        }
        function findAssessmentById(id) {
            for (const evs of Object.values(examCalendarCache)) {
                const found = evs.find(e => e.id === id);
                if (found) return found;
            }
            return null;
        }
        function removeAssessmentFromLocalCache(id) {
            Object.keys(examCalendarCache).forEach(key => {
                examCalendarCache[key] = examCalendarCache[key].filter(e => e.id !== id);
                if (examCalendarCache[key].length === 0) delete examCalendarCache[key];
            });
        }
        function groupAssessmentsBySubject() {
            const bySubject = {}; ASSESSMENT_SUBJECTS.forEach(s => bySubject[s] = []);
            const extra = []; // 9개 과목에 속하지 않는 기존 데이터도 손실 없이 보존한다
            getAllAssessmentRecords().forEach(ev => {
                if (ev.subject && ASSESSMENT_SUBJECTS.includes(ev.subject)) bySubject[ev.subject].push(ev);
                else extra.push(ev);
            });
            const byDate = (a, b) => (a.date || '').localeCompare(b.date || '');
            ASSESSMENT_SUBJECTS.forEach(s => bySubject[s].sort(byDate));
            extra.sort(byDate);
            return { bySubject, extra };
        }
        function assessmentSubjectSelectOptions(currentSubject) {
            let opts = '';
            if (currentSubject && !ASSESSMENT_SUBJECTS.includes(currentSubject)) {
                opts += `<option value="${escapeHtml(currentSubject)}" selected>${escapeHtml(currentSubject)}</option>`;
            }
            opts += ASSESSMENT_SUBJECTS.map(s => `<option value="${s}" ${s === currentSubject ? 'selected' : ''}>${s}</option>`).join('');
            return opts;
        }
        function renderAssessmentRow(ev, displayIndex, groupSubject, showSubjectSelect) {
            const id = ev.id || '';
            const date = ev.date || '';
            const title = ev.title || ev.text || '';
            const content = ev.description || '';
            const subjectForSelect = ev.subject || groupSubject;
            // 이미 과목별로 그룹핑되어 있으므로, 정상 분류된 9개 과목 그룹 안에서는 과목 선택을 다시 보여주지 않는다.
            // "기타(분류 필요)" 그룹에서만 어느 과목으로 옮길지 고를 수 있게 셀렉트를 보여준다.
            const subjectSelectHtml = showSubjectSelect
                ? `<select class="assess-subject-select">${assessmentSubjectSelectOptions(subjectForSelect)}</select>`
                : '';
            return `<div class="assess-row" data-subject="${escapeHtml(groupSubject)}" data-id="${id}">
                <span class="assess-row-num">${displayIndex}.</span>
                <input type="date" class="assess-date" value="${date}">
                ${subjectSelectHtml}
                <input type="text" class="assess-title" placeholder="수행평가 제목" value="${escapeHtml(title)}">
                <input type="text" class="assess-content" placeholder="내용" value="${escapeHtml(content)}">
                <button type="button" class="assess-row-delete" title="삭제">🗑️</button>
            </div>`;
        }
        function renderAssessmentSubjectRows() {
            const container = document.getElementById('assessment-subject-rows');
            if (!container) return;
            const { bySubject, extra } = groupAssessmentsBySubject();
            let html = '';
            ASSESSMENT_SUBJECTS.forEach(subject => {
                const saved = bySubject[subject];
                // 처음에는 아무 행도 없다. "+ 추가"를 눌러야 빈 입력행이 하나 생기고, 그때 1번이 붙는다.
                const blanks = assessmentBlankRowCount[subject] || 0;
                const rows = saved.slice();
                for (let i = 0; i < blanks; i++) rows.push({ id: '', date: '', subject, title: '', description: '' });
                const rowsHtml = rows.length > 0
                    ? rows.map((ev, i) => renderAssessmentRow(ev, i + 1, subject, false)).join('')
                    : `<div style="font-size:12px; color:var(--text-muted); padding:6px 0;">등록된 수행평가가 없습니다. "+ 추가"를 눌러 입력하세요.</div>`;
                html += `<div class="assess-subject-group" data-group-subject="${subject}">
                    <div class="assess-subject-header">
                        <span class="assess-subject-title">${subject}</span>
                        <button type="button" class="btn-sub assess-add-btn" data-add-subject="${subject}">+ 추가</button>
                    </div>
                    ${rowsHtml}
                </div>`;
            });
            if (extra.length > 0) {
                html += `<div class="assess-subject-group" data-group-subject="__extra__">
                    <div class="assess-subject-header"><span class="assess-subject-title">기타 (분류 필요)</span></div>
                    ${extra.map((ev, i) => renderAssessmentRow(ev, i + 1, ev.subject || '', true)).join('')}
                </div>`;
            }
            container.innerHTML = html;
        }

        // "+ 추가" 클릭 → 해당 과목에 빈 입력행 하나를 더 표시한다 (아직 Firebase에는 저장하지 않음)
        // 행 삭제 → id가 있으면 실제 삭제(+미러 캘린더 삭제), 아직 저장 전인 빈 행은 화면에서만 제거한다.
        document.addEventListener('click', (e) => {
            const addBtn = e.target.closest('#assessment-subject-rows [data-add-subject]');
            if (addBtn) {
                const subject = addBtn.getAttribute('data-add-subject');
                assessmentBlankRowCount[subject] = (assessmentBlankRowCount[subject] || 0) + 1;
                renderAssessmentSubjectRows();
                return;
            }
            const delBtn = e.target.closest('#assessment-subject-rows .assess-row-delete');
            if (delBtn) {
                const row = delBtn.closest('.assess-row');
                const id = row.getAttribute('data-id');
                if (!id) {
                    // 아직 저장 전인 빈 행: 화면에서 제거하고, 그만큼 대기 중인 빈 행 개수도 함께 줄인다.
                    const groupSubject = row.getAttribute('data-subject');
                    if (groupSubject) assessmentBlankRowCount[groupSubject] = Math.max(0, (assessmentBlankRowCount[groupSubject] || 0) - 1);
                    renderAssessmentSubjectRows();
                    return;
                }
                if (!confirm('이 수행평가 기록을 삭제하시겠습니까?')) return;
                deleteDoc(doc(fdb, 'calendar', id)).then(() => {
                    unmirrorAssessmentFromSchedule(id);
                    removeAssessmentFromLocalCache(id);
                    renderAssessmentSubjectRows();
                }).catch(() => alert('삭제 중 오류가 발생했습니다.'));
            }
        });

        // 입력행의 값이 바뀌면(포커스 아웃 시점) 저장한다. 완전히 빈 행은 저장하지 않는다.
        // 날짜/제목이 모두 있어야 학교 공용 일정 캘린더에 미러링한다 (그 전까지는 미러 항목을 만들지 않음).
        document.addEventListener('change', (e) => {
            const row = e.target.closest('#assessment-subject-rows .assess-row');
            if (!row) return;
            const groupSubject = row.getAttribute('data-subject');
            let id = row.getAttribute('data-id') || '';
            const date = row.querySelector('.assess-date').value;
            const subjectSelectEl = row.querySelector('.assess-subject-select');
            const subjectSelectVal = subjectSelectEl ? subjectSelectEl.value : '';
            const title = row.querySelector('.assess-title').value.trim();
            const content = row.querySelector('.assess-content').value.trim();
            const finalSubject = subjectSelectVal || groupSubject;

            if (!id) {
                if (!date && !title && !content) return; // 완전히 빈 행이면 아무 것도 하지 않는다
                const newDocRef = doc(collection(fdb, 'calendar')); // Firestore 자동 ID 생성 (RTDB push 대체)
                id = newDocRef.id;
                const payload = { date, subject: finalSubject, title, text: title, description: content, createdAt: Date.now() };
                setDoc(newDocRef, payload).catch(() => alert('저장 중 오류가 발생했습니다.'));
                if (title && date) mirrorAssessmentToSchedule(id, payload); else unmirrorAssessmentFromSchedule(id);
                // 실시간 리스너를 기다리지 않고 로컬 캐시에 즉시 반영해, 다음 렌더링에서 방금 만든 행이 사라지지 않게 한다.
                const key = date || '__nodate__';
                if (!examCalendarCache[key]) examCalendarCache[key] = [];
                examCalendarCache[key].push({ id, ...payload });
                assessmentBlankRowCount[groupSubject] = Math.max(0, (assessmentBlankRowCount[groupSubject] || 0) - 1);
            } else {
                const existing = findAssessmentById(id) || {};
                const payload = { date, subject: finalSubject, title, text: title, description: content, createdAt: existing.createdAt || Date.now(), updatedAt: Date.now() };
                updateDoc(doc(fdb, 'calendar', id), payload).catch(() => alert('저장 중 오류가 발생했습니다.'));
                if (title && date) mirrorAssessmentToSchedule(id, payload); else unmirrorAssessmentFromSchedule(id);
                removeAssessmentFromLocalCache(id);
                const newKey = date || '__nodate__';
                if (!examCalendarCache[newKey]) examCalendarCache[newKey] = [];
                examCalendarCache[newKey].push({ id, ...payload });
            }
            renderAssessmentSubjectRows();
        });

        function listenToCalendar() {
            onSnapshot(collection(fdb, 'calendar'), (snap) => {
                const raw = fsSnapshotToMap(snap);
                examCalendarCache = {};
                Object.entries(raw).forEach(([id, ev]) => {
                    if (!ev) return;
                    // 날짜가 아직 채워지지 않은 수행평가 기록 입력행(작성 중)도 데이터 손실 없이 보관한다.
                    const key = ev.date || '__nodate__';
                    if (!examCalendarCache[key]) examCalendarCache[key] = [];
                    examCalendarCache[key].push({ id, ...ev });
                });
                renderAssessmentSubjectRows();
            });
        }

        // --- 실시간 자리 배치 ---
        // 1-2반 고정 명단: 학생이 프로필을 아무리 수정해도 이 목록의 이름이 우선 표시된다 (친구프로필/스쿼드메이커/랜덤자리배치 공통 사용)
        const FIXED_PROFILE_ROSTER = {
            1: "고성민", 2: "김도영", 3: "김민재", 4: "김민호", 5: "김서준", 6: "김우석", 7: "김은교",
            8: "김지언", 9: "남강현", 10: "문은성", 11: "문주안", 12: "박건우", 13: "박지율", 14: "안가온",
            15: "안은섭", 16: "안중원", 17: "윤석용", 18: "이라건", 19: "이준서", 20: "이준이", 21: "이태호",
            22: "이현민", 23: "임유빈", 24: "장유준", 25: "정연우", 26: "홍준서"
        };
        const seatStructure = [[1,5,9,14,19,23],[2,6,10,15,20,24],[3,7,11,16,21,25],[4,8,12,17,22,26],[0,0,13,18,0,0]];
        let seatingDataCache = {};
        let seatingDataReady = false; // 자리 배치 데이터(캐시든 실시간이든)를 한 번이라도 받았는지 - 공유 링크로 열었을 때 탭을 옮길 시점 판단용
        function listenToSeating() {
            // RTDB는 오프라인 캐시가 없어서, 리스너가 값을 받기 전까지는 마지막으로 저장해둔 자리배치를 먼저 보여준다.
            const cached = loadInfoCache('seating');
            if (cached) { seatingDataCache = cached.data; seatingDataReady = true; renderSeatingGrid(); tryConsumePendingShareTarget(); }
            onValue(ref(db, 'dashboard/seating'), (snap) => {
                seatingDataCache = snap.val() || {};
                seatingDataReady = true;
                saveInfoCache('seating', seatingDataCache);
                renderSeatingGrid();
                tryConsumePendingShareTarget();
            });
        }
        // 한 좌석에 보여줄 이름 - 화면(renderSeatingGrid)과 이미지 저장(downloadSeatingImage)이 항상 똑같은
        // 결과를 보여주도록 계산을 여기 한 곳에 둔다.
        function getSeatDisplayName(num) {
            const assigned = seatingDataCache[`seat_${num}`];
            if (assigned !== undefined && assigned !== null && assigned !== '') {
                // 숫자(학생 번호)로 저장된 경우 보는 사람에 맞는 이름으로 변환, 예전 이름 문자열 데이터는 그대로 표시(호환)
                const resolved = /^\d+$/.test(assigned) ? resolveStudentDisplayName(assigned) : null;
                return resolved || assigned;
            }
            return `${num}번 학생`;
        }
        function renderSeatingGrid() {
            const gridEl = document.getElementById('seating-grid');
            if (!gridEl) return;
            gridEl.innerHTML = '';
            seatStructure.forEach(row => {
                row.forEach(num => {
                    const box = document.createElement('div');
                    if (num === 0) box.className = 'seat-box empty';
                    else {
                        box.className = 'seat-box';
                        box.innerHTML = `<div class="seat-label">${num}번 좌석</div><div class="seat-user">${getSeatDisplayName(num)}</div>`;
                        if (canManageSeats) { box.style.cursor = 'pointer'; box.onclick = () => openSeatModal(num); }
                    }
                    gridEl.appendChild(box);
                });
            });
        }

        // =========================================================================
        // 자리 배치 이미지로 저장 / 링크 공유
        // - 화면을 캡처(html2canvas)하지 않고 좌석 데이터로 캔버스에 직접 그린다: 이 앱의 카드 스타일(블러,
        //   CSS 변수, 다크 모드)에 결과가 좌우되지 않고, CDN 스크립트가 안 떠도 오프라인(저장된 자리배치)에서도
        //   동작하며, 어떤 테마로 보고 있든 공유하기 좋은 밝은 이미지가 나온다.
        // - 링크 공유는 게시글/공지와 같은 방식(?share=seat)이다. 이미지를 외부 호스트에 올려 만든 공개
        //   링크가 아니라 앱 링크라서, 1-2반으로 로그인한 사람만 열어볼 수 있다(반 친구들 실명이 들어간 자료).
        // =========================================================================
        // 순수 함수 - 캔버스/DOM 없이 좌표만 계산해서 따로 테스트할 수 있다(기본 좌석 배치 seatStructure와 같은 모양).
        function computeSeatImageLayout(structure) {
            const COLS = Math.max(...structure.map(r => r.length));
            const PAD = 48, HEADER_H = 136, DESK_W = 220, DESK_H = 50, DESK_GAP = 34;
            const SEAT_W = 150, SEAT_H = 96, GAP = 18, FOOTER_H = 64;
            const width = PAD * 2 + COLS * SEAT_W + (COLS - 1) * GAP;
            const desk = { x: (width - DESK_W) / 2, y: HEADER_H, w: DESK_W, h: DESK_H };
            const gridTop = desk.y + desk.h + DESK_GAP;
            const seats = [];
            structure.forEach((row, r) => row.forEach((num, c) => {
                if (num === 0) return; // 0은 빈 칸(자리 없음)
                seats.push({ num, x: PAD + c * (SEAT_W + GAP), y: gridTop + r * (SEAT_H + GAP), w: SEAT_W, h: SEAT_H });
            }));
            const gridBottom = gridTop + structure.length * SEAT_H + (structure.length - 1) * GAP;
            return { width, height: gridBottom + FOOTER_H, pad: PAD, desk, seats };
        }
        function pathRoundRect(ctx, x, y, w, h, r) {
            ctx.beginPath();
            ctx.moveTo(x + r, y);
            ctx.arcTo(x + w, y, x + w, y + h, r);
            ctx.arcTo(x + w, y + h, x, y + h, r);
            ctx.arcTo(x, y + h, x, y, r);
            ctx.arcTo(x, y, x + w, y, r);
            ctx.closePath();
        }
        const SEAT_IMAGE_FONT = `'Pretendard', 'Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif`;
        function drawSeatingImage(ctx, layout, getName, dateLabel) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, layout.width, layout.height);
            ctx.textBaseline = 'middle';

            ctx.textAlign = 'left';
            ctx.fillStyle = '#0f172a';
            ctx.font = `800 40px ${SEAT_IMAGE_FONT}`;
            ctx.fillText('1-2반 자리 배치', layout.pad, layout.pad + 22);
            ctx.fillStyle = '#64748b';
            ctx.font = `500 20px ${SEAT_IMAGE_FONT}`;
            ctx.fillText(dateLabel, layout.pad, layout.pad + 66);

            pathRoundRect(ctx, layout.desk.x, layout.desk.y, layout.desk.w, layout.desk.h, 12);
            ctx.fillStyle = '#94a3b8';
            ctx.fill();
            ctx.textAlign = 'center';
            ctx.fillStyle = '#ffffff';
            ctx.font = `700 20px ${SEAT_IMAGE_FONT}`;
            ctx.fillText('교 탁', layout.desk.x + layout.desk.w / 2, layout.desk.y + layout.desk.h / 2);

            layout.seats.forEach(seat => {
                pathRoundRect(ctx, seat.x, seat.y, seat.w, seat.h, 14);
                ctx.fillStyle = '#f8fafc';
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = '#e2e8f0';
                ctx.stroke();

                const cx = seat.x + seat.w / 2;
                ctx.textAlign = 'center';
                ctx.fillStyle = '#94a3b8';
                ctx.font = `500 14px ${SEAT_IMAGE_FONT}`;
                ctx.fillText(`${seat.num}번 좌석`, cx, seat.y + 28);

                // 이름이 칸보다 길면 글자 크기를 줄여서 맞추고(최소 14px), 그래도 넘치면 말줄임(…)으로 자른다 -
                // 어떤 데이터가 들어와도 글자가 옆 칸으로 삐져나가거나 잘리지 않게 한다.
                const maxTextW = seat.w - 20;
                let name = String(getName(seat.num));
                let size = 28;
                ctx.fillStyle = '#0f172a';
                ctx.font = `700 ${size}px ${SEAT_IMAGE_FONT}`;
                while (size > 14 && ctx.measureText(name).width > maxTextW) {
                    size -= 2;
                    ctx.font = `700 ${size}px ${SEAT_IMAGE_FONT}`;
                }
                if (ctx.measureText(name).width > maxTextW) {
                    while (name.length > 1 && ctx.measureText(name + '…').width > maxTextW) name = name.slice(0, -1);
                    name += '…';
                }
                ctx.fillText(name, cx, seat.y + 62);
            });

            ctx.textAlign = 'right';
            ctx.fillStyle = '#cbd5e1';
            ctx.font = `500 16px ${SEAT_IMAGE_FONT}`;
            ctx.fillText('1-2 커뮤니티', layout.width - layout.pad, layout.height - 30);
        }
        window.downloadSeatingImage = async function() {
            try {
                // 웹폰트가 아직 로딩 중이면 캔버스가 대체 글꼴로 그려버리므로, 준비될 때까지 잠깐 기다린다.
                if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
                const now = new Date();
                const pad2 = n => String(n).padStart(2, '0');
                const dateKey = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
                const layout = computeSeatImageLayout(seatStructure);
                const scale = 2; // 카톡 등으로 공유해도 글씨가 또렷하도록 2배 해상도로 만든다
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(layout.width * scale);
                canvas.height = Math.round(layout.height * scale);
                const ctx = canvas.getContext('2d');
                ctx.scale(scale, scale);
                drawSeatingImage(ctx, layout, getSeatDisplayName, dateKey.replace(/-/g, '.') + ' 기준');
                const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                if (!blob) throw new Error('이미지를 만들지 못했어요.');
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                // 파일명은 영문으로 - 브라우저에 따라 한글 download 이름이 무시되고 확장자 없는 "download"로 저장되는
                // 경우가 있어서(실제로 확인됨), .png 확장자가 확실히 붙는 이름을 쓴다.
                a.download = `seat-chart_${dateKey}.png`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 2000);
            } catch (e) {
                console.error('자리 배치 이미지 저장 오류:', e);
                alert('이미지 저장에 실패했어요. 잠시 후 다시 시도해주세요.');
            }
        };
        window.shareSeatingLink = async function() {
            const ok = await copyTextToClipboard(buildShareUrl('seat'));
            alert(ok
                ? '자리 배치 링크가 복사되었어요! 붙여넣기로 공유해보세요.\n(1-2반으로 로그인한 친구들만 열어볼 수 있어요)'
                : '링크 복사에 실패했어요. 브라우저 권한을 확인해주세요.');
        };

        // 랜덤 자리 배치 셔플/개별 자리 수정 버튼 노출 (canManageSeats가 바뀔 때마다 호출됨)
        function updateSeatComposerVisibility() {
            const btn = document.getElementById('btn-shuffle-seats');
            if (btn) btn.style.display = canManageSeats ? 'inline-flex' : 'none';
            const hint = document.getElementById('seat-view-only-hint');
            if (hint) hint.style.display = canManageSeats ? 'none' : 'block';
            renderSeatingGrid(); // 좌석 클릭 가능 여부(커서/onclick)도 함께 다시 그린다
        }

        let currentActiveSeat = null;
        // 스쿼드 메이커(openSquadModal)와 동일한 방식: 좌석을 클릭하면 26명 학생 버튼이 뜨고,
        // 하나를 고르면 그 자리에 배정된다.
        window.openSeatModal = function(seatNum) {
            if (!canManageSeats) return;
            currentActiveSeat = seatNum;
            document.getElementById('seat-modal-title').innerText = `${seatNum}번 좌석 배정`;
            const listEl = document.getElementById('seat-student-list'); listEl.innerHTML = '';
            for (let i = 1; i <= 26; i++) {
                const pName = resolveStudentDisplayName(i) || `${i}번`;
                listEl.innerHTML += `<button class="squad-member-btn" onclick="updateSeatAssignment(${i})">${i}. ${pName}</button>`;
            }
            document.getElementById('seat-modal').style.display = 'flex';
        }

        window.updateSeatAssignment = function(num) {
            if (canManageSeats && currentActiveSeat) {
                const seatRef = ref(db, `dashboard/seating/seat_${currentActiveSeat}`);
                if (num === '' || num === null || num === undefined) remove(seatRef);
                else set(seatRef, num);
            }
            document.getElementById('seat-modal').style.display = 'none';
        }

        window.shuffleSeats = function() {
            if (!canManageSeats) return alert('권한이 없습니다. (커뮤니티 엔지니어·반장·부반장·담임선생님만 가능)');
            if(!confirm("🎲 전 좌석 셔플 믹스 하시겠습니까?")) return;
            let pool = [];
            for(let i=1; i<=26; i++) pool.push(i); // 이름이 아니라 "몇 번 학생"인지를 셔플한다
            for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
            let updateData = {}; for(let i=1; i<=26; i++) updateData[`seat_${i}`] = pool[i-1];
            set(ref(db, 'dashboard/seating'), updateData).then(() => alert("🎲 재배치 완료!"));
        }

        // =========================================================================
        // 홈 바로가기 (관리자/반장/부반장/담임선생님만 추가·수정·삭제 가능)
        // =========================================================================
        // 기존에 하드코딩되어 있던 5개 바로가기를 그대로 기본값으로 심어둔다 (동작 변화 없이 Firebase로 이전).
        const DEFAULT_SHORTCUTS_SEED = {
            s1: { label: '🧑‍🏫 클래스룸', url: 'https://classroom.google.com/h/st', order: 0 },
            s2: { label: '📢 공지사항 보드판', url: 'https://docs.google.com/presentation/d/1tXyvxlnUymznKIxb6yD6AR7l1GOnoUmh93-qCtHU4W0/edit?usp=sharing', order: 1 },
            s3: { label: '📝 귀성 및 신청', url: 'https://hanil40-9awj8tjxyjljkfyjrayd9k.streamlit.app/', order: 2 },
            s4: { label: '💬 40기 질문방', url: 'https://40th-qna-kiwdwxdi6o2gqqheugwgc7.streamlit.app/', order: 3 },
            s5: { label: '⏰ 기상송 신청', url: 'https://poetic-sunshine-4f5c0a.netlify.app/', order: 4 }
        };
        let shortcutsCache = {};
        let editingShortcutId = null;
        let editingShortcutScope = 'shared'; // 'shared'(반 공용, RTDB) | 'personal'(이 브라우저에만, localStorage)
        let shortcutsSeedAttempted = false;

        // 개인 바로가기: 반 공용 바로가기(dashboard/shortcuts, RTDB)와 달리 누구나(관리자 아니어도)
        // 추가할 수 있고, 이 브라우저에만 저장된다 (다른 기기/브라우저에는 안 보임).
        const PERSONAL_SHORTCUTS_KEY = 'hanilgo_personal_shortcuts';
        function loadPersonalShortcuts() {
            try {
                const saved = JSON.parse(localStorage.getItem(PERSONAL_SHORTCUTS_KEY) || '{}');
                return (saved && typeof saved === 'object' && !Array.isArray(saved)) ? saved : {};
            } catch (e) { return {}; }
        }
        function savePersonalShortcuts(map) {
            try { localStorage.setItem(PERSONAL_SHORTCUTS_KEY, JSON.stringify(map)); } catch (e) {}
        }

        function listenToShortcuts() {
            onValue(ref(db, 'dashboard/shortcuts'), (snap) => {
                shortcutsCache = snap.val() || {};
                if (Object.keys(shortcutsCache).length === 0 && canManageShortcuts && !shortcutsSeedAttempted) {
                    // 최초 1회, 편집 권한이 있는 뷰어만 시도한다 (일반 뷰어가 시도하면 규칙상 permission_denied가 날 수 있음).
                    shortcutsSeedAttempted = true;
                    set(ref(db, 'dashboard/shortcuts'), DEFAULT_SHORTCUTS_SEED).catch(() => {});
                }
                renderShortcuts();
            });
        }

        function renderShortcuts() {
            const grid = document.getElementById('shortcuts-grid');
            if (!grid) return;
            const personalShortcuts = loadPersonalShortcuts();
            const entries = [
                ...Object.entries(shortcutsCache).map(([id, sc]) => ({ id, sc, personal: false })),
                ...Object.entries(personalShortcuts).map(([id, sc]) => ({ id, sc, personal: true }))
            ].sort((a, b) => (a.sc.order || 0) - (b.sc.order || 0));
            grid.innerHTML = entries.map(({ id, sc, personal }) => {
                const safeUrl = escapeJsAttr(sc.url || '');
                // 개인 바로가기는 관리자 권한과 무관하게 항상 본인이 수정/삭제할 수 있다.
                const canEditThis = personal || canManageShortcuts;
                const editBtn = canEditThis ? `<span data-edit-control onclick="event.stopPropagation(); openShortcutModal('${id}', '${personal ? 'personal' : 'shared'}')" style="position:absolute; top:-6px; right:-6px; cursor:pointer; font-size:14px; background:var(--card-bg); border:1px solid var(--border-color); border-radius:50%; width:20px; height:20px; display:flex; align-items:center; justify-content:center;">⚙️</span>` : '';
                const personalBadge = personal ? `<span title="나만 보이는 개인 바로가기" style="position:absolute; top:-6px; left:-6px; font-size:11px; background:var(--card-bg); border:1px solid var(--border-color); border-radius:50%; width:20px; height:20px; display:flex; align-items:center; justify-content:center;">👤</span>` : '';
                return `<div style="position:relative;">
                    ${editBtn}${personalBadge}
                    <button class="auth-btn" style="width: 100%; margin-top: 0; padding: 12px 8px; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" onclick="window.open('${safeUrl}', '_blank', 'noopener,noreferrer')">${sc.label}</button>
                </div>`;
            }).join('');
        }

        // canManageShortcuts/편집 모드가 바뀔 때마다 "바로가기 추가" 버튼들과 각 버튼의 ⚙️ 편집 아이콘 노출을 함께 갱신한다.
        // "위젯 편집" 모드일 때만 추가 버튼이 나오게 해서 평소엔 바로가기 영역이 깔끔하게 보이도록 한다.
        function updateShortcutComposerVisibility() {
            const btn = document.getElementById('btn-add-shortcut');
            if (btn) btn.style.display = (homeSectionEditMode && canManageShortcuts) ? 'inline-flex' : 'none';
            const personalBtn = document.getElementById('btn-add-shortcut-personal');
            if (personalBtn) personalBtn.style.display = homeSectionEditMode ? 'inline-flex' : 'none';
            renderShortcuts();
        }

        window.openShortcutModal = function(id, scope) {
            scope = scope === 'personal' ? 'personal' : 'shared';
            if (scope === 'shared' && !canManageShortcuts) return;
            editingShortcutId = id || null;
            editingShortcutScope = scope;
            const store = scope === 'personal' ? loadPersonalShortcuts() : shortcutsCache;
            const sc = id ? store[id] : null;
            const scopeLabel = scope === 'personal' ? '내 바로가기' : '바로가기';
            document.getElementById('shortcut-modal-title').innerText = id ? `${scopeLabel} 수정` : `${scopeLabel} 추가`;
            document.getElementById('shortcut-input-label').value = sc ? sc.label : '';
            document.getElementById('shortcut-input-url').value = sc ? (sc.url || '') : '';
            document.getElementById('shortcut-input-order').value = sc ? (sc.order || 0) : Object.keys(store).length;
            document.getElementById('shortcut-delete-btn').style.display = id ? 'block' : 'none';
            document.getElementById('shortcut-modal').style.display = 'flex';
        }

        window.closeShortcutModal = function() {
            document.getElementById('shortcut-modal').style.display = 'none';
            editingShortcutId = null;
        }

        window.saveShortcut = async function() {
            const label = document.getElementById('shortcut-input-label').value.trim();
            const url = document.getElementById('shortcut-input-url').value.trim();
            const order = parseInt(document.getElementById('shortcut-input-order').value) || 0;
            if (!label || !url) return alert('이름과 URL을 입력해주세요.');
            if (editingShortcutScope === 'personal') {
                const personalShortcuts = loadPersonalShortcuts();
                const id = editingShortcutId || `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                personalShortcuts[id] = { label, url, order };
                savePersonalShortcuts(personalShortcuts);
                closeShortcutModal();
                renderShortcuts();
                return;
            }
            if (!canManageShortcuts) return;
            try {
                if (editingShortcutId) await update(ref(db, `dashboard/shortcuts/${editingShortcutId}`), { label, url, order });
                else await push(ref(db, 'dashboard/shortcuts'), { label, url, order, createdAt: Date.now() });
                closeShortcutModal();
            } catch (e) { alert('바로가기 저장 중 오류가 발생했습니다.'); }
        }

        window.deleteShortcutFromModal = async function() {
            if (!editingShortcutId) return;
            if (editingShortcutScope === 'personal') {
                if (!confirm('이 바로가기를 삭제하시겠습니까?')) return;
                const personalShortcuts = loadPersonalShortcuts();
                delete personalShortcuts[editingShortcutId];
                savePersonalShortcuts(personalShortcuts);
                closeShortcutModal();
                renderShortcuts();
                return;
            }
            if (!canManageShortcuts) return;
            if (confirm('이 바로가기를 삭제하시겠습니까?')) {
                try { await remove(ref(db, `dashboard/shortcuts/${editingShortcutId}`)); closeShortcutModal(); }
                catch (e) { alert('삭제 중 오류가 발생했습니다.'); }
            }
        }

        // ---  프로필 & 관리자 시스템 ---
        function listenToProfiles() {
            onSnapshot(collection(fdb, 'profiles'), (snap) => {
                profilesData = fsSnapshotToMap(snap);
                syncOwnXpMirror();
                syncOwnStreakMirror();
                syncOwnNicknameMirror();
                const gridEl = document.getElementById('profile-card-grid'); 
                if(gridEl) gridEl.innerHTML = '';
                for(let i = 1; i <= 26; i++) {
                    const sData = profilesData[`student_${i}`] || {};
                    const displayName = isRestrictedViewer ? (FIXED_PROFILE_ROSTER[i] || `${i}번`) : (sData.name || '미등록');
                    const thumbPhoto = isRestrictedViewer ? 'data:image/svg+xml;utf8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27150%27 height=%27150%27%3E%3Crect width=%27150%27 height=%27150%27 fill=%27%23e5e7eb%27/%3E%3C/svg%3E' : (sData.photo || 'data:image/svg+xml;utf8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27150%27 height=%27150%27%3E%3Crect width=%27150%27 height=%27150%27 fill=%27%23e5e7eb%27/%3E%3C/svg%3E');
                    const appearance = getStudentAppearance(i, sData);
                    const nameHtml = renderStyledName(displayName, appearance);
                    const levelLine = `<div class="profile-thumb-level" style="color:var(--primary);">Lv.${appearance.level} · ${appearance.title}</div>`;
                    const isOn = typeof isNumberOnline === 'function' && isNumberOnline(i);
                    const avatarHtml = renderProfileAvatarHTML(appearance, thumbPhoto, isOn, false);
                    const card = document.createElement('div'); 
                    card.className = 'profile-thumb-card'; 
                    card.setAttribute('data-num', i);
                    card.onclick = () => openProfileModal(i);
                    
                    // 20번 학생 스페셜 UI
                    if(i === 20) {
                        card.style.border = "2px solid #eab308";
                        card.style.backgroundColor = "#fef9c3";
                        card.innerHTML = `${avatarHtml}<div class="profile-thumb-info" style="color:#a16207;">${i}번</div><div class="profile-thumb-name">👑 ${nameHtml}</div>${levelLine}<div style="font-size:10px; color:#ca8a04; font-weight:bold; margin-top:4px;">커뮤니티 창시자</div>`;
                    } else {
                        card.innerHTML = `${avatarHtml}<div class="profile-thumb-info">${i}번</div><div class="profile-thumb-name">${nameHtml}</div>${levelLine}`;
                    }
                    if(gridEl) gridEl.appendChild(card);
                }
                // 학생 프로필 이름이 바뀔 수 있으므로, 번호 기반으로 이름을 보여주는 스쿼드/자리배치 화면도 함께 다시 그린다
                renderSquadPitch();
                renderSeatingGrid();
                refreshAuthorViews();
            });
        }

        window.openProfileModal = function(num) {
            activeStudentNum = num;
            document.getElementById('profile-modal').style.display = 'flex';
            document.getElementById('modal-title-num').innerText = `${num}번 학생 프로필 상세 관리`;

            // 담임선생님 & 타반 학생: 기본 사진만 보여주고, 사진 변경/한줄 설명/실시간 댓글은 비공개 처리
            const editPhotoBtn = document.getElementById('btn-edit-photo');
            const descInput = document.getElementById('modal-desc-input');
            const saveBtn = document.getElementById('btn-save-profile');
            const hr = document.getElementById('profile-modal-hr');
            const commentSection = document.getElementById('profile-comment-section');
            if (editPhotoBtn) editPhotoBtn.style.display = isRestrictedViewer ? 'none' : '';
            if (descInput) descInput.style.display = isRestrictedViewer ? 'none' : '';
            if (saveBtn) saveBtn.style.display = isRestrictedViewer ? 'none' : '';
            if (hr) hr.style.display = isRestrictedViewer ? 'none' : '';
            if (commentSection) commentSection.style.display = isRestrictedViewer ? 'none' : '';

            onSnapshot(doc(fdb, 'profiles', `student_${num}`), (snap) => {
                const sData = snap.exists() ? snap.data() : {};
                document.getElementById('modal-img').src = isRestrictedViewer ? 'data:image/svg+xml;utf8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27150%27 height=%27150%27%3E%3Crect width=%27150%27 height=%27150%27 fill=%27%23e5e7eb%27/%3E%3C/svg%3E' : (sData.photo || 'data:image/svg+xml;utf8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27150%27 height=%27150%27%3E%3Crect width=%27150%27 height=%27150%27 fill=%27%23e5e7eb%27/%3E%3C/svg%3E');
                const appearance = getStudentAppearance(num, sData);
                document.getElementById('modal-level-line').textContent = `Lv.${appearance.level} · ${appearance.title}`;
                const nameInput = document.getElementById('modal-name-input');
                if (isRestrictedViewer) {
                    nameInput.value = FIXED_PROFILE_ROSTER[num] || `${num}번`;
                    nameInput.disabled = true;
                    nameInput.title = "이름은 반 고정 명단으로 표시되어 수정할 수 없습니다.";
                } else {
                    nameInput.value = sData.name || '';
                    nameInput.disabled = false;
                    nameInput.title = "";
                }
                document.getElementById('modal-desc-input').value = sData.desc || '';
            }, { onlyOnce: true });

            // 최고 관리자 전용 컨트롤 (부관리자 임명)
            const adminControls = document.getElementById('admin-controls');
            if (isAdmin) {
                const targetIsSub = !!subAdminsList[`student_${num}`];
                adminControls.style.display = 'block';
                adminControls.innerHTML = `<button onclick="toggleSubAdmin(${num}, ${!targetIsSub})" class="btn-sub" style="width:100%; color:white; background:${targetIsSub ? '#ef4444' : '#3b82f6'}; border:none; padding: 10px; margin-top:5px; font-weight:700;">${targetIsSub ? '🛡️ 관리자 권한 해제하기' : '🛡️ 관리자로 임명하기'}</button>`;
            } else { adminControls.style.display = 'none'; }

            if (!isRestrictedViewer) listenToProfileComments(num);
        }

        // 🥚 이스터에그: 학생 프로필 상세 관리 모달의 사진을 클릭하면 그 학생의 XP가 1씩 오른다.
        // presenceData(번호 -> uid 매핑, 한 번이라도 로그인한 학생이면 존재)로 uid를 찾아서
        // users/{uid}/xp의 진짜 원본 값을 직접 1 증가시킨다 (profiles/student_N.xp는 그 학생
        // 본인 로그인 시 자동으로 다시 미러링되는 값이라 여기서 건드려도 곧 원래대로 덮어써진다).
        window.easterEggBumpProfileXP = async function() {
            if (!currentUser) return showLoginScreen(() => easterEggBumpProfileXP());
            const num = activeStudentNum;
            if (num == null) return;
            const uid = Object.keys(presenceData).find(id => presenceData[id] && String(presenceData[id].number) === String(num));
            if (!uid) return; // 한 번도 로그인한 적 없는 학생은 uid를 알 방법이 없어 조용히 무시한다
            try {
                await runTransaction(ref(db, `users/${uid}/xp`), (current) => (typeof current === 'number' ? current : 0) + 1);
            } catch (e) {
                console.warn('이스터에그 XP 증가 실패(권한 등):', e);
            }
        };

        window.toggleSubAdmin = async function(num, makeSub) {
            if (!isAdmin) return alert("최고 관리자만 가능한 기능입니다.");
            try {
                if (makeSub) { await setDoc(doc(fdb, 'sub_admins', `student_${num}`), { active: true }); alert(`${num}번 학생을 관리자로 임명했습니다!`); } 
                else { await deleteDoc(doc(fdb, 'sub_admins', `student_${num}`)); alert(`${num}번 학생의 관리자 권한을 해제했습니다.`); }
                openProfileModal(num); 
            } catch(e) { alert("권한 변경 실패"); }
        }

        window.closeProfileModal = function() { document.getElementById('profile-modal').style.display = 'none'; activeStudentNum = null; }

        // 프로필 사진도 커뮤니티/공지 이미지와 같은 곳(freeimage.host, Edge Function 경유)으로 통합했다.
        window.uploadProfileImage = async function() {
            if (isRestrictedViewer) return;
            if (!currentUser) return showLoginScreen();
            const file = document.getElementById('modal-file-input').files[0]; if(!file) return;
            const btn = document.getElementById('btn-edit-photo'); btn.innerText = "업로드 중...⏳";
            try {
                const url = await uploadImageToFreeImageHost(file);
                document.getElementById('modal-img').src = url;
                alert("저장 버튼을 눌러야 영구 보관됩니다.");
            } catch(e) { console.error('프로필 사진 업로드 오류:', e); alert(e.message && e.message.includes('60MB') ? e.message : "업로드에 실패했습니다."); } finally { btn.innerText = "사진 변경"; }
        }

        window.saveProfileData = async function() {
            if(!activeStudentNum) return;
            if (isRestrictedViewer) return; // 담임선생님 & 타반 학생은 열람만 가능
            try {
                const payload = {
                    desc: document.getElementById('modal-desc-input').value.trim(),
                    photo: document.getElementById('modal-img').src
                };
                payload.name = document.getElementById('modal-name-input').value.trim();
                await writeOwnProfileDoc(activeStudentNum, payload);
                alert(`저장 완료`);
            } catch(e) {}
        }

        // profile_comments는 평탄화된 컬렉션이라 문서 ID가 "{studentKey}__{commentId}" 형태다.
        // studentKey로 필터링해서 그 학생의 댓글만 조회한다.
        function listenToProfileComments(num) {
            const studentKey = `student_${num}`;
            onSnapshot(query(collection(fdb, 'profile_comments'), where('studentKey', '==', studentKey)), (snap) => {
                const listEl = document.getElementById('modal-comments-list'); 
                listEl.innerHTML = '';
                const entries = snap.docs.map(d => [d.data().commentId, d.data()]).sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0));
                if(entries.length === 0) return listEl.innerHTML = `<div style="text-align:center; color:var(--text-muted); font-size:12px; padding:12px;">아직 작성된 메시지가 없습니다.</div>`;
                
                const SPECIAL_EMAIL = "20261230@hanilgo.cnehs.kr";

                entries.forEach(([key, item]) => {
                    const isMyComment = currentUser && currentUser.uid === item.authorId;
                    const canDelete = isMyComment || isAdmin || isSubAdmin;
                    
                    const isGodComment = (item.authorOriginal && item.authorOriginal.includes(SPECIAL_EMAIL));
                    const profileCommentDisplayName = resolveDisplayName(item.author, item.authorOriginal);
                    const profileCommentStyledName = renderStyledName(profileCommentDisplayName, appearanceForAuthorOriginal(item.authorOriginal), null, escapeNoticeText);
                    let cAuthor = (isAdmin || isSubAdmin) && item.authorOriginal ? `${profileCommentStyledName} <span style="color:#ef4444; font-size:10px;">[${adminOriginalTag(item.authorOriginal)}]</span>` : profileCommentStyledName;
                    if (isGodComment) {
                        cAuthor = `<span class="god-mode-text">👑 ${item.author}</span>`; // 기존 특수효과 - 그대로 유지
                    }

                    listEl.innerHTML += `
                        <div class="profile-comment-item">
                            <div class="profile-comment-content">
                                <div class="profile-comment-author">${cAuthor}</div>
                                <div class="profile-comment-text">${item.text}</div>
                            </div>
                            ${canDelete ? `<span onclick="deleteProfileComment('${key}')" style="color:#ef4444; cursor:pointer; font-size:12px; font-weight:bold; padding-left:10px;">삭제</span>` : ''}
                        </div>
                    `;
                });
            });
        }

        window.addProfileComment = async function() {
            if(!activeStudentNum) return;
            if (!currentUser) return showLoginScreen(() => addProfileComment());
            const input = document.getElementById('profile-comment-input');
            if(!input.value.trim()) return;
            try {
                const studentKey = `student_${activeStudentNum}`;
                const commentId = doc(collection(fdb, 'profile_comments')).id; // RTDB push ID 대신 Firestore 자동 ID를 commentId로 사용
                await setDoc(doc(fdb, 'profile_comments', `${studentKey}__${commentId}`), {
                    studentKey, commentId,
                    authorId: currentUser.uid, 
                    author: getAuthorName(), 
                    authorOriginal: currentUser.email,
                    text: input.value.trim(), 
                    timestamp: Date.now()
                });
                input.value = '';
            } catch(e) {}
        }

        window.deleteProfileComment = async function(commentId) {
            if(!activeStudentNum) return;
            if(confirm("이 댓글을 삭제 처리 할까요?")) await deleteDoc(doc(fdb, 'profile_comments', `student_${activeStudentNum}__${commentId}`));
        }
    