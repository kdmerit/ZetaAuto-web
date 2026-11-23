import { describe, expect, it } from 'vitest';

import { buildLocalChart, prepareSymbolBlock, runBacktest } from './engine';
import { initialPortfolio, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle } from './types';

const origin = Date.UTC(2026, 0, 1) / 1000;
const entryIndex = 500;
const settings: BacktestSettings = {
  mode: 'SINGLE', symbol: 'BTC', interval: '1h', side: 'BOTH',
  startDate: '2026-01-01', startTime: '00:00', endDate: '2026-02-01', endTime: '00:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1',
  partialTpEnabled: false, fullTpWavePercent: '100', minDisparityPercent: '1.0',
  ma20HalfCloseEnabled: false, roiClosePercent: '100', minVolatilityPercent: '0.5',
  volatilityK1: '0.5', volatilityK2: '1.0', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
};

type Prices = [open: number, high: number, low: number, close: number];

function candle(index: number, [open, high, low, close]: Prices): Candle {
  return {
    openTime: origin + index * 3600,
    closeTime: origin + (index + 1) * 3600,
    open, high, low, close, volume: 10,
  };
}

function breakoutFixture(following: Prices[] = []): Candle[] {
  return [
    ...Array.from({ length: entryIndex - 1 }, (_, index) => candle(index, [120, 124, 116, 120])),
    candle(entryIndex - 1, [112, 114, 102, 109]),
    candle(entryIndex, [100, 115, 95, 106]),
    ...following.map((prices, offset) => candle(entryIndex + 1 + offset, prices)),
  ];
}

function mirror(rows: Candle[]): Candle[] {
  return rows.map(row => ({ ...row, open: 300 - row.open, high: 300 - row.low, low: 300 - row.high, close: 300 - row.close }));
}

function prepare(rows: Candle[], input = settings) {
  return prepareSymbolBlock('BTCUSDT', rows, input, 'CANDLE_BREAKOUT', rows[0]!.openTime, rows.at(-1)!.closeTime);
}

