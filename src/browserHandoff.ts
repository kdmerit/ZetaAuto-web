/** One-use encrypted app login for Chrome; the fragment is erased before any request. */
import { parseNativeSession, type NativeSession } from './nativeBridge';

let pending: Promise<NativeSession | null> | null = null;

export function takeBrowserHandoff(apiBaseUrl: string): Promise<NativeSession | null> {
  if (pending) return pending;
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const grantId = fragment.get('app_grant');
  if (grantId === null) return Promise.resolve(null);
  const verifier = fragment.get('key');
  url.hash = '';
  window.history.replaceState(window.history.state, '', url.toString());
  pending = (async () => {
    if (!/^[a-f0-9]{64}$/.test(grantId) || !verifier || !/^[a-f0-9]{64}$/.test(verifier))
      throw new Error('앱에서 백테스트를 다시 열어 주세요.');
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${apiBaseUrl}/backtest-web-sessions/consume`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grantId, verifier }), signal: controller.signal, cache: 'no-store',
      });
      if (!response.ok) throw new Error('앱 로그인 연결이 만료되었습니다. 앱에서 다시 열어 주세요.');
      const document = await response.json() as { ciphertext?: unknown; ownerId?: unknown };
      if (typeof document.ciphertext !== 'string' || document.ciphertext.length > 32000 || typeof document.ownerId !== 'string')
        throw new Error('앱 로그인 연결 응답을 확인하지 못했습니다.');
      const bytes = Uint8Array.from(atob(document.ciphertext), (value) => value.charCodeAt(0));
      const rawKey = Uint8Array.from(verifier.match(/../g)!, (value) => parseInt(value, 16));
      const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
      const session = parseNativeSession(JSON.parse(new TextDecoder().decode(plaintext)), apiBaseUrl);
      const checked = await fetch(`${apiBaseUrl}/session`, {
        headers: { Authorization: `Bearer ${session.accessToken}` }, signal: controller.signal, cache: 'no-store',
      });
      if (!checked.ok || (await checked.json() as { userId?: unknown }).userId !== document.ownerId)
        throw new Error('앱 로그인 계정을 확인하지 못했습니다.');
      return session;
    } finally { window.clearTimeout(timer); }
  })();
  return pending;
}
