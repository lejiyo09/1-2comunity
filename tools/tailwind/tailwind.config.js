// 예전 js/tailwind-config.js (CDN 런타임용) 와 같은 규칙: 플래너 영역 안에서만 유틸리티가 적용되고, 전역 리셋(preflight)은 끈다.
module.exports = {
  content: ['../../index.html', '../../js/*.js'],
  important: '#planner-app-root',
  corePlugins: { preflight: false }
};
