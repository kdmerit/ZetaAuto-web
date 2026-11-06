import { describe, expect, it } from 'vitest';
import { buildLocalChart, prepareSymbolBlock } from './engine';
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
  envelopeDeviationPercent: '1.0', envelopeExitMode: 'CENTER', envelopeMaPeriod: '20',
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

describe('current envelope centre entry and fixed opposite-band exits', () => {
  it.each([false, true])('requires the previous opposite-band touch and exits at the later band touch, short=%s', short => {
    const { result, document, all, start } = replay(short);
    expect(result.entryCount).toBe(1); expect(result.closedTradeCount).toBe(1); expect(result.recentTrades[0]!.reason).toBe('ENVELOPE_OPPOSITE');
    const trade = result.recentTrades[0]!;
    expect(trade.entryPrice).toBeCloseTo(100 * (short ? .9998 : 1.0002), 10);
    expect(trade.signal.stop).toBeCloseTo(short ? 102.02 : 97.98, 10);
    expect(trade.signal.initialStop).toBeCloseTo(short ? 101 : 99, 10);
    expect(trade.signal.target).toBeCloseTo(short ? 99 : 101, 10);
    expect(trade.exitPrice).toBeCloseTo(short ? 99 : 101, 10);
    expect(trade.exitAt).toBe(start + 2 * 3600);
    expect(trade.signal.envelopeExitMode).toBe('OPPOSITE');
    expect(trade.priceLines).toContainEqual({ kind: 'SECOND_ENTRY', price: short ? 101 : 99 });
    expect(trade.priceLines).toContainEqual({ kind: 'SL', price: short ? 102.02 : 97.98 });
    expect(trade.priceLines).toContainEqual({ kind: 'TP', price: short ? 99 : 101 });
    expect(document.bars[1]!.envelope).toMatchObject({ priorUpperTouch: !short, priorLowerTouch: short });
    expect(all).toHaveLength(23);
  });
  it('does not treat a current-candle-only touch as an armed setup', () => {
    const { result } = replay(false, [[100, 100.4, 99.5, 99.8], [100, 101.2, 99.8, 101]]);
    expect(result.entryCount).toBe(0);
  });
  it('limits the arming touch to the previous 15 candles', () => {
    const neutral = Array.from({ length: 15 }, () => [100.5, 100.6, 100.4, 100.5]);
    const tooLate = replay(false, [[100, 101.5, 99.5, 100], ...neutral, [99.5, 100.4, 99.5, 99.8]]);
    expect(tooLate.result.entryCount).toBe(0);
    const stillValid = replay(false, [[100, 101.5, 99.5, 100], ...neutral.slice(0, 14), [99.5, 100.4, 99.5, 99.8]]);
    expect(stillValid.result.entryCount).toBe(1);
  });
  it.each([false, true])('uses the old SL band for the second entry before the outer stop, short=%s', short => {
    const { result } = replay(short, [[100, 101.5, 99.5, 100], [100.5, 101.5, 98.5, 99.8], [99, 99.5, 97.5, 98]]);
    const trade = result.recentTrades[0]!;
    expect(result.entryCount).toBe(1); expect(result.closedTradeCount).toBe(1); expect(result.exitReasons.SL).toBe(1);
    expect(trade.side).toBe(short ? 'SHORT' : 'LONG');
    expect(trade.signal.second).toBeCloseTo(short ? 101 : 99, 10);
    expect(trade.signal.stop).toBeCloseTo(short ? 102.02 : 97.98, 10);
    expect(trade.executions.map(fill => fill.kind)).toEqual(['ENTRY', 'SPLIT_ENTRY', 'CLOSE']);
  });
  it('keeps the entry candle band as the SL and target and shows both lines in the local chart', () => {
    const fixture = replay(); const trade = fixture.result.recentTrades[0]!;
    const chart = buildLocalChart(fixture.result, trade, fixture.parameters);
    expect(maximumTouchedStep(fixture.document)).toBe(15);
    expect(chart.priceLines).toContainEqual({ kind: 'SECOND_ENTRY', price: 99 });
    expect(chart.priceLines).toContainEqual({ kind: 'SL', price: 97.98 });
    expect(chart.priceLines).toContainEqual({ kind: 'TP', price: 101 });
  });
});
