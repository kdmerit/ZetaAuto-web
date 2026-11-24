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
  rows[index - 2] = candle(index - 2, 99.5, 99.75, 97.5, 99.5);
  rows[index - 1] = candle(index - 1, 101 + offset, 103 + offset, 100 + offset, 102 + offset);
  rows[index] = candle(index, 102 + offset, 108 + offset, 101.5 + offset, 107 + offset);
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
  it('ignores the sixth bar and accepts the inclusive 1.5× body threshold at lower volume', () => {
    const fixture = longRows();
    fixture[entryIndex - 6] = candle(entryIndex - 6, 100, 109, 95, 100);
    fixture[entryIndex] = candle(entryIndex, 105.5, 107.75, 96.5, 107, 1);
    const rows = inDirection(fixture, side);
    expect(signalAt(rows)).toMatchObject({ side, entry: side === 'LONG' ? 107 : 93, stop: side === 'LONG' ? 97.5 : 102.5 });
    const opposite = side === 'LONG' ? 'SHORT' : 'LONG';
    expect(prepareNewHigh(rows, { ...settings, side: opposite }).at(-1)?.signal).toBeNull();
  });

  it('uses the wick to break the five-bar extreme and keeps the close as the entry price', () => {
    const rows = longRows();
    rows[entryIndex - 5]!.high = 107.5;
    expect(signalAt(inDirection(rows, side))).toMatchObject({ side, entry: side === 'LONG' ? 107 : 93 });
  });

  it('accepts a strict MA60 crossing on the signal bar when the previous bar is still on the other side', () => {
    const rows = longRows();
    // Older closes raise MA60 to 108 at entry. The larger prior range keeps the gap within ATR.
    for (let index = entryIndex - 40; index < entryIndex - 30; index += 1) {
      rows[index] = candle(index, 147.15, 147.15, 147.15, 147.15);
    }
    rows[entryIndex - 4]!.low = 20;
    expect(signalAt(inDirection(rows, side))).toBeNull();
    rows[entryIndex]!.high = 108.1;
    expect(signalAt(inDirection(rows, side))?.side).toBe(side);
  });

  it('accepts an MA60 crossing on the previous bar and ignores an older crossing', () => {
    const rows = longRows();
    rows[entryIndex - 4] = candle(entryIndex - 4, 99.5, 99.75, 98, 99.5);
    rows[entryIndex - 2]!.high = 102; // The last crossing is three bars back.
    expect(signalAt(inDirection(rows, side))).toBeNull();
    rows[entryIndex - 2]!.high = 99.75;
    expect(signalAt(inDirection(rows, side))?.side).toBe(side);
  });

  it('requires the preceding five-bar stop to be strictly beyond all three moving averages', () => {
    const rows = longRows();
    for (let index = entryIndex - 40; index < entryIndex - 30; index += 1) {
      rows[index] = candle(index, 108.4, 108.4, 108.4, 108.4);
    }
    for (let index = entryIndex - 5; index <= entryIndex - 2; index += 1) {
      rows[index] = candle(index, 101, 101.25, 101, 101);
    }
    rows[entryIndex - 1]!.low = 101;
    rows[entryIndex - 6]!.low = 95;
    rows[entryIndex]!.low = 99;
    // The lowest eligible low equals entry MA20. Both the current and sixth older lows are below it.
    rows[entryIndex - 5]!.low = 100.65;
    expect(signalAt(inDirection(rows, side))).toBeNull();
    rows[entryIndex - 5]!.low = 100.64;
    expect(signalAt(inDirection(rows, side))).toMatchObject({ side, stop: side === 'LONG' ? 100.64 : 200 - 100.64 });
  });

  it('compares the signed MA20–MA60 gap across zero', () => {
    const rows = longRows();
    // Adding 0.2 to each MA60 leaves two negative gaps followed by a positive one.
    rows[entryIndex - 30] = candle(entryIndex - 30, 112, 112, 112, 112);
    expect(signalAt(inDirection(rows, side))?.side).toBe(side);
  });

  it.each([
    ['body size below 1.5×', (rows: Candle[]) => { rows[entryIndex]!.open = 105.501; rows[entryIndex]!.high = 107.75; }],
    ['body equal to 1.5× the breakout-side wick', (rows: Candle[]) => { rows[entryIndex]!.high = 107 + 5 / 1.5; }],
    ['range midpoint equal to MA5', (rows: Candle[]) => { rows[entryIndex]!.low = 95.4; }],
    ['a wick equal to the breakout level five bars back', (rows: Candle[]) => { rows[entryIndex - 5]!.high = 108; }],
    ['one step of the MA10–MA20 gap moving the wrong way', (rows: Candle[]) => { rows[entryIndex - 11] = candle(entryIndex - 11, 104, 105, 103, 104); }],
    ['a flat first step of the MA20–MA60 gap', (rows: Candle[]) => {
      rows[entryIndex - 21]!.close = 102;
      rows[entryIndex - 61]!.close = 102;
    }],
    ['the last step of the MA20–MA60 gap moving the wrong way', (rows: Candle[]) => {
      rows[entryIndex - 20] = candle(entryIndex - 20, 100, 105, 98, 105);
    }],
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
    rows[entryIndex - 8] = candle(entryIndex - 8, 100, 103.5, 96.5, 100);
    rows[entryIndex - 2] = candle(entryIndex - 2, 99.5, 99.75, 99.5, 99.5);
    rows[entryIndex - 1] = candle(entryIndex - 1, 101, 102, 101, 102);
    rows.push(candle(entryIndex, 102, 114.5, 101.5, 113.5));
    // The entry gap is ±0.5 and the preceding 20 true ranges sum to 10.
    expect(signalAt(inDirection(rows, side))?.side).toBe(side);
    rows[entryIndex - 8]!.high = 103.49;
    expect(signalAt(inDirection(rows, side))).toBeNull();
  });

  it('checks the ATR available at each of the preceding five bars', () => {
    const rows = Array.from({ length: entryIndex }, (_, index) => candle(index, 100, 100, 100, 100));
    rows[entryIndex - 2] = candle(entryIndex - 2, 99.5, 99.75, 99.5, 99.5);
    rows[entryIndex - 1] = candle(entryIndex - 1, 101, 102, 95, 102);
    rows.push(candle(entryIndex, 102, 108, 101.5, 107));
    // The first extra TR is visible only as far as the sixth prior bar. The next reaches the fifth.
    rows[entryIndex - 26] = candle(entryIndex - 26, 100, 102, 98, 100);
    expect(signalAt(inDirection(rows, side))).toBeNull();
    rows[entryIndex - 25] = candle(entryIndex - 25, 100, 102, 98, 100);
    expect(signalAt(inDirection(rows, side))).toMatchObject({ side });
  });

  it.each([5, 6])('uses exactly the previous five bars for signal suppression (distance %i)', distance => {
    const rows = longRows();
    for (let index = rows.length; index <= entryIndex + distance; index += 1) rows.push(candle(index, 100, 102, 98, 100));
    setLongSetup(rows, entryIndex + distance, 13);
    expect(signalAt(inDirection(rows, side), entryIndex + distance)?.side ?? null).toBe(distance === 5 ? null : side);
    // Convert the earlier signal into a doji without changing the later MA and ATR inputs.
    rows[entryIndex]!.open = rows[entryIndex]!.close;
    expect(signalAt(inDirection(rows, side), entryIndex + distance)?.side).toBe(side);
  });

  it('counts suppressed setups in the next five-bar window and across preparation blocks', () => {
    const rows = longRows();
    for (let index = rows.length; index <= entryIndex + 10; index += 1) rows.push(candle(index, 100, 102, 98, 100));
    setLongSetup(rows, entryIndex + 5, 13);
    setLongSetup(rows, entryIndex + 10, 30);
    const last = rows.at(-1)!;
    const warmup = newHighWarmup({ ...settings, side }) / day;
    const block = () => prepareSymbolBlock('BTCUSDT', inDirection(rows.slice(-warmup - 1), side),
      { ...settings, side }, 'NEW_HIGH', last.openTime, last.closeTime).bars[0]!.signal;
    expect(block()).toBeNull();
    rows[entryIndex + 5]!.open = rows[entryIndex + 5]!.close;
    expect(block()?.side).toBe(side);
  });
});

