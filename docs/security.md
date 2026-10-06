# 보안 · API 키 정리

## 먼저 알아둘 점: "브라우저에서 키를 숨기는 것"은 불가능하다

이 사이트는 서버 없이 브라우저에서 도는 정적 사이트다. 브라우저로 내려보낸 코드와 값은 개발자도구로 누구나 볼 수 있다. 그래서 키는 두 종류로 나뉜다.

| 종류 | 예 | 숨겨야 하나? | 어떻게 지키나 |
|---|---|---|---|
| **공개 식별자** (원래 공개용) | Firebase `apiKey`, Supabase `publishable(anon)` 키 | 숨길 수 없고 숨길 필요도 없음 | **서버 규칙**이 보호: Firebase 보안 규칙, Supabase RLS, Edge Function 의 토큰 검증 (+ 아래 권장 설정) |
| **비밀 키** (호출 한도/비용/권한이 걸림) | 날씨, NEIS, 이미지 호스팅, `service_role` | **반드시 서버에만** | Supabase Edge Function 의 **Secrets** 에 두고, 브라우저는 그 함수를 부른다 |

이번 정리로 **비밀 키는 전부 브라우저/저장소 코드에서 제거**했다. 남은 것은 공개 식별자뿐이고 `src/js/config.js`(배포용은 `js/config.js`) 한 곳에 모아 두었다.

## 무엇이 어디로 옮겨졌나

| 키 | 예전 | 지금 |
|---|---|---|
| weatherapi.com 키 | `index.html` 안에 그대로 | Supabase Secret `WEATHER_API_KEY` (함수 `api-proxy`) |
| NEIS 인증키 | `index.html` 안에 그대로 | Supabase Secret `NEIS_API_KEY` (함수 `api-proxy`) |
| imgbb 키 | `index.html` 안에 2곳 | **삭제** (자료실 추억 이미지도 기존 `upload-freeimage` 로 업로드) |
| freeimage.host 키 | `upload-freeimage` 코드 기본값 + 주석 | Supabase Secret `FREEIMAGE_API_KEY` 만 사용 (코드에 기본값 없음) |
| `service_role` | (원래 서버 전용) | 그대로. Supabase 가 Edge Function 에 자동 주입하며 브라우저에는 절대 없음 |

`api-proxy` 는 허용한 서비스·경로·파라미터만 통과시키고(화이트리스트), 같은 요청은 서버 메모리에 잠깐 캐시하고(날씨 10분, NEIS 30분), IP 당 10분 90회로 제한하며, 업스트림 오류에 키가 섞여 나가지 않게 한다. 날씨는 학교 위치로 고정, NEIS 는 우리 학교 코드만 허용한다.

## ⚠️ 꼭 해야 하는 일 (순서가 중요하다)

예전에 저장소(git 기록)에 올라간 키는 **이미 노출된 것으로 보고 새 키로 바꿔야** 한다. 코드에서 지워도 git 기록에는 남아 있기 때문이다. (저장소가 공개라면 특히.)

1. **키 새로 발급(회전)** — 각 서비스에서 새 키를 만들고 예전 키는 폐기한다.
   * weatherapi.com: 대시보드 → API Key 재생성
   * NEIS Open API: 인증키 재발급(또는 신청 정보에서 재생성)
   * freeimage.host: API 키 재발급
   * imgbb: 이제 쓰지 않으므로 계정에서 API 키 폐기/삭제
2. **Supabase Secrets 등록** (프로젝트 `cryeosgmuxqyphntqqlc`)
   ```bash
   supabase secrets set WEATHER_API_KEY=<새 날씨 키> NEIS_API_KEY=<새 NEIS 키> FREEIMAGE_API_KEY=<새 freeimage 키>
   # (선택) 이 사이트 주소에서 온 브라우저 요청만 허용:
   supabase secrets set ALLOWED_ORIGINS=https://one-2comunity-test.onrender.com
   ```
   `SUPABASE_` 로 시작하는 이름은 직접 등록할 수 없다(자동 주입되는 값이다).
