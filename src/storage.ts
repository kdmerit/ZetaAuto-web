import type { BacktestResult, BacktestSettings, Candle, Strategy } from './types';
import { cacheCandles, maintainCache, readCandlePages } from './database';

const settingsPrefix = 'zetaauto.web.backtest.settings.';
const resultsPrefix = 'zetaauto.web.backtest.result.';
const historyPrefix = 'zetaauto.web.backtest.history.';
export const chartMaStorageKey = 'zetaauto.web.chart.visibleMas';
const defaultChartMas = { ma5: true, ma10: false, ma20: true, ma60: false, ma120: false };
export type ChartMaVisibility = typeof defaultChartMas;
const historyRetentionMs = 30 * 24 * 60 * 60 * 1000;
const maxHistoryEntries = 100;

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
  localRunId?: string;
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
    (entry.strategy === 'PULLBACK' || entry.strategy === 'DISPARITY' || entry.strategy === 'VOLATILITY' || entry.strategy === 'ENVELOPE') &&
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

export async function loadCandles(cacheKey: string): Promise<Candle[] | null> {
  const [symbol, interval, start, end] = cacheKey.split(':');
  if (!symbol || !interval) return null;
  return loadCandleRange(symbol, interval, Number(start), Number(end));
}

export async function loadCandleRange(
  symbol: string,
  interval: string,
  startAt: number,
  endAt: number,
): Promise<Candle[]> {
  try {
    await maintainCache();
    return await readCandlePages(symbol, interval, startAt, endAt);
  } catch { return []; }
}

export async function saveCandles(
  cacheKey: string,
  candles: Candle[],
): Promise<void> {
  const [symbol, interval] = cacheKey.split(':');
  if (!symbol || !interval) return;
  await cacheCandles(symbol, interval as BacktestSettings['interval'], candles);
}

export const candleCacheKey = (
  symbol: string,
  interval: string,
  startAt: number,
  endAt: number,
): string => `${symbol}:${interval}:${startAt}:${endAt}`;
