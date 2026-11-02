import { describe, expect, it } from 'vitest';
import type { PreparedSymbol } from './engine';
import { currentEnvelopeSettings } from './envelope';
import { betterEnvelopeSetting, qualifiesEnvelopeSetting, statisticsTotalFor, type EnvelopeStatisticsRow } from './envelopeStatistics';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle } from './types';

const start = Date.UTC(2026, 1, 1) / 1000;
const settings: BacktestSettings = currentEnvelopeSettings({ mode: 'SINGLE', symbol: 'BTC', interval: '15m', side: 'LONG', startDate: '2026-02-01', startTime: '09:00', endDate: '2026-02-13', endTime: '09:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '5', partialTpEnabled: false, fullTpWavePercent: '100', minDisparityPercent: '1', ma20HalfCloseEnabled: false, roiClosePercent: '100', minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
  envelopeMaPeriod: '5', envelopeDeviationPercent: '1' });
function document(prices: number[][], side: 'LONG' | 'SHORT' = 'LONG', parents?: number[]): PreparedSymbol {
  return { symbol: 'BTCUSDT', bars: prices.map((p, i) => {
    const q = side === 'LONG' ? p : [200 - p[0]!, 200 - p[2]!, 200 - p[1]!, 200 - p[3]!];
    const candle: Candle = { openTime: start + i * 900, closeTime: start + (i + 1) * 900, open: q[0]!, high: q[1]!, low: q[2]!, close: q[3]!, volume: 10 };
    return { candle, signal: null, ma20: null, ma60Exit: null, envelope: { center: 100, lower: 99, upper: 101, long: side === 'LONG', short: side === 'SHORT', ...(parents ? { parentOpenTime: parents[i]!, sourceInterval: '4h' as const } : {}) } };
  }) };
}
function run(doc: PreparedSymbol, side: 'LONG' | 'SHORT' = 'LONG') {
  const state = initialPortfolio(1000); const p = { ...settings, side };
  replayPortfolioBlock(state, [doc], p, start, doc.bars.at(-1)!.candle.closeTime, 900);
  return { state, result: portfolioResult(state, p) };
}

