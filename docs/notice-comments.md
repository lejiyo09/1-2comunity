# 공지 댓글 (Firestore 규칙)

공지사항 상세 화면 아래에 댓글을 달 수 있다. 댓글은 게시글 댓글(`posts/{postId}/comments`)과 같은 모양으로
`notices/{noticeId}/comments/{commentId}` 에 저장된다.

```
{ authorId, authorName, authorOriginal, content, createdAt, editedAt? }
```

## Firebase 콘솔에서 꼭 해야 하는 것: Firestore 보안 규칙 추가

규칙에 이 경로가 없으면 댓글을 읽거나 쓸 때 `permission-denied` 가 나서 "댓글을 불러오지 못했어요 / 저장하지 못했어요" 라고 보인다.

**가장 안전한 방법**: 지금 `posts/{postId}/comments/{commentId}` 에 걸려 있는 규칙을 그대로 복사해서 경로만 `notices/{noticeId}/comments/{commentId}` 로 바꿔 넣는다.
(읽기/쓰기/수정/삭제 조건이 게시글 댓글과 똑같이 돼서, 로그인·게스트·관리자 권한이 같은 기준으로 동작한다.)

규칙을 새로 쓴다면 대략 이런 모양이다(`isAdminLike()` 는 기존 규칙의 관리자 조건으로 바꾼다):

```
match /notices/{noticeId}/comments/{commentId} {
  allow read: if true;                                  // 공지를 비로그인으로도 읽게 했다면 같게. 아니면 request.auth != null
  allow create: if request.auth != null
                && request.resource.data.authorId == request.auth.uid
                && request.resource.data.content is string
                && request.resource.data.content.size() <= 500;
  allow update: if request.auth != null
                && resource.data.authorId == request.auth.uid
                && request.resource.data.authorId == resource.data.authorId;
  allow delete: if request.auth != null
                && (resource.data.authorId == request.auth.uid || isAdminLike());
}
```

## 동작
* 공지 상세를 열면 그 공지의 댓글만 실시간으로 구독한다(목록 화면에서는 구독하지 않는다).
* 로그인한 사람은 누구나 댓글을 달 수 있고(Enter 로도 등록), 본인 댓글은 수정·삭제할 수 있다.
  관리자/운영자/공지 작성 권한자는 남의 댓글도 삭제할 수 있다.
* 로그아웃 상태에서는 댓글을 읽을 수 있고(규칙이 허용할 때), 등록을 누르면 로그인 창이 뜬다.
* 공지를 삭제하면 그 공지의 댓글도 함께 삭제한다(공지 삭제 권한자의 삭제가 규칙에서 허용돼야 한다).

> 현재 게시된 전체 규칙은 [`docs/firestore.rules`](firestore.rules) 에 있다(공지 댓글 규칙 포함).
