import { describe, expect, it } from 'vitest';
import type { PreparedSymbol } from './engine';
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

describe('daily opposite-band half-candle envelope entry filter', () => {
  it.each([
    { side: 'LONG' as const, candle: { open: 100, high: 103, low: 99, close: 100 }, expected: 0 },
    { side: 'SHORT' as const, candle: { open: 100, high: 101, low: 97, close: 100 }, expected: 0 },
    { side: 'LONG' as const, candle: { open: 100, high: 102.8, low: 99, close: 100 }, expected: 1 },
    { side: 'SHORT' as const, candle: { open: 100, high: 101, low: 97.2, close: 100 }, expected: 1 },
  ])('applies the midpoint boundary for $side only on 1d', ({ side, candle, expected }) => {
    const settings = { ...base, interval: '1d' as const, side };
    const document: PreparedSymbol = { symbol: 'BTCUSDT', bars: [{ candle: { openTime: at, closeTime: at + 86400,
      ...candle, volume: 1 }, signal: null, ma20: null, ma60Exit: null,
      envelope: { center: 100, lower: 99, upper: 101, long: side === 'LONG', short: side === 'SHORT' } }] };
    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [document], settings, at, at + 86400, 86400);
    expect(state.entries).toBe(expected);
  });

  it.each(['LONG', 'SHORT'] as const)('does not apply the daily filter to %s 1h entries', side => {
    const long = side === 'LONG';
    const settings = { ...base, interval: '1h' as const, side };
    const document: PreparedSymbol = { symbol: 'BTCUSDT', bars: [{ candle: { openTime: at, closeTime: at + 3600,
      open: 100, high: long ? 103 : 101, low: long ? 99 : 97, close: 100, volume: 1 }, signal: null, ma20: null, ma60Exit: null,
      envelope: { center: 100, lower: 99, upper: 101, long, short: !long } }] };
    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, [document], settings, at, at + 3600, 3600);
    expect(state.entries).toBe(1);
  });
});
