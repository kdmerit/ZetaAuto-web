import { describe, expect, it } from 'vitest';
import fixtures from './portfolio.fixtures.json';
import { prepareSymbolBlock, type PreparedSymbol } from './engine';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle, Signal, Strategy } from './types';

const origin = Date.UTC(2026, 0, 1) / 1000;
export const testSettings: BacktestSettings = {
  mode: 'ALL', symbol: 'AAA', interval: '15m', startDate: '2026-01-01', startTime: '09:00', endDate: '2026-01-04', endTime: '09:00',
  initialCapitalUsdt: '250', betAmountUsdt: '100', leverage: '3', side: 'BOTH', partialTpEnabled: false,
  fullTpWavePercent: '100', minDisparityPercent: '1.0', ma20HalfCloseEnabled: false, roiClosePercent: '100', volatilityK: '0.5',
};

function candle(index: number, row = [100, 101, 99, 100]): Candle {
  return { openTime: origin + index * 900, closeTime: origin + (index + 1) * 900, open: row[0]!, high: row[1]!, low: row[2]!, close: row[3]!, volume: 10 };
}

describe('local shared portfolio', () => {
  // These totals were produced independently by the deployed Python strategy/Decimal replay.
  it.each(fixtures)('matches server $strategy, mirrored=$short, partial=$partial', fixture => {
    const rows = [...Array.from({ length: fixture.count }, () => fixture.warmup), ...fixture.tail]
      .map((row, index) => candle(index, fixture.short ? [200 - row[0]!, 200 - row[2]!, 200 - row[1]!, 200 - row[3]!] : row));
    const settings = { ...testSettings, partialTpEnabled: fixture.partial };
    const start = rows[fixture.count]!.openTime;
    const end = rows.at(-1)!.closeTime;
    const document = prepareSymbolBlock('AAAUSDT', rows, settings, fixture.strategy as Strategy, start, end);
    const state = initialPortfolio(250);
    replayPortfolioBlock(state, [document], settings, start, end, 900);
    const result = portfolioResult(state, settings);
    for (const [key, value] of Object.entries(fixture.expected)) {
      const actual = result[key as keyof typeof result];
      if (typeof value === 'string') expect(actual, key).toBeCloseTo(Number(value), 5);
      else expect(actual, key).toEqual(value);
    }
    const resumed = initialPortfolio(250);
    const middle = rows.at(-2)!.openTime;
    replayPortfolioBlock(resumed, [document], settings, start, middle, 900);
    const saved = JSON.parse(JSON.stringify(resumed)) as typeof resumed;
    replayPortfolioBlock(saved, [document], settings, middle, end, 900);
    expect(portfolioResult(saved, settings)).toEqual(result);
  });

  it('shares capital across simultaneous symbols and closes positions before allocating new funds', () => {
    const signal: Signal = { strategy: 'DISPARITY', index: 0, side: 'LONG', entry: 100, stop: 90, target: 120, initialTarget: 120 };
    const doc = (symbol: string): PreparedSymbol => ({ symbol, bars: [
      { candle: candle(0), signal, ma20: 95, ma60Exit: 120 },
      { candle: candle(1, [100, 125, 99, 121]), signal, ma20: 95, ma60Exit: 120 },
    ] });
    const settings = { ...testSettings, initialCapitalUsdt: '101', leverage: '1' };
    const state = initialPortfolio(101);
    replayPortfolioBlock(state, [doc('ZZZUSDT'), doc('AAAUSDT')], settings, origin, origin + 1800, 900);
    expect(state.trades[0]?.symbol).toBe('AAAUSDT');
    expect(state.closed).toBe(1);
    expect(state.entries).toBe(2);
    expect(state.insufficientFunds).toBe(2);
    expect(Object.keys(state.positions)).toEqual(['AAAUSDT']);
  });

  it('preserves long wave extrema across a checkpoint beyond the warm-up window', () => {
    const fixture = fixtures[0]!;
    const raw = [...Array.from({ length: fixture.count }, () => fixture.warmup), ...fixture.tail];
    raw.splice(65, 0, ...Array.from({ length: 350 }, () => [112, 115, 109, 110]));
    const rows = raw.map((row, index) => candle(index, row));
    const whole = prepareSymbolBlock('AAAUSDT', rows, testSettings, 'PULLBACK', origin, rows.at(-1)!.closeTime);
    const cut = rows[380]!.openTime;
    const first = prepareSymbolBlock('AAAUSDT', rows.slice(0, 380), testSettings, 'PULLBACK', origin, cut);
    const second = prepareSymbolBlock('AAAUSDT', rows.slice(180), testSettings, 'PULLBACK', cut, rows.at(-1)!.closeTime, JSON.parse(JSON.stringify(first.waveState)));
    expect(second.bars.map(bar => bar.signal)).toEqual(whole.bars.filter(bar => bar.candle.openTime >= cut).map(bar => bar.signal));
    expect(second.waveState?.LONG.previousPrevious?.tailLow).toBe(98);
    expect(second.waveState?.LONG.previousPrevious?.startTime).toBeLessThan(rows[180]!.openTime);
  });
});
