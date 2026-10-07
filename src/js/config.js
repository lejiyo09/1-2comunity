// 사이트 설정 모음 (브라우저에 내려가는 "공개" 값만 둔다).
//
// ⚠️ 여기 있는 값은 전부 "공개 식별자"다 - 브라우저에서 도는 사이트는 이 값을 숨길 수 없고, 숨길 필요도 없게 설계된 값들이다.
//    진짜 보호는 이 값이 아니라 서버 쪽 규칙이 한다: Firebase 보안 규칙(Realtime DB/Firestore), Supabase RLS·Edge Function.
//    (자세한 점검 목록은 docs/security.md)
//   - Firebase apiKey : 프로젝트를 식별할 뿐 비밀번호가 아니다. Google Cloud 콘솔에서 "HTTP 리퍼러" 제한을 걸어 두면 다른 사이트에서 쓰기 어렵다.
//   - Supabase publishable(anon) key : RLS 가 허용한 범위만 읽을 수 있는 공개 키.
//
// 🚫 여기에 넣으면 안 되는 것: service_role / secret 키, 날씨·NEIS·이미지 호스팅 같은 외부 서비스 인증키.
//    그런 값은 Supabase Edge Function 의 Secrets 에만 두고(예: supabase/functions/api-proxy), 브라우저는 그 함수를 부른다.

export const firebaseConfig = {
    apiKey: "AIzaSyDQaFGU_N0NyDr6yZChZJKPplJgQL6bfJA",
    authDomain: "over-2a177.firebaseapp.com",
    databaseURL: "https://over-2a177-default-rtdb.firebaseio.com",
    projectId: "over-2a177",
    storageBucket: "over-2a177.firebasestorage.app",
    messagingSenderId: "534387478870",
    appId: "1:534387478870:web:af79f9e093fa4decf386f7",
    measurementId: "G-SFWHLMWJRC"
};

// 자료실/앱스토어/Edge Function 이 쓰는 Supabase 프로젝트
export const SUPABASE_URL = "https://cryeosgmuxqyphntqqlc.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_oXzL8eqnE-eVeBv4SGUIIA_c8wFi8u2";

// 음악 공유가 쓰는 별도 Supabase 프로젝트
export const SUPABASE_MUSIC_URL = "https://robineymrvvtetuphkjt.supabase.co";
export const SUPABASE_MUSIC_KEY = "sb_publishable_qP4gdsjkyT9ee3HcY3YikA_lINsb52Q";
