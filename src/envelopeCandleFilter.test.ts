import { describe, expect, it } from 'vitest';
import { envelopeCandleAllowsEntry, envelopeCandleContexts, envelopeCandleDataStart, envelopeDailyWickBlocksEntry, type EnvelopeCandleContext } from './envelopeCandleFilter';
import { currentEnvelopeSettings, envelopeParameters } from './envelope';
import { prepareSymbolBlock } from './engine';
import { initialPortfolio, replayPortfolioBlock } from './portfolio';
import { defaultSettings } from './components/StrategyBacktest';
import type { Candle } from './types';

const origin = Date.UTC(2026, 0, 3) / 1000;
function candle(open = 100, high = 101, low = 99, close = 100, at = origin, seconds = 86400): Candle {
  return { open, high, low, close, openTime: at, closeTime: at + seconds, volume: 1 };
}
function context(): EnvelopeCandleContext {
  return { daily: candle(), previousDaily: candle(99, 101, 98, 100, origin - 86400),
    beforePreviousDaily: candle(99, 101, 98, 100, origin - 2 * 86400),
    fourHourly: candle(100, 101, 99, 100, origin, 14400),
    previousFourHourly: candle(99, 101, 98, 100, origin - 14400, 14400),
    beforePreviousFourHourly: candle(99, 101, 98, 100, origin - 28800, 14400) };
}
function reflected(row: Candle): Candle {
  return { ...row, open: 200 - row.open, high: 200 - row.low, low: 200 - row.high, close: 200 - row.close };
}
function allows(input: EnvelopeCandleContext, side: 'LONG' | 'SHORT', price = 100): boolean {
  const value = side === 'LONG' ? input : Object.fromEntries(Object.entries(input).map(([key, row]) => [key, reflected(row)])) as unknown as EnvelopeCandleContext;
  return envelopeCandleAllowsEntry(value, side, [side === 'LONG' ? price : 200 - price]);
}

describe.each(['LONG', 'SHORT'] as const)('directional candle exclusions: %s', side => {
  it('rejects the current adverse daily body at exactly 5x, but permits just below it', () => {
    const input = context();
    input.daily = candle(100, 100, 95, 100);
    input.fourHourly = candle(95, 95, 95, 95, origin, 14400);
    expect(allows(input, side, 95)).toBe(false);
    expect(allows(input, side, 95.0001)).toBe(true);
  });
  it('independently rejects the previous adverse daily body at exactly 5x', () => {
    const input = context();
    input.previousDaily = candle(105, 105, 100, 100, origin - 86400);
    expect(allows(input, side)).toBe(false);
    input.previousDaily.open = 104.9999;
    expect(allows(input, side)).toBe(true);
  });
  it('rejects the current adverse 4h body at exactly 5x and permits just below it', () => {
    const input = context();
    input.fourHourly = candle(105, 106, 99, 100, origin, 14400);
    expect(allows(input, side)).toBe(false);
    input.fourHourly.open = 104.9999;
    expect(allows(input, side)).toBe(true);
  });
  it('rejects the previous adverse 4h body independently of current highs and lows', () => {
    const input = context();
    input.previousFourHourly = candle(105, 106, 99, 100, origin - 14400, 14400);
    expect(allows(input, side)).toBe(false);
    input.previousFourHourly.open = 104.9999;
    expect(allows(input, side)).toBe(true);
  });
  it('ignores wick imbalance and does not reject large favorable bodies', () => {
    const input = context();
    input.fourHourly = candle(94, 150, 93, 100, origin, 14400);
    input.previousFourHourly = candle(94, 150, 93, 100, origin - 14400, 14400);
    expect(allows(input, side)).toBe(true);
  });
  it('includes the exact 5x boundary for decimal market prices', () => {
    const input = context();
    input.fourHourly = candle(100.05, 100.05, 100, 100, origin, 14400);
    input.previousFourHourly = candle(99.99, 100, 99.99, 100, origin - 14400, 14400);
    expect(allows(input, side)).toBe(false);
    input.fourHourly.open = 100.04999;
    expect(allows(input, side)).toBe(true);
  });
  it('does not invent a nonzero reference body for a doji', () => {
    const input = context(); input.previousDaily = candle();
    input.fourHourly = candle(99.99, 99.99, 99.99, 99.99, origin, 14400);
    expect(allows(input, side, 99.99)).toBe(false);
    input.fourHourly = candle();
    expect(allows(input, side)).toBe(true);
  });
});

