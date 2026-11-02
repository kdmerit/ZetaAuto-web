import { describe, expect, it } from 'vitest';
import { calendarAtr, trueRange } from './atr';
import { enrichMarketCandles } from './marketIndicators';
import { intervalSeconds } from './api';
import type { BacktestInterval, Candle } from './types';

const candles = (interval: BacktestInterval, count: number): Candle[] => {
  const step = intervalSeconds(interval);
  return Array.from({ length: count }, (_, i) => ({ openTime: i * step, closeTime: (i + 1) * step, open: 100, high: 101, low: 99, close: 100, volume: 100 }));
};
describe('twenty calendar day simple ATR', () => {
  it.each(['15m', '1h', '4h', '1d'] as const)('uses twenty days, not twenty %s bars or Wilder smoothing', interval => {
    const count = 20 * 86400 / intervalSeconds(interval); const rows = candles(interval, count + 5);
    rows.at(-1)!.high = 201;
    const before = calendarAtr(rows, interval); const display = calendarAtr(rows, interval, true);
    expect(before.at(-1)).toEqual({ value: 2, samples: count, expected: count, complete: true });
    expect(display.at(-1)!.value).toBeCloseTo((count * 2 + 100) / count, 10);
    expect(display.at(-1)!.samples).toBe(count); expect(display.at(-1)!.value).not.toBe(102);
  });
  it('uses the previous close for gaps and drops samples beyond the calendar boundary', () => {
    const rows = candles('1d', 22); rows[0]!.high = 200;
    rows[21] = { ...rows[21]!, open: 110, high: 112, low: 109, close: 111 };
    expect(trueRange(rows[21]!, 100)).toBe(12);
    expect(calendarAtr(rows, '1d').at(-1)!.value).toBe(2);
    expect(calendarAtr(rows, '1d', true).at(-1)!.value).toBe(2.5);
  });
  it('never uses the current/future candle in the execution ATR and identifies partial history', () => {
    const rows = candles('1h', 483); const at = 481; const original = calendarAtr(rows, '1h')[at];
    rows[at]!.high = 5000; rows[at + 1]!.high = 10000;
    expect(calendarAtr(rows, '1h')[at]).toEqual(original);
    expect(calendarAtr(rows.slice(0, 100), '1h').at(-1)).toEqual({ value: 2, samples: 99, expected: 480, complete: false });
    expect(calendarAtr(rows, '1h')[0]!.value).toBeNull();
  });
  it('keeps display ATR independent of the configurable Wilder ATR envelope', () => {
    const rows = candles('1h', 500); rows.at(-1)!.high = 149;
    const value = enrichMarketCandles(rows, '1h').at(-1)!.marketMetrics!;
    expect(value.averageTrueRange20d).toBeCloseTo(2.1); expect(value.atrPercent).toBeCloseTo(2.1);
    expect(value.trueRange).toBe(50); expect(value.atrSamples).toBe(480);
  });
});
