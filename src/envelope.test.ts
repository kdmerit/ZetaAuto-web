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
], overrides: Partial<BacktestSettings> = {}) {
  const tail = rows.map((prices, index) => {
    const values = short ? [200 - prices[0]!, 200 - prices[2]!, 200 - prices[1]!, 200 - prices[3]!] : prices;
    return candle(index + 20, values);
  });
  const all = [...Array.from({ length: 20 }, (_, i) => candle(i)), ...tail];
  const parameters = { ...settings, ...overrides, side: short ? 'SHORT' as const : 'LONG' as const };
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

describe('envelope band-touch entries and exits', () => {
  it.each([false, true])('fills at the entry band and closes at the later opposite band, short=%s', short => {
    const { result, all, parameters } = replay(short, [[100, 100.2, 99, 100], [100, 101, 99.5, 100]]);
    const trade = result.recentTrades[0]!;
    expect(result.entryCount).toBe(1); expect(result.closedTradeCount).toBe(1);
    expect(trade.reason).toBe('ENVELOPE_OPPOSITE');
    expect(trade.signal).toMatchObject({ exitMode: 'ENVELOPE_TOUCH', envelopeEntryMode: 'BAND_TOUCH', envelopeExitMode: 'OPPOSITE' });
    expect(trade.entryPrice).toBeCloseTo(short ? 101 * .9998 : 99 * 1.0002, 10);
    expect(trade.signal.stop).toBeCloseTo(trade.entryPrice * (short ? 1.01 : .99), 10);
    expect(trade.entryAt).toBe(all[20]!.openTime);
    expect(trade.exitAt).toBe(all[21]!.openTime);
    expect(trade.executions.map(fill => fill.kind)).toEqual(['ENTRY', 'CLOSE']);
    const chart = buildLocalChart(runBacktest(all, parameters, 'ENVELOPE'), trade, parameters);
    expect(chart.priceLines.map(line => line.kind)).toEqual(['ENTRY', 'SL', 'TP', 'EXIT']);
  });

  it.each([false, true])('holds at the centre and fixes its SL at the initial fill, short=%s', short => {
    const { state, result } = replay(short, [[100, 100.2, 99, 100], [100, 100.5, 99.5, 100]]);
    expect(result.closedTradeCount).toBe(0);
    const position = state.positions.BTCUSDT!;
    expect(position.stop).toBeCloseTo(position.first * (short ? 1.01 : .99), 10);
  });

  it.each([false, true])('stops at the fill-relative offset without a second entry, short=%s', short => {
    const { result } = replay(short, [[100, 100.2, 99, 100], [100, 100, 97, 99]]);
    expect(result.exitReasons).toEqual({ SL: 1 }); expect(result.secondFillCount).toBe(0);
  });

  it('does not credit an upper-band touch that can precede the lower-band entry', () => {
    const { state } = replay(false, [[100, 101, 99, 99.5]]);
    expect(state.entries).toBe(1); expect(state.closed).toBe(0);
  });

  it('searches wick touches rather than closing breakouts in optimizer bounds', () => {
    const { document } = replay(false, [[100, 100, 98.5, 100]]);
    expect(maximumTouchedStep(document)).toBe(15);
  });

  it.each([
    { short: false, targetFirst: true }, { short: false, targetFirst: false },
    { short: true, targetFirst: true }, { short: true, targetFirst: false },
  ])('uses 15m chronology after the entry line touch (short=$short, targetFirst=$targetFirst)', ({ short, targetFirst }) => {
    const parent = candle(20, [100, 101.2, 97, 98]);
    const source = [
      [100, 100.1, 99, 99.8],
      targetFirst ? [99.8, 101.2, 99.7, 101] : [99.8, 100.5, 97, 98],
      targetFirst ? [101, 101.1, 97, 98] : [98, 101.2, 98, 101],
      [targetFirst ? 98 : 101, targetFirst ? 98 : 101, targetFirst ? 98 : 101, targetFirst ? 98 : 101],
    ].map((values, index) => {
      const prices = short ? [200 - values[0]!, 200 - values[2]!, 200 - values[1]!, 200 - values[3]!] : values;
      return { openTime: parent.openTime + index * 900, closeTime: parent.openTime + (index + 1) * 900,
        open: prices[0]!, high: prices[1]!, low: prices[2]!, close: prices[3]!, volume: 10 };
    });
    const rows = Array.from({ length: 20 }, (_, index) => candle(index));
    const all = [...rows, short ? { ...parent, open: 100, high: 103, low: 98.8, close: 102 } : parent];
    const parameters = { ...settings, side: short ? 'SHORT' as const : 'LONG' as const };
    const start = all[20]!.openTime; const end = all.at(-1)!.closeTime;
    const document = prepareSymbolBlock('BTCUSDT', all, parameters, 'ENVELOPE', start, end, undefined, undefined, undefined, undefined, undefined, undefined, source);
    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [document], parameters, start, end, 3600);
    const result = portfolioResult(state, parameters);
    expect(result.closedTradeCount).toBe(1);
    expect(result.exitReasons).toEqual(targetFirst ? { ENVELOPE_OPPOSITE: 1 } : { SL: 1 });
  });

  it.each([false, true])('waits for the parent close to confirm an opposite-band breakout, short=%s', short => {
    const { result, all, parameters } = replay(short, [
      [100, 101.2, 99, 100],
      [100, 101.2, 99.5, 100],
      [100, 101.2, 99.5, 101.2],
    ], { envelopeCloseOnConfirmedBreakout: true });
    const trade = result.recentTrades[0]!;
    expect(result.closedTradeCount).toBe(1);
    expect(trade.reason).toBe('ENVELOPE_CLOSE_CONFIRM');
    expect(trade.signal.envelopeCloseOnConfirmedBreakout).toBe(true);
    expect(trade.exitAt).toBe(all[22]!.closeTime);
    expect(trade.executions.at(-1)!.timing).toBe('BAR_CLOSE');
    expect(buildLocalChart(runBacktest(all, parameters, 'ENVELOPE'), trade, parameters).priceLines.at(-1)!.kind).toBe('EXIT');
  });

  it('does not close on a 15m opposite-band touch before parent close confirmation', () => {
    const parent = candle(20, [100, 101.2, 99, 100]);
    const source = [
      [100, 100.1, 99, 99.8],
      [99.8, 101.2, 99.7, 101],
      [101, 101.1, 100, 100],
      [100, 100, 100, 100],
    ].map((values, index) => ({ openTime: parent.openTime + index * 900, closeTime: parent.openTime + (index + 1) * 900,
      open: values[0]!, high: values[1]!, low: values[2]!, close: values[3]!, volume: 10 }));
    const rows = Array.from({ length: 20 }, (_, index) => candle(index));
    const all = [...rows, parent];
    const parameters = { ...settings, envelopeCloseOnConfirmedBreakout: true };
    const start = parent.openTime; const end = parent.closeTime;
    const document = prepareSymbolBlock('BTCUSDT', all, parameters, 'ENVELOPE', start, end, undefined, undefined, undefined, undefined, undefined, undefined, source);
    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [document], parameters, start, end, 3600);
    const result = portfolioResult(state, parameters);
    expect(result.entryCount).toBe(1);
    expect(result.closedTradeCount).toBe(0);
    expect(state.positions.BTCUSDT).toBeDefined();
  });
});

