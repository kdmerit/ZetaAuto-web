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
    candle(0, [100, 106, 99, 105], 10),
    candle(1, [90, 120, 80, 110], 30),
    candle(2, [110, 115, 100, 108], 20),
    candle(3, [108, 116, 101, 110], 25),
  ];
}

describe('reference candle strategy', () => {
  it('validates the 51~200 TP range', () => {
    expect(referenceTpPercent({ ...settings, referenceTpPercent: '80' })).toBe(80);
    expect(() => referenceTpPercent({ ...settings, referenceTpPercent: '50' })).toThrow();
    expect(() => referenceTpPercent({ ...settings, referenceTpPercent: '201' })).toThrow();
  });

  it('creates only the reference candle and its immediate next-bar signal', () => {
    const rows = setupRows();
    const document = prepareSymbolBlock('BTCUSDT', rows, settings, 'REFERENCE', rows[1]!.openTime, rows.at(-1)!.closeTime);
    expect(document.bars[0]!.signal).toMatchObject({
      strategy: 'REFERENCE', side: 'LONG', referenceRole: 'REFERENCE', entry: 100, stop: 80, target: 112,
      exitMode: 'REFERENCE_TOUCH',
    });
    expect(document.bars[1]!.signal).toMatchObject({ strategy: 'REFERENCE', referenceRole: 'NEXT', referenceOpenTime: rows[1]!.openTime });
    expect(document.bars[2]!.signal).toBeNull();
  });

  it('enters at the center and exits at the 80% TP without re-entering on the next-bar fallback', () => {
    const rows = setupRows();
    const referenceOpen = rows[1]!.openTime;
    const lowerTimeframe = [
      { openTime: referenceOpen, closeTime: referenceOpen + 900, open: 90, high: 105, low: 89, close: 104, volume: 1 },
      { openTime: referenceOpen + 900, closeTime: referenceOpen + 1800, open: 104, high: 115, low: 101, close: 110, volume: 1 },
      { openTime: referenceOpen + 1800, closeTime: referenceOpen + 2700, open: 110, high: 115, low: 95, close: 99, volume: 1 },
    ];
    const document = prepareSymbolBlock('BTCUSDT', rows, settings, 'REFERENCE', referenceOpen, rows.at(-1)!.closeTime,
      undefined, undefined, undefined, undefined, lowerTimeframe);
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], settings, rows[1]!.openTime, rows.at(-1)!.closeTime, 3600);
    const result = portfolioResult(state, settings);
    expect(result.entryCount).toBe(1);
    expect(result.closedTradeCount).toBe(1);
    expect(result.exitReasons).toEqual({ REFERENCE_TP: 1 });
    expect(result.recentTrades[0]!.entryPrice).toBeCloseTo(100.02, 10);
    expect(result.recentTrades[0]!.exitPrice).toBe(112);
    expect(result.recentTrades[0]!.priceLines).toEqual([
      { kind: 'ENTRY', price: 100.02 },
      { kind: 'SL', price: 80 },
      { kind: 'TP', price: 112 },
      { kind: 'EXIT', price: 112 },
    ]);
  });

  it('uses the immediate next candle when the reference candle did not make a same-candle center entry', () => {
    const rows = [
      candle(0, [100, 101, 99, 101], 10),
      candle(1, [115, 120, 80, 120], 30),
      candle(2, [110, 115, 100, 108], 20),
      candle(3, [108, 116, 101, 110], 25),
    ];
    const lowerTimeframe = [{
      openTime: rows[2]!.openTime, closeTime: rows[2]!.openTime + 900,
      open: 110, high: 115, low: 99, close: 99, volume: 1,
    }];
    const document = prepareSymbolBlock('BTCUSDT', rows, settings, 'REFERENCE', rows[1]!.openTime, rows.at(-1)!.closeTime,
      undefined, undefined, undefined, undefined, lowerTimeframe);
    expect(document.bars[0]!.signal).toBeNull();
    expect(document.bars[1]!.signal).toMatchObject({ strategy: 'REFERENCE', referenceRole: 'NEXT', entry: 100, stop: 80 });
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], settings, rows[1]!.openTime, rows.at(-1)!.closeTime, 3600);
    expect(state.entries).toBe(1);
  });

  it('mirrors the reference candle for a short setup', () => {
    const rows = [
      candle(0, [100, 106, 99, 105], 10),
      candle(1, [110, 120, 80, 90], 30),
    ];
    const document = prepareSymbolBlock('BTCUSDT', rows, { ...settings, side: 'SHORT' }, 'REFERENCE', rows[1]!.openTime, rows.at(-1)!.closeTime);
    expect(document.bars[0]!.signal).toMatchObject({ strategy: 'REFERENCE', side: 'SHORT', entry: 100, stop: 120, target: 88 });
  });

  it('uses chronological 15m candles so a parent-bar high cannot create a false TP', () => {
    const rows = setupRows();
    const referenceOpen = rows[1]!.openTime;
    const child = (index: number, values: [number, number, number, number]): Candle => ({
      openTime: referenceOpen + index * 900, closeTime: referenceOpen + (index + 1) * 900,
      open: values[0], high: values[1], low: values[2], close: values[3], volume: 1,
    });
    const lowerTimeframe = [
      child(0, [90, 105, 89, 104]),
      child(1, [104, 111, 101, 109]),
      child(2, [109, 110, 99, 105]),
      child(3, [108, 109, 79, 85]),
      child(4, [85, 90, 79, 82]),
    ];
    const document = prepareSymbolBlock('BTCUSDT', rows, settings, 'REFERENCE', referenceOpen, rows.at(-1)!.closeTime,
      undefined, undefined, undefined, undefined, lowerTimeframe);
    expect(document.bars[0]!.referenceIntrabarCandles).toHaveLength(4);
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], settings, referenceOpen, rows.at(-1)!.closeTime, 3600);
    expect(state.entries).toBe(1);
    expect(state.exitReasons).toEqual({ SL: 1 });
    expect(state.trades[0]!.exitPrice).toBeCloseTo(79.984, 10);
    expect(state.trades[0]!.executions.at(-1)!.candleOpenAt).toBe(referenceOpen + 4 * 900);
  });

  it('does not enter on an upward center break and waits for a later downward retest', () => {
    const rows = setupRows();
    const referenceOpen = rows[1]!.openTime;
    const lowerTimeframe = [
      { openTime: referenceOpen, closeTime: referenceOpen + 900, open: 90, high: 105, low: 89, close: 104, volume: 1 },
      { openTime: referenceOpen + 900, closeTime: referenceOpen + 1800, open: 104, high: 111, low: 101, close: 109, volume: 1 },
      { openTime: referenceOpen + 1800, closeTime: referenceOpen + 2700, open: 109, high: 110, low: 99, close: 100, volume: 1 },
    ];
    const document = prepareSymbolBlock('BTCUSDT', rows, settings, 'REFERENCE', referenceOpen, rows.at(-1)!.closeTime,
      undefined, undefined, undefined, undefined, lowerTimeframe);
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], settings, referenceOpen, rows.at(-1)!.closeTime, 3600);
    expect(state.entries).toBe(1);
    expect(state.trades[0]!.executions.find(fill => fill.kind === 'ENTRY')!.candleOpenAt).toBe(referenceOpen + 1800);
  });
});
