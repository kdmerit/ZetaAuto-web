import { describe, expect, it } from 'vitest';
import { defaultSettings } from './components/StrategyBacktest';
import { buildLocalChart, prepareSymbolBlock, runBacktest } from './engine';
import { currentNewHighSettings, newHighWarmup, prepareNewHigh } from './newHigh';
import { initialPortfolio, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle } from './types';

const day = 86400;
const origin = Date.UTC(2026, 0, 1) / 1000;
const entryIndex = 80;
const settings: BacktestSettings = { ...defaultSettings('NEW_HIGH'), interval: '1d' };
const sides = ['LONG', 'SHORT'] as const;

function candle(index: number, open: number, high: number, low: number, close: number, volume = 10): Candle {
  const openTime = origin + index * day;
  return { openTime, closeTime: openTime + day, open, high, low, close, volume };
}

function setLongSetup(rows: Candle[], index: number, offset = 0): void {
  rows[index - 2] = candle(index - 2, 100.75 + offset, 102 + offset, 97.5 + offset, 101 + offset);
  rows[index - 1] = candle(index - 1, 101 + offset, 103 + offset, 100 + offset, 102 + offset);
  rows[index] = candle(index, 102 + offset, 108 + offset, 101.5 + offset, 107 + offset, 50);
}

function longRows(): Candle[] {
  const rows = Array.from({ length: entryIndex }, (_, index) => candle(index, 100, 102, 98, 100));
  setLongSetup(rows, entryIndex);
  return rows;
}

function inDirection(rows: Candle[], side: typeof sides[number]): Candle[] {
  return side === 'LONG' ? rows : rows.map(row => ({
    ...row, open: 200 - row.open, high: 200 - row.low, low: 200 - row.high, close: 200 - row.close,
  }));
}

const signalAt = (rows: Candle[], index = entryIndex) => prepareNewHigh(rows, settings)[index]?.signal;

