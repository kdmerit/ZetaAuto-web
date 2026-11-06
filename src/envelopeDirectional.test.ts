import { describe, expect, it } from 'vitest';
import type { PreparedSymbol } from './engine';
import { currentEnvelopeSettings } from './envelope';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle } from './types';

const start = Date.UTC(2026, 1, 1) / 1000;
const settings = currentEnvelopeSettings({ mode: 'SINGLE', symbol: 'BTC', interval: '1h', side: 'LONG', initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1', envelopeMaPeriod: '5', envelopeDeviationPercent: '1' } as BacktestSettings);
function document(side: 'LONG' | 'SHORT'): PreparedSymbol {
  const values = side === 'LONG' ? [[99.5, 100.4, 99.5, 99.8], [100, 101.2, 99.8, 101]] : [[100.5, 100.5, 99.6, 100.2], [100, 100.2, 98.8, 99]];
  return { symbol: 'BTCUSDT', bars: values.map((value, index) => {
    const candle: Candle = { openTime: start + index * 3600, closeTime: start + (index + 1) * 3600, open: value[0]!, high: value[1]!, low: value[2]!, close: value[3]!, volume: 1 };
    return { candle, signal: null, ma20: null, ma60Exit: null, envelope: { center: 100, lower: 99, upper: 101, long: side === 'LONG', short: side === 'SHORT', priorUpperTouch: side === 'LONG', priorLowerTouch: side === 'SHORT' } };
  }) };
}
function run(side: 'LONG' | 'SHORT'): ReturnType<typeof portfolioResult> {
  const parameters = { ...settings, side }; const state = initialPortfolio(1000);
  const doc = document(side); replayPortfolioBlock(state, [doc], parameters, start, start + 2 * 3600, 3600);
  return portfolioResult(state, parameters);
}

describe('direction-specific envelope arming', () => {
  it.each(['LONG', 'SHORT'] as const)('uses only the %s prior touch flag', side => {
    const result = run(side); const trade = result.recentTrades[0]!;
    expect(result.entryCount).toBe(1); expect(result.closedTradeCount).toBe(1); expect(trade.reason).toBe('ENVELOPE_OPPOSITE');
    expect(trade.side).toBe(side); expect(trade.exitPrice).toBe(side === 'LONG' ? 101 : 99);
  });
  it('does not enter a long when only a lower touch is present, or a short when only an upper touch is present', () => {
    for (const side of ['LONG', 'SHORT'] as const) {
      const doc = document(side);
      for (const bar of doc.bars) { bar.envelope!.priorUpperTouch = side === 'SHORT'; bar.envelope!.priorLowerTouch = side === 'LONG'; }
      const parameters = { ...settings, side }; const state = initialPortfolio(1000);
      replayPortfolioBlock(state, [doc], parameters, start, start + 2 * 3600, 3600);
      expect(state.entries).toBe(0);
    }
  });
});
