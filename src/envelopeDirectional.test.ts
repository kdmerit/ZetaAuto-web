import { describe, expect, it } from 'vitest';
import { envelopeEntryMayTouch, type PreparedSymbol } from './engine';
import { currentEnvelopeSettings } from './envelope';
import { initialPortfolio, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings } from './types';

const at = Date.UTC(2026, 1, 1) / 1000;
const base = currentEnvelopeSettings({ initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1', envelopeMaPeriod: '5', envelopeDeviationPercent: '1' } as BacktestSettings);

describe('whole-candle MA20 envelope entry filter', () => {
  it.each(['LONG', 'SHORT'] as const)('requires the entire %s candle strictly beyond MA20', side => {
    const long = side === 'LONG';
    for (const enabled of [false, true]) for (const ma20 of [98, 99, 100, 101, 102]) {
      const settings = { ...base, side, envelopeMa20Enabled: enabled };
      const document: PreparedSymbol = { symbol: 'BTCUSDT', bars: [{ candle: { openTime: at, closeTime: at + 3600,
        open: 100, high: long ? 100 : 101, low: long ? 99 : 100, close: 100, volume: 1 }, signal: null, ma20, ma60Exit: null,
        envelope: { center: 100, lower: 99, upper: 101, long, short: !long } }] };
      const state = initialPortfolio(1000);
      replayPortfolioBlock(state, [document], settings, at, at + 3600, 3600);
      expect(state.entries).toBe(Number(!enabled || (long ? ma20 < 99 : ma20 > 101)));
    }
  });

  it.each(['LONG', 'SHORT'] as const)('supports the opposite whole-candle %s MA20 filter', side => {
    const long = side === 'LONG';
    for (const enabled of [false, true]) for (const ma20 of [98, 99, 100, 101, 102]) {
      const settings = { ...base, side, envelopeMa20Enabled: false, envelopeMa20BelowEnabled: enabled };
      const document: PreparedSymbol = { symbol: 'BTCUSDT', bars: [{ candle: { openTime: at, closeTime: at + 3600,
        open: 100, high: 101, low: 99, close: 100, volume: 1 }, signal: null, ma20, ma60Exit: null,
        envelope: { center: 100, lower: 99, upper: 101, long, short: !long } }] };
      const state = initialPortfolio(1000);
      replayPortfolioBlock(state, [document], settings, at, at + 3600, 3600);
      expect(state.entries).toBe(Number(!enabled || (long ? ma20 > 101 : ma20 < 99)));
    }
  });

  it.each(['LONG', 'SHORT'] as const)('rejects %s entries when both MA20 filters are enabled', side => {
    const settings = { ...base, side, envelopeMa20Enabled: true, envelopeMa20BelowEnabled: true };
    const document: PreparedSymbol = { symbol: 'BTCUSDT', bars: [{ candle: { openTime: at, closeTime: at + 3600,
      open: 100, high: 101, low: 99, close: 100, volume: 1 }, signal: null, ma20: 100, ma60Exit: null,
      envelope: { center: 100, lower: 99, upper: 101, long: side === 'LONG', short: side === 'SHORT' } }] };
    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [document], settings, at, at + 3600, 3600);
    expect(state.entries).toBe(0);
  });
});

describe('daily entry-band half-candle envelope entry filter', () => {
  it.each([
    { side: 'LONG' as const, candle: { open: 100, high: 101, low: 97, close: 100 }, expected: 0 },
    { side: 'SHORT' as const, candle: { open: 100, high: 103, low: 99, close: 100 }, expected: 0 },
    { side: 'LONG' as const, candle: { open: 100, high: 101, low: 96.8, close: 100 }, expected: 0 },
    { side: 'SHORT' as const, candle: { open: 100, high: 103.2, low: 99, close: 100 }, expected: 0 },
    { side: 'LONG' as const, candle: { open: 100, high: 101, low: 97.2, close: 100 }, expected: 1 },
    { side: 'SHORT' as const, candle: { open: 100, high: 102.8, low: 99, close: 100 }, expected: 1 },
    { side: 'LONG' as const, candle: { open: 100, high: 103, low: 99, close: 100 }, expected: 1 },
    { side: 'SHORT' as const, candle: { open: 100, high: 101, low: 97, close: 100 }, expected: 1 },
  ])('applies the midpoint boundary for $side only on 1d', ({ side, candle, expected }) => {
    const settings = { ...base, interval: '1d' as const, side };
    const document: PreparedSymbol = { symbol: 'BTCUSDT', bars: [{ candle: { openTime: at, closeTime: at + 86400,
      ...candle, volume: 1 }, signal: null, ma20: null, ma60Exit: null,
      envelope: { center: 100, lower: 99, upper: 101, long: side === 'LONG', short: side === 'SHORT' } }] };
    const state = initialPortfolio(1000);
    expect(envelopeEntryMayTouch(document.bars[0]!, settings)).toBe(expected === 1);
    replayPortfolioBlock(state, [document], settings, at, at + 86400, 86400);
    expect(state.entries).toBe(expected);
  });

  it.each([
    { side: 'LONG' as const, interval: '1h' as const, seconds: 3600 },
    { side: 'SHORT' as const, interval: '1h' as const, seconds: 3600 },
    { side: 'LONG' as const, interval: '4h' as const, seconds: 14400 },
    { side: 'SHORT' as const, interval: '4h' as const, seconds: 14400 },
  ])('does not apply the daily filter to $side $interval entries', ({ side, interval, seconds }) => {
    const long = side === 'LONG';
    const settings = { ...base, interval, side };
    const document: PreparedSymbol = { symbol: 'BTCUSDT', bars: [{ candle: { openTime: at, closeTime: at + seconds,
      open: 100, high: long ? 101 : 103, low: long ? 97 : 99, close: 100, volume: 1 }, signal: null, ma20: null, ma60Exit: null,
      envelope: { center: 100, lower: 99, upper: 101, long, short: !long } }] };
    const state = initialPortfolio(1000);
    expect(envelopeEntryMayTouch(document.bars[0]!, settings)).toBe(true);
    replayPortfolioBlock(state, [document], settings, at, at + seconds, seconds);
    expect(state.entries).toBe(1);
  });

  it.each([
    { side: 'LONG' as const, targetFirst: true },
    { side: 'LONG' as const, targetFirst: false },
    { side: 'SHORT' as const, targetFirst: true },
    { side: 'SHORT' as const, targetFirst: false },
  ])('preserves 15m exit order after an allowed daily $side entry (targetFirst=$targetFirst)', ({ side, targetFirst }) => {
    const settings = { ...base, interval: '1d' as const, side, envelopeDeviationPercent: '3' };
    const source = [
      [100, 100, 97, 97],
      targetFirst ? [97, 104, 97, 104] : [97, 97, 93, 93],
      targetFirst ? [104, 104, 93, 93] : [93, 104, 93, 104],
      targetFirst ? [93, 100, 93, 100] : [104, 104, 100, 100],
    ];
    const intrabars = Array.from({ length: 96 }, (_, index) => {
      const raw = source[index] ?? [100, 100, 100, 100];
      const prices = side === 'LONG' ? raw : [200 - raw[0]!, 200 - raw[2]!, 200 - raw[1]!, 200 - raw[3]!];
      return { openTime: at + index * 900, closeTime: at + (index + 1) * 900,
        open: prices[0]!, high: prices[1]!, low: prices[2]!, close: prices[3]!, volume: 1 };
    });
    const document: PreparedSymbol = { symbol: 'BTCUSDT', bars: [{
      candle: { openTime: at, closeTime: at + 86400, open: 100, high: side === 'LONG' ? 104 : 107,
        low: side === 'LONG' ? 93 : 96, close: 100, volume: 96 },
      signal: null, ma20: null, ma60Exit: null, envelopeIntrabarCandles: intrabars,
      envelope: { center: 100, lower: 97, upper: 103, long: side === 'LONG', short: side === 'SHORT' },
    }] };
    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [document], settings, at, at + 86400, 86400);
    expect(state.entries).toBe(1); expect(state.closed).toBe(1);
    expect(state.exitReasons).toEqual(targetFirst ? { ENVELOPE_OPPOSITE: 1 } : { SL: 1 });
  });
});