describe('candle breakout backtest', () => {
  it.each(['LONG', 'SHORT'] as const)('enters %s on the larger opposite-color close with the entry candle stop', side => {
    const source = breakoutFixture();
    const rows = side === 'LONG' ? source : mirror(source);
    const input = { ...settings, side, partialTpEnabled: true, candleBreakoutCloseMa20Enabled: true,
      candleBreakoutCloseMa20BelowEnabled: true, candleBreakoutCloseMa60Enabled: true,
      candleBreakoutMa20DistanceEnabled: true, candleBreakoutMa20AboveMa60Enabled: true, candleBreakoutAtrStopEnabled: true };
    const entry = rows[entryIndex]!;
    const stop = side === 'LONG' ? entry.low : entry.high;

    expect(prepare(rows, input).bars[entryIndex]!.signal).toMatchObject({
      strategy: 'CANDLE_BREAKOUT', side, entry: entry.close, stop, initialStop: stop, target: 0,
    });
    const result = runBacktest(rows, input, 'CANDLE_BREAKOUT');
    expect(result).toMatchObject({ signalCount: 1, entryCount: 1, closedTradeCount: 0, openPositionCount: 1 });
  });

  it.each([
    ['equal body', [110, 116, 95, 113]],
    ['equal range', [100, 112, 100, 106]],
    ['same color', [106, 115, 95, 100]],
  ] satisfies [string, Prices][])('blocks entry with %s', (_case, prices) => {
    const rows = breakoutFixture();
    rows[entryIndex] = candle(entryIndex, prices);
    expect(prepare(rows).bars[entryIndex]!.signal).toBeNull();
    expect(prepare(mirror(rows)).bars[entryIndex]!.signal).toBeNull();
  });

  it('requires a strict range excess over the completed twenty-day ATR', () => {
    const rows = breakoutFixture();
    // This previous candle has a range of 6 and TR of 8 from the previous close of 120.
    rows[entryIndex - 1] = candle(entryIndex - 1, [116, 118, 112, 115]);
    rows[entryIndex] = candle(entryIndex, [113, 120, 112, 118]);
    expect(prepare(rows).bars[entryIndex]!.signal).toBeNull();
    // A gap makes current TR exceed ATR, while the high-low range of 7 still fails.
    rows[entryIndex] = candle(entryIndex, [96, 102, 95, 100]);
    expect(prepare(rows).bars[entryIndex]!.signal).toBeNull();
    rows[entryIndex] = candle(entryIndex, [113, 120.01, 112, 118]);
    expect(prepare(rows).bars[entryIndex]!.signal?.side).toBe('LONG');
    expect(prepare(rows.slice(100)).bars.at(-1)!.signal).toBeNull();
  });

  it.each(['LONG', 'SHORT'] as const)('holds %s until one candle satisfies both exit comparisons, including after a checkpoint', side => {
    const source = breakoutFixture([
      [106, 115, 105, 112],
      [112, 115, 102, 104], // Close below the previous low, high only equals the entry high.
      [104, 122, 103, 120], // New high with a close above the previous low.
      [112, 114, 100, 102], // Low close on a later bar without a new high.
      [102, 116, 99, 100], // New high, close exactly at the previous low.
      [100, 116, 98, 98.5], // New high and close below the immediately previous low.
    ]);
    const input = { ...settings, side };
    const rows = side === 'LONG' ? source : mirror(source);
    const entry = rows[entryIndex]!;
    const exit = rows.at(-1)!;
    const prior = rows.at(-2)!;
    const state = initialPortfolio(Number(settings.initialCapitalUsdt));
    const beforeExit = prepare(rows.slice(0, -1), input);
    replayPortfolioBlock(state, [beforeExit], input, origin, exit.openTime, 3600);
    expect(state).toMatchObject({ entries: 1, closed: 0 });
    expect(state.positions.BTCUSDT?.candleBreakoutExit).toEqual(side === 'LONG'
      ? { entryExtreme: entry.high, previousExitLevel: prior.low }
      : { entryExtreme: entry.low, previousExitLevel: prior.high });

    const restored = structuredClone(state);
    const nextBlock = prepareSymbolBlock('BTCUSDT', rows, input, 'CANDLE_BREAKOUT', exit.openTime, exit.closeTime);
    replayPortfolioBlock(restored, [nextBlock], input, exit.openTime, exit.closeTime, 3600);
    expect(restored.exitReasons).toEqual({ CANDLE_BREAKOUT_REVERSAL_CLOSE: 1 });

    const result = runBacktest(rows, input, 'CANDLE_BREAKOUT');
    const direction = side === 'LONG' ? 1 : -1;
    const trade = result.recentTrades[0]!;
    expect(trade).toMatchObject({
      reason: 'CANDLE_BREAKOUT_REVERSAL_CLOSE', side, entryAt: entry.closeTime, exitAt: exit.closeTime,
      entryPrice: entry.close * (1 + direction * 0.0002), exitPrice: exit.close * (1 - direction * 0.0002),
    });
    expect(restored.trades[0]?.executions).toEqual(trade.executions);
    expect(trade.executions.map(fill => fill.timing)).toEqual(['BAR_CLOSE', 'BAR_CLOSE']);
    expect(buildLocalChart(result, trade, input).priceLines.map(line => line.kind)).toEqual(['ENTRY', 'SL', 'EXIT']);
  });

  it.each(['LONG', 'SHORT'] as const)('fills the fixed %s stop before a qualifying reversal close', side => {
    const source = breakoutFixture([[106, 115, 105, 112], [112, 119, 95, 102]]);
    const rows = side === 'LONG' ? source : mirror(source);
    const stop = side === 'LONG' ? 95 : 205;
    const result = runBacktest(rows, { ...settings, side, candleBreakoutAtrStopEnabled: true }, 'CANDLE_BREAKOUT');
    expect(result.exitReasons).toEqual({ SL: 1 });
    expect(result.recentTrades[0]).toMatchObject({
      reason: 'SL', exitPrice: stop * (side === 'LONG' ? 0.9998 : 1.0002), signal: { stop },
    });
  });
});
