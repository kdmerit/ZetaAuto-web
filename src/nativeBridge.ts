/** Native WebView integration. Credentials exist only in memory and never in URLs or browser storage. */

interface NativeHost {
  postMessage: (message: string) => void;
}

export interface NativeSession {
  accessToken: string;
  email: string;
  expiresAt: number;
  apiBaseUrl: string;
}

interface NativeEnvelope {
  channel: 'zetaauto.backtest';
  version: 1;
  type: string;
  requestId?: string;
  session?: unknown;
}

function host(): NativeHost | undefined {
  return (window as Window & { ReactNativeWebView?: NativeHost }).ReactNativeWebView;
}

export function isEmbeddedWebView(): boolean {
  return new URLSearchParams(window.location.search).get('embedded') === '1' &&
    typeof host()?.postMessage === 'function';
}

export function sendNativeMessage(type: 'SIGN_OUT' | 'EXIT_BACKTEST' | 'FULLSCREEN', payload: Record<string, unknown> = {}): void {
  if (isEmbeddedWebView()) host()?.postMessage(JSON.stringify({ ...payload, channel: 'zetaauto.backtest', version: 1, type }));
}

function decodeMessage(value: unknown): NativeEnvelope | null {
  if (typeof value !== 'string' || value.length > 32768) return null;
  try {
    const parsed = JSON.parse(value) as NativeEnvelope;
    return parsed?.channel === 'zetaauto.backtest' && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function subscribeNativeBack(listener: () => void): () => void {
  const receive = (event: MessageEvent): void => {
    if (isEmbeddedWebView() && decodeMessage(event.data)?.type === 'GO_BACK') listener();
  };
  // Android sends to document; iOS sends to window. Stop the duplicate bubbled event.
  const receiveDocument = (event: MessageEvent): void => { event.stopPropagation(); receive(event); };
  window.addEventListener('message', receive);
  document.addEventListener('message', receiveDocument as EventListener);
  return () => {
    window.removeEventListener('message', receive);
    document.removeEventListener('message', receiveDocument as EventListener);
  };
}

export function parseNativeSession(value: unknown, apiBaseUrl: string, now = Date.now()): NativeSession {
  const session = value as Partial<NativeSession> | null;
  if (!session || typeof session.accessToken !== 'string' || session.accessToken.length < 16 ||
    session.accessToken.length > 16384 || typeof session.email !== 'string' ||
    typeof session.expiresAt !== 'number' || !Number.isFinite(session.expiresAt) ||
    session.expiresAt <= now + 5000 || session.apiBaseUrl !== apiBaseUrl) {
    throw new Error('앱 로그인 세션 또는 서버 설정을 확인하지 못했습니다.');
  }
  return {
    accessToken: session.accessToken,
    email: session.email.trim().toLowerCase(),
    expiresAt: session.expiresAt,
    apiBaseUrl: session.apiBaseUrl,
  };
}

export function requestNativeSession(apiBaseUrl: string, forceRefresh = false): Promise<NativeSession> {
  return new Promise((resolve, reject) => {
    if (!isEmbeddedWebView()) { reject(new Error('앱 로그인 연결을 사용할 수 없습니다.')); return; }
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const requestId = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    const finish = (): void => {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      document.removeEventListener('message', receive as EventListener);
    };
    const receive = (event: MessageEvent): void => {
      const message = decodeMessage(event.data);
      if (message?.type !== 'SESSION' || message.requestId !== requestId) return;
      finish();
      try { resolve(parseNativeSession(message.session, apiBaseUrl)); }
      catch (failure) { reject(failure); }
    };
    const timer = window.setTimeout(() => {
      finish(); reject(new Error('앱 로그인 연결 시간이 초과되었습니다. 다시 연결해 주세요.'));
    }, 15000);
    window.addEventListener('message', receive);
    document.addEventListener('message', receive as EventListener);
    host()?.postMessage(JSON.stringify({ channel: 'zetaauto.backtest', version: 1, type: 'SESSION_REQUEST', requestId, forceRefresh }));
  });
}
