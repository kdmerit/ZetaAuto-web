import { useEffect, useRef, useState } from 'react';

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
        {auth.error ? <p className="error" role="alert">{auth.error}</p> : null}
        {missing ? <p className="notice">{AUTH_CONFIG_ERROR}</p> : null}
        <div className="auth-actions">
          <button className="primary-button full-width" type="button" disabled={missing} onClick={() => void auth.signIn()}>
            구글 로그인
          </button>
          <button className="outline-button full-width" type="button" disabled={missing} onClick={() => void auth.signIn(true)}>
            다른 계정으로 로그인
          </button>
        </div>
      </div>
    </main>
  );
}

function AccessDeniedScreen() {
  const auth = useAuth();
  return (
    <main className="screen auth-screen">
      <div className="auth-card surface-card access-denied-card">
        <p className="eyebrow">ZETAAUTO · ACCESS DENIED</p>
        <h1>허용되지 않은 계정</h1>
        <p className="muted">이 Google 계정으로는 백테스트에 접근할 수 없습니다.</p>
        <button className="primary-button full-width" type="button" onClick={() => void auth.signIn(true)}>
          다른 계정으로 로그인
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
  const screenRef = useRef<Screen>({ kind: 'MENU' });

  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  useEffect(() => {
    const currentState = window.history.state;
    const baseState = currentState && typeof currentState === 'object' ? currentState : {};
    window.history.replaceState({ ...baseState, zetaautoApp: true, screen: 'MENU' }, '');

    const handlePopState = () => {
      // ChartModal owns its own history entry. Let it consume this back action.
      if (document.querySelector('.chart-modal')) return;
      if (screenRef.current.kind !== 'MENU') {
        setScreen({ kind: 'MENU' });
        const nextState = window.history.state;
        const nextBase = nextState && typeof nextState === 'object' ? nextState : {};
        window.history.replaceState({ ...nextBase, zetaautoApp: true, screen: 'MENU' }, '');
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const openStrategy = (strategy: Strategy): void => {
    window.history.pushState({ zetaautoApp: true, screen: 'STRATEGY', strategy }, '');
    setScreen({ kind: 'STRATEGY', strategy });
  };

  if (!auth.config || !auth.accessToken || auth.email !== ALLOWED_WEB_EMAIL) return <LoginScreen />;
  return (
    <div className="app-shell">
      <FullscreenButton />
      {screen.kind === 'MENU' ? (
        <BacktestMenu
          email={auth.email}
          onSignOut={() => void auth.signOut()}
          onOpen={openStrategy}
        />
      ) : (
        <StrategyBacktest
          strategy={screen.strategy}
          context={{ apiBaseUrl: auth.config.apiBaseUrl, accessToken: auth.accessToken }}
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
  if (auth.status === 'ACCESS_DENIED') return <AccessDeniedScreen />;
  return auth.status === 'SIGNED_IN' ? <SignedInApp /> : <LoginScreen />;
}
