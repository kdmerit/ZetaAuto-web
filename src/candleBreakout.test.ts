import { describe, expect, it } from 'vitest';

import { buildLocalChart, prepareSymbolBlock, runBacktest } from './engine';
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
  rows[501] = candle(501, 112, 124, 110, 120);
  return rows;
}

function mirror(rows: Candle[]): Candle[] {
  return rows.map((row, index) => candle(index, 300 - row.open, 300 - row.low, 300 - row.high, 300 - row.close));
}

describe('candle breakout backtest', () => {
  it('creates the long setup at the close and uses the next candle for TP', () => {
    const rows = longFixture();
    const document = prepareSymbolBlock('BTCUSDT', rows, settings, 'CANDLE_BREAKOUT', rows[0]!.openTime, rows.at(-1)!.closeTime);
    const signal = document.bars[500]!.signal;
    expect(signal).toMatchObject({ strategy: 'CANDLE_BREAKOUT', side: 'LONG', entry: 112, stop: 96, target: 123, exitMode: 'CANDLE_BREAKOUT_TP' });
    const result = runBacktest(rows, settings, 'CANDLE_BREAKOUT');
    expect(result.signalCount).toBe(1);
    expect(result.entryCount).toBe(1);
    expect(result.recentTrades[0]).toMatchObject({ reason: 'CANDLE_BREAKOUT_TP', entryPrice: 112 * 1.0002, exitPrice: 123 });
    expect(buildLocalChart(result, result.recentTrades[0]!, settings).priceLines.map(line => line.kind)).toEqual(['ENTRY', 'SL', 'TP', 'EXIT']);
  });

  it('mirrors every directional condition for a short setup', () => {
    const rows = mirror(longFixture());
    const document = prepareSymbolBlock('BTCUSDT', rows, { ...settings, side: 'SHORT' }, 'CANDLE_BREAKOUT', rows[0]!.openTime, rows.at(-1)!.closeTime);
    expect(document.bars[500]!.signal).toMatchObject({ strategy: 'CANDLE_BREAKOUT', side: 'SHORT', entry: 188, stop: 204, target: 177, exitMode: 'CANDLE_BREAKOUT_TP' });
    const result = runBacktest(rows, { ...settings, side: 'SHORT' }, 'CANDLE_BREAKOUT');
    expect(result.signalCount).toBe(1);
    expect(result.recentTrades[0]).toMatchObject({ reason: 'CANDLE_BREAKOUT_TP', exitPrice: 177 });
  });

  it('requires a completed twenty-day ATR and a body crossing MA5', () => {
    const rows = longFixture().slice(0, 300);
    expect(prepareSymbolBlock('BTCUSDT', rows, settings, 'CANDLE_BREAKOUT', rows[0]!.openTime, rows.at(-1)!.closeTime).bars.every(bar => bar.signal === null)).toBe(true);
    const full = longFixture();
    full[500] = candle(500, 107, 114, 96, 112);
    expect(prepareSymbolBlock('BTCUSDT', full, settings, 'CANDLE_BREAKOUT', full[0]!.openTime, full.at(-1)!.closeTime).bars[500]!.signal).toBeNull();
  });
});
