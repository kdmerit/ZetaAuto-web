import { describe, expect, it } from 'vitest';
import { buildLocalChart, prepareSymbolBlock, runBacktest } from './engine';
import { envelopeParameters, envelopePeriods, priorMovingAverages, projectEnvelopeBands } from './envelope';
import { maximumTouchedStep } from './envelopeStatistics';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle, EnvelopeExitMode } from './types';

const origin = Date.UTC(2026, 0, 1) / 1000;
const settings: BacktestSettings = {
  mode: 'SINGLE', symbol: 'BTC', interval: '1h', startDate: '2026-01-01', startTime: '09:00', endDate: '2026-01-20', endTime: '09:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1', side: 'LONG', partialTpEnabled: false,
  fullTpWavePercent: '100', minDisparityPercent: '1', ma20HalfCloseEnabled: false, roiClosePercent: '100',
  minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
  envelopeDeviationPercent: '1.0', envelopeExitMode: 'MA20', envelopeMaPeriod: '20',
};
const candle = (i: number, prices = [100, 100, 100, 100]): Candle => ({ openTime: origin + i * 3600, closeTime: origin + (i + 1) * 3600,
  open: prices[0]!, high: prices[1]!, low: prices[2]!, close: prices[3]!, volume: 10 });

function replay(short = false, rows = [
  [100, 101.5, 99.5, 100],
  [99.5, 100.4, 99.5, 99.8],
  [100, 101.2, 99.8, 101],
]) {
  const tail = rows.map((prices, index) => {
    const values = short ? [200 - prices[0]!, 200 - prices[2]!, 200 - prices[1]!, 200 - prices[3]!] : prices;
    return candle(index + 20, values);
  });
  const all = [...Array.from({ length: 20 }, (_, i) => candle(i)), ...tail];
  const parameters = { ...settings, side: short ? 'SHORT' as const : 'LONG' as const };
  const start = all[20]!.openTime; const end = all.at(-1)!.closeTime;
  const document = prepareSymbolBlock('BTCUSDT', all, parameters, 'ENVELOPE', start, end);
  const state = initialPortfolio(1000);
  replayPortfolioBlock(state, [document], parameters, start, end, 3600);
  return { state, result: portfolioResult(state, parameters), document, all, parameters, start, end };
}

describe('envelope parameters and causal bands', () => {
  it.each(['0.1', '0.5', '20', '20.0'])('accepts inclusive valid offset %s', value => {
    expect(envelopeParameters({ ...settings, envelopeDeviationPercent: value }).percent).toBe(Number(value));
  });
  it.each(['0', '0.09', '20.1', '1.25', '-1', 'NaN', ''])('rejects invalid offset %s', value => {
    expect(() => envelopeParameters({ ...settings, envelopeDeviationPercent: value })).toThrow();
  });
  it.each(envelopePeriods)('supports SMA%d, using only prior closed prices', period => {
    const rows = Array.from({ length: 121 }, (_, i) => candle(i, [i + 1, i + 1, i + 1, i + 1]));
    expect(priorMovingAverages(rows, period)[120]).toBe((121 - period + 120) / 2);
    const changed = rows.map(row => ({ ...row })); changed[120]!.close = 9999;
    expect(priorMovingAverages(changed, period)[120]).toBe(priorMovingAverages(rows, period)[120]);
    expect(priorMovingAverages(rows, period)[period - 1]).toBeNull();
  });
  it('rejects unlisted periods and exit modes', () => {
    expect(() => envelopeParameters({ ...settings, envelopeMaPeriod: '30' })).toThrow();
    expect(() => envelopeParameters({ ...settings, envelopeExitMode: 'INVALID' as EnvelopeExitMode })).toThrow();
  });
  it('projects fixed original-period bands on smaller display bars without future closes', () => {
    const rows = Array.from({ length: 23 }, (_, i) => candle(i, [100 + i, 100 + i, 100 + i, 100 + i]));
    const targets = [20, 20.25, 20.5, 21].map(i => candle(i));
    const overlay = projectEnvelopeBands(rows, targets, { interval: '1h', period: 20, deviationPercent: 1 });
    expect(overlay.bands.map(band => band.center)).toEqual([109.5, 109.5, 109.5, 110.5]);
    expect(overlay.bands[0]!.upper).toBeCloseTo(110.595, 10);
    expect(overlay.bands[0]!.lower).toBeCloseTo(108.405, 10);
  });
});

describe('current envelope breakout and MA20 close exits', () => {
  function breakoutRows(short = false): Candle[] {
    const warmup = Array.from({ length: 60 }, (_, index) => candle(index));
    const tail = short
      ? [candle(60, [99.5, 99.6, 98, 98]), candle(61, [98, 102, 97, 101]), candle(62, [101, 102, 98, 101])]
      : [candle(60, [100.5, 102, 100.4, 102]), candle(61, [102, 103, 98, 101]), candle(62, [101, 102, 98, 99])];
    return [...warmup, ...tail];
  }

  it.each([false, true])('enters only after a confirmed %s breakout and exits on a later MA20 close', short => {
    const all = breakoutRows(short);
    const parameters = { ...settings, side: short ? 'SHORT' as const : 'LONG' as const };
    const result = runBacktest(all, parameters, 'ENVELOPE');
    expect(result.entryCount).toBe(1); expect(result.closedTradeCount).toBe(1);
    const trade = result.recentTrades[0]!;
    expect(trade.reason).toBe('ENVELOPE_MA20_CLOSE');
    expect(trade.signal.exitMode).toBe('ENVELOPE_MA20_CLOSE');
    expect(trade.signal.envelopeExitMode).toBe('MA20');
    expect(trade.entryAt).toBe(all[60]!.closeTime);
    expect(trade.exitAt).toBe(short ? all[61]!.closeTime : all[62]!.closeTime);
    expect(trade.executions.map(fill => fill.kind)).toEqual(['ENTRY', 'CLOSE']);
    expect(trade.executions[0]!.timing).toBe('BAR_CLOSE');
    expect(trade.executions[1]!.timing).toBe('BAR_CLOSE');
  });

  it('does not use an intrabar low/high as a MA20 close exit', () => {
    const all = breakoutRows(false);
    const parameters = { ...settings, side: 'LONG' as const };
    const result = runBacktest(all, parameters, 'ENVELOPE');
    expect(result.recentTrades[0]!.exitAt).toBe(all[62]!.closeTime);
  });

  it('requires the current close to finish beyond the upper band', () => {
    const all = breakoutRows(false);
    all[60] = { ...all[60]!, open: 100.5, close: 100.9, high: 101.2, low: 100.4 };
    const parameters = { ...settings, side: 'LONG' as const };
    expect(runBacktest(all, parameters, 'ENVELOPE').entryCount).toBe(0);
  });

  it('shows only entry and exit levels for the new MA20-close trade', () => {
    const all = breakoutRows(false); const parameters = { ...settings, side: 'LONG' as const };
    const result = runBacktest(all, parameters, 'ENVELOPE'); const trade = result.recentTrades[0]!;
    const chart = buildLocalChart(result, trade, parameters);
    expect(maximumTouchedStep(prepareSymbolBlock('BTCUSDT', all, parameters, 'ENVELOPE', all[0]!.openTime, all.at(-1)!.closeTime))).toBe(20);
    expect(chart.priceLines.map(line => line.kind)).toEqual(['ENTRY', 'EXIT']);
  });
});
