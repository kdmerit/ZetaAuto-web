import { describe, expect, it } from 'vitest';
import { currentEnvelopeSettings } from './envelope';
import type { PreparedSymbol } from './engine';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings } from './types';

const start = Date.UTC(2026, 1, 1) / 1000;
const settings = currentEnvelopeSettings({ mode: 'SINGLE', symbol: 'BTC', interval: '1h', side: 'LONG', initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '5',
  envelopeDailyTrend: false, envelopeMaPeriod: '5', envelopeDeviationPercent: '1', envelopeExitMode: 'OPPOSITE', envelopeMoveSlOnCenter: true } as BacktestSettings);
function document(prices: number[][], side: 'LONG' | 'SHORT', centers: number[] = []): PreparedSymbol {
  return { symbol: 'BTCUSDT', bars: prices.map((price, index) => {
    const p = side === 'LONG' ? price : [200 - price[0]!, 200 - price[2]!, 200 - price[1]!, 200 - price[3]!];
    const center = side === 'LONG' ? centers[index] ?? 100 : 200 - (centers[index] ?? 100);
    return { candle: { openTime: start + index * 3600, closeTime: start + (index + 1) * 3600, open: p[0]!, high: p[1]!, low: p[2]!, close: p[3]!, volume: 1 },
      signal: null, ma20: null, ma60Exit: null, envelope: { center, lower: center * .99, upper: center * 1.01, long: side === 'LONG', short: side === 'SHORT' } };
  }) };
}
function run(doc: PreparedSymbol, side: 'LONG' | 'SHORT') {
  const state = initialPortfolio(1000); const p = { ...settings, side };
  replayPortfolioBlock(state, [doc], p, start, doc.bars.at(-1)!.candle.closeTime, 3600);
  return { state, result: portfolioResult(state, p) };
}

describe('current envelope center-touch full exit', () => {
  it.each(['LONG', 'SHORT'] as const)('fully closes %s at the first intrabar center touch without waiting for opposite band or candle close', side => {
    const doc = document([[100, 100.2, 98.6, 98.8], [98.8, 100.2, 98.7, 99.3]], side);
    const { state, result } = run(doc, side); const trade = result.recentTrades[0]!;
    expect(result.entryCount).toBe(1); expect(result.closedTradeCount).toBe(1); expect(state.positions).toEqual({});
    expect(trade.reason).toBe('ENVELOPE_CENTER'); expect(trade.exitPrice).toBe(100); expect(trade.exitAt).toBe(start + 3600);
    expect(trade.executions.at(-1)!.timing).toBe('INTRABAR'); expect(trade.executions.map(fill => fill.kind)).toEqual(['ENTRY', 'CLOSE']);
    expect(trade.executions[0]!.quantity).toBe(trade.executions[1]!.quantity);
    expect(trade.signal.envelopeExitMode).toBe('CENTER'); expect(trade.signal.envelopeMoveSlOnCenter).toBe(false);
    expect(trade.signal.activeStop).toBe(trade.signal.initialStop); expect(trade.priceLines!.some(line => line.kind === 'INITIAL_SL')).toBe(false);
  });
  it.each(['LONG', 'SHORT'] as const)('keeps %s initial SL unchanged before the center and uses the newly confirmed center on a later hour', side => {
    const prices = [[100, 100.2, 98.6, 98.8], [98.8, 99.7, 98.7, 99.4], [99.4, 100.6, 99.2, 99.8]];
    const doc = document(prices, side, [100, 100, 100.5]); const p = { ...settings, side }; const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [doc], p, start, start + 2 * 3600, 3600);
    expect(state.closed).toBe(0); expect(state.positions.BTCUSDT!.centerStopMoved).not.toBe(true);
    const originalStop = state.positions.BTCUSDT!.stop;
    const restored = JSON.parse(JSON.stringify(state));
    replayPortfolioBlock(restored, [doc], p, start + 2 * 3600, start + 3 * 3600, 3600);
    const result = portfolioResult(restored, p); const trade = result.recentTrades[0]!;
    expect(trade.reason).toBe('ENVELOPE_CENTER'); expect(trade.exitPrice).toBe(side === 'LONG' ? 100.5 : 99.5);
    expect(trade.signal.activeStop).toBe(originalStop); expect(result).toEqual(run(doc, side).result);
  });
  it.each(['LONG', 'SHORT'] as const)('retains conservative SL priority when the %s entry candle can touch both initial SL and center', side => {
    const { result } = run(document([[100, 100.2, 98.6, 98.8], [99.3, 100.2, 97, 99.4]], side), side);
    expect(result.entryCount).toBe(1); expect(result.recentTrades[0]!.reason).toBe('SL');
    expect(result.recentTrades[0]!.signal.activeStop).toBe(result.recentTrades[0]!.signal.initialStop);
  });
});
