import { describe, expect, it } from 'vitest';
import type { PreparedEnvelope, PreparedSymbol } from './engine';
import { initialPortfolio, portfolioEquity, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle } from './types';

const start = Date.UTC(2026, 1, 1) / 1000;
const settings: BacktestSettings = { mode: 'SINGLE', symbol: 'BTC', interval: '15m', side: 'LONG', startDate: '2026-02-01', startTime: '09:00', endDate: '2026-02-13', endTime: '09:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '5', partialTpEnabled: false, fullTpWavePercent: '100', minDisparityPercent: '1', ma20HalfCloseEnabled: false, roiClosePercent: '100', minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
  envelopeMaPeriod: '5', envelopeDeviationPercent: '1', envelopeExitMode: 'OPPOSITE', envelopeMoveSlOnCenter: true };
function candle(index: number, [open, high, low, close]: number[]): Candle {
  return { openTime: start + index * 900, closeTime: start + (index + 1) * 900, open: open!, high: high!, low: low!, close: close!, volume: 10 };
}
const band = (center = 100): PreparedEnvelope => ({ center, lower: center * .99, upper: center * 1.01, long: true, short: false });
function document(prices: number[][], centers: number[] = []): PreparedSymbol {
  return { symbol: 'BTCUSDT', bars: prices.map((prices, index) => ({ candle: candle(index, prices), signal: null, ma20: null, ma60Exit: null, envelope: band(centers[index]) })) };
}

describe('center-touch protective stop', () => {
  it.each(['LONG', 'SHORT'] as const)('moves %s SL to the fill/center midpoint and applies it to the remaining half in the same candle', side => {
    const p = { ...settings, side, envelopeExitMode: 'HALF' as const };
    const doc = document([[99.5, 100.2, 98.8, 99.4]]);
    if (side === 'SHORT') for (const bar of doc.bars) {
      const c = bar.candle; [c.open, c.high, c.low, c.close] = [200 - c.open, 200 - c.low, 200 - c.high, 200 - c.close];
      bar.envelope = { ...band(), long: false, short: true };
    }
    const state = initialPortfolio(1000); replayPortfolioBlock(state, [doc], p, start, start + 900, 900);
    const result = portfolioResult(state, p); const trade = result.recentTrades.at(-1)!;
    expect(trade.reason).toBe('SL'); expect(trade.executions.map(fill => fill.kind)).toEqual(['ENTRY', 'PARTIAL_TP', 'CLOSE']);
    const expected = (trade.entryPrice + 100) / 2;
    expect(trade.signal.activeStop).toBeCloseTo(expected, 10);
    expect(trade.exitPrice).toBeCloseTo(expected * (side === 'LONG' ? .9998 : 1.0002), 10);
    expect(trade.priceLines).toContainEqual({ kind: 'INITIAL_SL', price: trade.signal.initialStop });
    expect(trade.priceLines).toContainEqual({ kind: 'SL', price: expected });
    expect(result.closedTradeCount).toBe(1);
  });
  it('does not move the stop while disabled or before a favorable center touch', () => {
    const doc = document([[99.5, 99.8, 98.8, 99.5], [99.6, 100.2, 99.6, 100.1]]);
    for (const enabled of [false, true]) {
      const p = { ...settings, envelopeMoveSlOnCenter: enabled }; const state = initialPortfolio(1000);
      replayPortfolioBlock(state, [doc], p, start, start + 900, 900);
      const position = state.positions.BTCUSDT!; expect(position.stop).toBe(position.signal.stop); expect(position.centerStopMoved).not.toBe(true);
      replayPortfolioBlock(state, [doc], p, start + 900, start + 1800, 900);
      if (enabled) expect(state.positions.BTCUSDT!.stop).toBeCloseTo((position.entry + 100) / 2, 10);
      else expect(state.positions.BTCUSDT!.stop).toBe(position.signal.stop);
    }
  });
  it('moves only once, uses the center at contact, and preserves the changed stop across checkpoints', () => {
    const doc = document([[99.5, 99.8, 98.8, 99.6], [99.6, 100.2, 99.6, 100.1], [100.1, 102.1, 100, 102]], [100, 100, 102]);
    const state = initialPortfolio(1000); replayPortfolioBlock(state, [doc], settings, start, start + 1800, 900);
    const moved = state.positions.BTCUSDT!.stop; expect(moved).toBeCloseTo((state.positions.BTCUSDT!.entry + 100) / 2, 10);
    const restored = JSON.parse(JSON.stringify(state)); replayPortfolioBlock(restored, [doc], settings, start + 1800, start + 2700, 900);
    expect(restored.positions.BTCUSDT.stop).toBe(moved); expect(restored.positions.BTCUSDT.centerStopMoved).toBe(true);
    const uninterrupted = initialPortfolio(1000); replayPortfolioBlock(uninterrupted, [doc], settings, start, start + 2700, 900);
    expect(restored).toEqual(uninterrupted);
  });
  it('does not tighten to a center on the losing side of the fill', () => {
    const doc = document([[99.5, 99.8, 98.8, 99.6], [99.6, 99.8, 99.2, 99.4]], [100, 99]);
    const state = initialPortfolio(1000); replayPortfolioBlock(state, [doc], settings, start, start + 1800, 900);
    expect(state.positions.BTCUSDT!.stop).toBe(state.positions.BTCUSDT!.signal.stop); expect(state.positions.BTCUSDT!.centerStopMoved).not.toBe(true);
  });
});

