import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';

import { AUTH_CONFIG_ERROR, tryGetAuthConfig } from './config';
import type { AuthConfig } from './types';

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  email: string | null;
  expiresAt: number;
}

export interface AuthContextValue {
  status: 'CONFIGURATION_MISSING' | 'RESTORING' | 'SIGNED_OUT' | 'ACCESS_DENIED' | 'SIGNED_IN';
  accessToken: string | null;
  email: string | null;
  error: string | null;
  config: AuthConfig | null;
  signIn: (selectAccount?: boolean) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const refreshStorageKey = 'zetaauto.web.refresh-session.v1';
const emailStorageKey = 'zetaauto.web.email.v1';
const oauthStateKey = 'zetaauto.web.oauth-state.v1';
export const ALLOWED_WEB_EMAIL = 'kdmerit@gmail.com';

function randomBase64Url(bytes = 32): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return btoa(String.fromCharCode(...values))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function readEmail(idToken: string | null): string | null {
  if (!idToken) return null;
  try {
    const payload = idToken.split('.')[1];
    if (!payload) return null;
    const decoded = atob(
      payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(
        payload.length + ((4 - (payload.length % 4)) % 4),
        '=',
      ),
    );
    const parsed = JSON.parse(decoded) as { email?: unknown };
    return typeof parsed.email === 'string'
      ? parsed.email.trim().toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function saveRefreshToken(value: string): void {
  try {
    sessionStorage.setItem(refreshStorageKey, value);
  } catch {
    // The session can still be used until the tab is closed.
  }
}

function saveSessionEmail(value: string | null): void {
  try {
    if (value) sessionStorage.setItem(emailStorageKey, value);
    else sessionStorage.removeItem(emailStorageKey);
  } catch {
    // The token session remains usable if storage is restricted.
  }
}

function readSessionEmail(): string | null {
  try {
    return sessionStorage.getItem(emailStorageKey)?.trim().toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function readRefreshToken(): string | null {
  try {
    return sessionStorage.getItem(refreshStorageKey);
  } catch {
    return null;
  }
}

function clearAuthStorage(): void {
  try {
    sessionStorage.removeItem(refreshStorageKey);
    sessionStorage.removeItem(emailStorageKey);
    sessionStorage.removeItem(oauthStateKey);
  } catch {
    // Ignore storage restrictions during logout.
  }
}

async function exchangeCode(
  config: AuthConfig,
  code: string,
  verifier: string,
): Promise<TokenSet> {
  const response = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!response.ok) throw new Error('Google 로그인 코드를 확인하지 못했습니다.');
  const body = (await response.json()) as Record<string, unknown>;
  if (
    typeof body.access_token !== 'string' ||
    typeof body.expires_in !== 'number' ||
    typeof body.refresh_token !== 'string'
  ) {
    throw new Error('Cognito 토큰 응답이 올바르지 않습니다.');
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    idToken: typeof body.id_token === 'string' ? body.id_token : null,
    email: readEmail(typeof body.id_token === 'string' ? body.id_token : null),
    expiresAt: Date.now() + body.expires_in * 1000,
  };
}

async function refreshTokens(
  config: AuthConfig,
  refreshToken: string,
  previousEmail: string | null,
): Promise<TokenSet> {
  const response = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.clientId,
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) throw new Error('저장된 로그인 세션이 만료되었습니다.');
  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
    throw new Error('Cognito 세션 응답이 올바르지 않습니다.');
  }
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === 'string' ? body.refresh_token : refreshToken,
    idToken: typeof body.id_token === 'string' ? body.id_token : null,
    email: readEmail(typeof body.id_token === 'string' ? body.id_token : null) ?? previousEmail,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
}

function requireAllowedAccount(tokenSet: TokenSet): TokenSet {
  if (tokenSet.email !== ALLOWED_WEB_EMAIL) {
    throw new Error(`허용된 Google 계정(${ALLOWED_WEB_EMAIL})으로 로그인해 주세요.`);
  }
  return tokenSet;
}

function removeOAuthQuery(): void {
  const url = new URL(window.location.href);
  url.search = '';
  window.history.replaceState({}, document.title, url.toString());
}

function readOAuthCallback(): { code: string; state: string } | null {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return null;
  return { code, state };
}

function readOAuthError(): string | null {
  return new URLSearchParams(window.location.search).get('error');
}

function readStoredOAuthState(): { state: string; verifier: string } | null {
  try {
    const raw = sessionStorage.getItem(oauthStateKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: unknown; verifier?: unknown };
    return typeof parsed.state === 'string' && typeof parsed.verifier === 'string'
      ? { state: parsed.state, verifier: parsed.verifier }
      : null;
  } catch {
    return null;
  }
}

function saveOAuthState(state: string, verifier: string): void {
  try {
    sessionStorage.setItem(oauthStateKey, JSON.stringify({ state, verifier }));
  } catch {
    throw new Error('브라우저 세션 저장소를 사용할 수 없습니다.');
  }
}

export function AuthProvider({ children }: PropsWithChildren) {
  const config = useMemo(() => tryGetAuthConfig(), []);
  const [status, setStatus] = useState<AuthContextValue['status']>(
    config ? 'RESTORING' : 'CONFIGURATION_MISSING',
  );
  const [tokens, setTokens] = useState<TokenSet | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(async (selectAccount = false) => {
    if (!config) throw new Error(AUTH_CONFIG_ERROR);
    const verifier = randomBase64Url(48);
    const state = randomBase64Url(24);
    saveOAuthState(state, verifier);
    const challenge = await sha256Base64Url(verifier);
    const url = new URL(`${config.cognitoDomain}/oauth2/authorize`);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: 'openid email profile',
      identity_provider: 'Google',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (selectAccount) params.set('prompt', 'select_account');
    else {
      params.set('prompt', 'none');
      params.set('login_hint', ALLOWED_WEB_EMAIL);
    }
    url.search = params.toString();
    window.location.assign(url.toString());
  }, [config]);

  const signOut = useCallback(async () => {
    const refreshToken = tokens?.refreshToken ?? readRefreshToken();
    if (config && refreshToken) {
      try {
        await fetch(`${config.cognitoDomain}/oauth2/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.clientId,
            token: refreshToken,
          }),
        });
      } catch {
        // Local sign-out must still complete if the network is unavailable.
      }
    }
    clearAuthStorage();
    setTokens(null);
    setStatus(config ? 'SIGNED_OUT' : 'CONFIGURATION_MISSING');
    setError(null);
    if (config) {
      const logoutUrl = new URL(`${config.cognitoDomain}/logout`);
      logoutUrl.search = new URLSearchParams({
        client_id: config.clientId,
        logout_uri: config.logoutUri,
      }).toString();
      window.location.replace(logoutUrl.toString());
    }
  }, [config, tokens?.refreshToken]);

  useEffect(() => {
    if (!config) return undefined;
    let active = true;
    const restore = async () => {
      try {
        const callback = readOAuthCallback();
        const oauthError = readOAuthError();
        if (oauthError) {
          removeOAuthQuery();
          throw new Error(oauthError === 'login_required' ? '기존 Google 세션으로 로그인할 수 없습니다.' : 'Google 로그인이 취소되었거나 실패했습니다.');
        }
        let next: TokenSet | null = null;
        if (callback) {
          const saved = readStoredOAuthState();
          if (!saved || saved.state !== callback.state) {
            throw new Error('로그인 요청 검증에 실패했습니다. 다시 로그인해 주세요.');
          }
          next = requireAllowedAccount(await exchangeCode(config, callback.code, saved.verifier));
          removeOAuthQuery();
          saveRefreshToken(next.refreshToken);
          saveSessionEmail(next.email);
        } else {
          const refreshToken = readRefreshToken();
          if (refreshToken) {
            next = requireAllowedAccount(await refreshTokens(config, refreshToken, readSessionEmail()));
            saveSessionEmail(next.email);
          }
        }
        if (!active) return;
        setTokens(next);
        setStatus(next ? 'SIGNED_IN' : 'SIGNED_OUT');
        setError(null);
      } catch (failure) {
        if (!active) return;
        clearAuthStorage();
        setTokens(null);
        const message = failure instanceof Error ? failure.message : '로그인 상태를 확인하지 못했습니다.';
        const accessDenied = message.startsWith('허용된 Google 계정');
        setStatus(accessDenied ? 'ACCESS_DENIED' : 'SIGNED_OUT');
        setError(accessDenied ? '허용되지 않은 Google 계정입니다.' : message);
        removeOAuthQuery();
      }
    };
    void restore();
    return () => {
      active = false;
    };
  }, [config]);

  useEffect(() => {
    if (!tokens || !config) return undefined;
    const delay = Math.max(tokens.expiresAt - Date.now() - 60_000, 5_000);
    const timer = window.setTimeout(() => {
      void refreshTokens(config, tokens.refreshToken, tokens.email)
        .then(requireAllowedAccount)
        .then((next) => {
          saveRefreshToken(next.refreshToken);
          saveSessionEmail(next.email);
          setTokens(next);
        })
        .catch(() => {
          clearAuthStorage();
          setTokens(null);
          setStatus('SIGNED_OUT');
          setError('로그인 세션이 만료되었습니다. 다시 로그인해 주세요.');
        });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [config, tokens]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      accessToken: tokens?.accessToken ?? null,
      email: tokens?.email ?? null,
      error,
      config,
      signIn,
      signOut,
    }),
    [config, error, signIn, signOut, status, tokens],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthProvider가 필요합니다.');
  return context;
}
