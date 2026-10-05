# 1-2comunity

한일고 1학년 2반 학급 커뮤니티 (정적 사이트: `index.html` 한 파일 + `assets/`).

* **앱스토어**: HTML/ZIP 웹앱을 올려 `/app/<id>` 로 게시·실행·다운로드 → 설정과 구조는 [`docs/appstore.md`](docs/appstore.md)
* **플래너 사진 읽기(베타)**: 사용 방법과 한계는 [`docs/planner-photo.md`](docs/planner-photo.md)
* Supabase: `supabase/migrations/`(DB·Storage 설정 SQL), `supabase/functions/`(Edge Functions)

## 플래너 스타일(Tailwind) 다시 빌드하기

플래너 화면은 Tailwind 유틸리티 클래스를 쓰지만, 접속할 때마다 CDN 에서 받아 컴파일하면 첫 화면이 느려져서 **미리 빌드한 `css/tailwind.css`** 를 쓴다.
플래너(`index.html`, `js/*.js`)에 새 Tailwind 클래스를 추가했다면 아래로 다시 만들고 `css/tailwind.css` 를 같이 커밋한다. (호스팅 쪽 빌드 명령은 필요 없다.)

```
cd tools/tailwind && npm install && npm run build
```
