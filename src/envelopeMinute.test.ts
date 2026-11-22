import { describe, expect, it } from 'vitest';
import { envelopeEntryMayTouch, prepareSymbolBlock, type PreparedSymbol } from './engine';
import { currentEnvelopeSettings } from './envelope';
import { initialPortfolio, replayPortfolioBlock, type PortfolioState } from './portfolio';
import type { BacktestSettings, Candle } from './types';
import { intervalSeconds } from './api';
import type { EnvelopeCandleContext } from './envelopeCandleFilter';
import { replayFixedEnvelope } from './envelopeReplay';

const day = 86400;
const start = Date.UTC(2026, 1, 1) / 1000;
const settings = currentEnvelopeSettings({ interval: '1d', side: 'LONG', initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1',
  envelopeMaPeriod: '3', envelopeDeviationPercent: '3', envelopeStopLossPercent: '3' } as BacktestSettings);
type Prices = [number, number, number, number];

function fixture(overrides: Record<number, Prices>, parameters = settings, days = 1, missingMinute?: number): PreparedSymbol {
  const seconds = intervalSeconds(parameters.interval);
  const count = seconds / 60;
  let price = 100;
  const minutes: Candle[] = Array.from({ length: days * count }, (_, index) => {
    const values = overrides[index] ?? [price, price, price, price];
    price = values[3];
    const [open, high, low, close] = parameters.side === 'SHORT'
      ? [200 - values[0], 200 - values[2], 200 - values[1], 200 - values[3]] : values;
    return { openTime: start + index * 60, closeTime: start + (index + 1) * 60, open, high, low, close, volume: 1 };
  });
  const warmup: Candle[] = Array.from({ length: 20 }, (_, index) => {
    const value = index < 17 && parameters.envelopeMa20Enabled ? (parameters.side === 'SHORT' ? 104 : 96) : 100;
    return { openTime: start + (index - 20) * seconds, closeTime: start + (index - 19) * seconds,
      open: value, high: value, low: value, close: value, volume: 1 };
  });
  const parents = Array.from({ length: days }, (_, index) => {
    const rows = minutes.slice(index * count, (index + 1) * count);
    return { ...rows[0]!, closeTime: rows.at(-1)!.closeTime, high: Math.max(...rows.map(row => row.high)),
      low: Math.min(...rows.map(row => row.low)), close: rows.at(-1)!.close, volume: rows.length };
  });
  const executionMinutes = missingMinute === undefined ? minutes : minutes.filter((_, index) => index !== missingMinute);
  return prepareSymbolBlock('BTCUSDT', [...warmup, ...parents], parameters, 'ENVELOPE', start, start + days * seconds,
    undefined, undefined, undefined, undefined, undefined, undefined, executionMinutes);
}

function replay(document: PreparedSymbol, parameters = settings, state = initialPortfolio(1000), from = start, end = document.bars.at(-1)!.candle.closeTime): PortfolioState {
  replayPortfolioBlock(state, [document], parameters, from, end, intervalSeconds(parameters.interval));
  return state;
}

