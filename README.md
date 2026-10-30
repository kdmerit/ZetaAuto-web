# ZetaAuto 웹 백테스트

`kdmerit/ZetaAuto-web`의 GitHub Pages에서 모바일 앱의 백테스트 메뉴를 제공하는 정적 React 앱입니다.

- 개별 종목 분석: Bybit 공개 캔들을 브라우저에서 조회하고 Web Worker로 계산합니다.
- 캔들 캐시·마지막 설정·결과: 브라우저의 IndexedDB와 localStorage에 저장합니다.
- 전체 종목·장기 분석: 인증된 Cognito JWT로 기존 `/reference-candle-backtests` AWS 작업을 사용합니다.
- 웹앱에는 AWS 자격증명이나 Google Client Secret을 넣지 않습니다.
- 모바일 브라우저에서는 우측 상단 `⛶` 버튼으로 앱 프레임을 전체화면으로 열고, 프레임 안에서 스크롤할 수 있습니다.

## 앱 안에서 사용

ZetaAuto v2.10.21 이상은 백테스트 탭에서 이 페이지를 WebView로 엽니다.
앱은 로그인된 사용자의 짧은 수명 Access Token을 메시지로 전달하며, 웹은 서버의 `/session`
검증 후 별도 로그인 없이 화면을 엽니다. 웹뷰의 단기 토큰은 메모리에만 두고 Refresh Token은
앱의 보안 저장소에 유지합니다. URL이나 웹 저장소에는 인증정보를 넣지 않습니다.
웹의 로그아웃은 앱 로그아웃으로 연결하고 뒤로가기는 차트·전략 화면부터 닫습니다.
전체화면 버튼은 앱 하단 메뉴를 숨깁니다. 일반 브라우저의 로그인 방식은 기존과 같습니다.

웹뷰 연결을 처음 설치한 이후 이 저장소의 화면·차트·웹 계산 변경은 Pages 배포만 하면 됩니다.
전체종목 등 서버 계산의 변경에는 AWS 배포도 필요하지만 APK 빌드는 필요하지 않습니다.
웹뷰의 이력·설정·캔들 캐시는 Chrome과 별개입니다.

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
- 서버 차트의 왼쪽 끝에 도달하면 과거 캔들을 자동으로 불러옵니다.

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
