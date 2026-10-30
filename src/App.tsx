import { useEffect, useState } from 'react';

import { AUTH_CONFIG_ERROR } from './config';
import { ALLOWED_WEB_EMAIL, useAuth } from './auth';
import { BacktestMenu } from './components/BacktestMenu';
import { StrategyBacktest } from './components/StrategyBacktest';
import type { Strategy } from './types';

type Screen = { kind: 'MENU' } | { kind: 'STRATEGY'; strategy: Strategy };

function LoginScreen() {
  const auth = useAuth();
  const missing = auth.status === 'CONFIGURATION_MISSING';
  return (
    <main className="screen auth-screen">
      <div className="auth-card surface-card">
        <p className="eyebrow">ZETAAUTO · BACKTEST</p>
        <h1>ZetaAuto 로그인</h1>
        <h2>본인만 접근하는 안전한 백테스트</h2>
        <p className="muted">
          Google 로그인을 Cognito에서 처리하며, 웹앱에는 Client Secret이나 AWS 자격증명을 넣지 않습니다.
        </p>
        <p className="notice">허용 계정: {ALLOWED_WEB_EMAIL}</p>
        {auth.error ? <p className="error" role="alert">{auth.error}</p> : null}
        {missing ? <p className="notice">{AUTH_CONFIG_ERROR}</p> : null}
        <button className="primary-button full-width" type="button" disabled={missing} onClick={() => void auth.signIn()}>
          Google로 로그인
        </button>
      </div>
    </main>
  );
}

function FullscreenButton() {
  const [fullscreen, setFullscreen] = useState(false);
  const [fallbackFullscreen, setFallbackFullscreen] = useState(false);
  useEffect(() => {
    const update = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  const toggle = async (): Promise<void> => {
    const shell = document.querySelector<HTMLElement>('.app-shell');
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (fallbackFullscreen) {
        shell?.classList.remove('pseudo-fullscreen');
        setFallbackFullscreen(false);
      }
      else {
        const target = shell ?? document.documentElement;
        if (typeof target.requestFullscreen !== 'function') {
          shell?.classList.add('pseudo-fullscreen');
          setFallbackFullscreen(true);
        } else await target.requestFullscreen();
      }
    } catch {
      shell?.classList.add('pseudo-fullscreen');
      setFallbackFullscreen(true);
    }
  };
  return (
    <button className="fullscreen-button" type="button" onClick={() => void toggle()} aria-label={fullscreen || fallbackFullscreen ? '전체화면 닫기' : '전체화면으로 보기'}>
      {fullscreen || fallbackFullscreen ? '⤢' : '⛶'}
    </button>
  );
}

function SignedInApp() {
  const auth = useAuth();
  const [screen, setScreen] = useState<Screen>({ kind: 'MENU' });
  if (!auth.config || !auth.accessToken || auth.email !== ALLOWED_WEB_EMAIL) return <LoginScreen />;
  return (
    <div className="app-shell">
      <FullscreenButton />
      {screen.kind === 'MENU' ? (
        <BacktestMenu
          email={auth.email}
          onSignOut={() => void auth.signOut()}
          onOpen={(strategy) => setScreen({ kind: 'STRATEGY', strategy })}
        />
      ) : (
        <StrategyBacktest
          strategy={screen.strategy}
          context={{ apiBaseUrl: auth.config.apiBaseUrl, accessToken: auth.accessToken }}
          onBack={() => setScreen({ kind: 'MENU' })}
        />
      )}
    </div>
  );
}

export function App() {
  const auth = useAuth();
  if (auth.status === 'RESTORING') {
    return <main className="screen centered"><div className="loading-card">로그인 세션을 확인하는 중입니다…</div></main>;
  }
  return auth.status === 'SIGNED_IN' ? <SignedInApp /> : <LoginScreen />;
}