describe.each(['LONG', 'SHORT'] as const)('causal minute-poll envelope: %s', side => {
  const parameters = { ...settings, side };
  const entry: Record<number, Prices> = { 0: [100, 100, 97, 97] };

  it('keeps the same entry when later daily extrema would have rejected the completed candle', () => {
    const stable = fixture(entry, parameters);
    const falling = fixture({ ...entry, 2: [97, 97, 93, 95] }, parameters);
    expect(envelopeEntryMayTouch(falling.bars[0]!, parameters)).toBe(true);
    const first = replay(stable, parameters); const second = replay(falling, parameters);
    expect(first.entries).toBe(1); expect(second.entries).toBe(1);
    expect(second.exitReasons).toEqual({ SL: 1 });
    expect(second.trades[0]!.entryAt).toBe(start + 60);
  });

  it.each(['1h', '4h', '1d'] as const)('computes %s entry MA20 from previous closes and the poll price, never the final close', interval => {
    const input = { ...parameters, interval, envelopeMa20Enabled: true };
    const state = replay(fixture({ ...entry, 30: [97, 150, 97, 150] }, input), input);
    expect(state.entries).toBe(1);
  });

  it('does not buy a band touch that disappears between minute observations', () => {
    const state = replay(fixture({ 0: [100, 100, 97, 100] }, parameters), parameters);
    expect(state.entries).toBe(0);
  });

  it('waits for the selected candle close when close-only entry is enabled', () => {
    const input = { ...parameters, envelopeCloseOnlyEntryEnabled: true, envelopeTakeProfitEnabled: true };
    const state = replay(fixture({ 0: [100, 100, 97, 100], 1439: [100, 106, 97, 97] }, input), input);
    expect(state.entries).toBe(1);
    expect(state.positions.BTCUSDT!.opened).toBe(start + day);
    const finalClose = parameters.side === 'LONG' ? 97 : 103;
    expect(state.positions.BTCUSDT!.first).toBeCloseTo(finalClose * (parameters.side === 'LONG' ? 1.0002 : .9998), 10);
    const inside = replay(fixture({ 0: [100, 100, 97, 100], 1439: [100, 100, 100, 100] }, input), input);
    expect(inside.entries).toBe(0);
  });

  it('does not credit target wicks in the entry 15m candle or carry them into the next quarter', () => {
    const state = replay(fixture({ ...entry, 14: [97, 104, 97, 100] }, parameters), parameters);
    expect(state.entries).toBe(1); expect(state.closed).toBe(0);
  });

  it('exits at the next observed market price after a later-quarter target wick, including slippage', () => {
    const state = replay(fixture({ ...entry, 15: [100, 104, 100, 100] }, parameters), parameters);
    expect(state.exitReasons).toEqual({ ENVELOPE_15M_WICK: 1 });
    const trade = state.trades[0]!;
    expect(trade.exitAt).toBe(start + 16 * 60);
    expect(trade.exitPrice).toBeCloseTo(side === 'LONG' ? 100 * .9998 : 100 * 1.0002, 10);
    expect(trade.exitPrice).not.toBe(trade.signal.target);
  });

  it.each([false, true])('keeps current-price band exits for TP off and archived TP jobs (enabled=%s)', enabled => {
    const input = { ...parameters, envelopeTakeProfitEnabled: enabled, envelopeTakeProfitPercent: '20', envelopeTakeProfitReplacesBand: !enabled };
    const state = replay(fixture({ ...entry, 2: [104, 104, 104, 104] }, input), input);
    expect(state.exitReasons).toEqual({ ENVELOPE_OPPOSITE: 1 });
    expect(state.trades[0]!.exitPrice).toBeCloseTo(side === 'LONG' ? 104 * .9998 : 96 * 1.0002, 10);
  });

  it('holds past both a current price and a later 15m wick at the opposite band until fixed TP fills', () => {
    const input = { ...parameters, envelopeTakeProfitEnabled: true, envelopeTakeProfitPercent: '10' };
    const bandTouches: Record<number, Prices> = { 2: [104, 104, 104, 104], 15: [100, 104, 100, 100] };
    const stillOpen = replay(fixture({ ...entry, ...bandTouches }, input), input);
    expect(stillOpen.entries).toBe(1);
    expect(stillOpen.closed).toBe(0);

    const state = replay(fixture({ ...entry, ...bandTouches, 20: [100, 110, 100, 100] }, input), input);
    expect(state.exitReasons).toEqual({ ENVELOPE_TP: 1 });
    expect(state.trades[0]!.exitAt).toBe(start + 20 * 60);
    expect(state.trades[0]!.priceLines?.map(line => line.kind)).toContain('FIXED_TP');
    expect(state.trades[0]!.priceLines?.map(line => line.kind)).not.toContain('TP');
  });

  it('fills a fixed 6% TP at its order price on an intraminute touch after entry', () => {
    const input = { ...parameters, envelopeTakeProfitEnabled: true, envelopeTakeProfitPercent: '6' };
    const document = fixture({ ...entry, 2: [97, 104, 97, 97] }, input);
    const state = replay(document, input);
    const trade = state.trades[0]!;
    const entryPrice = side === 'LONG' ? 97 * 1.0002 : 103 * .9998;
    const orderPrice = entryPrice * (side === 'LONG' ? 1.06 : .94);
    expect(state.exitReasons).toEqual({ ENVELOPE_TP: 1 });
    expect(trade.exitAt).toBe(start + 2 * 60);
    expect(trade.exitPrice).toBeCloseTo(orderPrice, 10);
    expect(trade.priceLines?.find(line => line.kind === 'FIXED_TP')?.price).toBe(trade.exitPrice);
    expect(replay(document, { ...input, envelopeTakeProfitEnabled: false }).closed).toBe(0);
  });

  it('uses the conservative stop result when the same minute reaches both SL and fixed TP', () => {
    const input = { ...parameters, envelopeTakeProfitEnabled: true, envelopeTakeProfitPercent: '6' };
    const state = replay(fixture({ ...entry, 2: [97, 104, 93, 97] }, input), input);
    expect(state.exitReasons).toEqual({ SL: 1 });
  });

  it.each([false, true])('observes center-return state only at polls (fixed TP enabled=%s)', enabled => {
    const input = { ...parameters, envelopeCloseOnCenterReturn: true, envelopeTakeProfitEnabled: enabled, envelopeTakeProfitPercent: '20' };
    const noLatch = replay(fixture({ ...entry, 2: [97, 101, 97, 97] }, input), input);
    expect(noLatch.closed).toBe(0);
    const latched = replay(fixture({ ...entry, 2: [100, 100, 100, 100], 3: [97, 97, 97, 97] }, input), input);
    expect(latched.exitReasons).toEqual({ ENVELOPE_CENTER_RETURN: 1 });
    expect(latched.trades[0]!.exitAt).toBe(start + 3 * 60);
  });

  it('continues exchange-side trailing stops within a minute without using pre-entry highs/lows', () => {
    const input = { ...parameters, envelopeTrailingStopEnabled: true, envelopeTakeProfitEnabled: true };
    const state = replay(fixture({ 0: [100, 120, 97, 97], 2: [97, 102, 97, 100] }, input), input);
    expect(state.exitReasons).toEqual({ TRAILING_STOP: 1 });
    expect(state.trades[0]!.exitAt).toBe(start + 2 * 60);
  });

  it('preserves minute entry times and the fixed TP across account checkpoints', () => {
    const input = { ...parameters, envelopeTakeProfitEnabled: true, envelopeTakeProfitPercent: '6' };
    const document = fixture({ ...entry, 1441: [97, 104, 97, 97] }, input, 2);
    const whole = replay(document, input);
    const first = replay(document, input, initialPortfolio(1000), start, start + day);
    const resumed = replay(document, input, JSON.parse(JSON.stringify(first)) as PortfolioState, start + day, start + 2 * day);
    expect(resumed.exitReasons).toEqual({ ENVELOPE_TP: 1 });
    expect(resumed).toEqual(whole);
  });

  it.each([false, true])('rejects a real gap in the required minute data (closeOnly=%s)', closeOnly => {
    const input = { ...parameters, envelopeCloseOnlyEntryEnabled: closeOnly };
    const document = fixture(entry, input, 1, 10);
    expect(document.bars[0]!.envelopeIntrabarCandles).toHaveLength(1439);
    expect(() => replay(document, input)).toThrow('1분봉');
  });

  it('skips a partially listed parent candle instead of treating its pre-listing minutes as missing', () => {
    const input = { ...parameters, interval: '1h' as const };
    const parentStart = start;
    const parentMinutes = Array.from({ length: 59 }, (_, index) => ({
      openTime: parentStart + (index + 1) * 60, closeTime: parentStart + (index + 2) * 60,
      open: 100, high: 100, low: 100, close: 100, volume: 1,
    }));
    const parent = { ...parentMinutes[0]!, openTime: parentStart, closeTime: parentStart + 3600,
      high: 100, low: 100, close: 100, volume: 59 };
    const document = prepareSymbolBlock('NEWUSDT', [parent], input, 'ENVELOPE', parentStart, parentStart + 3600,
      undefined, undefined, undefined, undefined, undefined, undefined, parentMinutes);
    expect(document.bars).toHaveLength(1);
    expect(document.bars[0]!.envelopeIntrabarCandles).toBeUndefined();
    expect(() => replay(document, input)).not.toThrow();
  });
});

