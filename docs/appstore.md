# 앱스토어 (웹앱 게시·실행) 설정과 구조

사용자가 `.html` 파일 하나(또는 여러 파일을 담은 `.zip`)를 올리면 이 사이트에서 바로 게시되고, 누구나 `/app/<고유ID>` 주소에서 실행·다운로드할 수 있다.
앱을 수정(새 파일로 교체)해도 주소는 바뀌지 않는다.

## 구성 요소

| 구성 | 위치 | 역할 |
| --- | --- | --- |
| 화면/로직 | `index.html` 의 `#tab-appstore`, `<script type="module" id="appstore-module">` | 목록·상세·등록/수정 폼·실행(sandbox)·다운로드·`/app/<id>` 라우팅 |
| DB/Storage | `supabase/migrations/20261002_appstore.sql` | `apps`, `app_versions` 테이블 + RLS, 조회수 RPC, `webapps` 버킷 |
| 쓰기 서버 | `supabase/functions/apps-write/index.ts` | 앱 등록/수정/삭제/내 앱 목록 (Firebase 토큰 검증 + 소유권 확인) |
| 주소 재작성 | `_redirects`(Netlify), `404.html`(안전장치) | `/app/<id>` 가 어떤 호스팅에서도 같은 화면으로 열리게 함 |

## 왜 Edge Function 인가 (RLS 관련)

이 사이트의 로그인은 **Firebase Auth** 라서 Supabase 의 `auth.uid()` 로는 작성자를 알 수 없다. 기존 자료실/음악과 같은 방식으로:

* **읽기**: RLS 로 `published = true` 인 앱만 누구나(anon) 조회.
* **쓰기**: `apps`/`app_versions` 에는 INSERT/UPDATE/DELETE 정책이 없고 권한도 회수(REVOKE)되어 클라이언트 직접 쓰기는 전부 거부된다.
  `apps-write` 함수가 Firebase ID 토큰을 서버에서 검증하고(이메일 없는 게스트는 거부), DB 의 `author_uid` 와 비교해 **본인 앱일 때만** `service_role` 키로 쓴다.
* **파일**: `webapps` 버킷은 공개 읽기(앱 실행/다운로드에 로그인이 필요 없어야 하므로). 업로드는 함수가 발급하는 **서명된 업로드 URL** 로만 가능(anon INSERT 정책 없음).

업로드 흐름: `prepare`(검사 후 토큰 발급, 등록이면 "등록 중" 임시 행으로 ID 를 작성자에게 묶음) → 브라우저가 Storage 로 직접 업로드 → `commit`(올라간 파일의 경로/크기/ZIP 시그니처를 서버가 다시 확인한 뒤 DB 반영).

## 실행 격리(보안)

업로드된 HTML/JS 는 이 사이트와 같은 출처에서 **절대** 실행되지 않는다.

* `<iframe sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads" srcdoc=...>` — **`allow-same-origin` 과 `allow-top-navigation` 이 없다.**
  앱은 고유하지 않은(opaque, `null`) 출처가 되어 부모 DOM, 이 사이트의 localStorage/쿠키, Firebase·Supabase 토큰, 로그인 세션, 관리자 화면에 접근할 수 없고 사이트 주소를 바꿔치기할 수도 없다.
* sandbox 안에서는 `localStorage` 가 막히므로, 앱 안에 **대용품(shim)** 을 넣어 주고 내용은 부모가 `postMessage` 로 받아 **앱·계정별 키**(`gmw_appdata:<앱ID>:<uid|guest>`)에 저장한다(앱당 512KB, 전체 2MB 제한, 메시지 출처/앱 ID 검증).
* ZIP 은 서버가 아니라 **브라우저 메모리에서만** 푼다(외부 라이브러리 없이 직접 파싱). 절대 경로·`../`·역슬래시 경로가 하나라도 있으면 ZIP 전체를 거부, 파일 400개·파일당 15MB·압축 해제 합계 30MB·비정상 압축률(압축 폭탄) 제한, 암호 ZIP/ZIP64 거부, `index.html`(최상위 또는 하나뿐인 폴더 안) 필수.
  푼 파일은 **data URL 로 인라인**해서 실행한다(sandbox 의 opaque 출처에서는 부모가 만든 blob URL 을 읽을 수 없기 때문). `fetch()`/`XMLHttpRequest`/`new Audio()`/`img.src = ...` 같은 동적 상대 경로는 shim 이 ZIP 안 파일로 연결한다.
* 앱 파일 제한: HTML 5MB, ZIP 20MB, 아이콘 1MB(PNG/JPG/WEBP/GIF — SVG 는 스크립트를 담을 수 있어 불허), 사용자당 앱 50개. 서버(`apps-write`)와 버킷(`file_size_limit`, `allowed_mime_types`)이 같은 제한을 다시 검사한다.

### 큰 앱: 외부 링크(Netlify 등)로 등록
HTML 5MB / ZIP 20MB 를 넘어 올릴 수 없는 앱은 **"🌐 외부 링크만"** 방식으로 등록한다. 파일은 올리지 않고 제작자가 Netlify 등에 직접 배포한 `https://` 주소만 건다(`file_type='link'`, `file_path='external'`).
* 앱스토어 안에서의 실행·다운로드는 없고, 상세 화면의 **"외부 링크로 열기"**(새 탭, `noopener noreferrer nofollow`)로만 연결한다. `/app/<id>/run` 으로 들어와도 상세 화면으로 돌려보낸다.
* 파일을 올린 앱에도 **선택 항목**으로 외부 공유 링크를 덧붙일 수 있다(`apps.external_url`). 이 경우 실행/다운로드 버튼과 외부 링크 버튼이 같이 보인다.
* 외부 링크는 서버(`apps-write`)와 화면이 같은 규칙으로 검사한다: `https` 만, 아이디/비밀번호 포함 금지, `localhost`/IP/내부 주소 금지, 500자 이하. DB 에도 `https://` 로 시작하는지 CHECK 제약이 있다.
* 외부 사이트는 앱스토어의 sandbox 보호가 적용되지 않으므로 상세 화면에 경고 문구와 도메인을 함께 보여준다.
* 이미 마이그레이션을 실행했다면 `20261002_appstore.sql` 을 **다시 실행**하고(idempotent) `apps-write` 함수를 **다시 배포**해야 한다.

