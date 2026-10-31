import { describe, expect, it } from 'vitest';
import fixtures from './portfolio.fixtures.json';
import { prepareSymbolBlock, type PreparedSymbol } from './engine';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle, Signal, Strategy } from './types';

const origin = Date.UTC(2026, 0, 1) / 1000;
export const testSettings: BacktestSettings = {
  mode: 'ALL', symbol: 'AAA', interval: '15m', startDate: '2026-01-01', startTime: '09:00', endDate: '2026-01-04', endTime: '09:00',
  initialCapitalUsdt: '250', betAmountUsdt: '100', leverage: '3', side: 'BOTH', partialTpEnabled: false,
  fullTpWavePercent: '100', minDisparityPercent: '1.0', ma20HalfCloseEnabled: false, roiClosePercent: '100', minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1.0',
  volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
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

describe('legacy confirmed-close volatility replay compatibility', () => {
  const settings = { ...testSettings, leverage: '1', partialTpEnabled: true };
  function document(short: boolean, tail: number[][]): PreparedSymbol {
    const data = [
      ...Array.from({ length: 20 }, () => [100, 101, 99, 100]),
      [104, 105, 99, 100], [100, 110, 90, 105], [100, 140, 95, 115], ...tail,
    ];
    const rows = data.map((row, i) => candle(i, short ? [200 - row[0]!, 200 - row[2]!, 200 - row[1]!, 200 - row[3]!] : row));
    // Saved v2.10.29 signal snapshots must remain readable. New signal
    // preparation no longer creates these confirmed-close orders.
    const entry = rows[22]!;
    const signal: Signal = { strategy: 'VOLATILITY', side: short ? 'SHORT' : 'LONG', index: 22,
      entry: entry.close, stop: short ? entry.high : entry.low, target: short ? 65 : 135, initialTarget: short ? 65 : 135,
      breakoutRange: 20, volatilityK1: 0.5, volatilityK2: 1, volatilityStopEnabled: true, exitMode: 'VOLATILITY_CLOSE' };
    return { symbol: 'AAAUSDT', bars: rows.slice(22).map((candle, i) => ({ candle, signal: i === 0 ? signal : null, ma20: null, ma60Exit: null })) };
  }
  const start = origin + 22 * 900;

  it.each([false, true])('holds across bars and checkpoints until a later K1 close, short=%s', short => {
    const doc = document(short, [[115, 121, 100, 116], [115, 128, 114, 126]]);
    const state = initialPortfolio(250);
    replayPortfolioBlock(state, [doc], settings, start, start + 1800, 900);
    expect(state.entries).toBe(1);
    expect(state.closed).toBe(0);
    expect(state.positions.AAAUSDT?.partial).toBeNull();
    const saved = JSON.parse(JSON.stringify(state)) as typeof state;
    replayPortfolioBlock(saved, [doc], settings, start + 1800, start + 2700, 900);
    expect(saved.closed).toBe(1);
    expect(saved.exitReasons).toEqual({ VOLATILITY_CLOSE: 1 });
    const trade = saved.trades[0]!;
    const entry = short ? 85 * 0.9998 : 115 * 1.0002;
    const exit = short ? 74 * 1.0002 : 126 * 0.9998;
    const quantity = 100 / entry;
    const profit = (exit - entry) * quantity * (short ? -1 : 1);
    const totalFees = 0.055 + exit * quantity * 0.00055;
    expect(trade.entryPrice).toBeCloseTo(entry, 10);
    expect(trade.exitPrice).toBeCloseTo(exit, 10);
    expect(saved.realized).toBeCloseTo(profit - totalFees, 10);
    expect(saved.cash).toBeCloseTo(250 + profit - totalFees, 10);
    expect(trade.priceLines).toEqual([{ kind: 'ENTRY', price: entry }, { kind: 'SL', price: short ? 105 : 95 }, { kind: 'TP', price: entry + (short ? -20 : 20) }]);
    const whole = initialPortfolio(250);
    replayPortfolioBlock(whole, [doc], settings, start, start + 2700, 900);
    expect(saved).toEqual(whole);
  });

  it.each([false, true])('uses the full TP before a qualifying close, short=%s', short => {
    const doc = document(short, [[115, 140, 110, 130]]);
    const state = initialPortfolio(250);
    replayPortfolioBlock(state, [doc], settings, start, start + 1800, 900);
    const entry = short ? 85 * 0.9998 : 115 * 1.0002;
    expect(state.exitReasons).toEqual({ FULL_TP: 1 });
    expect(state.trades[0]?.exitPrice).toBeCloseTo(entry + (short ? -20 : 20), 10);
    expect(state.trades[0]?.executions.map(fill => fill.kind)).toEqual(['ENTRY', 'CLOSE']);
  });

  it.each([false, true])('includes the exact K1 close boundary but not a close just before it, short=%s', short => {
    const doc = document(short, [[115, 130, 100, 116], [115, 130, 100, 116]]);
    const entry = short ? 85 * 0.9998 : 115 * 1.0002;
    const threshold = entry + (short ? -10 : 10);
    doc.bars[1]!.candle.close = threshold + (short ? 0.00001 : -0.00001);
    doc.bars[2]!.candle.close = threshold;
    const state = initialPortfolio(250);
    replayPortfolioBlock(state, [doc], settings, start, start + 1800, 900);
    expect(state.closed).toBe(0);
    replayPortfolioBlock(state, [doc], settings, start + 1800, start + 2700, 900);
    expect(state.exitReasons).toEqual({ VOLATILITY_CLOSE: 1 });
  });

  it.each([false, true])('fills a TP crossed by the next opening gap, short=%s', short => {
    const doc = document(short, [[140, 145, 139, 141]]);
    const state = initialPortfolio(250);
    replayPortfolioBlock(state, [doc], settings, start, start + 1800, 900);
    expect(state.exitReasons).toEqual({ FULL_TP: 1 });
    expect(state.trades[0]?.exitAt).toBe(start + 900);
    expect(state.trades[0]?.executions.at(-1)?.at).toBe(start + 900);
  });

  it.each([false, true])('does not exit on a K1 wick, entry price or analysis end above the SL, short=%s', short => {
    const doc = document(short, [[115, 130, 96, 116]]);
    const state = initialPortfolio(250);
    replayPortfolioBlock(state, [doc], settings, start, start + 1800, 900);
    expect(state.closed).toBe(0);
    expect(state.positions.AAAUSDT?.executions).toHaveLength(1);
    expect(state.exitReasons).toEqual({});
    expect(portfolioResult(state, settings).openPositionCount).toBe(1);
  });

  it.each([false, true])('does not move the range or K1 threshold when later candles become larger, short=%s', short => {
    const doc = document(short, [[115, 130, 96, 116], [116, 128, 110, 126]]);
    const state = initialPortfolio(250);
    replayPortfolioBlock(state, [doc], settings, start, start + 2700, 900);
    expect(state.exitReasons).toEqual({ VOLATILITY_CLOSE: 1 });
    expect(state.trades[0]?.signal.breakoutRange).toBe(20);
  });

  it.each([false, true])('does not trigger SL on its already closed entry candle, short=%s', short => {
    const doc = document(short, []);
    const state = initialPortfolio(250);
    replayPortfolioBlock(state, [doc], settings, start, start + 900, 900);
    expect(state.entries).toBe(1);
    expect(state.closed).toBe(0);
    expect(state.positions.AAAUSDT?.stop).toBe(short ? 105 : 95);
    expect(state.positions.AAAUSDT?.executions).toHaveLength(1);
  });

  it.each([false, true])('includes an exact SL wick touch and applies market exit fees and slippage, short=%s', short => {
    const doc = document(short, [[115, 120, 95, 116]]);
    const state = initialPortfolio(250);
    replayPortfolioBlock(state, [doc], settings, start, start + 1800, 900);
    const entry = short ? 85 * 0.9998 : 115 * 1.0002;
    const stop = short ? 105 : 95;
    const exit = stop * (short ? 1.0002 : 0.9998);
    const quantity = 100 / entry;
    const gross = (exit - entry) * quantity * (short ? -1 : 1);
    const fees = 0.055 + exit * quantity * 0.00055;
    expect(state.exitReasons).toEqual({ SL: 1 });
    expect(state.closed).toBe(1);
    expect(state.losses).toBe(1);
    expect(state.trades[0]?.exitPrice).toBeCloseTo(exit, 10);
    expect(state.cash).toBeCloseTo(250 + gross - fees, 10);
    expect(state.fees).toBeCloseTo(fees, 10);
    expect(state.trades[0]?.priceLines).toContainEqual({ kind: 'SL', price: stop });
    expect(state.trades[0]?.executions.map(fill => fill.kind)).toEqual(['ENTRY', 'CLOSE']);
  });

  it.each([false, true])('prefers SL when the same candle also touches TP or qualifies for a K1 close, short=%s', short => {
    for (const high of [130, 140]) {
      const doc = document(short, [[115, high, 90, 126]]);
      const state = initialPortfolio(250);
      replayPortfolioBlock(state, [doc], settings, start, start + 1800, 900);
      expect(state.exitReasons).toEqual({ SL: 1 });
      expect(state.trades[0]?.exitPrice).toBeCloseTo(short ? 105 * 1.0002 : 95 * 0.9998, 10);
    }
  });

  it.each([false, true])('fills a stop gap at opening price and preserves the entry candle SL across checkpoints, short=%s', short => {
    const doc = document(short, [[115, 120, 96, 116], [90, 100, 85, 96]]);
    const state = initialPortfolio(250);
    replayPortfolioBlock(state, [doc], settings, start, start + 1800, 900);
    const saved = JSON.parse(JSON.stringify(state)) as typeof state;
    expect(saved.positions.AAAUSDT?.stop).toBe(short ? 105 : 95);
    replayPortfolioBlock(saved, [doc], settings, start + 1800, start + 2700, 900);
    expect(saved.exitReasons).toEqual({ SL: 1 });
    expect(saved.trades[0]?.exitPrice).toBeCloseTo(short ? 110 * 1.0002 : 90 * 0.9998, 10);
    expect(saved.trades[0]?.exitAt).toBe(start + 1800);
    expect(saved.trades[0]?.priceLines).toContainEqual({ kind: 'SL', price: short ? 105 : 95 });
  });

  it.each([false, true])('does not turn a legacy pre-SL entry placeholder into a real stop or chart line, short=%s', short => {
    const doc = document(short, [[115, 130, 80, 116], [116, 128, 110, 126]]);
    const signal = doc.bars[0]!.signal!;
    delete signal.volatilityStopEnabled;
    signal.stop = signal.entry;
    const state = initialPortfolio(250);
    replayPortfolioBlock(state, [doc], settings, start, start + 2700, 900);
    expect(state.exitReasons).toEqual({ VOLATILITY_CLOSE: 1 });
    expect(state.trades[0]?.priceLines?.some(line => line.kind === 'SL')).toBe(false);
  });
});
