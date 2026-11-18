import { describe, expect, it } from 'vitest';
import { enrichCandles } from './api';
import { buildLocalChart, prepareSymbolBlock, runBacktest } from './engine';
import { atrEnvelopeBacktestParameters, currentAtrEnvelopeSettings } from './envelope';
import { defaultMarketIndicators, withMarketIndicators } from './marketIndicators';
import { minuteRows } from './test/envelopeFixtures';
import type { BacktestSettings, Candle, ChartData } from './types';

const hour = 3600;
const origin = Date.UTC(2026, 0, 1) / 1000;
const inputs = { emaPeriod: '1', atrPeriod: '1', atrMultiplier: '1' };
const settings = currentAtrEnvelopeSettings({
  mode: 'SINGLE', symbol: 'BTC', interval: '1h', side: 'LONG',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1',
  envelopeHalfCandleEnabled: false, atrEnvelope: inputs,
} as BacktestSettings);

function candle(index: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime: origin + index * hour, closeTime: origin + (index + 1) * hour, open, high, low, close, volume: 60 };
}

describe('ATR envelope backtest', () => {
  it('uses the market chart band from the previous completed candle at each open', () => {
    const rows = [candle(0, 100, 102, 99, 100), candle(1, 110, 112, 109, 110), candle(2, 100, 101, 98, 100)];
    const atrEnvelope = { emaPeriod: '2', atrPeriod: '2', atrMultiplier: '2.0' };
    const chart: ChartData = { symbol: 'BTCUSDT', interval: '1h', side: null, referenceAt: '', referenceIndex: null,
      candles: enrichCandles(rows), market: { sourceCandles: rows }, markers: [], waves: [], priceLines: [] };
    const market = withMarketIndicators(chart, { ...defaultMarketIndicators, ...atrEnvelope });
    const prepared = prepareSymbolBlock('BTCUSDT', rows, { ...settings, atrEnvelope }, 'ATR_ENVELOPE', origin, origin + 3 * hour);
    expect(prepared.bars[0]!.envelope).toBeUndefined();
    for (const i of [1, 2]) {
      const { center, upper, lower } = market.atrEnvelope!.bands[i - 1]!;
      expect(prepared.bars[i]!.envelope).toMatchObject({ center, upper, lower });
    }
    const withExtreme = prepareSymbolBlock('BTCUSDT', [...rows.slice(0, 2), candle(2, 100, 500, 30, 150)],
      { ...settings, atrEnvelope }, 'ATR_ENVELOPE', origin, origin + 3 * hour);
    expect(withExtreme.bars[2]!.envelope).toEqual(prepared.bars[2]!.envelope);
  });

  it.each(['LONG', 'SHORT'] as const)('enters and exits the frozen bands for %s, with optional trailing protection', side => {
    const history = Array.from({ length: 20 }, (_, index) => candle(index, 100, 102, 98, 100));
    const entry = candle(20, 96, 96, 85, 94);
    const exit = candle(21, 112, 112, 112, 112);
    const active = side === 'LONG' ? [entry, exit] : [entry, exit].map(row => ({
      ...row, open: 200 - row.open, high: 200 - row.low, low: 200 - row.high, close: 200 - row.close,
    }));
    const candles = [...history, ...active];
    const minutes = minuteRows(active);
    const input = { ...settings, side, envelopeStopLossPercent: '3', atrEnvelopeStopMultiplier: '0' };
    const run = (trailing: boolean) => runBacktest(candles, { ...input, envelopeTrailingStopEnabled: trailing }, 'ATR_ENVELOPE',
      undefined, undefined, undefined, undefined, undefined, minutes);

    const result = run(false);
    expect(result.exitReasons).toEqual({ ENVELOPE_OPPOSITE: 1 });
    expect(result.entryCount).toBe(1);
    const trade = result.recentTrades[0]!;
    expect(trade.entryAt).toBe(entry.openTime);
    expect(trade.exitAt).toBe(exit.openTime);
    expect(trade.signal).toMatchObject({ strategy: 'ATR_ENVELOPE', atrEnvelope: { emaPeriod: 1, atrPeriod: 1, multiplier: 1 } });
    expect(trade.signal.initialStop).toBeUndefined();
    expect(trade.priceLines?.map(line => line.kind)).toEqual(['ENTRY', 'TP', 'EXIT']);
    const chart = buildLocalChart(result, trade, input);
    expect(chart.atrEnvelope?.bands.find(band => band.openTime === entry.openTime)).toEqual({ openTime: entry.openTime, center: 100, lower: 96, upper: 104 });
    expect(chart.envelope).toBeUndefined();
    expect(chart.priceLines.some(line => line.kind === 'SL')).toBe(false);

    const stopped = run(true);
    expect(stopped.exitReasons).toEqual({ TRAILING_STOP: 1 });
    expect(stopped.recentTrades[0]!.priceLines?.some(line => line.kind === 'TRAILING_SL')).toBe(true);
  });

  it.each(['LONG', 'SHORT'] as const)('fixes the %s stop to the actual fill and the entry band ATR', side => {
    const history = Array.from({ length: 20 }, (_, index) => candle(index, 100, 102, 98, 100));
    const entry = candle(20, 96, 103, 95, 95.5);
    const exit = candle(21, 95.5, 97, 93.8, 94);
    const onSide = (row: Candle): Candle => side === 'LONG' ? row : {
      ...row, open: 200 - row.open, high: 200 - row.low, low: 200 - row.high, close: 200 - row.close,
    };
    const input = { ...settings, side, atrEnvelopeStopMultiplier: '0.5' };
    const result = runBacktest([...history, onSide(entry), onSide(exit)], input, 'ATR_ENVELOPE',
      undefined, undefined, undefined, undefined, undefined, minuteRows([entry, exit]).map(onSide));
    expect(result.exitReasons).toEqual({ SL: 1 });
    const trade = result.recentTrades[0]!;
    const direction = side === 'LONG' ? 1 : -1;
    const stop = trade.entryPrice - direction * 2; // Entry band ATR is 4; it rises to 8 on the next bar.
    expect(trade.exitAt).toBe(exit.openTime + 60);
    expect(trade.signal).toMatchObject({ stop, initialStop: stop, activeStop: stop });
    expect(trade.exitPrice).toBeCloseTo(stop * (1 - direction * 0.0002), 10);
    expect(trade.priceLines).toContainEqual({ kind: 'SL', price: stop });
    expect(buildLocalChart(result, trade, input).priceLines).toContainEqual({ kind: 'SL', price: stop });
  });

  it('starts the close-only SL after the parent close even if earlier minutes crossed it', () => {
    const history = Array.from({ length: 20 }, (_, index) => candle(index, 100, 102, 98, 100));
    const entry = candle(20, 100, 103, 80, 95);
    const exit = candle(21, 92, 92, 92, 92);
    const input = { ...settings, envelopeCloseOnlyEntryEnabled: true };
    const result = runBacktest([...history, entry, exit], input, 'ATR_ENVELOPE',
      undefined, undefined, undefined, undefined, undefined, minuteRows([entry, exit]));
    const trade = result.recentTrades[0]!;
    expect(result.exitReasons).toEqual({ SL: 1 });
    expect(trade.entryAt).toBe(entry.closeTime);
    expect(trade.exitAt).toBe(exit.openTime);
    expect(trade.signal.initialStop).toBeCloseTo(95 * 1.0002 - 4 * 0.5, 10);
    expect(trade.exitPrice).toBeCloseTo(92 * 0.9998, 10);
  });

  it('validates the SL multiplier in the same range and precision as N', () => {
    expect(atrEnvelopeBacktestParameters({ ...settings, atrEnvelopeStopMultiplier: '20.0' })).toMatchObject({ stopMultiplier: 20, band: { multiplier: 1 } });
    for (const value of ['-0.1', '0.05', '20.1', '']) {
      expect(() => atrEnvelopeBacktestParameters({ ...settings, atrEnvelopeStopMultiplier: value })).toThrow('SL 배수');
    }
  });

  it.each(['emaPeriod', 'atrPeriod', 'atrMultiplier'] as const)('allows zero %s and disables the bands', key => {
    const candles = Array.from({ length: 20 }, (_, index) => candle(index, 100, 102, 98, 100));
    const result = runBacktest(candles, { ...settings, atrEnvelope: { ...inputs, [key]: '0' } }, 'ATR_ENVELOPE');
    expect(result.entryCount).toBe(0);
    expect(result.observedBars).toBe(20);
  });

  it('applies the center-return exit and the same optional account allocation limit', () => {
    const history = Array.from({ length: 20 }, (_, index) => candle(index, 100, 102, 98, 100));
    const entry = candle(20, 96, 100, 96, 96);
    const run = (envelopeSideRatio50Enabled: boolean) => runBacktest([...history, entry], {
      ...settings, betAmountUsdt: '600', envelopeCloseOnCenterReturn: true, envelopeSideRatio50Enabled,
    }, 'ATR_ENVELOPE', undefined, undefined, undefined, undefined, undefined, minuteRows([entry]));
    const accepted = run(false);
    expect(accepted.exitReasons).toEqual({ ENVELOPE_CENTER_RETURN: 1 });
    expect(run(true).entryCount).toBe(0);
  });
});
