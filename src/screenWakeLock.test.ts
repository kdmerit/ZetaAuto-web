import { describe, expect, it, vi } from 'vitest';
import { keepAnalysisScreenAwake } from './screenWakeLock';

class TestPage extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  show(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

function sentinel() {
  const lock = Object.assign(new EventTarget(), {
    released: false, type: 'screen' as const, onrelease: null,
    release: vi.fn(async () => { lock.released = true; }),
  });
  return lock;
}

describe('backtest screen wake lock', () => {
  it('requests the visible screen once, releases it when hidden, and renews it on return', async () => {
    const page = new TestPage();
    const first = sentinel();
    const second = sentinel();
    const wakeLock = { request: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) };
    const stop = keepAnalysisScreenAwake(page, wakeLock);
    await Promise.resolve();
    expect(wakeLock.request).toHaveBeenCalledExactlyOnceWith('screen');
    page.show('visible');
    expect(wakeLock.request).toHaveBeenCalledTimes(1);
    page.show('hidden');
    expect(first.release).toHaveBeenCalledTimes(1);
    page.show('visible');
    await Promise.resolve();
    expect(wakeLock.request).toHaveBeenCalledTimes(2);
    stop();
    expect(second.release).toHaveBeenCalledTimes(1);
    page.show('hidden'); page.show('visible');
    expect(wakeLock.request).toHaveBeenCalledTimes(2);
  });

  it('releases a late request that resolves after the calculation finishes', async () => {
    const page = new TestPage();
    const lock = sentinel();
    let resolveRequest!: (value: WakeLockSentinel) => void;
    const request = vi.fn(() => new Promise<WakeLockSentinel>(resolve => { resolveRequest = resolve; }));
    const stop = keepAnalysisScreenAwake(page, { request });
    stop();
    resolveRequest(lock);
    await Promise.resolve();
    expect(lock.release).toHaveBeenCalledTimes(1);
  });
});
