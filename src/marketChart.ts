import { intervalSeconds } from './api';
import { maintainCache } from './database';
import { ensureCandles, type Instrument } from './marketData';
import { enrichMarketCandles, volumeWindowSeconds } from './marketIndicators';
import type { BacktestInterval, ChartData } from './types';

export function normalizeChartQuery(value: string): string { return value.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 40); }
export class NoMarketCandlesError extends Error { constructor() { super('이 기간에 표시할 완성 캔들이 없습니다.'); this.name = 'NoMarketCandlesError'; } }
export function matchingChartInstruments(rows: Instrument[], query: string): Instrument[] {
  const prefix = normalizeChartQuery(query);
  return prefix ? rows.filter(row => row.symbol.endsWith('USDT') && row.symbol.startsWith(prefix)) : [];
}

export function marketChartWindow(interval: BacktestInterval, options: { focusAt?: number; beforeAt?: number; now?: number } = {}) {
  const seconds = intervalSeconds(interval);
  const latestEnd = Math.floor((options.now ?? Date.now() / 1000) / seconds) * seconds;
  const focus = Math.min(Math.floor((options.focusAt ?? latestEnd - seconds) / seconds) * seconds, latestEnd - seconds);
  const end = Math.min(options.beforeAt ?? Math.min(latestEnd, focus + 160 * seconds), latestEnd);
  const start = end - 300 * seconds;
  // 600 bars stabilize the largest allowed EMA120/ATR120; 120 calendar days serve volume readouts.
  return { start, end, warmupStart: start - Math.max(volumeWindowSeconds, 600 * seconds), focus };
}

export async function loadMarketChart(instrument: Instrument, interval: BacktestInterval, options: { focusAt?: number; beforeAt?: number; signal?: AbortSignal } = {}): Promise<ChartData> {
  options.signal?.throwIfAborted();
  await maintainCache();
  const window = marketChartWindow(interval, options);
  const rows = await ensureCandles(instrument, interval, window.warmupStart, window.end, window.end, options.signal);
  options.signal?.throwIfAborted();
  const candles = enrichMarketCandles(rows, interval).filter(candle => candle.openTime >= window.start && candle.openTime < window.end);
  if (!candles.length) throw new NoMarketCandlesError();
  const index = candles.findIndex(candle => candle.openTime === window.focus);
  const referenceIndex = index >= 0 ? index : candles.length - 1;
  return { symbol: instrument.symbol, interval, side: null, referenceAt: new Date(candles[referenceIndex]!.openTime * 1000).toISOString(), referenceIndex,
    candles, market: { sourceCandles: rows }, markers: [], executions: [], waves: [], priceLines: [] };
}

/** Merge only adjacent/overlapping market pages; retain warmup for full-window metrics and local indicators. */
export function mergeMarketChartPages(older: ChartData, current: ChartData): ChartData {
  if (!older.market || !current.market || older.symbol !== current.symbol || older.interval !== current.interval) throw new Error('서로 다른 차트 구간은 합칠 수 없습니다.');
  if (older.candles.at(-1)!.closeTime < current.candles[0]!.openTime) throw new Error('차트 구간 사이에 누락된 캔들이 있습니다.');
  const sourceCandles = [...new Map([...older.market.sourceCandles, ...current.market.sourceCandles].map(candle => [candle.openTime, candle])).values()].sort((a, b) => a.openTime - b.openTime);
  const first = Math.min(older.candles[0]!.openTime, current.candles[0]!.openTime);
  const last = Math.max(older.candles.at(-1)!.openTime, current.candles.at(-1)!.openTime);
  const candles = enrichMarketCandles(sourceCandles, current.interval).filter(candle => candle.openTime >= first && candle.openTime <= last);
  const at = current.candles[current.referenceIndex ?? 0]?.openTime;
  return { ...current, candles, market: { sourceCandles }, referenceIndex: candles.findIndex(candle => candle.openTime === at) };
}
