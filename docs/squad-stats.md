# 스쿼드 메이커 · 선수 기록(레이더 비교)

스쿼드 메이커 탭 아래 **📊 선수 기록 · 레이더 비교** 카드에서 반 친구(프로필 번호)마다
xG · xA · PPDA · 프로그레시브 패스 · 프로그레시브 캐리 · 기회 창출을 입력하고,
최대 4명을 오각형 레이더 차트로 겹쳐 비교한다.

## 저장 위치

Firestore `squad_stats/{학생번호}` (예: `squad_stats/7`)

```json
{ "xg": 0.8, "xa": 0.2, "ppda": 8, "progPass": 5, "progCarry": 3, "chances": 2, "updatedAt": 1792539789118, "updatedBy": "<uid>" }
```

빈 칸은 `null`. 비교에 고른 선수는 기기마다 `localStorage['squad_compare_sel']` 에 기억한다.

## 레이더 점수

축 5개: xG, xA, 기회 창출, 전진 패스·캐리(프로그레시브 패스 + 캐리), 압박(PPDA).
각 축은 기록이 있는 반 친구 중 최고값을 100으로 맞춘 점수다. PPDA 는 낮을수록 압박이 강하므로 최저값이 100(점수 = 최저값 ÷ 내 값 × 100).
실제 입력값은 차트 아래 표와 꼭짓점 툴팁에 그대로 보인다.

## Firestore 보안 규칙

게시된 전체 규칙은 [`docs/firestore.rules`](firestore.rules) 에 있다(아래는 그중 이 컬렉션 부분의 요약). 규칙에 이 컬렉션이 없으면 화면에 "선수 기록을 불러올 권한이 없어요" 안내가 뜬다.

```
match /squad_stats/{num} {
  allow read: if request.auth != null;
  allow write: if request.auth != null
    && num.matches('^[0-9]+$')
    && request.resource.data.keys().hasOnly(['xg', 'xa', 'ppda', 'progPass', 'progCarry', 'chances', 'updatedAt', 'updatedBy']);
  allow delete: if request.auth != null;
}
```

(스쿼드 보드(`squad_players`)와 같은 수준 - 로그인한 사람이면 기록할 수 있다. 우리 반만 쓰게 하려면 기존 규칙에서 쓰는 반 확인 조건을 같이 붙인다.)
