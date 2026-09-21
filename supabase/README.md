# 자료실(Materials) 백엔드 설정

자료실이 쓰던 이전 Supabase 프로젝트가 사라져서(대시보드에 프로젝트가 더 이상 없음),
`cryeosgmuxqyphntqqlc.supabase.co`가 DNS 조회부터 실패하며 "자료실 서버 연결 오류"가 떴습니다.
이 폴더는 기존 **"1-2-music"** 프로젝트(`robineymrvvtetuphkjt.supabase.co`)에 자료실 기능을
다시 붙이기 위한 설정입니다. 아래 순서대로 진행하면 됩니다.

## 1. DB/Storage 설정 (SQL Editor에서 한 번 실행)

1. [Supabase 대시보드](https://supabase.com/dashboard) → **1-2-music** 프로젝트 → 왼쪽 메뉴 **SQL Editor**
2. `supabase/sql/materials_setup.sql` 파일 내용을 전체 복사해서 붙여넣고 **Run** 실행
   - `materials` 테이블, 다운로드 카운트 함수, `materials` 스토리지 버킷(비공개)이 만들어집니다.
3. 왼쪽 메뉴 **Storage**에 들어가서 `materials` 버킷이 생겼는지 확인 (SQL로 이미 만들어지지만 눈으로 확인 추천)

## 2. Edge Function 2개 배포

이 기능은 Firebase 로그인 토큰을 서버에서 직접 검증해야 해서, Supabase CLI로 배포해야 합니다.

```bash
# 최초 1회: CLI 설치 및 로그인
npm install -g supabase
supabase login

# 이 저장소를 클론한 폴더에서 실행
supabase link --project-ref robineymrvvtetuphkjt

# 두 함수를 각각 --no-verify-jwt 옵션으로 배포 (★ 이 옵션 빠뜨리면 401 에러가 남)
supabase functions deploy upload-material --no-verify-jwt
supabase functions deploy verify-delete-material --no-verify-jwt
```

`--no-verify-jwt`가 필요한 이유: 웹앱이 이 함수를 호출할 때 `Authorization` 헤더에 Supabase
로그인 세션 토큰이 아니라 publishable(anon) 키를 그대로 넣습니다 (실제 사용자 인증은 함수
내부에서 Firebase ID 토큰으로 따로 검증). 이 옵션 없이 배포하면 Supabase 플랫폼이 요청을
함수에 도달하기도 전에 막아버립니다. (`1-2 Music`의 `music-write` 함수도 같은 이유로
이 옵션으로 배포되어 있어야 정상 동작합니다.)

CLI 설치가 어려우면 Supabase 대시보드 → **Edge Functions** → 함수 생성 화면에서
"Enforce JWT Verification" 옵션을 끄고, `index.ts` 내용을 그대로 붙여넣는 방법도 됩니다
(대시보드 UI는 버전에 따라 위치가 다를 수 있습니다).

## 3. 코드 쪽 확인

`index.html`의 `SUPABASE_URL`이 이미 `1-2-music`과 같은 프로젝트를 가리키도록 수정되어 있는지
확인하세요 (이 저장소의 최신 커밋에 반영되어 있다면 별도 조치 불필요).

## 4. 동작 확인

배포된 사이트에서 자료실 탭을 열어 "● 자료실 서버 연결 오류" 문구가 사라지고 목록이 뜨는지,
파일 업로드/다운로드/본인 자료 삭제가 정상 동작하는지 확인해주세요.
