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

/** Nine warm-up candles, five bodies below MA5, then a two-times body signal. */
function longCandles(): Candle[] {
  return [
    [110, 111, 109, 110], [110, 111, 109, 110], [110, 111, 109, 110], [110, 111, 109, 110],
    [108.5, 109.5, 108, 109], [107.5, 108.5, 107, 108], [106.5, 300, 85, 107], [105.5, 106.5, 105, 106], [104.5, 105.5, 104, 105],
    [108, 130, 90, 120],
    [120, 125, 115, 121],
    [129, 130, 91, 129],
  ].map((prices, index) => row(index, prices));
}

function mirror(rows: Candle[]): Candle[] {
  return rows.map((candle, index) => row(index, [300 - candle.open, 300 - candle.low, 300 - candle.high, 300 - candle.close], candle.volume));
}

function prepared(rows: Candle[], side: 'LONG' | 'SHORT' = 'LONG') {
  const start = rows[9]!.openTime;
  return prepareSymbolBlock('BTCUSDT', rows, { ...settings, side }, 'VOLATILITY', start, rows.at(-1)!.closeTime);
}

describe('MA5 body volatility breakout preparation', () => {
  it.each([
    ['LONG', longCandles()],
    ['SHORT', mirror(longCandles())],
  ] as const)('creates the %s signal with the fixed conditions', (side, rows) => {
    const document = prepared(rows, side);
    const signal = document.bars[0]!.signal!;
    expect(signal).toMatchObject({
      strategy: 'VOLATILITY', side, exitMode: 'VOLATILITY_MA5', volatilityStopEnabled: true,
    });
    expect(signal.entry).toBeCloseTo(side === 'LONG' ? 128.4 : 171.6, 10);
    expect(signal.volatilityAtr).toBeTypeOf('number');
    expect(signal.stop).toBeCloseTo(signal.entry - (side === 'LONG' ? 1 : -1) * signal.volatilityAtr! * 2, 10);
    expect(signal.target).toBe(signal.entry);
    expect(signal.entry).not.toBe(rows[9]!.close);
    expect(signal.volatilityK1).toBeUndefined();
    expect(signal.volatilityK2).toBeUndefined();
  });

  it('does not use volume as a condition', () => {
    const rows = longCandles();
    rows[8]!.volume = 1_000;
    rows[9]!.volume = 1;
    expect(prepared(rows).bars[0]!.signal).not.toBeNull();
  });

  it.each([
    ['a previous body reaches MA5', (rows: Candle[]) => { rows[8]!.close = 110; }],
    ['the current candle midpoint is below MA5', (rows: Candle[]) => { rows[9]!.high = 105; rows[9]!.low = 90; }],
    ['the current body is less than twice the previous body', (rows: Candle[]) => { rows[9]!.open = 104.5; rows[9]!.close = 105; }],
  ])('rejects when %s', (_reason, change) => {
    const rows = longCandles(); change(rows);
    expect(prepared(rows).bars[0]!.signal).toBeNull();
  });

  it('uses the prior TR average for the two-ATR stop', () => {
    const rows = longCandles();
    rows[7]!.low = 88;
    const signal = prepared(rows).bars[0]!.signal!;
    expect(signal.volatilityAtr).toBeTypeOf('number');
    expect(signal.stop).toBeCloseTo(signal.entry - signal.volatilityAtr! * 2, 10);
  });

  it('keeps the signal aligned with a completed candle rather than requiring 1-minute data', () => {
    const document = prepared(longCandles());
    expect(document.bars[0]!.intrabarCandles).toBeUndefined();
    expect(document.bars[0]!.ma5Exit).toBeTypeOf('number');
  });
});

describe('MA5 body volatility breakout replay', () => {
  it.each([
    ['LONG', longCandles()],
    ['SHORT', mirror(longCandles())],
  ] as const)('enters at the completed signal close and exits when the candle midpoint crosses MA5, %s', (side, rows) => {
    const document = prepared(rows, side);
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], { ...settings, side }, rows[9]!.openTime, rows.at(-1)!.closeTime, 3600);
    const result = portfolioResult(state, { ...settings, side });
    expect(result.entryCount).toBe(1);
    expect(result.closedTradeCount).toBe(1);
    expect(result.exitReasons).toEqual({ VOLATILITY_MA5_EXIT: 1 });
    expect(result.recentTrades[0]!.entryPrice).toBeCloseTo(document.bars[0]!.signal!.entry * (side === 'LONG' ? 1.0002 : 0.9998), 10);
    expect(result.recentTrades[0]!.executions[0]).toMatchObject({ timing: 'INTRABAR', candleOpenAt: rows[9]!.openTime });
    expect(result.recentTrades[0]!.signal.stop).toBeCloseTo(result.recentTrades[0]!.entryPrice - (side === 'LONG' ? 1 : -1) * document.bars[0]!.signal!.volatilityAtr! * 2, 10);
    expect(result.recentTrades[0]!.priceLines).toEqual([
      { kind: 'ENTRY', price: result.recentTrades[0]!.entryPrice },
      { kind: 'SL', price: result.recentTrades[0]!.signal.stop },
    ]);
  });

  it.each([
    ['LONG', longCandles()],
    ['SHORT', mirror(longCandles())],
  ] as const)('does not use MA5 exit while the completed candle is below the entry profit zone, %s', (side, rows) => {
    rows[11] = side === 'LONG' ? row(11, [100, 130, 91, 100]) : row(11, [200, 209, 170, 200]);
    const document = prepared(rows, side);
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], { ...settings, side }, rows[9]!.openTime, rows.at(-1)!.closeTime, 3600);
    const result = portfolioResult(state, { ...settings, side });
    expect(result.entryCount).toBe(1);
    expect(result.closedTradeCount).toBe(0);
    expect(result.exitReasons).toEqual({});
  });

  it.each([
    ['LONG', longCandles()],
    ['SHORT', mirror(longCandles())],
  ] as const)('applies the ATR-based SL, %s', (side, rows) => {
    if (side === 'LONG') {
      rows[7]!.low = 95;
      rows[8]!.low = 94;
      rows[10]!.low = 50;
      rows[10]!.close = 119;
    } else {
      rows[6]!.high = 205;
      rows[7]!.high = 205;
      rows[8]!.high = 206;
      rows[10]!.high = 260;
      rows[10]!.close = 181;
    }
    const document = prepared(rows, side);
    const state = initialPortfolio(1_000);
    replayPortfolioBlock(state, [document], { ...settings, side }, rows[9]!.openTime, rows.at(-1)!.closeTime, 3600);
    expect(portfolioResult(state, { ...settings, side }).exitReasons).toEqual({ SL: 1 });
  });

  it('does not render a TP line for the new fixed-exit strategy', () => {
    const prefix = Array.from({ length: 12 }, (_, index) => row(index, [110, 111, 109, 110]));
    const rows = [...prefix, ...longCandles().map((candle, index) => ({ ...candle, openTime: origin + (index + 12) * 3600, closeTime: origin + (index + 13) * 3600 }))];
    const result = runBacktest(rows, settings, 'VOLATILITY');
    const trade = result.recentTrades[0]!;
    const chart = buildLocalChart(result, trade, settings);
    expect(chart.priceLines).toEqual([
      { kind: 'ENTRY', price: trade.entryPrice },
      { kind: 'SL', price: trade.signal.activeStop ?? trade.signal.stop },
    ]);
  });
});
