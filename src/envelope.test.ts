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

function replay(exit: EnvelopeExitMode = 'CENTER', short = false, tail = [[99.5, 99.8, 98.5, 99], [99.5, 101.5, 99.3, 101]]) {
  const parameters = { ...settings, envelopeExitMode: exit, side: short ? 'SHORT' as const : 'LONG' as const };
  const rows = [...Array.from({ length: 120 }, (_, i) => candle(i)), ...tail.map((prices, i) => candle(i + 120,
    short ? [200 - prices[0]!, 200 - prices[2]!, 200 - prices[1]!, 200 - prices[3]!] : prices))];
  const start = rows[120]!.openTime; const end = rows.at(-1)!.closeTime;
  const document = prepareSymbolBlock('BTCUSDT', rows, parameters, 'ENVELOPE', start, end);
  const state = initialPortfolio(1000);
  replayPortfolioBlock(state, [document], parameters, start, end, 3600);
  return { state, result: portfolioResult(state, parameters), document, rows, parameters, start, end };
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

describe('envelope shared-account fills', () => {
  it.each([false, true])('executes center/opposite/half exits with a fixed fill-relative SL, short=%s', short => {
    for (const exit of ['CENTER', 'OPPOSITE', 'HALF'] as const) {
      const { result } = replay(exit, short);
      expect(result.entryCount).toBe(1); expect(result.closedTradeCount).toBe(1); expect(result.openPositionCount).toBe(0);
      const final = result.recentTrades.at(-1)!;
      const first = final.executions[0]!;
      const entry = short ? 101 * 0.9998 : 99 * 1.0002;
      expect(first.price).toBeCloseTo(entry, 10);
      expect(final.signal.stop).toBeCloseTo(entry * (short ? 1.01 : 0.99), 10);
      const center = short ? 100.05 : 99.95;
      const opposite = center * (short ? 0.99 : 1.01);
      expect(final.exitPrice).toBeCloseTo(exit === 'CENTER' ? center : opposite, 10);
      expect(final.reason).toBe(exit === 'CENTER' ? 'ENVELOPE_CENTER' : 'ENVELOPE_OPPOSITE');
      if (exit === 'HALF') {
        expect(final.executions.map(fill => fill.kind)).toEqual(['ENTRY', 'PARTIAL_TP', 'CLOSE']);
        expect(final.executions[1]!.quantity).toBeCloseTo(first.quantity / 2, 10);
        expect(final.executions[2]!.quantity).toBeCloseTo(first.quantity / 2, 10);
      } else expect(final.executions.map(fill => fill.kind)).toEqual(['ENTRY', 'CLOSE']);
      const gross = final.executions.slice(1).reduce((sum, fill) => sum + (fill.price - entry) * fill.quantity * (short ? -1 : 1), 0);
      const fees = final.executions.reduce((sum, fill) => sum + fill.price * fill.quantity * 0.00055, 0);
      expect(result.finalEquityUsdt).toBeCloseTo(1000 + gross - fees, 8);
      expect(result.feesUsdt).toBeCloseTo(fees, 8);
      expect(first.timing).toBe('INTRABAR');
    }
  });
  it.each([false, true])('stops a gap at the observed open, short=%s', short => {
    const { result } = replay('HALF', short, [[99.5, 99.8, 98.5, 99], [95, 96, 94, 95]]);
    expect(result.exitReasons.SL).toBe(1);
    expect(result.recentTrades[0]!.exitPrice).toBeCloseTo(short ? 105 * 1.0002 : 95 * 0.9998, 10);
  });
  it('does not use a pre-entry high to fill a target; applies same-bar SL conservatively', () => {
    const { result } = replay('HALF', false, [[100, 102, 95, 99]]);
    expect(result.closedTradeCount).toBe(1); expect(result.exitReasons.SL).toBe(1);
    expect(result.recentTrades[0]!.executions.map(fill => fill.kind)).toEqual(['ENTRY', 'CLOSE']);
  });
  it('does not reuse same-bar exit proceeds across symbols or enter twice in the same candle', () => {
    const { document, start, end } = replay('CENTER', false, [[100, 101.2, 98.8, 100]]);
    const parameters = { ...settings, mode: 'ALL' as const, initialCapitalUsdt: '101' };
    const state = initialPortfolio(101);
    replayPortfolioBlock(state, [{ ...document, symbol: 'ZZZUSDT' }, { ...document, symbol: 'AAAUSDT' }], parameters, start, end, 3600);
    expect(state.entries).toBe(1); expect(state.insufficientFunds).toBe(1);
    expect(state.trades.every(trade => trade.symbol === 'AAAUSDT')).toBe(true);
  });
  it('preserves an open account across JSON checkpoints and prepares exact wider-offset skipping', () => {
    const fixture = replay('HALF');
    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [fixture.document], fixture.parameters, fixture.start, fixture.start + 3600, 3600);
    const resumed = JSON.parse(JSON.stringify(state)) as typeof state;
    replayPortfolioBlock(resumed, [fixture.document], fixture.parameters, fixture.start + 3600, fixture.end, 3600);
    expect(portfolioResult(resumed, fixture.parameters)).toEqual(fixture.result);
    expect(maximumTouchedStep(fixture.document)).toBe(15);
    const chart = buildLocalChart({ ...fixture.result, candles: fixture.rows }, { ...fixture.result.recentTrades.at(-1)!, entryIndex: 120, signalIndex: 120, exitIndex: 121 }, fixture.parameters);
    expect(chart.envelope).toMatchObject({ period: 20, deviationPercent: 1, interval: '1h' });
    expect(chart.envelope!.bands.find(band => band.openTime === fixture.start)!.lower).toBe(99);
    expect(chart.priceLines.find(line => line.kind === 'SL')?.price).toBeCloseTo(99 * 1.0002 * 0.99, 10);
  });
});
