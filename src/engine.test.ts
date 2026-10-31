import { describe, expect, it } from 'vitest';

import { prepareSymbolBlock, runBacktest } from './engine';
import type { BacktestSettings, Candle } from './types';

function candle(index: number, overrides: Partial<Candle> = {}): Candle {
  const openTime = Date.UTC(2026, 0, 1, index) / 1000;
  return {
    openTime,
    closeTime: openTime + 3600,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
    ...overrides,
  };
}

const settings: BacktestSettings = {
  mode: 'SINGLE',
  symbol: 'BTC',
  interval: '1h',
  startDate: '2026-01-01',
  startTime: '00:00',
  endDate: '2026-01-02',
  endTime: '00:00',
  initialCapitalUsdt: '1000',
  betAmountUsdt: '100',
  leverage: '1',
  side: 'BOTH',
  partialTpEnabled: false,
  fullTpWavePercent: '100',
  minDisparityPercent: '1.0',
  ma20HalfCloseEnabled: false,
  roiClosePercent: '100',
  minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1.0',
};

describe('volatility breakout backtest', () => {
  function rows(short = false): Candle[] {
    const candles = Array.from({ length: 22 }, (_, index) => candle(index));
    candles[8] = candle(8, { open: 104, high: 105, low: 99, close: 100 });
    candles[9] = candle(9, { open: 100, high: 110, low: 90, close: 105 });
    // R=20, permitted current close = [110,120]. The high already exceeds TP;
    // it is in the past when the confirmed-close entry is placed.
    candles[10] = candle(10, { open: 100, high: 140, low: 95, close: 115 });
    for (let index = 11; index < candles.length; index++) candles[index] = candle(index, { open: 115, high: 121, low: 100, close: 116 });
    return short ? candles.map(row => ({ ...row, open: 200 - row.open, high: 200 - row.low, low: 200 - row.high, close: 200 - row.close })) : candles;
  }
  function signals(candles: Candle[], overrides: Partial<BacktestSettings> = {}) {
    return prepareSymbolBlock('BTCUSDT', candles, { ...settings, ...overrides }, 'VOLATILITY', candles[0]!.openTime, candles.at(-1)!.closeTime).bars.flatMap(bar => bar.signal ? [bar.signal] : []);
  }

  it.each([false, true])('uses the mirrored three-bar pattern, close band and prior range, short=%s', short => {
    const signal = signals(rows(short));
    expect(signal).toHaveLength(1);
    expect(signal[0]).toMatchObject({ side: short ? 'SHORT' : 'LONG', entry: short ? 85 : 115, breakoutRange: 20, volatilityK1: 0.5, volatilityK2: 1, exitMode: 'VOLATILITY_CLOSE', target: short ? 65 : 135 });
  });

  it.each([110, 120])('includes the K1/K2 boundaries at close=%s', close => {
    const candles = rows();
    candles[10]!.close = close;
    expect(signals(candles)).toHaveLength(1);
  });

  it.each([109.99, 120.01])('rejects a close outside the band even when the wick touched it, close=%s', close => {
    const candles = rows(); candles[10]!.close = close;
    expect(signals(candles)).toHaveLength(0);
  });

  it.each([8, 9, 10])('requires all three strict candle directions (not a doji), index=%s', index => {
    const candles = rows(); candles[index]!.close = candles[index]!.open;
    expect(signals(candles)).toHaveLength(0);
  });

  it.each([false, true])('requires a strict higher low/lower high, short=%s', short => {
    const candles = rows(short);
    if (short) candles[10]!.high = candles[9]!.high;
    else candles[10]!.low = candles[9]!.low;
    expect(signals(candles)).toHaveLength(0);
  });

  it('enforces the minimum percentage against the prior close, inclusive at the threshold', () => {
    const candles = rows();
    candles[9] = candle(9, { open: 100, low: 100, high: 110, close: 105 });
    candles[10] = candle(10, { open: 105, low: 101, high: 120, close: 112 });
    expect(signals(candles, { minVolatilityPercent: '10' })).toHaveLength(0);
    expect(signals(candles, { minVolatilityPercent: String(10 / 105 * 100) })).toHaveLength(1);
  });

  it('honours side selection and does not use future candles to decide entry', () => {
    expect(signals(rows(), { side: 'SHORT' })).toHaveLength(0);
    const candles = rows();
    expect(signals(candles.slice(0, 11))).toEqual(signals(candles));
  });

  it.each([false, true])('does not same-bar exit or stop at entry; waits for a later qualifying close, short=%s', short => {
    const candles = rows(short);
    const fill = short ? 85 * 0.9998 : 115 * 1.0002;
    candles[12] = candle(12, short
      ? { open: 85, high: 90, low: 73, close: 74 }
      : { open: 115, high: 128, low: 114, close: 126 });
    const result = runBacktest(candles, settings, 'VOLATILITY');
    expect(result.entryCount).toBe(1);
    expect(result.closedTradeCount).toBe(1);
    expect(result.exitReasons).toEqual({ VOLATILITY_CLOSE: 1 });
    expect(result.recentTrades[0]?.entryPrice).toBeCloseTo(fill);
    expect(result.recentTrades[0]?.exitPrice).toBeCloseTo(short ? 74 * 1.0002 : 126 * 0.9998);
    expect(result.recentTrades[0]?.exitAt).toBe(candles[12]!.closeTime);
  });

  it.each([false, true])('takes the full one-range TP intrabar and retains no SL/partial orders, short=%s', short => {
    const candles = rows(short);
    candles[11] = candle(11, short ? { open: 85, high: 90, low: 60, close: 80 } : { open: 115, high: 140, low: 110, close: 120 });
    const result = runBacktest(candles, { ...settings, partialTpEnabled: true }, 'VOLATILITY');
    expect(result.exitReasons).toEqual({ FULL_TP: 1 });
    expect(result.recentTrades[0]?.exitPrice).toBeCloseTo((short ? 85 * 0.9998 - 20 : 115 * 1.0002 + 20));
  });
});