3. **Edge Function 배포** — 둘 다 `--no-verify-jwt` (로그인 토큰은 함수 안에서 검증하거나 공개 데이터라 필요 없음)
   ```bash
   supabase functions deploy api-proxy --no-verify-jwt
   supabase functions deploy upload-freeimage --no-verify-jwt     # 코드에서 기본 키를 없앴으니 다시 배포
   ```
   대시보드로 하려면 Edge Functions → 함수 선택/New Function → 코드 붙여넣기 → Verify JWT 끄기 → Deploy, Secrets 는 Edge Functions → Secrets.
4. **그 다음에** 사이트(Render)를 배포한다.
   * 사이트를 **먼저** 배포하면 날씨와 학사일정이 `api-proxy` 가 준비될 때까지 잠깐 안 나온다(마지막으로 받은 값이 있으면 캐시로 표시). 급식은 키 없이 호출해서 영향이 없다.
   * `upload-freeimage` 는 새 키를 Secret 에 넣기 전에 재배포하면 이미지 업로드가 "서버 설정이 안 되어 있어요"로 실패한다. (2번 → 3번 순서)

### 주소만 열어서 바로 확인하기 (콘솔 오류 읽는 법)
브라우저 주소창에 `https://<프로젝트>.supabase.co/functions/v1/api-proxy?service=weather` 를 열어 본다. (이 앱은 `js/config.js` 의 `SUPABASE_URL` 프로젝트를 쓴다.)

| 보이는 것 | 뜻 | 할 일 |
|---|---|---|
| 날씨 JSON (`"current": ...`) | 정상 | 없음 |
| `404` / `NOT_FOUND` / `Requested function was not found` | **그 프로젝트에 `api-proxy` 함수가 없음** (다른 프로젝트에 배포했거나 아직 배포 전, 함수 이름 오타) | 위 3번을 **같은 프로젝트**에 하기 |
| `503` + "서버 설정(WEATHER_API_KEY)이 아직 안 되어 있어요" | 함수는 있는데 시크릿이 없음 | 위 2번 |
| `502` + "외부 서비스 오류" | 키가 틀렸거나 외부 서비스 문제 | 키 값 확인 |

### 주소만 열어서 바로 확인하기 (콘솔 오류 읽는 법)
브라우저 주소창에 `https://<프로젝트>.supabase.co/functions/v1/api-proxy?service=weather` 를 열어 본다. (이 앱은 `js/config.js` 의 `SUPABASE_URL` 프로젝트를 쓴다.)

| 보이는 것 | 뜻 | 할 일 |
|---|---|---|
| 날씨 JSON (`"current": ...`) | 정상 | 없음 |
| `404` / `NOT_FOUND` / `Requested function was not found` | **그 프로젝트에 `api-proxy` 함수가 없음** (다른 프로젝트에 배포했거나 아직 배포 전, 함수 이름 오타) | 위 3번을 **같은 프로젝트**에 하기 |
| `503` + "서버 설정(WEATHER_API_KEY)이 아직 안 되어 있어요" | 함수는 있는데 시크릿이 없음 | 위 2번 |
| `502` + "외부 서비스 오류" | 키가 틀렸거나 외부 서비스 문제 | 키 값 확인 |

### 배포 후 확인
* 홈의 날씨 위젯이 나오는지, 브라우저 개발자도구 → Network 에서 `api-proxy?service=weather` 요청이 보이고 요청 주소에 `key=` 가 **없는지**.
* 이미지를 올리는 글쓰기/자료 등록이 되는지.
* `view-source` 로 `js/` 파일들에서 `weatherapi`, `NEIS`, `imgbb` 키 문자열이 없는지.

## 공개 식별자를 더 안전하게 쓰는 설정 (콘솔에서 하는 일)

코드로는 할 수 없고 각 콘솔에서 설정해야 한다. 이 저장소에는 Firebase/Supabase 의 규칙 파일이 없어서 **규칙 내용은 직접 확인하지 못했다** — 아래 체크리스트로 점검해 달라.