describe('envelope center-touch then entry-band return exits', () => {
  const entry = [99.5, 99.5, 99, 99.5];
  const center = [99.5, 100, 99.4, 99.8];
  const returned = [99.8, 99.8, 99, 99.4];
  const rest = [99.4, 99.6, 99.2, 99.5];

  function simulate(short: boolean, groups: number[][][], enabled = true, interval: '1h' | '4h' | '1d' = '1h') {
    const seconds = interval === '1d' ? 86400 : interval === '4h' ? 14400 : 3600;
    const source: Candle[] = groups.flatMap((group, parentIndex) => Array.from({ length: seconds / 900 }, (_, index) => {
      const lastClose = group.at(-1)![3]!;
      const values = group[index] ?? [lastClose, lastClose, lastClose, lastClose];
      const prices = short ? [200 - values[0]!, 200 - values[2]!, 200 - values[1]!, 200 - values[3]!] : values;
      const openTime = origin + (20 + parentIndex) * seconds + index * 900;
      return { openTime, closeTime: openTime + 900, open: prices[0]!, high: prices[1]!, low: prices[2]!, close: prices[3]!, volume: 10 };
    }));
    const parents = groups.map((_, index) => {
      const rows = source.slice(index * seconds / 900, (index + 1) * seconds / 900);
      return { ...rows[0]!, closeTime: rows.at(-1)!.closeTime,
        high: Math.max(...rows.map(row => row.high)), low: Math.min(...rows.map(row => row.low)), close: rows.at(-1)!.close };
    });
    const parameters = { ...settings, interval, side: short ? 'SHORT' as const : 'LONG' as const, envelopeCloseOnCenterReturn: enabled };
    const all = [...Array.from({ length: 20 }, (_, index) => ({ ...candle(index), openTime: origin + index * seconds, closeTime: origin + (index + 1) * seconds })), ...parents];
    const start = parents[0]!.openTime; const end = parents.at(-1)!.closeTime;
    const document = prepareSymbolBlock('BTCUSDT', all, parameters, 'ENVELOPE', start, end, undefined, undefined, undefined, undefined, undefined, undefined, source);
    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [document], parameters, start, end, seconds);
    return { state, document, parameters, start, end };
  }

  it.each([false, true])('closes on the third 15m candle after entry and center touch, short=%s', short => {
    const { state, start } = simulate(short, [[entry, center, returned, rest]]);
    expect(state.entries).toBe(1);
    expect(state.exitReasons).toEqual({ ENVELOPE_CENTER_RETURN: 1 });
    const trade = state.trades[0]!;
    expect(trade.exitAt).toBe(start + 1800);
    expect(trade.exitPrice).toBeCloseTo(short ? 101 * 1.0002 : 99 * .9998, 10);
    expect(trade.signal.envelopeCloseOnCenterReturn).toBe(true);
  });

  it.each([false, true])('does not use a band return that preceded the center touch, short=%s', short => {
    const { state } = simulate(short, [[entry, [99.5, 99.7, 99, 99.4], [99.4, 100, 99.4, 99.8], [99.8, 99.9, 99.5, 99.8]]]);
    expect(state.closed).toBe(0);
    expect(state.positions.BTCUSDT!.envelopeCenterTouched).toBe(true);
  });

  it.each([
    ['4h', false], ['4h', true], ['1d', false], ['1d', true],
  ] as const)('distinguishes identical %s parent OHLC by the 15m event order, short=%s', (interval, short) => {
    const afterCenter = simulate(short, [[entry, center, returned, rest]], true, interval);
    const beforeCenter = simulate(short, [[entry, [99.5, 99.8, 99, 99.8], [99.8, 100, 99.4, 99.8], [99.8, 99.9, 99.5, 99.5]]], true, interval);
    expect(afterCenter.document.bars[0]!.candle).toEqual(beforeCenter.document.bars[0]!.candle);
    expect(afterCenter.document.bars[0]!.envelopeIntrabarCandles).toHaveLength(interval === '1d' ? 96 : 16);
    expect(afterCenter.state.exitReasons).toEqual({ ENVELOPE_CENTER_RETURN: 1 });
    expect(afterCenter.state.trades[0]!.exitAt).toBe(afterCenter.start + 1800);
    expect(beforeCenter.state.closed).toBe(0);
    expect(beforeCenter.state.positions.BTCUSDT!.envelopeCenterTouched).toBe(true);
  });

  it.each([false, true])('uses the conservative path when both levels occur within the same 15m candle, short=%s', short => {
    const { state } = simulate(short, [[entry, [99.5, 100, 99, 99.5], [99.5, 99.5, 99.5, 99.5], [99.5, 99.5, 99.5, 99.5]]]);
    expect(state.exitReasons).toEqual({ ENVELOPE_CENTER_RETURN: 1 });
  });

  it.each([false, true])('ignores a center touch from before the entry, short=%s', short => {
    const { state } = simulate(short, [[[100, 100, 99.5, 99.5], entry, [99.5, 99.7, 99, 99.4], [99.4, 99.4, 99.4, 99.4]]]);
    expect(state.entries).toBe(1);
    expect(state.closed).toBe(0);
    expect(state.positions.BTCUSDT!.envelopeCenterTouched).toBe(false);
  });

  it.each([false, true])('keeps the original holding behavior when the option is off, short=%s', short => {
    const { state } = simulate(short, [[entry, center, returned, rest]], false);
    expect(state.closed).toBe(0);
    expect(state.positions.BTCUSDT!.envelopeCenterTouched).toBeUndefined();
  });

  it.each([false, true])('preserves the touch over a checkpoint and returns to the updated band, short=%s', short => {
    const { state: whole, document, parameters, start, end } = simulate(short, [
      [entry, center, [99.8, 100.4, 99.8, 100.4], [100.4, 100.4, 100.4, 100.4]],
      [[100.4, 100.5, 99.05, 99.1], [99.1, 99.1, 99.01, 99.1], [99.1, 99.1, 99.1, 99.1], [99.1, 99.1, 99.1, 99.1]],
    ]);
    const state = initialPortfolio(1000);
    const boundary = start + 3600;
    replayPortfolioBlock(state, [{ ...document, bars: document.bars.slice(0, 1) }], parameters, start, boundary, 3600);
    expect(state.positions.BTCUSDT!.envelopeCenterTouched).toBe(true);
    const resumed: typeof state = JSON.parse(JSON.stringify(state));
    replayPortfolioBlock(resumed, [{ ...document, bars: document.bars.slice(1) }], parameters, boundary, end, 3600);
    expect(resumed.exitReasons).toEqual({ ENVELOPE_CENTER_RETURN: 1 });
    expect(resumed.trades).toEqual(whole.trades);
    expect(resumed.trades[0]!.exitAt).toBe(boundary + 900);
    const band = document.bars[1]!.envelope!;
    expect(resumed.trades[0]!.exitPrice).toBeCloseTo(short ? band.upper * 1.0002 : band.lower * .9998, 10);
  });

  it.each([false, true])('still closes at the opposite band if it is reached before the return, short=%s', short => {
    const { state, start } = simulate(short, [[entry, center, [99.8, 101, 99.8, 100.5], [100.5, 100.5, 99, 99.5]]]);
    expect(state.exitReasons).toEqual({ ENVELOPE_OPPOSITE: 1 });
    expect(state.trades[0]!.exitAt).toBe(start + 1800);
  });

  it.each([false, true])('uses the observed open on a return gap and gives SL priority beyond the stop, short=%s', short => {
    const first = [entry, center, [99.8, 100, 99.8, 100], [100, 100, 100, 100]];
    const gap = simulate(short, [first, Array.from({ length: 4 }, () => [98.5, 98.6, 98.4, 98.5])]);
    expect(gap.state.exitReasons).toEqual({ ENVELOPE_CENTER_RETURN: 1 });
    expect(gap.state.trades[0]!.exitPrice).toBeCloseTo(short ? 101.5 * 1.0002 : 98.5 * .9998, 10);
    const stop = simulate(short, [first, Array.from({ length: 4 }, () => [97, 97.1, 96.9, 97])]);
    expect(stop.state.exitReasons).toEqual({ SL: 1 });
  });
});
