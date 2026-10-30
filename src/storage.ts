import type { BacktestResult, BacktestSettings, Candle, Strategy } from './types';

const settingsPrefix = 'zetaauto.web.backtest.settings.';
const resultsPrefix = 'zetaauto.web.backtest.result.';
const dbName = 'zetaauto-web-cache';
const dbVersion = 1;

export function loadSettings(
  strategy: Strategy,
  fallback: BacktestSettings,
): BacktestSettings {
  try {
    const raw = localStorage.getItem(`${settingsPrefix}${strategy}`);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    return { ...fallback, ...(parsed as Partial<BacktestSettings>) };
  } catch {
    return fallback;
  }
}

export function saveSettings(
  strategy: Strategy,
  settings: BacktestSettings,
): void {
  try {
    localStorage.setItem(
      `${settingsPrefix}${strategy}`,
      JSON.stringify(settings),
    );
  } catch {
    // Private browsing or quota errors should not block analysis.
  }
}

export function loadCachedResult(strategy: Strategy): BacktestResult | null {
  try {
    const raw = localStorage.getItem(`${resultsPrefix}${strategy}`);
    return raw ? (JSON.parse(raw) as BacktestResult) : null;
  } catch {
    return null;
  }
}

export function saveCachedResult(strategy: Strategy, result: BacktestResult): void {
  try {
    localStorage.setItem(`${resultsPrefix}${strategy}`, JSON.stringify(result));
  } catch {
    // Result caching is best effort.
  }
}

interface CandleRecord {
  cacheKey: string;
  candles: Candle[];
  savedAt: number;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(dbName, dbVersion);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('candles')) {
        db.createObjectStore('candles', { keyPath: 'cacheKey' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

export async function loadCandles(cacheKey: string): Promise<Candle[] | null> {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise((resolve) => {
    const transaction = db.transaction('candles', 'readonly');
    const request = transaction.objectStore('candles').get(cacheKey);
    request.onsuccess = () => {
      const record = request.result as CandleRecord | undefined;
      resolve(record?.candles ?? null);
    };
    request.onerror = () => resolve(null);
  });
}

export async function saveCandles(
  cacheKey: string,
  candles: Candle[],
): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction('candles', 'readwrite');
    transaction.objectStore('candles').put({
      cacheKey,
      candles,
      savedAt: Date.now(),
    } satisfies CandleRecord);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
  });
}

export const candleCacheKey = (
  symbol: string,
  interval: string,
  startAt: number,
  endAt: number,
): string => `${symbol}:${interval}:${startAt}:${endAt}`;
