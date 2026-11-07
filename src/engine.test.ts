import { describe, expect, it } from 'vitest';
import { buildLocalChart, prepareSymbolBlock, runBacktest } from './engine';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle } from './types';

const origin = Date.UTC(2026, 0, 1) / 1000;
const settings: BacktestSettings = {
  mode: 'SINGLE', symbol: 'BTC', interval: '1h', side: 'BOTH',
  startDate: '2026-01-01', startTime: '09:00', endDate: '2026-01-02', endTime: '09:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1',
  partialTpEnabled: false, fullTpWavePercent: '100', minDisparityPercent: '1.0',
  ma20HalfCloseEnabled: false, roiClosePercent: '100', minVolatilityPercent: '0.5',
  volatilityK1: '0.5', volatilityK2: '1.0', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
};

function row(index: number, prices: number[], volume = 10): Candle {
  return { openTime: origin + index * 3600, closeTime: origin + (index + 1) * 3600,
    open: prices[0]!, high: prices[1]!, low: prices[2]!, close: prices[3]!, volume };
}

function mirror(rows: Candle[]): Candle[] {
  return rows.map((candle, index) => row(index, [300 - candle.open, 300 - candle.low, 300 - candle.high, 300 - candle.close], candle.volume));
}

function mirroredRow(index: number, prices: number[], volume = 10): Candle {
  return row(index, [300 - prices[0]!, 300 - prices[2]!, 300 - prices[1]!, 300 - prices[3]!], volume);
}

function qualifyingLong(index = 0): Candle {
  return row(index, [100, 111, 89, 110]);
}

function prepared(rows: readonly Candle[], side: 'LONG' | 'SHORT' = 'LONG', extra: Partial<BacktestSettings> = {}, volatilityIntrabarCandles?: Candle[]) {
  const candles = [...rows];
  return prepareSymbolBlock('BTCUSDT', candles, { ...settings, ...extra, side }, 'VOLATILITY', candles[0]!.openTime, candles.at(-1)!.closeTime, undefined, undefined, undefined, undefined, undefined, volatilityIntrabarCandles);
}

function replay(rows: readonly Candle[], side: 'LONG' | 'SHORT') {
  const candles = [...rows];
  const document = prepared(candles, side);
  const state = initialPortfolio(1_000);
  replayPortfolioBlock(state, [document], { ...settings, side }, candles[0]!.openTime, candles.at(-1)!.closeTime, 3600);
  return { document, state, result: portfolioResult(state, { ...settings, side }) };
}

