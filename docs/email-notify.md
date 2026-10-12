# 이메일 알림 (Gmail SMTP) 설치 가이드

설정 → **📧 이메일 알림**에서 본인 Gmail 을 등록하면, 아래 알림을 메일로 받는다.

* 내가 쓴 **글**이나 내가 올린 **공지**에 **댓글**이 달렸을 때
* 새 **공지**가 올라왔을 때

받고 싶은 알림 종류는 따로 켜고 끌 수 있고, 언제든 주소를 삭제할 수 있다.

## 어떻게 동작하나

1. 사용자가 Gmail 주소를 입력하면 서버가 **6자리 인증 코드**를 그 주소로 보낸다. 코드를 입력해야 알림이 켜진다(남의 주소로 메일을 보내는 오용 방지).
2. 사용자가 댓글/공지를 올린 직후 앱이 Supabase Edge Function `mail-notify` 를 부른다.
3. 함수는 부른 사람의 말을 믿지 않고, **같은 로그인 토큰으로 Firestore 에서 그 댓글/공지를 읽어** "정말 있고, 부른 사람이 쓴 것"인지 확인한 뒤에만 보낸다.
4. 받는 사람의 Gmail 은 Supabase 테이블 `email_subscriptions` 에만 저장된다. RLS 를 켜고 정책을 만들지 않아서 **브라우저에서는 읽을 수 없고**, 함수만(service_role) 읽는다.

보내는 규칙(서버가 지킨다):

| 규칙 | 값 |
|---|---|
| 본인이 쓴 글/공지에 본인이 단 댓글 | 보내지 않음 |
| 같은 댓글/공지 | 한 번만 |
| 같은 글에서 연달아 달린 댓글 | 5분에 한 통 |
| 공지 알림 | 방금(15분 안에) 올린 본인 공지만, 한 번에 최대 60명 |
| 인증 코드 | 계정당 1분에 한 번, 하루 5번, 틀리면 5번까지 |
| 하루 발송 한도 | 기본 400통(`MAIL_DAILY_LIMIT`) — Gmail 한도(약 500통)보다 낮게 |
| 한 사람의 알림 호출 | 1시간에 60번 |
| 같은 Gmail 주소 | 한 계정만 인증 가능 |

## 설치 순서 (Supabase 프로젝트 `cryeosgmuxqyphntqqlc` 하나에만)

### 1. 발송에 쓸 Gmail 계정 준비 (학급용 계정을 따로 만드는 것을 권장)
1. 그 계정의 [Google 계정 → 보안]에서 **2단계 인증**을 켠다.
2. https://myaccount.google.com/apppasswords 에서 **앱 비밀번호**를 만든다(이름은 아무거나, 예: `class-site`). 16자리가 나온다 — 한 번만 보이니 복사해 둔다. (공백이 있어도 된다.)
   * 본인 Google 비밀번호는 절대 넣지 않는다. 앱 비밀번호는 언제든 삭제해서 무효화할 수 있다.

### 2. SQL 실행
Supabase → SQL Editor 에 `supabase/migrations/20261012_mail_notify.sql` 내용을 붙여 넣고 실행한다.

### 3. Secrets 등록 (Edge Functions → Secrets)

| 이름 | 값 |
|---|---|
| `GMAIL_USER` | 발송용 Gmail 주소 (예: `class12.notify@gmail.com`) |
| `GMAIL_APP_PASSWORD` | 위에서 만든 앱 비밀번호 16자리 |
| `SITE_URL` | 사이트 주소 (예: `https://one-2comunity-test.onrender.com`) — 메일 속 "사이트에서 보기" 링크에 쓰인다 |
| `MAIL_FROM_NAME` | (선택) 보낸 사람 이름. 기본 `1-2 커뮤니티` |
| `MAIL_DAILY_LIMIT` | (선택) 하루 최대 발송 수. 기본 400 |

### 4. 함수 배포
* 대시보드: Edge Functions → **Deploy a new function → Via Editor** → 이름 **`mail-notify`** → `supabase/functions/mail-notify/index.ts` 전체를 붙여 넣고 Deploy → 함수 설정에서 **Verify JWT 끄기**.
* 또는 CLI: `supabase functions deploy mail-notify --no-verify-jwt --project-ref cryeosgmuxqyphntqqlc`

### 5. 확인
1. 사이트 설정 → 이메일 알림에서 본인 Gmail 입력 → **인증 코드 받기** → 메일(스팸함도 확인)의 6자리 입력.
2. 다른 계정으로 내 글에 댓글을 달면 메일이 온다.

## 문제 해결

| 증상 | 원인 / 해결 |
|---|---|
| 설정에 "이메일 알림 기능이 아직 서버에 설치되지 않았어요" | `mail-notify` 함수가 그 프로젝트에 없다(이름 오타 포함) → 4번 |
| "메일 서버 설정(GMAIL_USER / GMAIL_APP_PASSWORD)이 아직 안 되어 있어요" | 3번 시크릿 이름/값 확인 후 함수 다시 Deploy |
| "메일을 보내지 못했어요" | 앱 비밀번호가 틀렸거나(2단계 인증 필요), Gmail 이 로그인을 막았다. 함수 로그(Edge Functions → mail-notify → Logs)의 `mail send failed` 를 확인. 새 앱 비밀번호를 만들어 다시 등록 |
| 로그에 연결 오류(포트) | 이 함수는 `smtp.gmail.com:465`(TLS)를 쓴다. 보통 Edge Function 에서 허용된다. 막힌다면 알려 달라 — Resend 같은 HTTP 방식 메일 서비스로 바꾸는 쪽이 안전하다 |
| 메일이 스팸함에 감 | 처음 몇 통은 스팸으로 갈 수 있다. "스팸 아님"으로 표시하면 이후 정상 도착한다 |
| 댓글을 달았는데 메일이 안 옴 | 받는 사람이 알림을 안 켰거나 "댓글" 스위치를 껐다 / 같은 글에서 5분 안의 연속 댓글 / 오늘 한도 초과 / 본인 글에 본인 댓글 |
| 새 공지 메일이 안 감 | 공지를 올린 사람 본인의 알림이 아니라 **다른 사람이 "새 공지" 스위치를 켜 둔 경우에만** 간다. 공지 작성 직후(15분 안) 한 번만 보낸다 |

## 참고 / 한계
* Firestore 에는 서버 트리거가 없어서(Cloud Functions 는 결제 수단이 필요한 유료 플랜) "올린 직후 앱이 알려 주는" 방식이다. 올리는 사람의 브라우저가 그 직후 꺼지면 그 한 건은 알림이 안 갈 수 있다.
* 모든 알림 호출은 Firestore 보안 규칙을 거친다 — 함수가 사용자의 토큰으로 글/댓글/공지를 읽을 수 있어야 하므로, 로그인한 사용자가 `posts`, `notices` 와 그 하위 `comments` 를 읽을 수 있는 규칙(공지 댓글은 `docs/notice-comments.md`)이 필요하다.
* 이메일 주소는 개인정보다. 공개 저장소/로그/화면 어디에도 남기지 않으며, 알림을 끄면 서버에서 삭제된다.
