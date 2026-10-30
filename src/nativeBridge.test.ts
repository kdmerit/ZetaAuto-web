import { afterEach, describe, expect, it, vi } from 'vitest';
import { isEmbeddedWebView, parseNativeSession, requestNativeSession, subscribeNativeBack } from './nativeBridge';

const baseUrl = 'https://api.example.com/dev';
const sampleSession = () => ({
  accessToken: 'unit-test-access-value', email: ' Test@Example.com ',
  expiresAt: Date.now() + 3600_000, apiBaseUrl: baseUrl,
});

function setupHost(receive: (message: string) => void): { page: EventTarget; document: EventTarget } {
  const page = Object.assign(new EventTarget(), {
    location: { search: '?embedded=1' },
    ReactNativeWebView: { postMessage: receive },
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  });
  const document = new EventTarget();
  vi.stubGlobal('window', page);
  vi.stubGlobal('document', document);
  return { page, document };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('native authentication channel', () => {
  it('rejects expired sessions and a different backend, and drops all additional fields', () => {
    expect(() => parseNativeSession({ ...sampleSession(), expiresAt: 0 }, baseUrl)).toThrow();
    expect(() => parseNativeSession(sampleSession(), 'https://other.example.com')).toThrow();
    const parsed = parseNativeSession({ ...sampleSession(), refreshToken: 'never-forward-this' }, baseUrl);
    expect(parsed.email).toBe('test@example.com');
    expect(parsed).not.toHaveProperty('refreshToken');
  });

  it('accepts only the correlated reply on the Android message target', async () => {
    let request: Record<string, unknown> = {};
    const { document } = setupHost((message) => { request = JSON.parse(message); });
    expect(isEmbeddedWebView()).toBe(true);
    const pending = requestNativeSession(baseUrl, true);
    const response = { channel: 'zetaauto.backtest', version: 1, type: 'SESSION', requestId: request.requestId, session: sampleSession() };
    document.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ ...response, requestId: 'wrong-request' }) }));
    document.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(response) }));
    expect(request).toMatchObject({ type: 'SESSION_REQUEST', forceRefresh: true });
    await expect(pending).resolves.toMatchObject({ accessToken: 'unit-test-access-value' });
  });

  it('times out a missing host response without falling back to an OAuth redirect', async () => {
    vi.useFakeTimers();
    setupHost(() => undefined);
    const pending = requestNativeSession(baseUrl);
    const rejected = expect(pending).rejects.toThrow('연결 시간이 초과');
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
  });

  it('handles a native back request exactly once and unsubscribes', () => {
    const { document } = setupHost(() => undefined);
    const listener = vi.fn();
    const unsubscribe = subscribeNativeBack(listener);
    const message = JSON.stringify({ channel: 'zetaauto.backtest', version: 1, type: 'GO_BACK' });
    document.dispatchEvent(new MessageEvent('message', { data: message }));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    document.dispatchEvent(new MessageEvent('message', { data: message }));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
