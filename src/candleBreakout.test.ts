import { describe, expect, it } from 'vitest';

import { buildLocalChart, prepareSymbolBlock, runBacktest } from './engine';
import { initialPortfolio, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle } from './types';

const origin = Date.UTC(2026, 0, 1) / 1000;
const settings: BacktestSettings = {
  mode: 'SINGLE', symbol: 'BTC', interval: '1h', side: 'BOTH',
  startDate: '2026-01-01', startTime: '00:00', endDate: '2026-02-01', endTime: '00:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1',
  partialTpEnabled: false, fullTpWavePercent: '100', minDisparityPercent: '1.0',
  ma20HalfCloseEnabled: false, roiClosePercent: '100', minVolatilityPercent: '0.5',
  volatilityK1: '0.5', volatilityK2: '1.0', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
};

function candle(index: number, open: number, high: number, low: number, close: number): Candle {
  return {
    openTime: origin + index * 3600,
    closeTime: origin + (index + 1) * 3600,
    open, high, low, close, volume: 10,
  };
}

function longFixture(): Candle[] {
  const rows = Array.from({ length: 502 }, (_, index) => candle(index, 109, 112, 108, 110));
  rows[498] = candle(498, 101, 102, 99, 100);
  rows[499] = candle(499, 100, 101, 97, 98);
  rows[500] = candle(500, 101, 114, 96, 112);
  rows[501] = candle(501, 112, 136, 110, 130);
  return rows;
}

function mirror(rows: Candle[]): Candle[] {
  return rows.map((row, index) => candle(index, 300 - row.open, 300 - row.low, 300 - row.high, 300 - row.close));
}

// Of the 480 hours before the entry candle, 479 have a true range of 4 and one has 11.
const entryAtr = (479 * 4 + 11) / 480;

