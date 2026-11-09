import { describe, expect, it } from 'vitest';
import type { PreparedSymbol } from './engine';
import { currentEnvelopeSettings } from './envelope';
import { initialPortfolio, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle } from './types';

const start = Date.UTC(2026, 1, 1) / 1000;
const base = currentEnvelopeSettings({ side: 'LONG', initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1', envelopeMaPeriod: '5', envelopeDeviationPercent: '1' } as BacktestSettings);
const bar = (index: number, prices: number[], lower = 99, upper = 101) => ({
  candle: { openTime: start + index * 3600, closeTime: start + (index + 1) * 3600, open: prices[0]!, high: prices[1]!, low: prices[2]!, close: prices[3]!, volume: 1 } satisfies Candle,
  signal: null, ma20: 100, ma60Exit: null, envelope: { center: 100, lower, upper, long: true, short: false },
});

describe('envelope held positions', () => {
  it('follows the current opposite band while retaining its original stop', () => {
    const document: PreparedSymbol = { symbol: 'BTCUSDT', bars: [bar(0, [100, 100, 99, 100]), bar(1, [100, 101.5, 99.5, 101], 99, 102), bar(2, [101, 102, 100, 101], 99, 102)] };
    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [document], base, start, start + 7200, 3600);
    expect(state.closed).toBe(0); expect(state.positions.BTCUSDT!.target).toBe(102);
    const stop = state.positions.BTCUSDT!.stop;
    const resumed = structuredClone(state);
    replayPortfolioBlock(resumed, [document], base, start + 7200, start + 10800, 3600);
    expect(resumed.exitReasons).toEqual({ ENVELOPE_OPPOSITE: 1 }); expect(resumed.trades[0]!.signal.stop).toBe(stop);
  });

  it('fills an adverse opening gap at the open and does not reenter the same bar', () => {
    const document: PreparedSymbol = { symbol: 'BTCUSDT', bars: [bar(0, [100, 100, 99, 100]), bar(1, [97, 101, 96, 100])] };
    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [document], base, start, start + 7200, 3600);
    expect(state.exitReasons).toEqual({ SL: 1 }); expect(state.entries).toBe(1);
    expect(state.trades[0]!.exitPrice).toBeCloseTo(97 * .9998, 10);
  });
});