describe('wick-pattern volatility breakout preparation', () => {
  it.each([
    ['LONG', [qualifyingLong()]],
    ['SHORT', [mirroredRow(0, [100, 111, 89, 110])]],
  ] as const)('creates a completed-candle %s signal', (side, rows) => {
    const signal = prepared(rows, side).bars[0]!.signal!;
    expect(signal).toMatchObject({ strategy: 'VOLATILITY', side, exitMode: 'VOLATILITY_WICK_RULE', volatilityStopEnabled: true });
    expect(signal.entry).toBe(side === 'LONG' ? 110 : 190);
    expect(signal.stop).toBe(side === 'LONG' ? 89 : 211);
    expect(signal.target).toBe(side === 'LONG' ? 132 : 168);
    expect(signal.initialTarget).toBe(signal.target);
    expect(signal.volatilityAtr).toBeUndefined();
  });

  it.each([
    ['lower wick is not larger than the body', (candle: Candle) => { candle.low = 90; }],
    ['upper wick exceeds ten percent of the range', (candle: Candle) => { candle.high = 114; }],
    ['the candle is bearish', (candle: Candle) => { candle.open = 110; candle.close = 100; }],
  ])('rejects long setup when %s', (_reason, change) => {
    const candle = qualifyingLong();
    change(candle);
    expect(prepared([candle]).bars[0]!.signal).toBeNull();
  });

  it('applies the same wick tests in reverse for a short setup', () => {
    const candle = mirroredRow(0, [100, 111, 89, 110]);
    candle.low = 186;
    expect(prepared([candle], 'SHORT').bars[0]!.signal).toBeNull();
    expect(prepared([mirroredRow(0, [100, 114, 89, 110])], 'SHORT').bars[0]!.signal).toBeNull();
  });

  it('applies the optional one-percent MA10 distance filter in both directions', () => {
    const farLong = [...Array.from({ length: 10 }, (_, index) => row(index, [120, 121, 119, 120])), qualifyingLong(10)];
    const nearLong = [...Array.from({ length: 10 }, (_, index) => row(index, [110.5, 111.5, 109.5, 110.5])), qualifyingLong(10)];
    expect(prepared(farLong, 'LONG', { volatilityMa10Enabled: true, volatilityMa10DistancePercent: '5' }).bars.at(-1)!.signal).not.toBeNull();
    expect(prepared(farLong, 'LONG', { volatilityMa10Enabled: true, volatilityMa10DistancePercent: '10' }).bars.at(-1)!.signal).toBeNull();
    expect(prepared(nearLong, 'LONG', { volatilityMa10Enabled: true }).bars.at(-1)!.signal).toBeNull();

    const farShort = mirror(farLong);
    const nearShort = mirror(nearLong);
    expect(prepared(farShort, 'SHORT', { volatilityMa10Enabled: true, volatilityMa10DistancePercent: '4.5' }).bars.at(-1)!.signal).not.toBeNull();
    expect(prepared(nearShort, 'SHORT', { volatilityMa10Enabled: true }).bars.at(-1)!.signal).toBeNull();
    expect(() => prepared([qualifyingLong()], 'LONG', { volatilityMa10Enabled: true, volatilityMa10DistancePercent: '20.1' })).toThrow('0.1~20.0');
  });

  it('applies the optional MA60 side filter in both directions', () => {
    const longAbove = [...Array.from({ length: 60 }, (_, index) => row(index, [100, 101, 99, 100])), qualifyingLong(60)];
    const longBelow = [...Array.from({ length: 60 }, (_, index) => row(index, [120, 121, 119, 120])), qualifyingLong(60)];
    expect(prepared(longAbove, 'LONG', { volatilityMa60Enabled: true }).bars.at(-1)!.signal).not.toBeNull();
    expect(prepared(longBelow, 'LONG', { volatilityMa60Enabled: true }).bars.at(-1)!.signal).toBeNull();

    expect(prepared(mirror(longAbove), 'SHORT', { volatilityMa60Enabled: true }).bars.at(-1)!.signal).not.toBeNull();
    expect(prepared(mirror(longBelow), 'SHORT', { volatilityMa60Enabled: true }).bars.at(-1)!.signal).toBeNull();
  });

  it('applies the inverse MA60 side filter and blocks contradictory filters', () => {
    const longAbove = [...Array.from({ length: 60 }, (_, index) => row(index, [100, 101, 99, 100])), qualifyingLong(60)];
    const longBelow = [...Array.from({ length: 60 }, (_, index) => row(index, [120, 121, 119, 120])), qualifyingLong(60)];
    expect(prepared(longBelow, 'LONG', { volatilityMa60BelowEnabled: true }).bars.at(-1)!.signal).not.toBeNull();
    expect(prepared(longAbove, 'LONG', { volatilityMa60BelowEnabled: true }).bars.at(-1)!.signal).toBeNull();

    expect(prepared(mirror(longBelow), 'SHORT', { volatilityMa60BelowEnabled: true }).bars.at(-1)!.signal).not.toBeNull();
    expect(prepared(mirror(longAbove), 'SHORT', { volatilityMa60BelowEnabled: true }).bars.at(-1)!.signal).toBeNull();
    expect(prepared(longAbove, 'LONG', { volatilityMa60Enabled: true, volatilityMa60BelowEnabled: true }).bars.at(-1)!.signal).toBeNull();
  });

  it('uses chronological 15-minute exits before falling back to a parent-bar path', () => {
    const parentRows = [qualifyingLong(), row(1, [110, 140, 80, 100])];
    const childRows = [
      [110, 133, 109, 132], [132, 140, 80, 100], [100, 100, 100, 100], [100, 100, 100, 100],
    ].map((prices, index) => ({ ...row(index, prices), openTime: origin + 3600 + index * 900, closeTime: origin + 3600 + (index + 1) * 900 }));
    const document = prepared(parentRows, 'LONG', {}, childRows);
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], { ...settings, side: 'LONG' }, origin, origin + 2 * 3600, 3600);
    expect(state.exitReasons).toEqual({ FULL_TP: 1 });
  });
});