function history(): Candle[] {
  return Array.from({ length: 196 }, (_, index) => {
    const at = origin - 2 * 86400 + index * 900;
    if (index >= 192) return candle(97, 97, 97, 97, at, 900);
    const part = index % 96;
    return candle(99 + part / 96, 99 + (part + 1) / 96, 99 + part / 96, 99 + (part + 1) / 96, at, 900);
  });
}
describe.each(['LONG', 'SHORT'] as const)('daily wick exclusion: %s', side => {
  it.each([
    ['exactly three bodies', 1, 4, -1, true],
    ['less than three bodies', 1, 3.9999, -1, false],
    ['exactly seventy percent', 1, 7, -3, true],
    ['less than seventy percent', 1, 7, -3.0001, false],
    ['favorable body contributes zero', -1, 6, -4, false],
    ['favorable candle with enough wick', -1, 7, -3, true],
    ['doji with long wick', 0, 7, -3, true],
    ['doji with balanced wicks', 0, 5, -5, false],
    ['flat candle', 0, 0, 0, false],
  ] as const)('%s, on either current or previous daily candle', (_, open, high, low, blocked) => {
    for (const target of ['daily', 'previousDaily'] as const) {
      const input = context();
      input[target] = candle(100 + open, 100 + high, 100 + low, 100, input[target].openTime);
      expect(allows(input, side)).toBe(!blocked);
    }
  });
  it('requires both thresholds on the same candle and never uses a 4h wick', () => {
    const input = context();
    input.daily = candle(101, 107, 96, 100);
    input.previousDaily = candle(101, 103.9, 100, 100, origin - 86400);
    input.fourHourly = candle(100, 107, 97, 100, origin, 14400);
    expect(allows(input, side)).toBe(true);
  });
  it('includes decimal boundaries and uses the latest observed price for the body', () => {
    const input = context();
    input.daily = candle(100.01, 100.07, 99.97, 100);
    expect(allows(input, side)).toBe(false);
    input.daily.low = 99.96999;
    expect(allows(input, side)).toBe(true);
    input.daily = candle(100, 107, 97, 100);
    expect(allows(input, side, 98)).toBe(false);
    expect(allows(input, side, 97)).toBe(true);
  });
  it('mirrors upper and lower wick calculations exactly', () => {
    const row = candle(101, 104, 99, 100);
    expect(envelopeDailyWickBlocksEntry(side === 'LONG' ? row : reflected(row), side)).toBe(true);
  });
});
describe('causal daily/four-hour snapshots', () => {
  it('cannot block a fill using a wick that forms later in the current 15m candle', () => {
    const rows = history(); rows[192] = candle(97, 110, 96, 97, origin, 900);
    const snapshots = envelopeCandleContexts(rows);
    expect(envelopeCandleAllowsEntry(snapshots.get(origin), 'LONG', [97])).toBe(true);
    expect(envelopeCandleAllowsEntry(snapshots.get(origin + 900), 'LONG', [97])).toBe(false);
  });
  it('uses two complete daily candles, UTC boundaries, and only the current 15m open', () => {
    const rows = history();
    rows[192] = candle(97, 180, 10, 20, origin, 900);
    const snapshots = envelopeCandleContexts(rows);
    expect(snapshots.get(origin)).toMatchObject({ daily: { open: 97, high: 97, low: 97, close: 97 },
      fourHourly: { open: 97, high: 97, low: 97, close: 97 }, previousDaily: { open: 99, close: 100 },
      beforePreviousFourHourly: { openTime: origin - 28800, closeTime: origin - 14400 } });
    expect(snapshots.get(origin + 900)?.daily).toMatchObject({ open: 97, high: 180, low: 10, close: 97 });
    expect(snapshots.has(origin - 900)).toBe(false);
  });
  it('rejects incomplete history and gaps instead of combining nonadjacent candles', () => {
    const rows = history();
    expect(envelopeCandleContexts(rows.slice(1)).has(origin)).toBe(false);
    expect(envelopeCandleContexts(rows.filter((_, index) => index !== 180)).has(origin)).toBe(false);
    expect(envelopeCandleAllowsEntry(undefined, 'LONG', [97])).toBe(false);
    expect(envelopeCandleAllowsEntry(context(), 'LONG', [NaN])).toBe(false);
  });
  it('requests only the extra 15m warmup when the filter is enabled', () => {
    const base = defaultSettings('ENVELOPE');
    expect(envelopeCandleDataStart(base, origin + 3000)).toBe(origin + 3000);
    expect(envelopeCandleDataStart({ ...base, envelopeCandleFilterEnabled: true }, origin + 3000)).toBe(origin - 2 * 86400);
  });
});

