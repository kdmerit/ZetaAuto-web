import { useEffect, useRef, useState } from 'react';

import { AUTH_CONFIG_ERROR } from './config';
import { ALLOWED_WEB_EMAIL, useAuth } from './auth';
import { BacktestMenu } from './components/BacktestMenu';
import { StrategyBacktest } from './components/StrategyBacktest';
import type { Strategy } from './types';
import { sendNativeMessage, subscribeNativeBack } from './nativeBridge';

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
          {auth.embedded ? (
            <button className="primary-button full-width" type="button" disabled={missing} onClick={() => void auth.signIn()}>앱 로그인 다시 연결</button>
          ) : <>
          <button className="primary-button full-width" type="button" disabled={missing} onClick={() => void auth.signIn()}>
            구글 로그인
          </button>
          <button className="outline-button full-width" type="button" disabled={missing} onClick={() => void auth.signIn(true)}>
            다른 계정으로 로그인
          </button>
          </>}
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
          {auth.embedded ? '앱 로그인 다시 연결' : '다른 계정으로 로그인'}
        </button>
      </div>
    </main>
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

    const handlePopState = (event: PopStateEvent) => {
      // Closing a chart with its X button removes the dialog before popstate.
      // The destination is still the same strategy, not the menu; use history
      // state instead of relying only on the dialog remaining in the DOM.
      if (event.state?.screen === 'STRATEGY'
        && (event.state.strategy === 'PULLBACK' || event.state.strategy === 'DISPARITY')) {
        if (screenRef.current.kind !== 'STRATEGY' || screenRef.current.strategy !== event.state.strategy) {
          setScreen({ kind: 'STRATEGY', strategy: event.state.strategy });
        }
        return;
      }
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

  useEffect(() => subscribeNativeBack(() => {
    if (document.querySelector('.chart-modal') || window.history.state?.zetaautoChart || screenRef.current.kind === 'STRATEGY') {
      window.history.back();
    } else {
      sendNativeMessage('EXIT_BACKTEST');
    }
  }), []);

  const openStrategy = (strategy: Strategy): void => {
    window.history.pushState({ zetaautoApp: true, screen: 'STRATEGY', strategy }, '');
    setScreen({ kind: 'STRATEGY', strategy });
  };

  if (!auth.config || !auth.accessToken || auth.email !== ALLOWED_WEB_EMAIL) return <LoginScreen />;
  return (
    <div className="app-shell">
      {screen.kind === 'MENU' ? (
        <BacktestMenu
          email={auth.email}
          onSignOut={() => void auth.signOut()}
          onOpen={openStrategy}
        />
      ) : (
        <StrategyBacktest
          strategy={screen.strategy}
          context={{
            apiBaseUrl: auth.config.apiBaseUrl,
            accessToken: auth.accessToken,
            refreshAccessToken: auth.refreshAccessToken,
          }}
        />
      )}
    </div>
  );
}

export function App() {
  const auth = useAuth();
  useEffect(() => {
    if (auth.status === 'SIGNED_IN') return undefined;
    return subscribeNativeBack(() => sendNativeMessage('EXIT_BACKTEST'));
  }, [auth.status]);
  if (auth.status === 'RESTORING') {
    return <main className="screen centered"><div className="loading-card">로그인 세션을 확인하는 중입니다…</div></main>;
  }
  if (auth.status === 'ACCESS_DENIED') return <AccessDeniedScreen />;
  return auth.status === 'SIGNED_IN' ? <SignedInApp /> : <LoginScreen />;
}