describe('wick-pattern volatility breakout replay', () => {
  it.each([
    ['LONG', [qualifyingLong(), row(1, [110, 112, 100, 108]), row(2, [108, 120, 100, 115]), row(3, [115, 118, 108, 116])]],
    ['SHORT', mirror([qualifyingLong(), row(1, [110, 112, 100, 108]), row(2, [108, 120, 100, 115]), row(3, [115, 118, 108, 116])])],
  ] as const)('holds below/above the first entry, raises the SL, then closes on a smaller body, %s', (side, rows) => {
    const { state, result } = replay(rows, side);
    expect(result.entryCount).toBe(1);
    expect(result.closedTradeCount).toBe(1);
    expect(result.exitReasons).toEqual({ VOLATILITY_WICK_EXIT: 1 });
    expect(result.secondFillCount).toBe(0);
    expect(result.recentTrades[0]!.signal.target).toBe(side === 'LONG' ? 132 : 168);
    expect(result.recentTrades[0]!.executions.map(fill => fill.kind)).toEqual(['ENTRY', 'CLOSE']);
    expect(state.positions.BTCUSDT).toBeUndefined();
  });

  it.each([
    ['LONG', [qualifyingLong(), row(1, [110, 112, 88, 108])]],
    ['SHORT', mirror([qualifyingLong(), row(1, [110, 112, 88, 108])])],
  ] as const)('uses the initial SL from the entry candle on later candles, %s', (side, rows) => {
    const { result } = replay(rows, side);
    expect(result.exitReasons).toEqual({ SL: 1 });
  });

  it.each([
    ['LONG', [qualifyingLong(), row(1, [110, 112, 100, 108]), row(2, [108, 120, 100, 115])]],
    ['SHORT', mirror([qualifyingLong(), row(1, [110, 112, 100, 108]), row(2, [108, 120, 100, 115])])],
  ] as const)('raises the SL only after a larger same-direction candle beyond entry, %s', (side, rows) => {
    const { state } = replay(rows, side);
    expect(state.closed).toBe(0);
    expect(state.positions.BTCUSDT?.stop).toBe(side === 'LONG' ? 100 : 200);
  });

  it.each([
    ['LONG', [qualifyingLong(), row(1, [110, 112, 100, 108]), row(2, [108, 120, 100, 115]), row(3, [115, 121, 108, 112])]],
    ['SHORT', mirror([qualifyingLong(), row(1, [110, 112, 100, 108]), row(2, [108, 120, 100, 115]), row(3, [115, 121, 108, 112])])],
  ] as const)('closes when the candle beyond entry is opposite-colored, %s', (side, rows) => {
    const { result } = replay(rows, side);
    expect(result.exitReasons).toEqual({ VOLATILITY_WICK_EXIT: 1 });
  });

  it('uses the entry candle range as the TP and renders it without a second-entry line', () => {
    const prefix = Array.from({ length: 19 }, (_, index) => row(index, [100, 101, 99, 100]));
    const tail = [qualifyingLong(19), row(20, [110, 112, 100, 108]), row(21, [108, 120, 100, 115]), row(22, [115, 118, 108, 116])];
    const result = runBacktest([...prefix, ...tail], settings, 'VOLATILITY');
    const trade = result.recentTrades[0]!;
    const chart = buildLocalChart(result, trade, settings);
    expect(trade.signal.target).toBe(132);
    expect(chart.priceLines.some(line => line.kind === 'TP' && line.price === 132)).toBe(true);
    expect(chart.priceLines.some(line => line.kind === 'SECOND_ENTRY')).toBe(false);
  });

  it.each([
    ['LONG', [qualifyingLong(), row(1, [110, 133, 109, 120])]],
    ['SHORT', mirror([qualifyingLong(), row(1, [110, 133, 109, 120])])],
  ] as const)('closes at the entry-candle-range TP, %s', (side, rows) => {
    const { result } = replay(rows, side);
    expect(result.exitReasons).toEqual({ FULL_TP: 1 });
    expect(result.recentTrades[0]!.exitPrice).toBeCloseTo(side === 'LONG' ? 132 : 168, 10);
  });
});
