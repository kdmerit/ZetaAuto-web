import { describe, expect, it } from 'vitest';
import type { PreparedSymbol } from './engine';
import { currentEnvelopeSettings } from './envelope';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle } from './types';

const start = Date.UTC(2026, 1, 1) / 1000;
const settings = currentEnvelopeSettings({ mode: 'SINGLE', symbol: 'BTC', interval: '1h', side: 'LONG', initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1', envelopeMaPeriod: '5', envelopeDeviationPercent: '1' } as BacktestSettings);

function document(side: 'LONG' | 'SHORT', exit = false): PreparedSymbol {
  const first: Candle = { openTime: start, closeTime: start + 3600, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1 };
  const second: Candle = side === 'LONG'
    ? { openTime: start + 3600, closeTime: start + 7200, open: 100.5, high: 102, low: 100, close: 102, volume: 1 }
    : { openTime: start + 3600, closeTime: start + 7200, open: 99.5, high: 100, low: 98, close: 98, volume: 1 };
  const third: Candle = side === 'LONG'
    ? { openTime: start + 7200, closeTime: start + 10800, open: 102, high: 103, low: 98, close: exit ? 99 : 104, volume: 1 }
    : { openTime: start + 7200, closeTime: start + 10800, open: 98, high: 102, low: 97, close: exit ? 101 : 96, volume: 1 };
  const band = { center: 100, lower: 99, upper: 101, long: side === 'LONG', short: side === 'SHORT', previousClose: 100 };
  return { symbol: 'BTCUSDT', bars: [
    { candle: first, signal: null, ma20: 100, ma60Exit: null, ma5: 100, ma10: 100, ma60: 100, envelope: { ...band } },
    { candle: second, signal: null, ma20: side === 'LONG' ? 103 : 97, ma60Exit: null, ma5: side === 'LONG' ? 105 : 95, ma10: side === 'LONG' ? 104 : 96, ma60: side === 'LONG' ? 102 : 98, envelope: { ...band } },
    { candle: third, signal: null, ma20: side === 'LONG' ? 103 : 97, ma60Exit: null, ma5: side === 'LONG' ? 105 : 95, ma10: side === 'LONG' ? 104 : 96, ma60: side === 'LONG' ? 102 : 98, envelope: { ...band } },
  ] };
}

function run(side: 'LONG' | 'SHORT', exit = false): { result: ReturnType<typeof portfolioResult>; state: ReturnType<typeof initialPortfolio> } {
  const parameters = { ...settings, side }; const state = initialPortfolio(1000);
  replayPortfolioBlock(state, [document(side, exit)], parameters, start, start + 3 * 3600, 3600);
  return { result: portfolioResult(state, parameters), state };
}

describe('envelope breakout replay', () => {
  it.each(['LONG', 'SHORT'] as const)('does not close %s merely at a later centre-line touch', side => {
    const { result, state } = run(side);
    expect(result.entryCount).toBe(1); expect(result.closedTradeCount).toBe(0); expect(result.openPositionCount).toBe(1);
    expect(state.positions.BTCUSDT!.signal.exitMode).toBe('ENVELOPE_MA20_CLOSE');
  });

  it.each(['LONG', 'SHORT'] as const)('closes %s only when a later candle closes beyond MA20', side => {
    const { result } = run(side, true);
    expect(result.entryCount).toBe(1); expect(result.closedTradeCount).toBe(1);
    expect(result.recentTrades[0]!.reason).toBe('ENVELOPE_MA20_CLOSE');
    expect(result.recentTrades[0]!.executions.map(fill => fill.kind)).toEqual(['ENTRY', 'CLOSE']);
  });
});
