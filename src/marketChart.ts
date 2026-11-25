import { intervalSeconds } from './api';
import { chartAtrPeriod } from './atr';
import { maintainCache } from './database';
import { readChartCandleBatch, type Instrument } from './marketData';
import { enrichMarketCandles } from './marketIndicators';
import type { BacktestInterval, ChartData } from './types';

const pageSize = 300;

export function normalizeChartQuery(value: string): string { return value.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 40); }
export class NoMarketCandlesError extends Error { constructor() { super('이 기간에 표시할 완성 캔들이 없습니다.'); this.name = 'NoMarketCandlesError'; } }
export function matchingChartInstruments(rows: Instrument[], query: string): Instrument[] {
  const prefix = normalizeChartQuery(query);
  return prefix ? rows.filter(row => row.symbol.endsWith('USDT') && row.symbol.startsWith(prefix)) : [];
}

export function marketChartWindow(interval: BacktestInterval, options: { focusAt?: number; now?: number } = {}) {
  const seconds = intervalSeconds(interval);
  const currentStart = Math.floor((options.now ?? Date.now() / 1000) / seconds) * seconds;
  const latestEnd = currentStart + seconds;
  const focus = Math.min(Math.floor((options.focusAt ?? currentStart) / seconds) * seconds, currentStart);
  const end = Math.min(latestEnd, focus + 160 * seconds);
  return { end, focus, includesCurrent: end > currentStart };
}

export async function loadMarketChart(instrument: Instrument, interval: BacktestInterval, options: { focusAt?: number; signal?: AbortSignal } = {}): Promise<ChartData> {
  options.signal?.throwIfAborted();
  await maintainCache();
  const window = marketChartWindow(interval, options);
  const rows = await readChartCandleBatch(instrument, interval, window.end, options.signal, window.includesCurrent);
  options.signal?.throwIfAborted();
  const candles = enrichMarketCandles(rows, interval, chartAtrPeriod).slice(-pageSize);
  if (!candles.length) throw new NoMarketCandlesError();
  const index = candles.findIndex(candle => candle.openTime === window.focus);
  const referenceIndex = index >= 0 ? index : candles.length - 1;
  return { symbol: instrument.symbol, interval, side: null, referenceAt: new Date(candles[referenceIndex]!.openTime * 1000).toISOString(), referenceIndex,
    candles, market: { sourceCandles: rows }, markers: [], executions: [], waves: [], priceLines: [] };
}

/** Reveal one page from the buffer, extending it only when fewer than 300 older bars remain. */
export async function loadOlderMarketChart(
  instrument: Instrument,
  current: ChartData,
  signal?: AbortSignal,
): Promise<{ chart: ChartData; hasOlder: boolean }> {
  const buffer = current.market?.sourceCandles;
  if (!buffer?.length || current.symbol !== instrument.symbol) return { chart: current, hasOlder: false };
  const remaining = buffer.length - current.candles.length;
  const needsBatch = remaining < pageSize;
  const older = needsBatch ? await readChartCandleBatch(instrument, current.interval, buffer[0]!.openTime, signal) : [];
  signal?.throwIfAborted();
  const sourceCandles = older.length ? [...older, ...buffer] : buffer;
  const added = Math.min(pageSize, remaining + older.length);
  if (!added) return { chart: current, hasOlder: false };
  const candles = enrichMarketCandles(sourceCandles, current.interval, chartAtrPeriod).slice(-(current.candles.length + added));
  return {
    chart: { ...current, candles, market: { sourceCandles }, referenceIndex: current.referenceIndex === null ? null : current.referenceIndex + added },
    hasOlder: !needsBatch || older.length > 0,
  };
}
