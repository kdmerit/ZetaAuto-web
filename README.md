# ZetaAuto 웹 백테스트

`kdmerit/ZetaAuto-web`의 GitHub Pages에서 모바일 앱의 백테스트 메뉴를 제공하는 정적 React 앱입니다. 현재 웹 버전은 v2.10.25입니다.

- 개별 종목 분석: Bybit 공개 캔들을 브라우저에서 조회하고 Web Worker로 계산합니다.
- 캔들 캐시·마지막 설정·결과: 브라우저의 IndexedDB와 localStorage에 저장합니다.
- 전체 종목·장기 분석: 인증된 Cognito JWT로 기존 `/reference-candle-backtests` AWS 작업을 사용합니다.
- 변동성 돌파: 직전 캔들 변동폭과 K값(기본 0.5)을 사용해 돌파 진입 후 신호 캔들 마감에 청산합니다. 개별 분석은 브라우저에서, 전체·장기 분석은 AWS에서 같은 규칙으로 계산합니다.
- 웹앱에는 AWS 자격증명이나 Google Client Secret을 넣지 않습니다.

## 앱 안에서 사용

ZetaAuto v2.10.24부터 백테스트 탭은 Chrome 맞춤 탭으로 이 페이지를 엽니다.
동일 휴대폰·동일 Chrome 프로필의 일반 탭과 localStorage·IndexedDB를 공유하므로
설정·분석 이력·캔들 캐시를 함께 사용합니다. 설정 변경은 즉시 저장하며 다른 탭의 변경도
탭 복귀·storage 이벤트에서 반영합니다. 다른 기기·시크릿 모드·다른 프로필과의 동기화는 아닙니다.
v2.10.22까지의 WebView 저장소에 있던 데이터는 자동으로 Chrome에 복사하지 않습니다.

앱은 AES-256-GCM으로 단기 세션을 암호화하고 JWT 보호 API에 암호문만 60초 동안 맡깁니다.
Chrome은 일회성 ID와 키를 URL fragment에서 받은 즉시 지우고, 키 증명으로 한 번만
암호문을 받아 복호화합니다. 실제 JWT는 `/session`에서 생성자 계정과 다시 대조합니다.
Access Token·Refresh Token은 URL·localStorage·IndexedDB에 넣지 않으며 앱 갱신 토큰은 전달하지 않습니다.
이미 Chrome 탭에 웹 OAuth 갱신 세션이 있으면 이를 재사용합니다. 앱 단기 토큰만 받은 새 탭은
토큰 만료 후 인증 API가 필요할 때 기존 Google 브라우저 로그인으로 웹 세션을 획득합니다.
로컬 계산 중에는 인증 갱신을 위해 페이지를 자동으로 이동시키지 않습니다.

이전 v2.10.21–v2.10.22 앱의 WebView 연결은 호환을 위해 유지합니다.
앱은 로그인된 사용자의 짧은 수명 Access Token을 메시지로 전달하며, 웹은 서버의 `/session`
검증 후 별도 로그인 없이 화면을 엽니다. 웹뷰의 단기 토큰은 메모리에만 두고 Refresh Token은
앱의 보안 저장소에 유지합니다. URL이나 웹 저장소에는 인증정보를 넣지 않습니다.
웹의 로그아웃은 앱 로그아웃으로 연결하고 뒤로가기는 차트·전략 화면부터 닫습니다.
일반 브라우저의 로그인 방식은 기존과 같습니다.

웹뷰 연결을 처음 설치한 이후 이 저장소의 화면·차트·웹 계산 변경은 Pages 배포만 하면 됩니다.
전체종목 등 서버 계산의 변경에는 AWS 배포도 필요하지만 APK 빌드는 필요하지 않습니다.
이전 WebView의 이력·설정·캔들 캐시는 Chrome과 별개이고, 새 Chrome 맞춤 탭은 Chrome 저장소를 사용합니다.

## 공개 저장소의 비밀정보 검사

소스와 전체 Git 이력, 실제 배포하는 `dist/`를 Gitleaks로 검사합니다. Pages 배포도 동일한
검사를 통과해야 합니다. 실제 Access/Refresh Token, 거래소 API Key/Secret, AWS 자격증명,
Google Client Secret, 인증서·키 파일·APK·로그·실제 `.env`는 커밋하지 않습니다.
API 주소와 비밀키 없는 Cognito App Client ID는 브라우저가 접속하는 공개 설정값입니다.
비밀정보 취급 원칙은 [SECURITY.md](SECURITY.md)를 따릅니다.

## 체결 차트 조작

