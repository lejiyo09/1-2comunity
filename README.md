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
* 플래너 화면의 Tailwind 클래스는 CDN 대신 미리 빌드한 `css/tailwind.css` 를 쓴다. 플래너(`index.html`, `src/js/*.js`)에 새 Tailwind 클래스를 추가했다면 위 빌드가 이 파일도 다시 만든다.
