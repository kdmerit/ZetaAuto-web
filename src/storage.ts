import type { BacktestResult, BacktestSettings, Candle, Strategy } from './types';

const settingsPrefix = 'zetaauto.web.backtest.settings.';
const resultsPrefix = 'zetaauto.web.backtest.result.';
const historyPrefix = 'zetaauto.web.backtest.history.';
export const chartMaStorageKey = 'zetaauto.web.chart.visibleMas';
const defaultChartMas = { ma5: true, ma10: false, ma20: true, ma60: false, ma120: false };
export type ChartMaVisibility = typeof defaultChartMas;
const historyRetentionMs = 30 * 24 * 60 * 60 * 1000;
const maxHistoryEntries = 100;
const candleCacheRetentionMs = 30 * 24 * 60 * 60 * 1000;
const candleCacheMaxBytes = 1024 * 1024 * 1024;
const candleCacheMaxRecords = 512;
const dbName = 'zetaauto-web-cache';
const dbVersion = 1;

export interface BacktestHistoryEntry {
  id: string;
  strategy: Strategy;
  savedAt: number;
  mode: BacktestSettings['mode'];
  symbol: string;
  interval: BacktestSettings['interval'];
  settings: BacktestSettings;
  result: BacktestResult;
  serverJobId: string | null;
}

export function loadChartMas(): ChartMaVisibility {
  const visibility = { ...defaultChartMas };
  try {
    const raw = localStorage.getItem(chartMaStorageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of Object.keys(visibility) as (keyof ChartMaVisibility)[]) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === 'boolean') visibility[key] = value;
      }
    }
  } catch {
    // A damaged value or unavailable storage must not prevent opening charts.
  }
  return visibility;
}

export function saveChartMas(visibility: ChartMaVisibility): void {
  try {
    localStorage.setItem(chartMaStorageKey, JSON.stringify(visibility));
  } catch {
    // Chart toggles still work when storage is unavailable or full.
  }
}

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

function isHistoryEntry(value: unknown): value is BacktestHistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<BacktestHistoryEntry>;
  return (
    typeof entry.id === 'string' &&
    (entry.strategy === 'PULLBACK' || entry.strategy === 'DISPARITY') &&
    typeof entry.savedAt === 'number' &&
    Number.isFinite(entry.savedAt) &&
    (entry.mode === 'SINGLE' || entry.mode === 'ALL') &&
    typeof entry.symbol === 'string' &&
    typeof entry.interval === 'string' &&
    Boolean(entry.settings) &&
    Boolean(entry.result)
  );
}

function loadStoredHistory(strategy: Strategy): BacktestHistoryEntry[] {
  try {
    const raw = localStorage.getItem(`${historyPrefix}${strategy}`);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - historyRetentionMs;
    const entries = parsed
      .filter(isHistoryEntry)
      .filter((entry) => entry.savedAt >= cutoff)
      .sort((left, right) => right.savedAt - left.savedAt);
    if (entries.length !== parsed.length) {
      try {
        localStorage.setItem(`${historyPrefix}${strategy}`, JSON.stringify(entries));
      } catch {
        // A full storage area should not hide otherwise readable history.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export function loadBacktestHistory(
  strategy: Strategy,
  mode: BacktestSettings['mode'],
  symbol: string,
): BacktestHistoryEntry[] {
  return loadStoredHistory(strategy).filter(
    (entry) => entry.mode === mode && entry.symbol === symbol,
  );
}

export function saveBacktestHistory(entry: BacktestHistoryEntry): void {
  try {
    const entries = [
      entry,
      ...loadStoredHistory(entry.strategy).filter((item) => item.id !== entry.id),
    ].slice(0, maxHistoryEntries);
    for (let length = entries.length; length > 0; length -= 1) {
      try {
        localStorage.setItem(
          `${historyPrefix}${entry.strategy}`,
          JSON.stringify(entries.slice(0, length)),
        );
        return;
      } catch {
        // If a large local result hits the quota, drop the oldest entry and retry.
      }
    }
  } catch {
    // Private browsing or quota errors should not block analysis.
  }
}

interface CandleRecord {
  cacheKey: string;
  candles: Candle[];
  savedAt: number;
}

function isCandleRecord(value: unknown): value is CandleRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CandleRecord>;
  return (
    typeof record.cacheKey === 'string' &&
    Array.isArray(record.candles) &&
    typeof record.savedAt === 'number' &&
    Number.isFinite(record.savedAt)
  );
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

function readAllCandleRecords(db: IDBDatabase): Promise<CandleRecord[]> {
  return new Promise((resolve) => {
    const transaction = db.transaction('candles', 'readonly');
    const request = transaction.objectStore('candles').getAll();
    request.onsuccess = () => {
      resolve((request.result as unknown[]).filter(isCandleRecord));
    };
    request.onerror = () => resolve([]);
  });
}

function recordBytes(record: CandleRecord): number {
  try {
    return JSON.stringify(record).length * 2;
  } catch {
    return 0;
  }
}

async function pruneCandleRecords(
  db: IDBDatabase,
  records: CandleRecord[],
): Promise<CandleRecord[]> {
  const cutoff = Date.now() - candleCacheRetentionMs;
  const candidates = records
    .filter((record) => record.savedAt >= cutoff)
    .sort((left, right) => right.savedAt - left.savedAt);
  const keep: CandleRecord[] = [];
  const remove = new Set<string>();
  let bytes = 0;

  for (const record of candidates) {
    const size = recordBytes(record);
    if (
      keep.length >= candleCacheMaxRecords ||
      size > candleCacheMaxBytes ||
      bytes + size > candleCacheMaxBytes
    ) {
      remove.add(record.cacheKey);
      continue;
    }
    keep.push(record);
    bytes += size;
  }
  for (const record of records) {
    if (!keep.some((item) => item.cacheKey === record.cacheKey)) {
      remove.add(record.cacheKey);
    }
  }
  if (remove.size === 0) return keep;

  await new Promise<void>((resolve) => {
    const transaction = db.transaction('candles', 'readwrite');
    const store = transaction.objectStore('candles');
    remove.forEach((cacheKey) => store.delete(cacheKey));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  return keep;
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

export async function loadCandleRange(
  symbol: string,
  interval: string,
  startAt: number,
  endAt: number,
): Promise<Candle[]> {
  const db = await openDatabase();
  if (!db) return [];
  const activeRecords = await pruneCandleRecords(db, await readAllCandleRecords(db));
  const prefix = `${symbol}:${interval}:`;
  const byTime = new Map<number, Candle>();
  activeRecords
    .filter((record) => record.cacheKey.startsWith(prefix))
    .flatMap((record) => record.candles)
    .filter((candle) => candle.openTime >= startAt && candle.openTime < endAt)
    .forEach((candle) => byTime.set(candle.openTime, candle));
  return [...byTime.values()].sort((left, right) => left.openTime - right.openTime);
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
    transaction.onabort = () => resolve();
  });
  await pruneCandleRecords(db, await readAllCandleRecords(db));
}

export const candleCacheKey = (
  symbol: string,
  interval: string,
  startAt: number,
  endAt: number,
): string => `${symbol}:${interval}:${startAt}:${endAt}`;