describe('entry execution, independent SL and persisted filters', () => {
  const settings = currentEnvelopeSettings({ ...defaultSettings('ENVELOPE'), interval: '1h', envelopeMa20Enabled: false,
    envelopeMaPeriod: '3', side: 'LONG', envelopeCandleFilterEnabled: true });
  const parents = [...Array.from({ length: 3 }, (_, i) => candle(100, 100, 100, 100, origin - (3 - i) * 3600, 3600)), candle(97, 97, 97, 97, origin, 3600)];
  it.each([false, true].flatMap(limited => ['BODY', 'CURRENT_WICK', 'PREVIOUS_WICK'].map(rule => [limited, rule] as const)))('blocks opening and crossing fills when enabled, allocation=%s exclusion=%s', (limited, rule) => {
    for (const enabled of [false, true]) for (const crossing of [false, true]) {
      const parameters = { ...settings, envelopeCandleFilterEnabled: enabled, envelopeSideRatio50Enabled: limited };
      const lower = history();
      if (crossing) for (let index = 192; index < lower.length; index += 1) {
        lower[index] = candle(100, 100, index === 192 ? 97 : 100, 100, origin + (index - 192) * 900, 900);
      }
      const all = crossing ? [...parents.slice(0, -1), candle(100, 100, 97, 100, origin, 3600)] : parents;
      const document = prepareSymbolBlock('BTCUSDT', all, parameters, 'ENVELOPE', origin, origin + 3600,
        undefined, undefined, undefined, undefined, undefined, undefined, lower);
      const denied = context();
      if (rule === 'BODY') denied.previousDaily = candle(105, 105, 100, 100, origin - 86400);
      else if (rule === 'CURRENT_WICK') denied.daily = candle(98, 104, 94, 97);
      else denied.previousDaily = candle(101, 107, 97, 100, origin - 86400);
      for (const bar of document.bars) bar.envelopeCandleContexts = new Map(lower.slice(192).map(row => [row.openTime, denied]));
      const state = initialPortfolio(1000);
      replayPortfolioBlock(state, [document], parameters, origin, origin + 3600, 3600);
      expect(state.entries).toBe(enabled ? 0 : 1);
    }
  });
  it.each([false, true])('does not use an adverse 15m body formed after the fill, allocation=%s', limited => {
    for (const side of ['LONG', 'SHORT'] as const) {
      let lower = history(); lower[192] = candle(97, 103, 80, 81, origin, 900);
      let all = [...parents.slice(0, -1), candle(97, 103, 80, 97, origin, 3600)];
      if (side === 'SHORT') { lower = lower.map(reflected); all = all.map(reflected); }
      const parameters = { ...settings, side, envelopeSideRatio50Enabled: limited };
      const document = prepareSymbolBlock('BTCUSDT', all, parameters, 'ENVELOPE', origin, origin + 3600,
        undefined, undefined, undefined, undefined, undefined, undefined, lower);
      const state = initialPortfolio(1000);
      replayPortfolioBlock(state, [document], parameters, origin, origin + 3600, 3600);
      expect(state.entries).toBe(1);
      expect(state.positions.BTCUSDT?.signal.envelopeStopLossPercent ?? state.trades[0]?.signal.envelopeStopLossPercent).toBe(3);
    }
  });
  it.each(['LONG', 'SHORT'] as const)('keeps %s SL independent of the envelope width and retains the fill adjustment', side => {
    const parameters = { ...settings, side, envelopeCandleFilterEnabled: false, envelopeDeviationPercent: '3', envelopeStopLossPercent: '1' };
    const all = side === 'LONG' ? parents : parents.map(reflected);
    const document = prepareSymbolBlock('BTCUSDT', all, parameters, 'ENVELOPE', origin, origin + 3600);
    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [document], parameters, origin, origin + 3600, 3600);
    const position = state.positions.BTCUSDT!;
    expect(position.stop).toBeCloseTo(position.first * (side === 'LONG' ? .99 : 1.01), 10);
    expect(position.signal.envelopeDeviationPercent).toBe(3);
    expect(position.signal.envelopeStopLossPercent).toBe(1);
    expect(position.target).toBe(side === 'LONG' ? 103 : 97);
  });
  it.each(['0.1', '3', '20.0'])('accepts inclusive SL %s and preserves it through settings normalization', value => {
    const parameters = currentEnvelopeSettings({ ...settings, envelopeStopLossPercent: value, envelopeDeviationPercent: '7' });
    expect(envelopeParameters(parameters).stopPercent).toBe(Number(value));
    expect(parameters.envelopeCandleFilterEnabled).toBe(true);
  });
  it.each(['LONG', 'SHORT'] as const)('changes actual %s stop executions when SL changes without moving the bands', side => {
    for (const stop of ['1', '5']) {
      const parameters = { ...settings, side, envelopeCandleFilterEnabled: false, envelopeStopLossPercent: stop };
      let all = [...parents, candle(97, 97, 94.5, 95, origin + 3600, 3600)];
      if (side === 'SHORT') all = all.map(reflected);
      const document = prepareSymbolBlock('BTCUSDT', all, parameters, 'ENVELOPE', origin, origin + 7200);
      const state = initialPortfolio(1000);
      replayPortfolioBlock(state, [document], parameters, origin, origin + 3600, 3600);
      const resumed = structuredClone(state);
      replayPortfolioBlock(resumed, [document], parameters, origin + 3600, origin + 7200, 3600);
      expect(resumed.entries).toBe(1);
      expect(resumed.exitReasons.SL ?? 0).toBe(stop === '1' ? 1 : 0);
      expect(resumed.closed).toBe(stop === '1' ? 1 : 0);
    }
  });
  it.each(['', '0', '0.09', '20.1', '3.15', '-1', 'NaN'])('rejects invalid SL %s', value => {
    expect(() => envelopeParameters({ ...settings, envelopeStopLossPercent: value })).toThrow('SL');
  });
});
