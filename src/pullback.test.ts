import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildLocalChart, prepareSymbolBlock } from './engine';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import { StrategyBacktest } from './components/StrategyBacktest';
import type { PreparedBar } from './engine';
import type { BacktestSettings, Candle, Signal } from './types';

const origin = Date.UTC(2026, 0, 1) / 1000;
const baseSettings: BacktestSettings = {
  mode: 'SINGLE', symbol: 'BTC', interval: '1h', startDate: '2026-01-01', startTime: '00:00', endDate: '2026-01-10', endTime: '00:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1', side: 'LONG', partialTpEnabled: false,
  fullTpWavePercent: '100', minDisparityPercent: '1', ma20HalfCloseEnabled: false, roiClosePercent: '100', minVolatilityPercent: '0.5',
  volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
  envelopeMaPeriod: '20', envelopeDeviationPercent: '5.0',
};

function candle(index: number, close: number, high = close + 0.5, low = close - 0.5): Candle {
  return { openTime: origin + index * 3600, closeTime: origin + (index + 1) * 3600, open: close, high, low, close, volume: 10 };
}

function rowsFor(side: 'LONG' | 'SHORT', priorEnvelopeTouch = true): Candle[] {
  const source = Array.from({ length: 151 }, (_, index) => 100 + index * 0.02 + index * index * 0.002);
  source[149] = 139.777;
  const rows = source.map((close, index) => candle(index, close, close + 0.5, close - 0.5));
  if (priorEnvelopeTouch) rows[140] = candle(140, source[140]!, source[140]! + 20, source[140]! - 0.5);
  rows[149] = candle(149, source[149]!, source[149]! + 0.5, source[149]! - 0.5);
  rows[150] = candle(150, source[150]!, source[150]! + 10, source[150]! - 0.5);
  if (side === 'LONG') return rows;
  return rows.map((row, index) => candle(index, 300 - row.close, 300 - row.low, 300 - row.high));
}

describe('updated pullback MA/envelope strategy', () => {
  it('renders the new envelope inputs and removes the old wave TP input', () => {
    const html = renderToStaticMarkup(createElement(StrategyBacktest, { strategy: 'PULLBACK', context: { apiBaseUrl: 'https://example.invalid', accessToken: 'fixture-only' } }));
    expect(html).toContain('엔벨로프 SMA');
    expect(html).toContain('엔벨로프 이격 (%)');
    expect(html).toContain('value="5.0"');
    expect(html).not.toContain('전체 TP 직전 파동폭');
  });

  it.each(['LONG', 'SHORT'] as const)('enters on a MA20 pullback and exits on the opposite envelope, side=%s', side => {
    const settings = { ...baseSettings, side };
    const rows = rowsFor(side);
    const start = rows[149]!.openTime;
    const document = prepareSymbolBlock('BTCUSDT', rows, settings, 'PULLBACK', start, rows.at(-1)!.closeTime);
    const signalBar = document.bars[0]!;
    expect(signalBar.signal).toMatchObject({ strategy: 'PULLBACK', side, exitMode: 'PULLBACK_ENVELOPE', envelopeMaPeriod: 20, envelopeDeviationPercent: 5 });
    expect(signalBar.pullbackEnvelope).toBeDefined();

    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [document], settings, start, rows.at(-1)!.closeTime, 3600);
    const result = portfolioResult(state, settings);
    expect(result.entryCount).toBe(1);
    expect(result.exitReasons).toEqual({ PULLBACK_ENVELOPE: 1 });
    expect(result.recentTrades[0]!.priceLines).toEqual([{ kind: 'ENTRY', price: result.recentTrades[0]!.entryPrice }]);
    expect(buildLocalChart({ ...result, candles: rows }, result.recentTrades[0]!, settings).envelope?.deviationPercent).toBe(5);
  });

  it.each(['LONG', 'SHORT'] as const)('requires an opposite envelope touch in the prior ten candles, side=%s', side => {
    const rows = rowsFor(side, false);
    const document = prepareSymbolBlock('BTCUSDT', rows, { ...baseSettings, side }, 'PULLBACK', rows[149]!.openTime, rows.at(-1)!.closeTime);
    expect(document.bars[0]!.signal).toBeNull();
    const touched = rowsFor(side, true);
    const touchedDocument = prepareSymbolBlock('BTCUSDT', touched, { ...baseSettings, side }, 'PULLBACK', touched[149]!.openTime, touched.at(-1)!.closeTime);
    expect(touchedDocument.bars[0]!.signal).toMatchObject({ strategy: 'PULLBACK', side });
  });

  it.each(['LONG', 'SHORT'] as const)('exits at MA60 touch before the envelope target, side=%s', side => {
    const long = side === 'LONG';
    const signal: Signal = {
      strategy: 'PULLBACK', side, index: 0, entry: 100, stop: 0,
      target: long ? 120 : 80, initialTarget: long ? 120 : 80, exitMode: 'PULLBACK_ENVELOPE',
      envelopeMaPeriod: 20, envelopeDeviationPercent: 5,
    };
    const bar = (index: number, signalValue: Signal | null): PreparedBar => ({
      candle: {
        openTime: origin + index * 3600, closeTime: origin + (index + 1) * 3600,
        open: 100, high: long ? 101 : 110, low: long ? 90 : 99, close: 100, volume: 10,
      },
      signal: signalValue, ma20: long ? 110 : 90, ma60: long ? 95 : 105, ma120: long ? 90 : 110,
      ma60Exit: null, pullbackEnvelope: { center: 100, upper: 120, lower: 80, long: true, short: true },
    });
    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [{ symbol: 'BTCUSDT', bars: [bar(0, signal), bar(1, null)] }], { ...baseSettings, side }, origin, origin + 7200, 3600);
    expect(portfolioResult(state, { ...baseSettings, side }).exitReasons).toEqual({ PULLBACK_MA60: 1 });
  });
});
