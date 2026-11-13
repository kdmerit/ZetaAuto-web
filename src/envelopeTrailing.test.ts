import { describe, expect, it } from 'vitest';
import type { PreparedBar, PreparedSymbol } from './engine';
import { currentEnvelopeSettings, envelopeParameters } from './envelope';
import { initialPortfolio, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle } from './types';

const start = Date.UTC(2026, 10, 1) / 1000;
const base = currentEnvelopeSettings({ side: 'LONG', interval: '1h', initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '7',
  envelopeMaPeriod: '3', envelopeDeviationPercent: '3', envelopeStopLossPercent: '20',
  envelopeTrailingStopEnabled: true } as BacktestSettings);

function parent(index: number, prices: number[][], side: 'LONG' | 'SHORT' = 'LONG'): PreparedBar {
  const children = prices.map((values, i): Candle => {
    const [o, h, l, c] = values as [number, number, number, number];
    const mirrored = side === 'SHORT';
    return { openTime: start + index * 3600 + i * 900, closeTime: start + index * 3600 + (i + 1) * 900,
      open: mirrored ? 200 - o : o, high: mirrored ? 200 - l : h,
      low: mirrored ? 200 - h : l, close: mirrored ? 200 - c : c, volume: 1 };
  });
  return { candle: { openTime: children[0]!.openTime, closeTime: children.at(-1)!.closeTime,
    open: children[0]!.open, high: Math.max(...children.map(c => c.high)), low: Math.min(...children.map(c => c.low)),
    close: children.at(-1)!.close, volume: children.length }, signal: null, ma20: 100, ma60Exit: null,
    envelope: { center: 100, lower: side === 'LONG' ? 100 : 1, upper: side === 'LONG' ? 199 : 100,
      long: side === 'LONG', short: side === 'SHORT' }, envelopeIntrabarCandles: children };
}
const entryPrices = [[120, 130, 119, 120], [120, 121, 110, 111], [111, 112, 101, 101], [101, 101, 100, 100.5]];
const profitPrices = [[100.5, 110, 100.5, 109], [109, 109.5, 106, 108], [108, 108, 108, 108], [108, 108, 108, 108]];
function run(bars: PreparedBar[], settings = base) {
  const state = initialPortfolio(1000);
  const document: PreparedSymbol = { symbol: 'BTCUSDT', bars };
  replayPortfolioBlock(state, [document], settings, start, bars.at(-1)!.candle.closeTime, 3600);
  return state;
}

describe('single-stage envelope trailing replay through 15m candles', () => {
  it.each(['LONG', 'SHORT'] as const)('uses only post-entry extremes, a fixed 3-percent price distance, and survives resume: %s', side => {
    const settings = { ...base, side };
    const first = parent(0, entryPrices, side);
    const state = run([first], settings);
    const position = state.positions.BTCUSDT!;
    expect(state.closed).toBe(0);
    expect(position.envelopeTrailingExtreme).toBe(side === 'LONG' ? 101 : 99.5);
    const distance = position.entry * .03;
    expect(position.envelopeTrailingDistance).toBeCloseTo(distance, 10);
    const resumed = JSON.parse(JSON.stringify(state));
    const next = parent(1, profitPrices, side);
    replayPortfolioBlock(resumed, [{ symbol: 'BTCUSDT', bars: [next] }], settings, start + 3600, start + 7200, 3600);
    expect(resumed.exitReasons).toEqual({ TRAILING_STOP: 1 });
    const expectedStop = side === 'LONG' ? 110 - distance : 90 + distance;
    expect(resumed.trades[0].exitPrice).toBeCloseTo(expectedStop * (side === 'LONG' ? .9998 : 1.0002), 8);
    expect(resumed.trades[0].signal.envelopeTrailingStopPercent).toBe(3);
    expect(resumed.trades[0].priceLines).toContainEqual({ kind: 'TRAILING_SL', price: expectedStop });
  });

  it.each(['LONG', 'SHORT'] as const)('fills an adverse gap at its actual open: %s', side => {
    const gap = [[90, 91, 89, 90], [90, 90, 90, 90], [90, 90, 90, 90], [90, 90, 90, 90]];
    const state = run([parent(0, entryPrices, side), parent(1, gap, side)], { ...base, side });
    expect(state.exitReasons).toEqual({ TRAILING_STOP: 1 });
    expect(state.trades[0]!.exitPrice).toBeCloseTo(side === 'LONG' ? 90 * .9998 : 110 * 1.0002, 8);
  });

  it('keeps the fixed SL when trailing is disabled and ignores dormant invalid rates', () => {
    const settings = { ...base, envelopeTrailingStopEnabled: false, envelopeTrailingStopPercent: 'bad' };
    expect(() => envelopeParameters(settings)).not.toThrow();
    const state = run([parent(0, entryPrices), parent(1, profitPrices)], settings);
    expect(state.closed).toBe(0);
    expect(state.positions.BTCUSDT!.envelopeTrailingStop).toBeUndefined();
    const stopped = run([parent(0, [[101, 101, 95, 96], [96, 96, 96, 96], [96, 96, 96, 96], [96, 96, 96, 96]])],
      { ...settings, envelopeStopLossPercent: '3' });
    expect(stopped.exitReasons).toEqual({ SL: 1 });
  });

  it('keeps chronological sub-bars instead of the adverse parent OHLC path', () => {
    const rising = [[100.5, 102, 100.5, 102], [102, 104, 102, 104], [104, 106, 104, 106], [106, 108, 106, 108]];
    const state = run([parent(0, entryPrices), parent(1, rising)]);
    expect(state.closed).toBe(0);
    expect(state.positions.BTCUSDT!.envelopeTrailingExtreme).toBe(108);
  });

  it.each(['LONG', 'SHORT'] as const)('applies the same trailing rule with the coupled 50-percent allocation: %s', side => {
    const bars = [parent(0, entryPrices, side), parent(1, profitPrices, side)];
    const ordinary = run(bars, { ...base, side });
    const limited = run(bars, { ...base, side, envelopeSideRatio50Enabled: true });
    expect(limited.exitReasons).toEqual({ TRAILING_STOP: 1 });
    expect(limited.trades[0]!.exitPrice).toBeCloseTo(ordinary.trades[0]!.exitPrice, 8);
  });

  it('rejects missing or damaged 15m data rather than guessing from a daily/1h range', () => {
    const missing = parent(0, entryPrices);
    delete missing.envelopeIntrabarCandles;
    expect(() => run([missing])).toThrow('15분봉');
    const invalid = parent(0, entryPrices);
    invalid.envelopeIntrabarCandles!.pop();
    expect(() => run([invalid])).toThrow('15분봉');
  });

  it.each(['0', '0.9', '100.1', '3.01', 'NaN'])('validates enabled trailing distance %s', value => {
    expect(() => envelopeParameters({ ...base, envelopeTrailingStopPercent: value })).toThrow('트레일링');
  });
});