describe('candle breakout backtest', () => {
  it('enters at the breakout close and exits at the following close when the old TP is crossed intrabar', () => {
    const rows = longFixture();
    const document = prepareSymbolBlock('BTCUSDT', rows, settings, 'CANDLE_BREAKOUT', rows[0]!.openTime, rows.at(-1)!.closeTime);
    const signal = document.bars[500]!.signal;
    expect(signal).toMatchObject({ strategy: 'CANDLE_BREAKOUT', side: 'LONG', entry: 112, stop: 96, target: 0 });
    const result = runBacktest(rows, settings, 'CANDLE_BREAKOUT');
    expect(result.signalCount).toBe(1);
    expect(result.entryCount).toBe(1);
    const trade = result.recentTrades[0]!;
    expect(trade).toMatchObject({ reason: 'CANDLE_BREAKOUT_ATR_CLOSE', entryPrice: 112 * 1.0002, exitPrice: 130 * 0.9998 });
    expect(trade.priceLines?.map(line => line.kind)).toEqual(['ENTRY', 'SL', 'EXIT']);
    expect(buildLocalChart(result, trade, settings).priceLines.map(line => line.kind)).toEqual(['ENTRY', 'SL', 'EXIT']);
  });

  it('mirrors every directional condition for a short setup', () => {
    const rows = mirror(longFixture());
    const document = prepareSymbolBlock('BTCUSDT', rows, { ...settings, side: 'SHORT' }, 'CANDLE_BREAKOUT', rows[0]!.openTime, rows.at(-1)!.closeTime);
    expect(document.bars[500]!.signal).toMatchObject({ strategy: 'CANDLE_BREAKOUT', side: 'SHORT', entry: 188, stop: 204, target: 0 });
    const result = runBacktest(rows, { ...settings, side: 'SHORT' }, 'CANDLE_BREAKOUT');
    expect(result.signalCount).toBe(1);
    expect(result.recentTrades[0]).toMatchObject({ reason: 'CANDLE_BREAKOUT_ATR_CLOSE', exitPrice: 170 * 1.0002 });
  });

  it('enters a short even if the removed body-based target would have been negative', () => {
    const rows = mirror(longFixture());
    rows[500] = candle(500, 199, 204, 58, 60);
    const result = runBacktest(rows, { ...settings, side: 'SHORT' }, 'CANDLE_BREAKOUT');
    expect(result.entryCount).toBe(1);
    expect(result.openPositionCount).toBe(1);
  });

  it.each(['LONG', 'SHORT'] as const)('closes %s on the first following candle when its close equals the ATR threshold', side => {
    const direction = side === 'LONG' ? 1 : -1;
    const rows = side === 'LONG' ? longFixture() : mirror(longFixture());
    const entryClose = rows[500]!.close;
    const entryPrice = entryClose * (1 + direction * 0.0002);
    const threshold = entryPrice + direction * entryAtr;
    const exit = candle(501, entryClose, Math.max(entryClose, threshold) + 1, Math.min(entryClose, threshold) - 1, threshold);
    rows[501] = exit;

    const result = runBacktest(rows, { ...settings, side }, 'CANDLE_BREAKOUT');
    expect(result.exitReasons).toEqual({ CANDLE_BREAKOUT_ATR_CLOSE: 1 });
    const trade = result.recentTrades[0]!;
    expect(trade).toMatchObject({ entryPrice, exitPrice: threshold * (1 - direction * 0.0002), exitAt: exit.closeTime, exitIndex: 501 });
    expect(trade.executions.at(-1)).toMatchObject({ kind: 'CLOSE', timing: 'BAR_CLOSE', candleOpenAt: exit.openTime });
  });

  it('waits through a wick beyond the old TP and carries the entry ATR into the next replay block', () => {
    const rows = longFixture();
    const threshold = rows[500]!.close * 1.0002 + entryAtr;
    rows[501] = candle(501, 112, 136, 110, threshold - 0.01);
    const exit = candle(502, rows[501]!.close, 126, 110, threshold + 0.02);
    rows.push(exit);
    const start = rows[0]!.openTime;
    const document = prepareSymbolBlock('BTCUSDT', rows, settings, 'CANDLE_BREAKOUT', start, exit.closeTime);
    const state = initialPortfolio(Number(settings.initialCapitalUsdt));

    replayPortfolioBlock(state, [document], settings, start, exit.openTime, 3600);
    expect(state.closed).toBe(0);
    expect(state.positions.BTCUSDT?.signal.candleBreakoutEntryAtr).toBeCloseTo(entryAtr);
    const restored = structuredClone(state);
    replayPortfolioBlock(restored, [document], settings, exit.openTime, exit.closeTime, 3600);
    expect(restored.trades[0]).toMatchObject({ reason: 'CANDLE_BREAKOUT_ATR_CLOSE', exitAt: exit.closeTime, exitPrice: exit.close * 0.9998 });
  });

  it('uses the existing stop loss when it executes before a qualifying close', () => {
    const rows = longFixture();
    rows[501] = candle(501, 112, 125, 95, 118);
    const result = runBacktest(rows, settings, 'CANDLE_BREAKOUT');
    expect(result.exitReasons).toEqual({ SL: 1 });
    expect(result.recentTrades[0]).toMatchObject({ reason: 'SL', exitPrice: 96 * 0.9998 });
  });

  it('requires a completed twenty-day ATR and a body crossing MA5', () => {
    const rows = longFixture().slice(0, 300);
    expect(prepareSymbolBlock('BTCUSDT', rows, settings, 'CANDLE_BREAKOUT', rows[0]!.openTime, rows.at(-1)!.closeTime).bars.every(bar => bar.signal === null)).toBe(true);
    const full = longFixture();
    full[500] = candle(500, 107, 114, 96, 112);
    expect(prepareSymbolBlock('BTCUSDT', full, settings, 'CANDLE_BREAKOUT', full[0]!.openTime, full.at(-1)!.closeTime).bars[500]!.signal).toBeNull();
  });
});
