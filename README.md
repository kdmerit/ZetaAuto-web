# ZetaAuto 웹 백테스트

`kdmerit/ZetaAuto-web`의 GitHub Pages에서 모바일 앱의 백테스트 메뉴를 제공하는 정적 React 앱입니다.

- 개별 종목 분석: Bybit 공개 캔들을 브라우저에서 조회하고 Web Worker로 계산합니다.
- 캔들 캐시·마지막 설정·결과: 브라우저의 IndexedDB와 localStorage에 저장합니다.
- 전체 종목·장기 분석: 인증된 Cognito JWT로 기존 `/reference-candle-backtests` AWS 작업을 사용합니다.
- 웹앱에는 AWS 자격증명이나 Google Client Secret을 넣지 않습니다.
- 모바일 브라우저에서는 우측 상단 `⛶` 버튼으로 앱 프레임을 전체화면으로 열고, 프레임 안에서 스크롤할 수 있습니다.

## 체결 차트 조작

- 차트를 열면 최초 진입 캔들을 화면 중앙에 표시합니다. 매수가를 누르면 그 위치로 돌아갑니다.
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
