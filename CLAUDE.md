# 작업 메모 (Claude 용)

- **버전 번호**: 설정 창 맨 아래 `ver X.Y.Z` (`index.html`). 규칙은 (큰 변화).(기능 추가·변경).(버그 수정).
  앱을 고칠 때마다 다음 번호를 예측해서 사용자에게 "이 번호가 맞아?" 하고 확인받은 뒤 올린다.
  문서·테스트만 바뀌고 앱 동작이 그대로면 올리지 않는다.
- **Firestore 규칙**: 원본은 `docs/firestore.rules` (콘솔에 게시된 최종본). 규칙 변경이 필요하면 따로 말이 없어도
  이 파일을 고치고, 바뀐 전체 규칙을 사용자에게 주면서 콘솔에 붙여 넣어 게시해 달라고 한다.
  새 Firestore 컬렉션을 쓰는 기능을 만들면 반드시 이 파일에 규칙을 추가한다.
- **빌드**: 원본은 `src/js`, `src/css`. 고친 뒤 `cd tools/build && npm run build` 로 `js/`, `css/`, 앱 버전 해시(sw.js·index.html)를 만들어 같이 커밋한다. `npm run check` 로 확인.
- **시험**: `cd tools/tests && npm test` (가짜 Firebase 하네스 `harness.mjs`).