describe('new high/low executions', () => {
  it.each(sides)('takes %s partial profit once at one stop distance and closes the rest beyond current MA20', side => {
    const stop = side === 'LONG' ? 97.5 : 102.5;
    const entry = side === 'LONG' ? 107 * 1.0002 : 93 * 0.9998;
    const partial = entry + (entry - stop);
    const rows = inDirection([...longRows(),
      candle(entryIndex + 1, 107, 118, 106, 109.5),
      candle(entryIndex + 2, 109.5, 118, 99.5, 101), // Touches TP again and closes between MA10 and MA20.
      candle(entryIndex + 3, 101, 105, 99.5, 101), // Close equals MA20.
      candle(entryIndex + 4, 101, 102, 99.5, 101.025), // Between the prior MA20 of 101 and the current 101.05125.
    ], side);
    rows[entryIndex + 1]![side === 'LONG' ? 'high' : 'low'] = partial;
    const result = runBacktest(rows, settings, 'NEW_HIGH');
    expect(result).toMatchObject({ entryCount: 1, closedTradeCount: 1, winCount: 1, openPositionCount: 0,
      exitReasons: { PARTIAL_TP: 1, NEW_HIGH_MA20_CLOSE: 1 } });
    const partialTrade = result.recentTrades[0]!;
    const trade = result.recentTrades[1]!;
    expect(partialTrade).toMatchObject({ reason: 'PARTIAL_TP', exitPrice: partial,
      exitAt: rows[entryIndex + 1]!.openTime, quantity: trade.quantity });
    expect(trade).toMatchObject({ reason: 'NEW_HIGH_MA20_CLOSE', entryAt: rows[entryIndex]!.closeTime,
      exitAt: rows.at(-1)!.closeTime, signal: { initialStop: stop, activeStop: stop, partial } });
    expect(trade.executions.map(fill => fill.kind)).toEqual(['ENTRY', 'PARTIAL_TP', 'CLOSE']);
    expect(trade.executions.map(fill => fill.timing)).toEqual(['BAR_CLOSE', 'INTRABAR', 'BAR_CLOSE']);
    expect(trade.quantity).toBe(trade.executions[0]!.quantity / 2);
    expect(trade.exitPrice).toBeCloseTo(side === 'LONG' ? 101.025 * 0.9998 : 98.975 * 1.0002, 12);
    expect(trade.netProfitUsdt).toBeCloseTo(result.realizedProfitUsdt, 12);
    const { priceLines } = buildLocalChart(result, trade, settings);
    expect(priceLines.map(line => line.kind)).toEqual(['ENTRY', 'SL', 'PARTIAL_TP', 'EXIT']);
    expect(priceLines).toContainEqual({ kind: 'SL', price: stop });
    expect(priceLines).toContainEqual({ kind: 'PARTIAL_TP', price: partial });
  });

  it.each(sides)('closes all of a %s position if MA20 triggers before any partial fill', side => {
    const rows = inDirection([...longRows(), candle(entryIndex + 1, 107, 110, 98.5, 100)], side);
    const result = runBacktest(rows, settings, 'NEW_HIGH');
    expect(result.exitReasons).toEqual({ NEW_HIGH_MA20_CLOSE: 1 });
    const trade = result.recentTrades[0]!;
    expect(trade.quantity).toBe(trade.executions[0]!.quantity);
    expect(trade.exitAt).toBe(rows.at(-1)!.closeTime);
  });

  it.each(sides)('ignores pre-entry extremes and gives the %s stop priority when the intrabar order is unknown', side => {
    const fixture = longRows();
    fixture[entryIndex]!.low = 96.5;
    const rows = inDirection(fixture, side);
    const input = { ...settings, newHighSlEnabled: false, newHighTpEnabled: true, newHighTrailingStopEnabled: true };
    expect(runBacktest(rows, input, 'NEW_HIGH')).toMatchObject({ entryCount: 1, openPositionCount: 1, exitReasons: {} });
    rows.push(...inDirection([candle(entryIndex + 1, 107, 118, 97.5, 98)], side));
    const result = runBacktest(rows, input, 'NEW_HIGH');
    expect(result.exitReasons).toEqual({ SL: 1 });
    expect(result.recentTrades[0]!.exitPrice).toBeCloseTo(side === 'LONG' ? 97.5 * 0.9998 : 102.5 * 1.0002, 12);
  });

  it('fills a short partial target before a later 15-minute stop that gaps past its price', () => {
    const rows = inDirection(longRows(), 'SHORT');
    const exit = candle(entryIndex + 1, 93, 105, 82, 91.5);
    const children = Array.from({ length: day / 900 }, (_, index): Candle => {
      const at = exit.openTime + index * 900;
      const [open, high, low, close] = index === 0 ? [93, 94, 82, 90] as const
        : index === 1 ? [104, 105, 90, 91.5] as const : [91.5, 91.5, 91.5, 91.5] as const;
      return { openTime: at, closeTime: at + 900, open, high, low, close, volume: 1 };
    });
    const result = runBacktest([...rows, exit], settings, 'NEW_HIGH', undefined, undefined, children);
    expect(result.exitReasons).toEqual({ PARTIAL_TP: 1, SL: 1 });
    const trade = result.recentTrades[1]!;
    expect(trade.executions.slice(1)).toMatchObject([
      { kind: 'PARTIAL_TP', at: exit.openTime, candleOpenAt: exit.openTime },
      { kind: 'CLOSE', at: exit.openTime + 900, candleOpenAt: exit.openTime },
    ]);
    expect(trade.exitPrice).toBeCloseTo(104 * 1.0002, 12);
  });

  it('fills the target at a favorable opening before a later stop in the same replay bar', () => {
    const exit = candle(entryIndex + 1, 117, 118, 97.5, 101);
    const result = runBacktest([...longRows(), exit], settings, 'NEW_HIGH');
    expect(result.exitReasons).toEqual({ PARTIAL_TP: 1, SL: 1 });
    expect(result.recentTrades[1]!.executions.slice(1)).toMatchObject([
      { kind: 'PARTIAL_TP', at: exit.openTime }, { kind: 'CLOSE' },
    ]);
  });

  it('sizes the order using the five-bar stop and transaction costs', () => {
    const rows = [...longRows(), candle(entryIndex + 1, 107, 109, 97.5, 103)];
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
    const exit = candle(entryIndex + 1, 106, 110, 97.5, 108);
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
    expect(newHighWarmup({ ...settings, side: 'LONG' })).toBe(66 * day);
    expect(newHighWarmup({ ...settings, side: 'SHORT' })).toBe(66 * day);
    expect(newHighWarmup(current)).toBe(20 * day + 11 * 3600);
  });
});
