import { intervalSeconds } from './api';
import type { BacktestInterval, Candle } from './types';

export const atrWindowSeconds = 20 * 86400;
export function trueRange(candle: Candle, previousClose?: number): number {
  return previousClose === undefined ? candle.high - candle.low
    : Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
}

export const chartAtrPeriod = 14;

/** Standalone display ATR includes the selected bar in its rolling TR mean. */
export function chartAtr14(candles: Candle[]) {
  const ranges = candles.map((candle, index) => trueRange(candle, candles[index - 1]?.close));
  let sum = 0;
  return ranges.map((range, index) => {
    sum += range;
    if (index >= chartAtrPeriod) sum -= ranges[index - chartAtrPeriod]!;
    const samples = Math.min(index + 1, chartAtrPeriod);
    return { value: Math.max(0, sum) / samples, samples, expected: chartAtrPeriod };
  });
}

/** Calendar-day SMA of TR, not Wilder ATR20 and not twenty intraday bars. */
export function calendarAtr(candles: Candle[], interval: BacktestInterval, includeCurrent = false) {
  const ranges = candles.map((candle, index) => trueRange(candle, candles[index - 1]?.close));
  const expected = atrWindowSeconds / intervalSeconds(interval);
  let left = 0; let sum = 0;
  return candles.map((candle, index) => {
    if (includeCurrent) sum += ranges[index]!;
    const end = includeCurrent ? candle.closeTime : candle.openTime;
    const limit = includeCurrent ? index + 1 : index;
    while (left < limit && candles[left]!.openTime < end - atrWindowSeconds) sum -= ranges[left++]!;
    const samples = limit - left;
    const value = samples ? Math.max(0, sum) / samples : null;
    if (!includeCurrent) sum += ranges[index]!;
    return { value, samples, expected, complete: samples === expected };
  });
}
