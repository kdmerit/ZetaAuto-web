import { describe, expect, it } from 'vitest';

import { runBacktest } from './engine';
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
  volatilityK: '0.5',
};

describe('volatility breakout backtest', () => {
  it('uses the previous candle range and closes at the signal candle close', () => {
    const candles = Array.from({ length: 22 }, (_, index) => candle(index));
    candles[9] = candle(9, { high: 110, low: 90 });
    candles[10] = candle(10, { high: 120, low: 95, close: 115 });
    candles[11] = candle(11, { high: 110, low: 90 });
    candles[12] = candle(12, { high: 105, low: 80, close: 85 });

    const result = runBacktest(candles, settings, 'VOLATILITY');

    expect(result.signalCount).toBe(2);
    expect(result.entryCount).toBe(2);
    expect(result.closedTradeCount).toBe(2);
    expect(result.exitReasons.SESSION_CLOSE).toBe(2);
    expect(result.recentTrades[0]?.side).toBe('LONG');
    expect(result.recentTrades[0]?.entryPrice).toBeCloseTo(110.022);
    expect(result.recentTrades[0]?.exitPrice).toBeCloseTo(114.977);
    expect(result.recentTrades[1]?.side).toBe('SHORT');
  });

  it('skips a candle when both breakout directions are touched', () => {
    const candles = Array.from({ length: 20 }, (_, index) => candle(index));
    candles[8] = candle(8, { high: 110, low: 90 });
    candles[9] = candle(9, { high: 120, low: 80, close: 100 });

    const result = runBacktest(candles, settings, 'VOLATILITY');

    expect(result.signalCount).toBe(0);
    expect(result.entryCount).toBe(0);
  });
});
