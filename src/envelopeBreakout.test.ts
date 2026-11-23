import { describe, expect, it } from 'vitest';
import { intervalSeconds } from './api';
import { buildLocalChart, envelopeEntryMayTouch, prepareSymbolBlock, runBacktest } from './engine';
import { currentEnvelopeBreakoutSettings } from './envelope';
import { initialPortfolio, replayPortfolioBlock } from './portfolio';
import { minuteRows } from './test/envelopeFixtures';
import type { BacktestSettings, Candle } from './types';

const start = Date.UTC(2026, 1, 1) / 1000;
const defaults = currentEnvelopeBreakoutSettings({ interval: '1h', side: 'LONG', symbol: 'BTC',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1', envelopeMaPeriod: '1',
  envelopeDeviationPercent: '3', envelopeStopLossPercent: '20' } as BacktestSettings);
type Prices = [open: number, high: number, low: number, close: number];

function fixture(overrides: Record<number, Prices>, count: number, settings = defaults, warmup = 20) {
  const seconds = intervalSeconds(settings.interval);
  const candles: Candle[] = Array.from({ length: warmup + count }, (_, index) => {
    const offset = index - warmup;
    const [open, high, low, close] = overrides[offset] ?? [100, 100, 100, 100];
    const prices = settings.side === 'SHORT' ? [200 - open, 200 - low, 200 - high, 200 - close] : [open, high, low, close];
    return { openTime: start + offset * seconds, closeTime: start + (offset + 1) * seconds,
      open: prices[0]!, high: prices[1]!, low: prices[2]!, close: prices[3]!, volume: 1 };
  });
  const minutes = minuteRows(candles.slice(warmup));
  const end = start + count * seconds;
  const prepare = (lower?: Candle[]) => prepareSymbolBlock('BTCUSDT', candles, settings, 'ENVELOPE_BREAKOUT', start, end,
    undefined, undefined, undefined, undefined, undefined, undefined, lower);
  const replay = (until = end) => {
    const state = initialPortfolio(Number(settings.initialCapitalUsdt));
    replayPortfolioBlock(state, [prepare(minutes)], settings, start, until, seconds);
    return state;
  };
  return { candles, minutes, prepare, replay, seconds };
}

describe('first envelope breakout at the selected candle close', () => {
  it.each([['LONG', '1h'], ['SHORT', '4h'], ['LONG', '1d']] as const)('uses the midpoint for %s %s entry and only the later close for the band exit', (side, interval) => {
    const settings = { ...defaults, side, interval };
    const { candles, minutes, replay, seconds } = fixture({
      0: [100, 106, 100, 102], // Exactly half outside, even though the close is inside.
      1: [102, 106, 100, 106], // Midpoint and intrabar low return, but the close is outside.
      2: [106, 115, 105, 108], // Midpoint stays outside and the close returns.
    }, 3, settings);
    expect(replay(start + 2 * seconds)).toMatchObject({ entries: 1, closed: 0 });
    const result = runBacktest(candles, settings, 'ENVELOPE_BREAKOUT', undefined, undefined, undefined, undefined, undefined, minutes);
    expect(result.exitReasons).toEqual({ ENVELOPE_BREAKOUT_CLOSE: 1 });
    const trade = result.recentTrades[0]!;
    expect(trade).toMatchObject({ side, entryAt: start + seconds, exitAt: start + 3 * seconds,
      signal: { strategy: 'ENVELOPE_BREAKOUT', envelopeMaPeriod: 1 } });
    expect(trade.entryPrice).toBeCloseTo(side === 'LONG' ? 102 * 1.0002 : 98 * .9998, 9);
    expect(trade.exitPrice).toBeCloseTo(side === 'LONG' ? 108 * .9998 : 92 * 1.0002, 9);
    expect(trade.executions.map(fill => fill.timing)).toEqual(['BAR_CLOSE', 'BAR_CLOSE']);
    expect(buildLocalChart(result, trade, settings).envelope?.bands.find(band => band.openTime === start))
      .toMatchObject({ upper: 103, lower: 97 });
  });

  it('excludes breakouts in exactly the previous five candles and uses each candle’s own band', () => {
    const breakout: Prices = [100, 106, 100, 100];
    const current: Prices = [102, 110, 102, 105];
    const prior: Record<number, Prices> = { [-1]: [100, 102, 100, 102], 0: current };
    const blocked = fixture({ ...prior, [-5]: breakout }, 1);
    const blockedBar = blocked.prepare().bars[0]!;
    expect(blockedBar.envelope?.upper).toBeGreaterThan(105);
    expect(envelopeEntryMayTouch(blockedBar, defaults)).toBe(false);
    expect(blocked.replay().entries).toBe(0);
    expect(fixture({ ...prior, [-6]: breakout }, 1).replay().entries).toBe(1);
    expect(fixture({ ...prior, [-5]: [100, 105, 100, 100] }, 1).replay().entries).toBe(1);
    expect(fixture({ 0: breakout }, 1, defaults, 5).replay().entries).toBe(0);
  });

  it('does not buy a close above the upper band with less than half outside or exit exactly on the band', () => {
    expect(fixture({ 0: [100, 104, 100, 104] }, 1).replay().entries).toBe(0);
    const replay = fixture({ 0: [100, 106, 100, 100], 1: [100, 104, 99, 103] }, 2).replay();
    expect(replay).toMatchObject({ entries: 1, closed: 0 });
  });

  it.each(['LONG', 'SHORT'] as const)('keeps %s open on a band-return close until the enabled fixed TP fills', side => {
    const settings = { ...defaults, side, envelopeTakeProfitEnabled: true, envelopeTakeProfitPercent: '4' };
    const { replay, seconds } = fixture({ 0: [100, 108, 100, 104], 1: [104, 105, 100, 104], 2: [104, 111, 104, 104] }, 3, settings);
    expect(replay(start + 2 * seconds)).toMatchObject({ entries: 1, closed: 0 });
    const result = replay();
    expect(result.exitReasons).toEqual({ ENVELOPE_TP: 1 });
    const trade = result.trades[0]!;
    expect(trade.exitPrice).toBeCloseTo(trade.entryPrice * (side === 'LONG' ? 1.04 : .96), 9);
    expect(trade.priceLines?.map(line => line.kind)).toEqual(['ENTRY', 'SL', 'FIXED_TP', 'EXIT']);
  });

  it('keeps the fill-relative fixed stop active when TP replaces the band-return rule', () => {
    const settings = { ...defaults, envelopeStopLossPercent: '3', envelopeTakeProfitEnabled: true, envelopeTakeProfitPercent: '10' };
    const result = fixture({ 0: [100, 108, 100, 104], 1: [104, 105, 99, 104] }, 2, settings).replay();
    expect(result.exitReasons).toEqual({ SL: 1 });
    const trade = result.trades[0]!;
    expect(trade.signal.stop).toBeCloseTo(trade.entryPrice * .97, 9);
  });
});