- 차트를 열면 최초 진입 캔들을 화면 중앙에 표시합니다. 매수가를 누르면 그 위치로 돌아갑니다.
- 세로축과 거래량은 화면에 보이는 캔들 구간에 자동으로 맞춥니다. 먼 주문 가격은 축을 늘리지 않으며 하단의 SL·TP 가격에서 확인할 수 있습니다.
- 두 손가락을 벌리면 캔들이 확대되고, 오므리면 축소되어 더 많은 캔들이 보입니다. 손가락 사이의 캔들을 중심으로 확대·축소하며 세로축도 다시 맞춥니다.
- 짧게 터치하면 십자선과 오른쪽 가격, 차트 아래 캔들 정보를 표시합니다. 이 상태에서 드래그하면 차트는 고정되고 선택한 캔들이 바뀝니다.
- 다시 짧게 터치하면 십자선을 닫고, 좌우 드래그로 차트를 이동할 수 있습니다.
- 차트 배경에서 시작한 의도적인 터치만 팝업을 닫습니다. 같은 차트 이력 항목의 중복
  popstate 알림이나 차트를 연 직후 이어지는 터치는 팝업을 닫지 않습니다.
- 서버 차트의 왼쪽 끝에 도달하면 과거 캔들을 자동으로 불러옵니다.
- 이동평균선 5개 체크 상태는 변경 즉시 localStorage에 저장합니다. 종목·전략을 바꾸거나
  차트·페이지를 다시 열어도 마지막 선택을 복원하며, 같은 Chrome 프로필의 다른 탭에도 반영합니다.
- 종목명·시간의 기본 문단 여백과 이평선 패널 간격을 줄여 캔들 차트가 더 위에 보이도록 합니다.

## 이력 설정

이력 카드를 선택하면 해당 기록의 종목·방향·주기·기간·수치와 체크박스를 입력폼 및 마지막 설정에
복원하고, 기록된 결과를 즉시 표시합니다. 늦게 도착한 최신 작업 조회가 선택한 이력을 덮어쓰지 않습니다.
서버 작업 이력의 설정은 현재 수정 중인 폼 대신 해당 작업의 요청값으로 저장합니다.
새 필드가 없던 예전 이력은 기본값으로 보완합니다. 단, 예전에 잘못 기록된 값은 원본 없이 복구할 수 없습니다.
CSV 파일 분석 버튼과 파일 선택 입력은 제거했습니다. 개별 종목의 공개 캔들 분석과 AWS 분석은 유지합니다.

## GitHub Pages 설정

배포 워크플로에는 현재 배포된 공개값이 기본값으로 들어 있습니다. 필요하면 저장소 Settings → Secrets and variables → Actions → Variables에서 아래 공개 변수로 덮어쓸 수 있습니다.

```text
VITE_API_BASE_URL=https://qsytnyfa5c.execute-api.ap-northeast-2.amazonaws.com/dev
VITE_COGNITO_DOMAIN=https://<project>-<environment>-<account-id>.auth.ap-northeast-2.amazoncognito.com
VITE_COGNITO_CLIENT_ID=<CognitoWebAppClientId 출력값>
```

선택 변수는 기본 Pages 주소를 사용하므로 보통 생략해도 됩니다.

```text
VITE_COGNITO_REDIRECT_URI=https://kdmerit.github.io/ZetaAuto-web/
VITE_COGNITO_LOGOUT_URI=https://kdmerit.github.io/ZetaAuto-web/
```

## AWS/Cognito 설정

`infrastructure/template.yaml`의 Google federation을 활성화할 때 다음을 함께 설정합니다.

1. `WebOAuthCallbackUri`와 `WebOAuthLogoutUri`를 `https://kdmerit.github.io/ZetaAuto-web/`로 등록합니다.
2. Google OAuth 콘솔의 승인된 리디렉션 URI에는 Cognito의 `/oauth2/idpresponse` 출력값을 등록합니다.
3. `AllowedEmailSha256`에는 `kdmerit@gmail.com`의 SHA-256 값 `cea3a87911783e6c41d2ef2cdf2b5091b2a965a27a058882aeb5aa707234d32b`를 사용합니다.
4. 스택 출력 `CognitoWebAppClientId`를 `VITE_COGNITO_CLIENT_ID`에 넣습니다.

Cognito PreSignUp Lambda의 서버 allow-list가 실제 접근 통제이고, 웹앱도 토큰 이메일이 `kdmerit@gmail.com`이 아닐 경우 세션을 폐기하는 보조 검사를 수행합니다.

## 로컬 실행

```bash
cp .env.example .env.local
npm ci
npm run dev
```

GitHub Pages의 프로젝트 base path는 `/ZetaAuto-web/`로 고정되어 있습니다.
