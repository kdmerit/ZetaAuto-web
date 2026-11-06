import { describe, expect, it } from 'vitest';
import type { PreparedSymbol } from './engine';
import { currentEnvelopeSettings } from './envelope';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle } from './types';

const start = Date.UTC(2026, 1, 1) / 1000;
const settings = currentEnvelopeSettings({ mode: 'SINGLE', symbol: 'BTC', interval: '1h', side: 'LONG', initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1', envelopeMaPeriod: '5', envelopeDeviationPercent: '1' } as BacktestSettings);
function document(side: 'LONG' | 'SHORT' = 'LONG'): PreparedSymbol {
  const values = side === 'LONG'
    ? [[99.5, 100.4, 99.5, 99.8], [100, 100.2, 99.8, 100]]
    : [[100.5, 100.5, 99.6, 100.2], [100, 100.2, 99.8, 100]];
  const bars = values.map((value, index) => {
    const candle: Candle = { openTime: start + index * 3600, closeTime: start + (index + 1) * 3600, open: value[0]!, high: value[1]!, low: value[2]!, close: value[3]!, volume: 1 };
    return { candle, signal: null, ma20: null, ma60Exit: null, envelope: { center: 100, lower: 99, upper: 101, long: side === 'LONG', short: side === 'SHORT', priorUpperTouch: side === 'LONG', priorLowerTouch: side === 'SHORT' } };
  });
  return { symbol: 'BTCUSDT', bars };
}
function run(side: 'LONG' | 'SHORT'): ReturnType<typeof portfolioResult> {
  const parameters = { ...settings, side }; const state = initialPortfolio(1000);
  replayPortfolioBlock(state, [document(side)], parameters, start, start + 2 * 3600, 3600);
  return portfolioResult(state, parameters);
}

describe('envelope centre-line entries', () => {
  it.each(['LONG', 'SHORT'] as const)('does not close %s merely at a later centre-line touch', side => {
    const result = run(side);
    expect(result.entryCount).toBe(1); expect(result.closedTradeCount).toBe(0); expect(result.openPositionCount).toBe(1);
  });
  it.each(['LONG', 'SHORT'] as const)('uses the opposite band from the entry candle rather than a later moving band', side => {
    const doc = document(side); const second = doc.bars[1]!;
    second.envelope = { ...second.envelope!, center: side === 'LONG' ? 110 : 90, lower: side === 'LONG' ? 109 : 89, upper: side === 'LONG' ? 111 : 91 };
    const parameters = { ...settings, side }; const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [doc], parameters, start, start + 2 * 3600, 3600);
    const result = portfolioResult(state, parameters);
    expect(result.closedTradeCount).toBe(0); expect(result.openPositionCount).toBe(1);
    expect(state.positions.BTCUSDT!.target).toBe(side === 'LONG' ? 101 : 99);
    expect(state.positions.BTCUSDT!.stop).toBe(side === 'LONG' ? 99 : 101);
  });
});