describe('fixed envelope reclaim entries', () => {
  it.each(['LONG', 'SHORT'] as const)('enters %s only on a later candle reclaim, at the band rather than at close', side => {
    const doc = document([[100, 100.2, 98.6, 98.8], [98.8, 101.2, 98.7, 101]], side);
    const { result } = run(doc, side); expect(result.entryCount).toBe(1); expect(result.closedTradeCount).toBe(1);
    const trade = result.recentTrades[0]!;
    expect(trade.entryAt).toBe(start + 900); expect(trade.entryPrice).toBeCloseTo(side === 'LONG' ? 99 * 1.0002 : 101 * .9998, 10);
    expect(trade.exitPrice).toBe(side === 'LONG' ? 101 : 99); expect(trade.reason).toBe('ENVELOPE_OPPOSITE');
    expect(trade.signal.envelopeEntryMode).toBe('RECLAIM'); expect(trade.executions[0]!.timing).toBe('INTRABAR');
  });
  it.each(['LONG', 'SHORT'] as const)('rejects a same-candle dip/recovery and a mere boundary touch for %s', side => {
    expect(run(document([[100, 102, 98, 100], [100, 102, 99, 100]], side), side).result.entryCount).toBe(0);
    expect(run(document([[100, 100.2, 99, 99], [99, 101.2, 99, 101]], side), side).result.entryCount).toBe(0);
  });
  it.each(['LONG', 'SHORT'] as const)('permits a bounded late opening fill for %s and does not chase a gap above the halfway window', side => {
    const allowed = run(document([[100, 100.2, 98.6, 98.8], [99.3, 99.4, 99.1, 99.2]], side), side);
    expect(allowed.result.entryCount).toBe(1); expect(allowed.state.positions.BTCUSDT!.entry).toBeCloseTo(side === 'LONG' ? 99.3 * 1.0002 : 100.7 * .9998, 10);
    const missed = run(document([[100, 100.2, 98.6, 98.8], [99.6, 101.2, 98.8, 101], [100, 100.2, 99.1, 99.3]], side), side);
    expect(missed.result.entryCount).toBe(0);
  });
  it.each(['LONG', 'SHORT'] as const)('moves %s SL once at the favorable center touch after entry, not before entry', side => {
    const doc = document([[100, 100.2, 98.6, 98.8], [98.8, 99.6, 98.7, 99.4], [99.4, 100.2, 99.3, 99.4]], side);
    const { result } = run(doc, side); const trade = result.recentTrades[0]!;
    expect(result.entryCount).toBe(1); expect(trade.reason).toBe('SL'); expect(trade.exitAt).toBe(start + 1800);
    expect(trade.signal.activeStop).toBeCloseTo((trade.entryPrice + 100) / 2, 10);
    expect(trade.priceLines!.some(line => line.kind === 'INITIAL_SL')).toBe(true);
    expect(trade.executions.map(fill => fill.kind)).toEqual(['ENTRY', 'CLOSE']);
  });
  it('uses the selected parent candle, not its 15-minute execution fragments, for distinct-candle enforcement', () => {
    const doc = document([[100, 100.2, 98.6, 98.8], [98.8, 101.2, 98.7, 101]], 'LONG', [start, start]);
    expect(run(doc).result.entryCount).toBe(0);
  });
  it('preserves the pending outside candle across a JSON checkpoint without duplicate fills', () => {
    const doc = document([[100, 100.2, 98.6, 98.8], [98.8, 101.2, 98.7, 101]]);
    const state = initialPortfolio(1000); replayPortfolioBlock(state, [doc], settings, start, start + 900, 900);
    expect(state.entries).toBe(0); expect(state.envelopeReclaims!['BTCUSDT:LONG']!.outsideAt).toBe(start);
    const restored = JSON.parse(JSON.stringify(state)); replayPortfolioBlock(restored, [doc], settings, start + 900, start + 1800, 900);
    expect(restored).toEqual(run(doc).state);
  });
  it('does not reuse another symbol’s later reclaim proceeds to fund an earlier entry in the same candle', () => {
    const doc = document([[100, 100.2, 98.6, 98.8], [98.8, 101.2, 98.7, 101]]);
    const state = initialPortfolio(101);
    replayPortfolioBlock(state, [{ ...doc, symbol: 'AAAUSDT' }, { ...doc, symbol: 'ZZZUSDT' }], { ...settings, mode: 'ALL', initialCapitalUsdt: '101' }, start, start + 1800, 900);
    expect(state.entries).toBe(1); expect(state.insufficientFunds).toBe(1); expect(state.trades.every(trade => trade.symbol === 'AAAUSDT')).toBe(true);
  });
});

describe('qualified optimal settings and fixed-case counts', () => {
  const candidate: EnvelopeStatisticsRow = { interval: '1h', side: 'LONG', maPeriod: 5, deviationPercent: 1, exitMode: 'OPPOSITE', returnPercent: 2, entryCount: 2,
    winRatePercent: 60, profitUsdt: 20, realizedProfitUsdt: 20, feesUsdt: 1, closedTradeCount: 2, winCount: 1, lossCount: 1, maxDrawdownPercent: 1, openPositionCount: 0 };
  it('accepts all inclusive boundaries and rejects each criterion independently, even when the return is otherwise higher', () => {
    expect(qualifiesEnvelopeSetting(candidate)).toBe(true); expect(betterEnvelopeSetting(candidate)).toBe(true);
    for (const invalid of [{ entryCount: 1, returnPercent: 99 }, { winRatePercent: 59.99, returnPercent: 99 }, { returnPercent: 1.9999 }, { winRatePercent: null }, { returnPercent: Infinity }, { winRatePercent: NaN }]) {
      expect(qualifiesEnvelopeSetting({ ...candidate, ...invalid })).toBe(false); expect(betterEnvelopeSetting({ ...candidate, ...invalid }, candidate)).toBe(false);
    }
  });
  it('removes the three-way exit dimension while retaining legacy report totals', () => {
    const p = { ...settings, side: 'BOTH' as const, envelopeStatisticsInterval: '1h' as const };
    expect(statisticsTotalFor(p)).toBe(3200); expect(statisticsTotalFor({ ...p, envelopeStatisticsInterval: 'ALL' })).toBe(12800);
    expect(statisticsTotalFor(p, '2.10.42')).toBe(9600); expect(statisticsTotalFor(p, '2.10.41')).toBe(4800);
    expect(currentEnvelopeSettings({ ...settings, envelopeExitMode: 'HALF', envelopeMoveSlOnCenter: false })).toMatchObject({ envelopeExitMode: 'OPPOSITE', envelopeMoveSlOnCenter: true, envelopeEntryMode: 'RECLAIM' });
  });
});