### Firebase
* **API 키 제한** — Google Cloud 콘솔 → API 및 서비스 → 사용자 인증 정보 → "Browser key" → *애플리케이션 제한사항: HTTP 리퍼러* 에 사이트 주소(예: `https://one-2comunity-test.onrender.com/*`, 개발 중이면 `http://localhost:*`)만 허용. 다른 사이트에서 이 키로 Firebase 를 부르기 어려워진다. *API 제한사항* 도 Firebase 가 쓰는 API 로 좁힌다.
* **Authentication → Settings → Authorized domains** 에 쓰는 도메인만 둔다. 새 Render 주소로 옮기면 추가해야 로그인이 된다.
* **보안 규칙 점검** — Realtime Database / Firestore 규칙이 "로그인한 사용자만" 또는 "본인 데이터만"으로 되어 있는지. `.read: true`, `.write: true`, `allow read, write: if true` 같은 전체 공개 규칙이 없어야 한다. (게스트 열람용으로 읽기만 여는 경로는 필요한 컬렉션만 열고 쓰기는 항상 로그인 필요로 둔다.)
* **익명 로그인(Anonymous)** — 게스트가 커뮤니티 글/공지를 읽게 하려면 켜 둔다(켜져 있어도 쓰기는 규칙이 막는다). 끄면 게스트 화면은 열리지만 Firestore 규칙이 로그인을 요구하는 데이터는 비어 보이고 안내 배너가 뜬다.
* **App Check**(권장) — reCAPTCHA v3 로 "우리 사이트에서 온 요청만" 서버가 받게 하는 기능. 콘솔에서 켜고 앱에 연동 코드를 넣어야 해서 아직 적용하지 않았다(필요하면 다음 작업으로).

### Supabase
* 모든 테이블에 **RLS 켜기**, 정책은 필요한 최소 범위(예: 앱스토어는 공개 앱만 읽기, 쓰기는 Edge Function 만). 이 저장소의 `supabase/migrations/20261002_appstore.sql` 이 앱스토어 쪽 예시다.
* Storage 버킷은 공개/비공개를 의도대로(음악 `music` 은 비공개 + 서명 URL).
* `service_role` 키는 어디에도 복사하지 않는다(Edge Function 은 자동 주입값을 쓴다).

## 보안 헤더

`_headers`(Netlify)와 `render.yaml`(Render) 에 같은 값을 넣어 두었다. Render 를 대시보드로 설정했다면 **Settings → Headers** 에 아래를 직접 추가한다.

| 헤더 | 값 | 효과 |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | 파일 종류를 브라우저가 멋대로 추측하지 못하게 |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | 다른 사이트로 갈 때 주소 일부만 전달 |
| `Content-Security-Policy` | `frame-ancestors 'none'; object-src 'none'` | 다른 사이트가 이 사이트를 iframe 에 넣어 클릭을 가로채는 것(clickjacking)·플러그인 차단 |
| `Permissions-Policy` | `geolocation=(), payment=(), usb=()` | 쓰지 않는 기능 차단 |
| 코드 파일(`/js/*`, `/css/*`) | `Cache-Control: no-cache` | 배포 때마다 새 코드를 확인(서비스워커도 네트워크 우선) |

완전한 CSP(`script-src` 제한)는 아직 못 넣는다 — HTML 곳곳의 `onclick="..."` 인라인 이벤트 핸들러 때문에 `'unsafe-inline'` 이 필요해서 효과가 작다. 이벤트 핸들러를 JS 로 옮기는 리팩터링을 한 뒤에 엄격한 CSP 를 켜는 것이 순서다.

## 앱스토어(사용자 앱) 보안

사용자가 올린 앱은 `sandbox` iframe(스크립트만 허용, same-origin/top-navigation 없음)에서 실행되고, ZIP 은 경로 조작·압축 폭탄을 막으며 브라우저 안에서만 푼다. 자세한 내용은 `docs/appstore.md`.
