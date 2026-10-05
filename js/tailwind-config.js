
  // 일일 플래너 탭에서만 Tailwind 유틸리티가 적용되도록 스코프를 제한합니다.
  // (preflight 전역 리셋을 꺼서 기존 커뮤니티 앱의 버튼/입력창 스타일을 건드리지 않습니다)
  tailwind.config = {
    important: '#planner-app-root',
    corePlugins: { preflight: false }
  };
