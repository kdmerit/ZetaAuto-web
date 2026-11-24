import { describe, expect, it } from 'vitest';
import { defaultSettings } from './components/StrategyBacktest';
import { buildLocalChart, runBacktest } from './engine';
import { prepareMaDisparity } from './maDisparity';
import { maDisparityEntryCandles } from './test/maDisparityFixtures';
import type { Candle } from './types';

const day = 86400;
const entryOpen = Date.UTC(2026, 4, 1) / 1000;
const input = defaultSettings('MA_DISPARITY');
const sides = ['LONG', 'SHORT'] as const;
type Side = typeof sides[number];
const fixture = () => maDisparityEntryCandles(entryOpen, day);

function inDirection(candles: Candle[], side: Side): Candle[] {
  return side === 'LONG' ? candles : candles.map(row => ({
    ...row, open: 250 - row.open, high: 250 - row.low, low: 250 - row.high, close: 250 - row.close,
  }));
}

function setup(rows: Candle[], side: Side) {
  return prepareMaDisparity(inDirection(rows, side), input).at(-1)?.signal;
}

function setPrice(row: Candle, close: number): void {
  Object.assign(row, { open: close, high: close + 0.25, low: close - 0.25, close });
}

describe.each(sides)('%s MA disparity', side => {
  it('accepts an exactly two-times body and sets the stop from the signal and prior three candles', () => {
    const rows = fixture();
    rows.at(-5)!.low = 90;
    expect(setup(rows, side)).toMatchObject({ strategy: 'MA_DISPARITY', side, entry: side === 'LONG' ? 107 : 143,
      stop: side === 'LONG' ? 98.5 : 151.5 });
    rows.at(-1)!.low = 97;
    expect(setup(rows, side)?.stop).toBe(side === 'LONG' ? 97 : 153);
    const otherSide = side === 'LONG' ? 'SHORT' : 'LONG';
    expect(prepareMaDisparity(inDirection(rows, side), { ...input, side: otherSide }).at(-1)?.signal).toBeNull();
  });

  it.each([
    ['body below twice the previous body', (rows: Candle[]) => { rows.at(-1)!.open = 105.01; }],
    ['body equal to 1.5 times the wick', (rows: Candle[]) => { rows.at(-1)!.high = 107 + 2 / 1.5; }],
    ['third preceding high equal to that candle’s MA20', (rows: Candle[]) => { rows.at(-4)!.high = 104.85; }],
    ['one increase in the preceding signed gap', (rows: Candle[]) => { setPrice(rows.at(-13)!, 119); }],
    ['no opposing MA order in the preceding candles', (rows: Candle[]) => {
      for (const row of rows.slice(-11, -4)) setPrice(row, row.close + 14);
      Object.assign(rows.at(-1)!, { open: 107, high: 109.5, low: 106.75, close: 109 });
    }],
    ['high breaks MA20 but the close remains below it', (rows: Candle[]) => { Object.assign(rows.at(-1)!, { open: 90, low: 89, close: 102 }); }],
  ] as const)('rejects %s', (_label, change) => {
    const rows = fixture();
    change(rows);
    expect(setup(rows, side)).toBeNull();
  });

  it('allows the signed gap to decrease across zero during the three preceding candles', () => {
    const rows = fixture();
    for (const row of rows.slice(-11, -4)) setPrice(row, row.close + 11);
    expect(setup(rows, side)?.side).toBe(side);
  });

  it('accepts equality at the 3× gap ratio and rejects a narrower gap to MA60', () => {
    const rows = fixture();
    for (const row of rows.slice(-60, -30)) setPrice(row, 112.05);
    for (const row of rows.slice(-20, -13)) Object.assign(row, { low: row.close, high: row.close });
    rows.at(-4)!.low = 100.75;
    expect(setup(rows, side)?.side).toBe(side);
    setPrice(rows.at(-60)!, 112.04);
    expect(setup(rows, side)).toBeNull();
  });

  it('accepts exactly two ATRs of room and rejects less, using the ATR before the signal candle', () => {
    const rows = fixture();
    // Signal MA60 is 114.125. Widen an earlier wick so that ATR is exactly 3.5625.
    rows.at(-8)!.high = 135.75;
    rows.at(-1)!.low = 90;
    expect(setup(rows, side)?.side).toBe(side);
    rows.at(-8)!.high += 0.01;
    expect(setup(rows, side)).toBeNull();
  });

  it('opens at the confirmed close and takes the first subsequent touch of the live MA60', () => {
    const rows = fixture();
    Object.assign(rows.at(-1)!, { open: 95, low: 94, high: 114.5 });
    const initial = runBacktest(inDirection(rows, side), input, 'MA_DISPARITY');
    expect(initial).toMatchObject({ entryCount: 1, openPositionCount: 1, exitReasons: {} });

    const target = 6727.5 / 59;
    const at = entryOpen + day;
    rows.push({ openTime: at, closeTime: at + day, open: 107, high: target, low: 102, close: 104, volume: 10 });
    const prices = inDirection(rows, side);
    const result = runBacktest(prices, input, 'MA_DISPARITY');
    expect(result).toMatchObject({ entryCount: 1, closedTradeCount: 1, exitReasons: { MA60_TOUCH: 1 } });
    const trade = result.recentTrades[0]!;
    expect(trade.executions).toMatchObject([{ kind: 'ENTRY', at, timing: 'BAR_CLOSE' }, { kind: 'CLOSE', at, timing: 'INTRABAR' }]);
    expect(trade.signal.initialTarget).toBeCloseTo(side === 'LONG' ? 114.125 : 250 - 114.125);
    expect(trade.exitPrice).toBeCloseTo(side === 'LONG' ? target * 0.9998 : (250 - target) * 1.0002);
    expect(buildLocalChart(result, trade, input).priceLines.map(line => line.kind)).toEqual(['ENTRY', 'SL', 'TP', 'EXIT']);
  });

  it('prioritizes the stop when the intrabar order is unknown and uses the actual opening on a gap', () => {
    const rows = fixture();
    const at = entryOpen + day;
    const after = { openTime: at, closeTime: at + day, open: 107, high: 117, low: 97, close: 105, volume: 10 };
    rows.push(after);
    const check = (level: number) => {
      const result = runBacktest(inDirection(rows, side), input, 'MA_DISPARITY');
      expect(result.exitReasons).toEqual({ SL: 1 });
      expect(result.recentTrades[0]?.exitPrice).toBeCloseTo(side === 'LONG' ? level * 0.9998 : (250 - level) * 1.0002);
    };
    check(98.5);
    after.open = 98;
    check(98);
  });
});
