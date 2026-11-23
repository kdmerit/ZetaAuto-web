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

function shortRows(plateau = 20): Candle[] {
  const rows = Array.from({ length: entryIndex }, (_, index) => {
    const price = index < entryIndex - plateau ? 80 : 110;
    return candle(index, price, price + 1, price - 1, price);
  });
  rows[entryIndex - 2]!.high = 114;
  rows.push(candle(entryIndex, 110, 112, 103, 104, 2));
  return rows;
}

const signalAt = (rows: Candle[], index = entryIndex) => prepareNewHigh(rows, settings)[index]?.signal;

describe('new high/low signals', () => {
  it('enters a bullish 20-bar high at the inclusive 5× body and volume boundaries', () => {
    const rows = longRows();
    expect(signalAt(rows)).toMatchObject({ side: 'LONG', entry: 107, stop: 97.5 });
    expect(prepareNewHigh(rows, { ...settings, side: 'SHORT' }).at(-1)?.signal).toBeNull();
  });

  it.each([
    ['body size below 5×', (rows: Candle[]) => { rows[entryIndex]!.open = 102.001; }],
    ['volume below 5×', (rows: Candle[]) => { rows[entryIndex]!.volume = 49.999; }],
    ['body equal to 1.5× the upper wick', (rows: Candle[]) => { rows[entryIndex]!.high = 107 + 5 / 1.5; }],
    ['range midpoint equal to MA5', (rows: Candle[]) => { rows[entryIndex]!.low = 96; }],
    ['close equal to the high 20 bars back', (rows: Candle[]) => { rows[entryIndex - 20]!.high = 107; }],
    ['one step of the three-bar MA gap decreases', (rows: Candle[]) => { rows[entryIndex - 11] = candle(entryIndex - 11, 104, 105, 103, 104); }],
  ] as const)('rejects a long with %s', (_label, change) => {
    const rows = longRows();
    change(rows);
    expect(signalAt(rows)).toBeNull();
  });

  it('compares each earlier MA gap with the ATR that was available at that bar', () => {
    const rows = Array.from({ length: entryIndex }, (_, index) => candle(index, 100, 100, 100, 100));
    rows[entryIndex - 2] = candle(entryIndex - 2, 100, 101, 100, 101);
    rows[entryIndex - 1] = candle(entryIndex - 1, 101, 102, 101, 102);
    rows.push(candle(entryIndex, 102, 108, 101.5, 107, 50));
    expect(signalAt(rows)).toBeNull();
    // This prior TR falls outside the entry ATR but inside several lookback bars' ATR windows.
    rows[entryIndex - 21] = candle(entryIndex - 21, 100, 102, 98, 100);
    expect(signalAt(rows)).toMatchObject({ side: 'LONG' });
  });

  it.each([10, 11])('uses exactly the previous ten bars for long suppression (distance %i)', distance => {
    const rows = longRows();
    for (let index = rows.length; index <= entryIndex + distance; index += 1) rows.push(candle(index, 100, 102, 98, 100));
    setLongSetup(rows, entryIndex + distance, 13);
    expect(signalAt(rows, entryIndex + distance)?.side ?? null).toBe(distance === 10 ? null : 'LONG');
    // Lowering the first setup's volume leaves all later price/MA conditions unchanged.
    rows[entryIndex]!.volume = 10;
    expect(signalAt(rows, entryIndex + distance)?.side).toBe('LONG');
  });

  it('counts suppressed long setups in the next ten-bar window and across preparation blocks', () => {
    const rows = longRows();
    for (let index = rows.length; index <= entryIndex + 20; index += 1) rows.push(candle(index, 100, 102, 98, 100));
    setLongSetup(rows, entryIndex + 10, 13);
    setLongSetup(rows, entryIndex + 20, 30);
    const last = rows.at(-1)!;
    const warmup = newHighWarmup({ ...settings, side: 'LONG' }) / day;
    const block = () => prepareSymbolBlock('BTCUSDT', rows.slice(-warmup - 1),
      { ...settings, side: 'LONG' }, 'NEW_HIGH', last.openTime, last.closeTime).bars[0]!.signal;
    expect(block()).toBeNull();
    rows[entryIndex + 10]!.volume = 10;
    expect(block()?.side).toBe('LONG');
  });

  it('enters a bearish five-bar low above MA60 without requiring long volume or body conditions', () => {
    const rows = shortRows();
    expect(signalAt(rows)).toMatchObject({ side: 'SHORT', entry: 104, stop: 114 });
    expect(prepareNewHigh(rows, { ...settings, side: 'LONG' }).at(-1)?.signal).toBeNull();
    rows[entryIndex - 5]!.low = 104;
    expect(signalAt(rows)).toBeNull();
  });

  it('accepts short close-above-MA20 and MA10-above-MA20 conditions on different prior bars', () => {
    const rows = shortRows();
    [103, 103, 103, 107, 110].forEach((price, offset) => {
      const index = entryIndex - 5 + offset;
      rows[index] = candle(index, price, price + 1, price - 1, price);
    });
    rows[entryIndex] = candle(entryIndex, 110, 112, 100, 101);
    expect(signalAt(rows)?.side).toBe('SHORT');
  });

  it.each([5, 6])('uses exactly the previous five bars for short suppression (distance %i)', distance => {
    const rows = shortRows(17);
    const prices = [110, 110, 106, 105, 104].slice(0, distance - 1);
    prices.forEach((price, offset) => rows.push(candle(entryIndex + offset + 1, price, price + 1, price - 1, price)));
    rows.push(candle(entryIndex + distance, 105, 106, 99, 100));
    expect(signalAt(rows)?.side).toBe('SHORT');
    expect(signalAt(rows, entryIndex + distance)?.side ?? null).toBe(distance === 5 ? null : 'SHORT');
    rows[entryIndex]!.open = 104;
    expect(signalAt(rows, entryIndex + distance)?.side).toBe('SHORT');
  });

  it('requires the short close to be more than an ATR above MA60', () => {
    const rows = shortRows();
    rows[entryIndex - 20]!.high = 520;
    expect(signalAt(rows)).toBeNull();
  });
});