describe.each(sides)('%s new high/low signals', side => {
  it('enters a 20-bar breakout at the inclusive 5× body and volume boundaries', () => {
    const rows = inDirection(longRows(), side);
    expect(signalAt(rows)).toMatchObject({ side, entry: side === 'LONG' ? 107 : 93, stop: side === 'LONG' ? 101.5 : 98.5 });
    const opposite = side === 'LONG' ? 'SHORT' : 'LONG';
    expect(prepareNewHigh(rows, { ...settings, side: opposite }).at(-1)?.signal).toBeNull();
  });

  it.each([
    ['body size below 5×', (rows: Candle[]) => { rows[entryIndex]!.open = 102.001; }],
    ['volume below 5×', (rows: Candle[]) => { rows[entryIndex]!.volume = 49.999; }],
    ['body equal to 1.5× the breakout-side wick', (rows: Candle[]) => { rows[entryIndex]!.high = 107 + 5 / 1.5; }],
    ['range midpoint equal to MA5', (rows: Candle[]) => { rows[entryIndex]!.low = 96; }],
    ['close equal to the breakout level 20 bars back', (rows: Candle[]) => { rows[entryIndex - 20]!.high = 107; }],
    ['one step of the three-bar MA gap moving the wrong way', (rows: Candle[]) => { rows[entryIndex - 11] = candle(entryIndex - 11, 104, 105, 103, 104); }],
  ] as const)('rejects a signal with %s', (_label, change) => {
    const rows = longRows();
    change(rows);
    expect(signalAt(inDirection(rows, side))).toBeNull();
  });

  it.each([false, true])('allows the MA20–MA60 gap at one ATR and rejects a larger absolute gap (higher historical prices: %s)', higherHistory => {
    const rows = Array.from({ length: entryIndex }, (_, index) => candle(index, 100, 100, 100, 100));
    if (higherHistory) {
      // Raise the entry MA60 by exactly 1, with no effect on its MA20 or ATR.
      for (let index = entryIndex - 59; index < entryIndex - 29; index += 1) rows[index] = candle(index, 102, 102, 102, 102);
    }
    rows[entryIndex - 8] = candle(entryIndex - 8, 100, 104, 96, 100);
    rows[entryIndex - 2] = candle(entryIndex - 2, 100, 101, 100, 101);
    rows[entryIndex - 1] = candle(entryIndex - 1, 101, 102, 101, 102);
    rows.push(candle(entryIndex, 102, 113, 101.5, 112, 50));
    // The entry gap is ±0.5 and the preceding 20 true ranges sum to 10.
    expect(signalAt(inDirection(rows, side))?.side).toBe(side);
    rows[entryIndex - 8]!.high = 103.99;
    expect(signalAt(inDirection(rows, side))).toBeNull();
  });

  it('compares each earlier MA gap with the ATR that was available at that bar', () => {
    const rows = Array.from({ length: entryIndex }, (_, index) => candle(index, 100, 100, 100, 100));
    rows[entryIndex - 2] = candle(entryIndex - 2, 100, 101, 100, 101);
    rows[entryIndex - 1] = candle(entryIndex - 1, 101, 102, 95, 102);
    rows.push(candle(entryIndex, 102, 108, 101.5, 107, 50));
    expect(signalAt(inDirection(rows, side))).toBeNull();
    // This prior TR falls outside the entry ATR but inside several lookback bars' ATR windows.
    rows[entryIndex - 21] = candle(entryIndex - 21, 100, 102, 98, 100);
    expect(signalAt(inDirection(rows, side))).toMatchObject({ side });
  });

  it.each([10, 11])('uses exactly the previous ten bars for signal suppression (distance %i)', distance => {
    const rows = longRows();
    for (let index = rows.length; index <= entryIndex + distance; index += 1) rows.push(candle(index, 100, 102, 98, 100));
    setLongSetup(rows, entryIndex + distance, 13);
    expect(signalAt(inDirection(rows, side), entryIndex + distance)?.side ?? null).toBe(distance === 10 ? null : side);
    // Lowering the first setup's volume leaves all later price/MA conditions unchanged.
    rows[entryIndex]!.volume = 10;
    expect(signalAt(inDirection(rows, side), entryIndex + distance)?.side).toBe(side);
  });

  it('counts suppressed setups in the next ten-bar window and across preparation blocks', () => {
    const rows = longRows();
    for (let index = rows.length; index <= entryIndex + 20; index += 1) rows.push(candle(index, 100, 102, 98, 100));
    setLongSetup(rows, entryIndex + 10, 13);
    setLongSetup(rows, entryIndex + 20, 30);
    const last = rows.at(-1)!;
    const warmup = newHighWarmup({ ...settings, side }) / day;
    const block = () => prepareSymbolBlock('BTCUSDT', inDirection(rows.slice(-warmup - 1), side),
      { ...settings, side }, 'NEW_HIGH', last.openTime, last.closeTime).bars[0]!.signal;
    expect(block()).toBeNull();
    rows[entryIndex + 10]!.volume = 10;
    expect(block()?.side).toBe(side);
  });
});

