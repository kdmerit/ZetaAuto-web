# 비밀정보 취급

이 저장소와 Pages 자산은 공개된다. 브라우저가 읽는 모든 VITE 설정은 공개값으로 취급한다.
API 주소·Cognito domain·비밀키가 없는 App Client ID는 공개 설정이고 인증 권한을 부여하지 않는다.
실제 권한은 서버가 검증한 사용자 토큰과 기존 허용 계정 정책으로 결정한다.

Access/Refresh Token, 거래소 API Key/Secret, AWS 자격증명, Google Client Secret,
서비스 계정 JSON·개인키·실제 `.env`·디버그 로그를 파일·fixture·커밋·Issue에 넣지 않는다.
웹뷰는 앱의 단기 Access Token만 메모리로 전달받으며 URL·웹 저장소·로그에 남기지 않는다.
Refresh Token은 앱의 보안 저장소에 남는다. 일반 브라우저 로그인은 해당 탭의 기존 세션 정책을 따른다.

Chrome 맞춤 탭은 AES-GCM으로 암호화한 단기 앱 세션만 일회성 API를 통해 받는다.
서버에는 키·평문 JWT 대신 암호문을 60초 TTL로 보관하며 CAS로 한 번만 소비한다.
키와 일회성 ID는 fragment에서 즉시 제거하고 전체 URL·fragment·요청 본문을 로그에 기록하지 않는다.
복호화 후 `/session` JWT 검증·생성자 소유권·허용 계정을 확인하며 앱 갱신 토큰을 공유하지 않는다.

Git 이력과 배포 파일의 Gitleaks 검사를 통과한 변경만 Pages에 배포한다.
비밀값 노출을 발견하면 값을 공개하지 말고 저장소 소유자에게 비공개로 알린다.
실제 자격증명이 커밋됐다면 해당 값을 폐기·재발급하고 Git 이력과 배포물도 점검한다.
