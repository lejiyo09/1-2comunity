# 1-2comunity

한일고 1학년 2반 학급 커뮤니티 (정적 사이트: `index.html` 한 파일 + `assets/`).

* **앱스토어**: HTML/ZIP 웹앱을 올려 `/app/<id>` 로 게시·실행·다운로드 → 설정과 구조는 [`docs/appstore.md`](docs/appstore.md)
* **플래너 사진 읽기(베타)**: 사용 방법과 한계는 [`docs/planner-photo.md`](docs/planner-photo.md)
* Supabase: `supabase/migrations/`(DB·Storage 설정 SQL), `supabase/functions/`(Edge Functions)

## 코드 수정 · 배포용 파일 만들기 (꼭 읽어 주세요)

사이트가 실제로 내려받는 `js/`, `css/` 는 **공백·주석을 지운 배포용 파일**이라 읽기 어렵다. 사람이 읽고 고치는 **원본은 `src/js/`, `src/css/`** 에 있다.

* 코드를 고친 뒤에는 반드시 아래를 실행하고, `src/` 와 `js/`·`css/` 를 **같이 커밋**한다. (Render/Netlify 에는 빌드 명령이 필요 없다.)
  ```
  cd tools/build && npm install && npm run build
  ```
* 변환은 공백/주석 제거와 문법 줄이기뿐이고, 변수·함수 이름은 바꾸지 않는다(HTML 의 `onclick="…"` 이름 참조가 그대로 동작).
* `npm run check` 로 배포용 파일이 원본과 맞는지 확인할 수 있다(다르면 오류).
* 빌드는 앱 파일 내용으로 **앱 버전**을 계산해 `sw.js` 의 `APP_VERSION` 과 `index.html` 의 `<meta name="app-version">` 에 넣는다. 배포 뒤 이 값이 바뀌면, 사이트를 열어 둔 사람에게 "새 버전이 준비되었습니다 [업데이트]" 알림이 뜬다(`src/js/app-update.js`). 그래서 `index.html` 만 고쳤더라도 빌드를 돌려서 커밋해야 알림이 뜬다.
* 플래너 화면의 Tailwind 클래스는 CDN 대신 미리 빌드한 `css/tailwind.css` 를 쓴다. 플래너(`index.html`, `src/js/*.js`)에 새 Tailwind 클래스를 추가했다면 위 빌드가 이 파일도 다시 만든다.

## Firestore 보안 규칙

현재 Firebase 콘솔에 게시된 Firestore 규칙의 원본은 **[`docs/firestore.rules`](docs/firestore.rules)** 다.
규칙을 바꿀 때는 이 파일을 고친 뒤, 파일 전체를 Firebase 콘솔 → Firestore → 규칙에 붙여 넣어 게시한다.
앱이 새 Firestore 컬렉션을 쓰기 시작하면 여기에도 `match` 블록을 추가해야 한다(없으면 `permission-denied`).

## 오프라인에서 첫 화면이 열리는지 시험하기

`sw.js` 는 앱 파일뿐 아니라 앱이 불러오는 Firebase·Supabase 모듈(외부 서버)도 저장해 두어서, 한 번이라도 온라인으로 열어 본 기기는 오프라인에서도 앱이 시작된다.
고쳤다면 `cd tools/tests && npm install && npm test` (Chromium 필요, 경로는 `CHROMIUM_PATH`)로 확인한다.
`node offline_sw_test.mjs old <커밋>` 은 그 커밋의 `sw.js` 로 같은 시험을 해서 **실패해야 정상**이다(시험이 문제를 재현하는지 확인).

## 기능 시험 (가짜 Firebase)

`tools/tests/harness.mjs` 는 실제 `index.html` 과 `js/`·`css/` 를 열고 Firebase(Auth/RTDB/Firestore)·Supabase 를 메모리 안의 가짜로 바꿔서, 인터넷 없이 로그인/게스트 화면을 시험하게 해 준다.
새 시험은 `bootApp({ userData, uid, userEmail, guest, noAuth, rtdb, fsData, rtdbDeny, fsDeny })` 로 시작한다(`tools/tests/notice_comments_test.mjs` 참고).