### 알려진 제한 (앱이 지원하지 않는 것)

IndexedDB·쿠키, Web Worker/Service Worker, ES 모듈 `import`(상대 경로), 여러 HTML 페이지 사이 이동(`<a href="page2.html">`; `#해시` 기반 단일 페이지 앱은 가능),
JS 로 만든 `style.backgroundImage = "url(x.png)"` 같은 문자열 안의 상대 경로. 카메라/마이크 권한은 주지 않는다.

## 설정 (한 번만)

### 1) Supabase (자료실용 프로젝트 `cryeosgmuxqyphntqqlc`)

1. 대시보드 → **SQL Editor** → `supabase/migrations/20261002_appstore.sql` 전체를 붙여넣고 **Run** (여러 번 실행해도 안전).
2. 터미널에서 Edge Function 배포 (Supabase CLI):
   ```bash
   supabase login
   supabase link --project-ref cryeosgmuxqyphntqqlc
   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service_role 키>   # upload-material/edit-material 때 이미 등록했다면 생략
   supabase functions deploy apps-write --no-verify-jwt
   ```
   (대시보드에서 하려면 Edge Functions → New Function → 이름 `apps-write` → `supabase/functions/apps-write/index.ts` 내용 붙여넣기 → **Verify JWT 끄기** → Deploy, Secrets 에 `SUPABASE_SERVICE_ROLE_KEY`.)
3. Storage 에 `webapps` 버킷이 생겼는지, **Public** 이고 크기 제한이 20MB 인지 확인.

### 2) Render (Static Site `one-2comunity-test`)

`/app/<id>` 는 실제 파일이 아니라 앱 화면(`index.html`)으로 보여줘야 한다. **Dashboard → 해당 Static Site → Redirects/Rewrites → Add Rule**
* Source: `/app/*`  · Destination: `/index.html`  · Action: **Rewrite**

(이 규칙이 없어도 `404.html` 안전장치가 `/?gmw_route=/app/<id>` 로 보내 주소를 복원하므로 동작은 하지만, 첫 방문에서 한 번 더 이동하고 일부 환경에서는 404 상태 코드가 남는다. 규칙을 넣는 것을 권장한다.)
환경 변수는 따로 필요 없다(이 사이트는 빌드 없는 정적 사이트).
Netlify 는 저장소의 `_redirects` 가 이미 같은 규칙이다.

### 3) 추천 앱 지정 / 운영(SQL)

```sql
update public.apps set featured = true  where id = '<앱ID>';   -- 앱스토어 "추천 앱"에 노출
update public.apps set published = false where id = '<앱ID>';  -- 문제 있는 앱을 목록/주소에서 숨김
delete from public.apps where id = '<앱ID>';                   -- 완전 삭제(버전 이력도 함께; Storage 파일은 apps-write delete 또는 대시보드에서)
```

## 직접 테스트하는 방법

1. **회원가입 → 로그인**: 사이트에서 가입(또는 기존 계정으로 로그인).
2. 사이드바(또는 모바일 하단) **🧩 앱스토어** → 오른쪽 위 **＋ 앱 등록**.
3. 이름/설명/카테고리/버전 입력, 아이콘(선택), **HTML 파일 선택**(예: 아래 샘플) → **게시하기**.
   ```html
   <!doctype html><meta charset="utf-8"><title>테스트</title>
   <h1>안녕!</h1><button onclick="n.textContent=++c; localStorage.setItem('c', c)">+1</button> <span id="n"></span>
   <script>var c = +localStorage.getItem('c') || 0; n.textContent = c;</script>
   ```
4. 게시되면 `/app/<고유ID>` 상세 페이지로 이동 → 앱스토어 목록에도 카드가 보이는지 확인.
5. **▶ 웹에서 실행** → 앱이 실행되고 버튼을 눌러 값이 유지되는지 확인(새로고침해도 유지).
6. **다른 브라우저(또는 시크릿 창, 로그인 안 한 상태)** 에서 같은 `/app/<고유ID>` 주소를 열어 실행되는지 확인(수정 버튼은 보이지 않아야 함).
7. 내 계정에서 **✏️ 수정** → HTML 파일을 새 것으로 교체, 버전 `1.1.0`, 업데이트 내용 입력 → 저장.
8. 같은 `/app/<고유ID>` 주소를 새로고침 → **새 버전이 실행**되고 주소는 그대로인지, 상세의 "업데이트 기록"에 두 버전이 보이는지 확인.
9. 상세의 **⬇ HTML 다운로드**(ZIP 앱이면 ZIP 다운로드) → 파일이 내려받아지는지 확인.
10. (ZIP) `index.html` + `style.css` + `script.js` + `assets/` 를 압축해 같은 방식으로 등록 → 실행 확인. 일부러 `../x.html` 이 든 ZIP 이나 `index.html` 이 없는 ZIP 을 올리면 거부 메시지가 나와야 한다.
