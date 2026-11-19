import { useEffect } from 'react';

type VisibleDocument = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

export function keepAnalysisScreenAwake(page: VisibleDocument, wakeLock: WakeLock): () => void {
  let disposed = false;
  let pending = false;
  let visibilityChange = 0;
  let held: WakeLockSentinel | undefined;

  const release = (sentinel: WakeLockSentinel | undefined): void => {
    if (sentinel && !sentinel.released) void sentinel.release().catch(() => {});
  };
  const acquire = async (): Promise<void> => {
    if (disposed || pending || held && !held.released || page.visibilityState !== 'visible') return;
    const revision = visibilityChange;
    pending = true;
    try {
      const sentinel = await wakeLock.request('screen');
      if (disposed || page.visibilityState !== 'visible') release(sentinel);
      else held = sentinel;
    } catch { /* Battery saver or browser policy can decline the request. */ }
    finally {
      pending = false;
      if (revision !== visibilityChange) void acquire();
    }
  };

  const onVisibility = (): void => {
    visibilityChange += 1;
    if (page.visibilityState === 'visible') void acquire();
    else { release(held); held = undefined; }
  };
  page.addEventListener('visibilitychange', onVisibility);
  void acquire();
  return () => {
    disposed = true;
    page.removeEventListener('visibilitychange', onVisibility);
    release(held);
  };
}

export function useBacktestScreenWakeLock(active: boolean): void {
  useEffect(() => {
    return active && navigator.wakeLock ? keepAnalysisScreenAwake(document, navigator.wakeLock) : undefined;
  }, [active]);
}
