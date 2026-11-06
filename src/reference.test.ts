import { describe, expect, it } from 'vitest';

import { prepareSymbolBlock } from './engine';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import { referenceTpPercent } from './reference';
import type { BacktestSettings, Candle } from './types';

const origin = Date.UTC(2026, 0, 1) / 1000;
const settings: BacktestSettings = {
  mode: 'SINGLE', symbol: 'BTC', interval: '1h', startDate: '2026-01-01', startTime: '00:00', endDate: '2026-01-02', endTime: '00:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1', side: 'BOTH', partialTpEnabled: false,
  fullTpWavePercent: '100', minDisparityPercent: '1', ma20HalfCloseEnabled: false, roiClosePercent: '100',
  minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
  referenceTpPercent: '80',
};

function candle(index: number, values: [number, number, number, number], volume: number): Candle {
  return { openTime: origin + index * 3600, closeTime: origin + (index + 1) * 3600,
    open: values[0], high: values[1], low: values[2], close: values[3], volume };
}

function setupRows(): Candle[] {
  return [
    candle(0, [100, 106, 80, 104], 10),
    candle(1, [90, 150, 70, 130], 50),
    candle(2, [130, 140, 100, 128], 20),
    candle(3, [128, 145, 105, 135], 25),
  ];
}

describe('reference candle strategy', () => {
  it('validates the 51~200 TP range', () => {
    expect(referenceTpPercent({ ...settings, referenceTpPercent: '80' })).toBe(80);
    expect(() => referenceTpPercent({ ...settings, referenceTpPercent: '50' })).toThrow();
    expect(() => referenceTpPercent({ ...settings, referenceTpPercent: '201' })).toThrow();
  });

  it('requires both reference volume and body to reach five times the previous candle', () => {
    const volumeBelowFive = [
      candle(0, [100, 106, 80, 104], 10),
      candle(1, [90, 150, 70, 130], 49),
    ];
    const bodyBelowFive = [
      candle(0, [100, 106, 80, 104], 10),
      candle(1, [100, 150, 70, 115], 50),
    ];
    expect(prepareSymbolBlock('BTCUSDT', volumeBelowFive, settings, 'REFERENCE', volumeBelowFive[1]!.openTime, volumeBelowFive.at(-1)!.closeTime).bars[0]!.signal).toBeNull();
    expect(prepareSymbolBlock('BTCUSDT', bodyBelowFive, settings, 'REFERENCE', bodyBelowFive[1]!.openTime, bodyBelowFive.at(-1)!.closeTime).bars[0]!.signal).toBeNull();
  });

  it('optionally requires the reference candle to straddle MA10 by direction', () => {
    const history = Array.from({ length: 9 }, (_, index) => candle(index, [100, 101, 99, 100.05], 10));
    const longAllowed = [...history, candle(9, [95, 120, 90, 110], 50)];
    const longLowBlocked = [...history, candle(9, [95, 120, 102, 110], 50)];
    const longHalfBlocked = [...history, candle(9, [95, 105, 90, 102], 50)];
    const longCloseBlocked = [...history, candle(9, [95, 120, 90, 100], 50)];
    expect(prepareSymbolBlock('BTCUSDT', longAllowed, { ...settings, referenceMa10Enabled: true }, 'REFERENCE', longAllowed[9]!.openTime, longAllowed.at(-1)!.closeTime).bars[0]!.signal).toMatchObject({ side: 'LONG' });
    for (const rows of [longLowBlocked, longHalfBlocked, longCloseBlocked]) {
      expect(prepareSymbolBlock('BTCUSDT', rows, { ...settings, referenceMa10Enabled: true }, 'REFERENCE', rows[9]!.openTime, rows.at(-1)!.closeTime).bars[0]!.signal).toBeNull();
    }

    const shortAllowed = [...history, candle(9, [95, 105, 80, 90], 50)];
    const shortHighBlocked = [...history, candle(9, [95, 98, 80, 90], 50)];
    const shortHalfBlocked = [...history, candle(9, [95, 110, 95, 90], 50)];
    const shortCloseBlocked = [...history, candle(9, [95, 105, 80, 101], 50)];
    const shortSettings = { ...settings, side: 'SHORT' as const, referenceMa10Enabled: true };
    expect(prepareSymbolBlock('BTCUSDT', shortAllowed, shortSettings, 'REFERENCE', shortAllowed[9]!.openTime, shortAllowed.at(-1)!.closeTime).bars[0]!.signal).toMatchObject({ side: 'SHORT' });
    for (const rows of [shortHighBlocked, shortHalfBlocked, shortCloseBlocked]) {
      expect(prepareSymbolBlock('BTCUSDT', rows, shortSettings, 'REFERENCE', rows[9]!.openTime, rows.at(-1)!.closeTime).bars[0]!.signal).toBeNull();
    }
  });

  it('creates only the reference candle and its immediate next-bar signal', () => {
    const rows = setupRows();
    const document = prepareSymbolBlock('BTCUSDT', rows, settings, 'REFERENCE', rows[1]!.openTime, rows.at(-1)!.closeTime);
    expect(document.bars[0]!.signal).toMatchObject({
      strategy: 'REFERENCE', side: 'LONG', referenceRole: 'REFERENCE', entry: 110, stop: 70, target: 134,
      exitMode: 'REFERENCE_TOUCH',
    });
    expect(document.bars[1]!.signal).toMatchObject({ strategy: 'REFERENCE', referenceRole: 'NEXT', referenceOpenTime: rows[1]!.openTime });
    expect(document.bars[2]!.signal).toBeNull();
  });

  it('enters at the line and exits at the 80% TP without re-entering on the next-bar fallback', () => {
    const rows = setupRows();
    const referenceOpen = rows[1]!.openTime;
    const lowerTimeframe = [
      { openTime: referenceOpen, closeTime: referenceOpen + 900, open: 90, high: 150, low: 89, close: 130, volume: 1 },
      { openTime: referenceOpen + 900, closeTime: referenceOpen + 1800, open: 115, high: 150, low: 100, close: 110, volume: 1 },
      { openTime: referenceOpen + 1800, closeTime: referenceOpen + 2700, open: 110, high: 140, low: 105, close: 138, volume: 1 },
    ];
    const document = prepareSymbolBlock('BTCUSDT', rows, settings, 'REFERENCE', referenceOpen, rows.at(-1)!.closeTime,
      undefined, undefined, undefined, undefined, lowerTimeframe);
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], settings, rows[1]!.openTime, rows.at(-1)!.closeTime, 3600);
    const result = portfolioResult(state, settings);
    const expectedEntry = 110 * (1 + 0.0002);
    expect(result.entryCount).toBe(1);
    expect(result.closedTradeCount).toBe(1);
    expect(result.exitReasons).toEqual({ REFERENCE_TP: 1 });
    expect(result.recentTrades[0]!.entryPrice).toBeCloseTo(expectedEntry, 10);
    expect(result.recentTrades[0]!.exitPrice).toBe(134);
    expect(result.recentTrades[0]!.priceLines).toEqual([
      { kind: 'ENTRY', price: expectedEntry },
      { kind: 'SL', price: 70 },
      { kind: 'TP', price: 134 },
      { kind: 'EXIT', price: 134 },
    ]);
  });

  it('uses the immediate next candle when the reference candle did not make a same-candle line entry', () => {
    const rows = [
      candle(0, [100, 101, 99, 101], 10),
      candle(1, [115, 150, 80, 150], 50),
      candle(2, [130, 145, 100, 108], 20),
      candle(3, [108, 146, 101, 110], 25),
    ];
    const lowerTimeframe = [{
      openTime: rows[2]!.openTime, closeTime: rows[2]!.openTime + 900,
      open: 130, high: 140, low: 99, close: 99, volume: 1,
    }];
    const document = prepareSymbolBlock('BTCUSDT', rows, settings, 'REFERENCE', rows[1]!.openTime, rows.at(-1)!.closeTime,
      undefined, undefined, undefined, undefined, lowerTimeframe);
    expect(document.bars[0]!.signal).toBeNull();
    expect(document.bars[1]!.signal).toMatchObject({ strategy: 'REFERENCE', referenceRole: 'NEXT', entry: 115, stop: 80 });
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], settings, rows[1]!.openTime, rows.at(-1)!.closeTime, 3600);
    expect(state.entries).toBe(1);
  });

  it('mirrors the reference candle for a short setup', () => {
    const rows = [
      candle(0, [100, 120, 90, 105], 10),
      candle(1, [150, 160, 80, 100], 50),
    ];
    const document = prepareSymbolBlock('BTCUSDT', rows, { ...settings, side: 'SHORT' }, 'REFERENCE', rows[1]!.openTime, rows.at(-1)!.closeTime);
    expect(document.bars[0]!.signal).toMatchObject({ strategy: 'REFERENCE', side: 'SHORT', entry: 120, stop: 160, target: 96 });
  });

  it('uses chronological 15m candles so a parent-bar high cannot create a false TP', () => {
    const rows = setupRows();
    const referenceOpen = rows[1]!.openTime;
    const child = (index: number, values: [number, number, number, number]): Candle => ({
      openTime: referenceOpen + index * 900, closeTime: referenceOpen + (index + 1) * 900,
      open: values[0], high: values[1], low: values[2], close: values[3], volume: 1,
    });
    const lowerTimeframe = [
      child(0, [90, 150, 89, 130]),
      child(1, [130, 140, 100, 120]),
      child(2, [120, 140, 99, 110]),
      child(3, [110, 130, 95, 99]),
      child(4, [99, 100, 69, 65]),
    ];
    const document = prepareSymbolBlock('BTCUSDT', rows, settings, 'REFERENCE', referenceOpen, rows.at(-1)!.closeTime,
      undefined, undefined, undefined, undefined, lowerTimeframe);
    expect(document.bars[0]!.referenceIntrabarCandles).toHaveLength(4);
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], settings, referenceOpen, rows.at(-1)!.closeTime, 3600);
    expect(state.entries).toBe(1);
    expect(state.exitReasons).toEqual({ SL: 1 });
    expect(state.trades[0]!.exitPrice).toBeCloseTo(69.986, 10);
    expect(state.trades[0]!.executions.at(-1)!.candleOpenAt).toBe(referenceOpen + 4 * 900);
  });

  it('ignores a 15m line touch before the reference high is confirmed', () => {
    const rows = [
      candle(0, [100, 106, 80, 104], 10),
      candle(1, [90, 150, 70, 130], 50),
      candle(2, [130, 140, 120, 128], 20),
    ];
    const referenceOpen = rows[1]!.openTime;
    const lowerTimeframe = [
      { openTime: referenceOpen, closeTime: referenceOpen + 900, open: 120, high: 125, low: 100, close: 110, volume: 1 },
      { openTime: referenceOpen + 900, closeTime: referenceOpen + 1800, open: 110, high: 150, low: 105, close: 130, volume: 1 },
    ];
    const document = prepareSymbolBlock('BTCUSDT', rows, settings, 'REFERENCE', referenceOpen, rows.at(-1)!.closeTime,
      undefined, undefined, undefined, undefined, lowerTimeframe);
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], settings, referenceOpen, rows.at(-1)!.closeTime, 3600);
    expect(state.entries).toBe(0);
  });

  it('does not enter on an upward line break and waits for a later downward retest', () => {
    const rows = setupRows();
    const referenceOpen = rows[1]!.openTime;
    const lowerTimeframe = [
      { openTime: referenceOpen, closeTime: referenceOpen + 900, open: 90, high: 150, low: 89, close: 130, volume: 1 },
      { openTime: referenceOpen + 900, closeTime: referenceOpen + 1800, open: 130, high: 145, low: 100, close: 120, volume: 1 },
      { openTime: referenceOpen + 1800, closeTime: referenceOpen + 2700, open: 120, high: 140, low: 99, close: 110, volume: 1 },
    ];
    const document = prepareSymbolBlock('BTCUSDT', rows, settings, 'REFERENCE', referenceOpen, rows.at(-1)!.closeTime,
      undefined, undefined, undefined, undefined, lowerTimeframe);
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], settings, referenceOpen, rows.at(-1)!.closeTime, 3600);
    expect(state.entries).toBe(1);
    expect(state.trades[0]!.executions.find(fill => fill.kind === 'ENTRY')!.candleOpenAt).toBe(referenceOpen + 1800);
  });

  it.each([
    ['4h', 4 * 3600],
    ['1d', 24 * 3600],
  ] as const)('gates the reference retest for the %s parent interval', (interval, seconds) => {
    const row = (index: number, values: [number, number, number, number], volume: number): Candle => ({
      openTime: origin + index * seconds, closeTime: origin + (index + 1) * seconds,
      open: values[0], high: values[1], low: values[2], close: values[3], volume,
    });
    const rows = [
      row(0, [100, 120, 90, 105], 10),
      row(1, [150, 160, 80, 100], 50),
      row(2, [100, 130, 90, 95], 20),
    ];
    const referenceOpen = rows[1]!.openTime;
    const lowerTimeframe = [
      { openTime: referenceOpen, closeTime: referenceOpen + 900, open: 150, high: 160, low: 101, close: 150, volume: 1 },
      { openTime: referenceOpen + 900, closeTime: referenceOpen + 1800, open: 150, high: 155, low: 80, close: 130, volume: 1 },
      { openTime: referenceOpen + 1800, closeTime: referenceOpen + 2700, open: 105, high: 110, low: 95, close: 90, volume: 1 },
    ];
    const document = prepareSymbolBlock('BTCUSDT', rows, { ...settings, interval, side: 'SHORT' }, 'REFERENCE', referenceOpen, rows.at(-1)!.closeTime,
      undefined, undefined, undefined, undefined, lowerTimeframe);
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], { ...settings, interval, side: 'SHORT' }, referenceOpen, rows.at(-1)!.closeTime, seconds);
    expect(state.entries).toBe(1);
    expect(state.trades[0]!.executions.find(fill => fill.kind === 'ENTRY')?.candleOpenAt).toBe(referenceOpen + 900);
  });
});