describe('shared minute execution and entry filters', () => {
  it('reconstructs entry-time 1d/4h contexts from two completed days of real minute fixtures', () => {
    const input = { ...settings, interval: '1h' as const, envelopeCandleFilterEnabled: true };
    const turns = [98, 100, 98, 100, 98, 101, 99, 101, 99, 101, 99, 102, 100];
    const history: Candle[] = Array.from({ length: 2880 }, (_, index) => {
      const segment = Math.floor(index / 240); const fraction = index % 240;
      const from = turns[segment]!; const to = turns[segment + 1]!;
      const open = from + (to - from) * fraction / 240;
      const close = from + (to - from) * (fraction + 1) / 240;
      return { openTime: start - 2 * day + index * 60, closeTime: start - 2 * day + (index + 1) * 60,
        open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1 };
    });
    const current = fixture({ 0: [100, 100, 97, 97], 20: [97, 120, 90, 90] }, input).bars[0]!.envelopeIntrabarCandles!;
    const minutes = [...history, ...current];
    const parents = Array.from({ length: 49 }, (_, index) => {
      const rows = minutes.slice(index * 60, (index + 1) * 60);
      return { ...rows[0]!, closeTime: rows.at(-1)!.closeTime, high: Math.max(...rows.map(row => row.high)),
        low: Math.min(...rows.map(row => row.low)), close: rows.at(-1)!.close, volume: rows.length };
    });
    const document = prepareSymbolBlock('BTCUSDT', parents, input, 'ENVELOPE', start, start + 3600,
      undefined, undefined, undefined, undefined, undefined, undefined, minutes);
    expect(document.bars[0]!.envelopeCandleContext?.daily).toMatchObject({ open: 100, high: 100, low: 100, close: 100 });
    expect(document.bars[0]!.envelopeCandleContext?.previousDaily.close).toBe(100);
    const state = replay(document, input);
    expect(state.entries).toBe(1);
    expect(state.trades[0]!.entryAt).toBe(start + 60);
  });

  it('keeps fixed/statistics replay identical to ordinary replay', async () => {
    const input = { ...settings, interval: '1h' as const, envelopeTakeProfitEnabled: true, envelopeTakeProfitPercent: '10' };
    const document = fixture({ 0: [100, 100, 97, 97], 15: [100, 104, 100, 100], 20: [100, 110, 100, 100] }, input);
    const direct = replay(document, input);
    const result = await replayFixedEnvelope(document, input, 3600, new AbortController().signal, async () => {});
    expect(result.entryCount).toBe(direct.entries);
    expect(result.exitReasons).toEqual({ ENVELOPE_TP: 1 });
    expect(result.exitReasons).toEqual(direct.exitReasons);
    expect(result.recentTrades).toEqual(direct.trades);
  });

  it.each([false, true])('retains the existing optional 50-percent allocation, enabled=%s', enabled => {
    const input = { ...settings, envelopeSideRatio50Enabled: enabled };
    const documents = Array.from({ length: 6 }, (_, index) => ({ ...fixture({ 0: [100, 100, 97, 97] }, input), symbol: `COIN${index}USDT` }));
    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, documents, input, start, start + day, day);
    expect(state.entries).toBe(enabled ? 5 : 6);
  });

  it('applies previous 1d/4h body and wick exclusions to minute-poll entries', () => {
    const input = { ...settings, interval: '1h' as const, envelopeCandleFilterEnabled: true };
    const candle = (seconds: number, offset: number, open = 99, high = 100, low = 99, close = 100): Candle => ({
      openTime: start + offset * seconds, closeTime: start + (offset + 1) * seconds, open, high, low, close, volume: 1,
    });
    const context: EnvelopeCandleContext = { daily: candle(day, 0, 100, 100, 100), previousDaily: candle(day, -1), beforePreviousDaily: candle(day, -2),
      fourHourly: candle(14400, 0, 100, 100, 100), previousFourHourly: candle(14400, -1), beforePreviousFourHourly: candle(14400, -2) };
    for (const field of ['previousDaily', 'previousFourHourly'] as const) for (const wick of [false, true]) {
      const document = fixture({ 0: [100, 100, 97, 97] }, input);
      document.bars[0]!.envelopeCandleContext = { ...context, [field]: { ...context[field], open: wick ? 101 : 105, high: wick ? 108 : 105, low: 100 } };
      expect(replay(document, input).entries).toBe(0);
    }
    const allowed = fixture({ 0: [100, 100, 97, 97], 20: [97, 97, 90, 90] }, input);
    allowed.bars[0]!.envelopeCandleContext = context;
    expect(replay(allowed, input).entries).toBe(1);
  });
});