describe('new high/low executions', () => {
  it('holds through a wick break or a losing close and closes a profitable prior-low break at the close', () => {
    const rows = [...longRows(),
      candle(entryIndex + 1, 110, 113, 109, 112),
      candle(entryIndex + 2, 112, 112, 108, 110),
      candle(entryIndex + 3, 110, 111, 106, 107),
      candle(entryIndex + 4, 110, 112, 109.5, 111),
      candle(entryIndex + 5, 111, 112, 107.5, 108.5),
    ];
    const result = runBacktest(rows, settings, 'NEW_HIGH');
    expect(result).toMatchObject({ entryCount: 1, exitReasons: { NEW_HIGH_PREVIOUS_LOW_CLOSE: 1 } });
    const trade = result.recentTrades[0]!;
    expect(trade).toMatchObject({ entryAt: rows[entryIndex]!.closeTime, exitAt: rows.at(-1)!.closeTime,
      signal: { initialStop: 97.5, activeStop: 97.5 } });
    expect(trade.executions.map(fill => fill.timing)).toEqual(['BAR_CLOSE', 'BAR_CLOSE']);
    expect(trade.exitPrice).toBeCloseTo(108.5 * 0.9998, 12);
    expect(buildLocalChart(result, trade, settings).priceLines.map(line => line.kind)).toEqual(['ENTRY', 'SL', 'EXIT']);
  });

  it('ignores pre-entry extremes and gives the later stop priority over a long reversal close', () => {
    const rows = longRows();
    const input = { ...settings, newHighSlEnabled: false, newHighTpEnabled: true, newHighTrailingStopEnabled: true };
    expect(runBacktest(rows, input, 'NEW_HIGH')).toMatchObject({ entryCount: 1, openPositionCount: 1 });
    rows.push(candle(entryIndex + 1, 111, 113, 110, 112));
    rows.push(candle(entryIndex + 2, 112, 115, 97.5, 108));
    const result = runBacktest(rows, input, 'NEW_HIGH');
    expect(result.exitReasons).toEqual({ SL: 1 });
    expect(result.recentTrades[0]!.exitPrice).toBeCloseTo(97.5 * 0.9998, 12);
  });

  it('closes a short at the live MA60 touch independently of the closing price', () => {
    const rows = shortRows();
    const touch = rows.slice(-59).reduce((total, row) => total + row.close, 0) / 59;
    for (const close of [touch, 112]) {
      const result = runBacktest([...rows, candle(entryIndex + 1, 104, 113, touch, close)], settings, 'NEW_HIGH');
      expect(result.exitReasons).toEqual({ MA60_TOUCH: 1 });
      expect(result.recentTrades[0]!.exitPrice).toBeCloseTo(touch * 1.0002, 12);
    }
  });

  it('honors 15-minute order, prioritizes the stop within an ambiguous bar, and fills opening gaps', () => {
    const rows = shortRows();
    const touch = rows.slice(-59).reduce((total, row) => total + row.close, 0) / 59;
    const exit = candle(entryIndex + 1, 104, 115, touch, 112);
    const children = Array.from({ length: day / 900 }, (_, index): Candle => {
      const at = exit.openTime + index * 900;
      const prices = index === 0 ? [104, 105, touch, 104] : index === 1 ? [104, 115, 104, 112] : [112, 112, 112, 112];
      const [open, high, low, close] = prices as [number, number, number, number];
      return { openTime: at, closeTime: at + 900, open, high, low, close, volume: 1 };
    });
    const run = (bars: Candle[], intrabar?: Candle[]) => runBacktest(bars, settings, 'NEW_HIGH', undefined, undefined, intrabar);
    const result = run([...rows, exit], children);
    expect(result.exitReasons).toEqual({ MA60_TOUCH: 1 });
    expect(result.recentTrades[0]!.executions.at(-1)).toMatchObject({ at: exit.openTime, candleOpenAt: exit.openTime, timing: 'INTRABAR' });
    expect(run([...rows, exit]).exitReasons).toEqual({ SL: 1 });

    const gapped = run([...rows, candle(entryIndex + 1, 116, 118, touch, 111)]);
    expect(gapped.exitReasons).toEqual({ SL: 1 });
    expect(gapped.recentTrades[0]!.exitPrice).toBeCloseTo(116 * 1.0002, 12);
    const favorable = run([...rows, candle(entryIndex + 1, 85, 117, 84, 115)]);
    expect(favorable.exitReasons).toEqual({ MA60_TOUCH: 1 });
    expect(favorable.recentTrades[0]!.exitPrice).toBeCloseTo(85 * 1.0002, 12);
  });

  it('retains fixed-loss sizing with the three-bar stop including transaction costs', () => {
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
    expect(newHighWarmup({ ...settings, side: 'LONG' })).toBe(41 * day);
    expect(newHighWarmup({ ...settings, side: 'SHORT' })).toBe(64 * day);
    expect(newHighWarmup(current)).toBe(20 * day + 21 * 3600);
  });
});