describe('new high/low executions', () => {
  it.each(sides)('holds %s through wick touches and equal closes, then exits on a losing reversal close', side => {
    const rows = inDirection([...longRows(),
      candle(entryIndex + 1, 110, 113, 109, 112),
      candle(entryIndex + 2, 112, 112, 108, 110),
      candle(entryIndex + 3, 110, 111, 106, 108),
      candle(entryIndex + 4, 108, 109, 104.5, 105),
    ], side);
    const reason = side === 'LONG' ? 'NEW_HIGH_PREVIOUS_LOW_CLOSE' : 'NEW_HIGH_PREVIOUS_HIGH_CLOSE';
    const stop = side === 'LONG' ? 101.5 : 98.5;
    const result = runBacktest(rows, settings, 'NEW_HIGH');
    expect(result).toMatchObject({ entryCount: 1, lossCount: 1, exitReasons: { [reason]: 1 } });
    const trade = result.recentTrades[0]!;
    expect(trade).toMatchObject({ entryAt: rows[entryIndex]!.closeTime, exitAt: rows.at(-1)!.closeTime,
      signal: { initialStop: stop, activeStop: stop } });
    expect(trade.executions.map(fill => fill.timing)).toEqual(['BAR_CLOSE', 'BAR_CLOSE']);
    expect(trade.exitPrice).toBeCloseTo(side === 'LONG' ? 105 * 0.9998 : 95 * 1.0002, 12);
    const { priceLines } = buildLocalChart(result, trade, settings);
    expect(priceLines.map(line => line.kind)).toEqual(['ENTRY', 'SL', 'EXIT']);
    expect(priceLines).toContainEqual({ kind: 'SL', price: stop });
  });

  it.each(sides)('ignores pre-entry extremes and gives the later stop priority over a %s reversal close', side => {
    const rows = inDirection(longRows(), side);
    const input = { ...settings, newHighSlEnabled: false, newHighTpEnabled: true, newHighTrailingStopEnabled: true };
    expect(runBacktest(rows, input, 'NEW_HIGH')).toMatchObject({ entryCount: 1, openPositionCount: 1 });
    rows.push(...inDirection([candle(entryIndex + 1, 111, 113, 110, 112), candle(entryIndex + 2, 112, 115, 101.5, 108)], side));
    const result = runBacktest(rows, input, 'NEW_HIGH');
    expect(result.exitReasons).toEqual({ SL: 1 });
    expect(result.recentTrades[0]!.exitPrice).toBeCloseTo(side === 'LONG' ? 101.5 * 0.9998 : 98.5 * 1.0002, 12);
  });

  it('fills a short stop at the opening price of the first 15-minute bar that gaps past it', () => {
    const rows = inDirection(longRows(), 'SHORT');
    const exit = candle(entryIndex + 1, 93, 101, 91, 91.5);
    const children = Array.from({ length: day / 900 }, (_, index): Candle => {
      const at = exit.openTime + index * 900;
      const [open, high, low, close] = index === 0 ? [93, 94, 91, 92] as const
        : index === 1 ? [100, 101, 91.5, 91.5] as const : [91.5, 91.5, 91.5, 91.5] as const;
      return { openTime: at, closeTime: at + 900, open, high, low, close, volume: 1 };
    });
    const result = runBacktest([...rows, exit], settings, 'NEW_HIGH', undefined, undefined, children);
    expect(result.exitReasons).toEqual({ SL: 1 });
    const trade = result.recentTrades[0]!;
    expect(trade.executions.at(-1)).toMatchObject({ at: exit.openTime + 900, candleOpenAt: exit.openTime });
    expect(trade.exitPrice).toBeCloseTo(100 * 1.0002, 12);
  });

  it('sizes the order using the entry candle stop and transaction costs', () => {
    const rows = [...longRows(), candle(entryIndex + 1, 107, 109, 101.5, 103)];
    const input = { ...settings, newHighSizingMode: 'RISK' as const, newHighRiskAmount: '10' };
    const trade = runBacktest(rows, input, 'NEW_HIGH').recentTrades[0]!;
    expect(trade.reason).toBe('SL');
    expect(trade.netProfitUsdt).toBeCloseTo(-10, 10);
  });

  it('uses opening cash for new orders in the shared account and allows no same-bar re-entry', () => {
    const rows = longRows();
    const offset = rows.at(-1)!.openTime;
    const input = { ...settings, initialCapitalUsdt: '101' };
    const first = prepareSymbolBlock('AAAUSDT', rows, input, 'NEW_HIGH', offset, offset + day).bars[0]!;
    const exit = candle(entryIndex + 1, 106, 110, 101.5, 108);
    const second = { ...first, candle: exit };
    const state = initialPortfolio(101);
    replayPortfolioBlock(state, [{ symbol: 'AAAUSDT', bars: [first, second] }, { symbol: 'ZZZUSDT', bars: [second] }],
      input, offset, exit.closeTime, day);
    expect(state).toMatchObject({ entries: 1, closed: 1, insufficientFunds: 1, positions: {} });
    expect(Object.keys(state.positions)).toEqual([]);
  });
});

describe('new high settings migration', () => {
  it('discards obsolete rule inputs while retaining the selected stake and enough history for each direction', () => {
    const current = currentNewHighSettings({ ...settings, interval: '15m', newHighLookback: 'invalid',
      newHighSlEnabled: false, newHighTpMultiplier: 'invalid', newHighDailyMa20Enabled: true, betAmountUsdt: '25' });
    expect(current).toMatchObject({ interval: '1h', betAmountUsdt: '25', newHighSizingMode: 'BET' });
    for (const field of ['newHighLookback', 'newHighSlEnabled', 'newHighTpMultiplier', 'newHighDailyMa20Enabled']) expect(current).not.toHaveProperty(field);
    expect(newHighWarmup({ ...settings, side: 'LONG' })).toBe(69 * day);
    expect(newHighWarmup({ ...settings, side: 'SHORT' })).toBe(69 * day);
    expect(newHighWarmup(current)).toBe(20 * day + 21 * 3600);
  });
});