describe('simultaneous directional virtual settings', () => {
  it('compares both opening directions when different bands are simultaneously eligible, without a long-first bias', () => {
    const p = { ...settings, side: 'BOTH' as const, envelopeMoveSlOnCenter: false };
    const definitions = { LONG: { ...band(), sourceInterval: '1h' as const }, SHORT: { center: 90, upper: 90.9, lower: 89.1, long: false, short: true, sourceInterval: '4h' as const } };
    const run = (sides: ('LONG' | 'SHORT')[]) => {
      const state = initialPortfolio(1000); const document: PreparedSymbol = { symbol: 'BTCUSDT', bars: [{ candle: candle(0, [95, 95.2, 94.8, 95]), signal: null, ma20: null, ma60Exit: null,
        envelopeBySide: Object.fromEntries(sides.map(side => [side, definitions[side]])) }] };
      replayPortfolioBlock(state, [document], p, start, start + 900, 900, { settingsForSymbolSide: { BTCUSDT: { LONG: { ...p, side: 'LONG' }, SHORT: { ...p, side: 'SHORT' } } } });
      return state;
    };
    const alternatives = [run(['LONG']), run(['SHORT'])].sort((a, b) => portfolioEquity(a) - portfolioEquity(b));
    const combined = run(['LONG', 'SHORT']); expect(combined.entries).toBe(1);
    expect(portfolioEquity(combined)).toBeCloseTo(portfolioEquity(alternatives[0]!), 10);
    expect(combined.positions.BTCUSDT!.signal.side).toBe(alternatives[0]!.positions.BTCUSDT!.signal.side);
    expect(run(['SHORT', 'LONG'])).toEqual(combined);
  });
  it('selects the entry direction causally and manages that holding with its own bands, settings and parent gate', () => {
    const long = { ...settings, interval: '1h' as const, envelopeMoveSlOnCenter: false };
    const short = { ...settings, side: 'SHORT' as const, interval: '4h' as const, envelopeMaPeriod: '60', envelopeDeviationPercent: '2', envelopeExitMode: 'HALF' as const, envelopeMoveSlOnCenter: false };
    const prices = [[99.5, 99.8, 98.8, 99.5], [99.5, 101.2, 99.5, 101], [111, 112.5, 110.5, 112], [112, 112.1, 107, 108]];
    const doc: PreparedSymbol = { symbol: 'BTCUSDT', bars: prices.map((prices, index) => ({ candle: candle(index, prices), signal: null, ma20: null, ma60Exit: null,
      envelopeBySide: { LONG: { ...band(), parentOpenTime: start, sourceInterval: '1h' }, SHORT: { center: 110, upper: 112.2, lower: 107.8, long: false, short: true, parentOpenTime: start, sourceInterval: '4h' } } })) };
    const options = { settingsForSymbolSide: { BTCUSDT: { LONG: long, SHORT: short } } }; const p = { ...settings, side: 'BOTH' as const };
    const state = initialPortfolio(1000); replayPortfolioBlock(state, [doc], p, start, start + 3600, 900, options);
    expect(state.entries).toBe(2); expect(state.closed).toBe(2);
    const l = state.trades.find(trade => trade.side === 'LONG')!; const s = state.trades.filter(trade => trade.side === 'SHORT').at(-1)!;
    expect(l.exitPrice).toBe(101); expect(l.signal).toMatchObject({ envelopeMaPeriod: 5, envelopeDeviationPercent: 1, envelopeExitMode: 'OPPOSITE', envelopeSourceInterval: '1h' });
    expect(s.exitPrice).toBe(107.8); expect(s.signal).toMatchObject({ envelopeMaPeriod: 60, envelopeDeviationPercent: 2, envelopeExitMode: 'HALF', envelopeSourceInterval: '4h' });
    expect(s.executions.map(fill => fill.kind)).toEqual(['ENTRY', 'PARTIAL_TP', 'CLOSE']);
    expect(Object.keys(state.positions)).toHaveLength(0);
    const split = initialPortfolio(1000); replayPortfolioBlock(split, [doc], p, start, start + 2700, 900, options);
    const restored = JSON.parse(JSON.stringify(split)); replayPortfolioBlock(restored, [doc], p, start + 2700, start + 3600, 900, options);
    expect(restored).toEqual(state);
    expect(state.envelopeParents!['BTCUSDT:LONG']!.blocked).toBe(true); expect(state.envelopeParents!['BTCUSDT:SHORT']!.blocked).toBe(true);
  });
});
