import { describe, expect, it } from 'vitest';
import { validateMinuteCandles } from './intrabar';
import { initialPortfolio, replayPortfolioBlock } from './portfolio';
import type { PreparedBar, PreparedSymbol } from './engine';
import type { BacktestSettings, Candle, Signal } from './types';

const origin = Date.UTC(2026, 0, 1) / 1000;
const settings: BacktestSettings = {
  mode: 'ALL', symbol: 'AAA', interval: '1h', side: 'BOTH', startDate: '2026-01-01', startTime: '09:00', endDate: '', endTime: '00:00',
  initialCapitalUsdt: '101', betAmountUsdt: '100', leverage: '1', partialTpEnabled: false, fullTpWavePercent: '100',
  minDisparityPercent: '1', ma20HalfCloseEnabled: false, roiClosePercent: '100', minVolatilityPercent: '0.5',
  volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
};
function candle(at: number, p: number[], seconds = 3600): Candle {
  return { openTime: at, closeTime: at + seconds, open: p[0]!, high: p[1]!, low: p[2]!, close: p[3]!, volume: 10 };
}
function bar(at = origin, high = 125): PreparedBar {
  const parent = candle(at, [100, high, 95, 112]);
  const minutes = Array.from({ length: 60 }, (_, i) => candle(at + i * 60,
    i === 0 ? [100, 106, 95, 106] : i === 1 ? [106, high, 105, 112] : [112, 112, 112, 112], 60));
  const signal: Signal = { strategy: 'VOLATILITY', side: 'LONG', index: at / 3600, entry: 110, stop: 100, target: 120, initialTarget: 120,
    breakoutRange: 20, breakoutLevel: 110, volatilityK1: 0.5, volatilityK2: 1, volatilityPriorExtreme: 90, volatilityEntryLimit: 120,
    volatilityStopEnabled: true, volatilityTpEnabled: true, volatilityNextCloseEnabled: false, exitMode: 'VOLATILITY_TP' };
  return { candle: parent, signal, ma20: null, ma60Exit: null, intrabarCandles: minutes };
}

describe('1-minute ordering validation', () => {
  it('requires full ordered coverage and matching parent OHLC', () => {
    const original = bar();
    expect(() => validateMinuteCandles(original.candle, original.intrabarCandles!)).not.toThrow();
    expect(() => validateMinuteCandles(original.candle, original.intrabarCandles!.slice(1))).toThrow('1분봉');
    expect(() => validateMinuteCandles(original.candle, [...original.intrabarCandles!].reverse())).toThrow('1분봉');
    expect(() => validateMinuteCandles({ ...original.candle, high: 130 }, original.intrabarCandles!)).toThrow('일치');
  });
  it('refuses a missing minute series instead of using coarse OHLC implicitly', () => {
    const original = bar(); delete original.intrabarCandles;
    expect(() => replayPortfolioBlock(initialPortfolio(101), [{ symbol: 'AAAUSDT', bars: [original] }], settings, origin, origin + 3600, 3600)).toThrow('1분봉');
  });
});

describe('causal 1-minute entry and fixed stop', () => {
  it('keeps earlier minute lows as SL, not the later wick or the entry minute open', () => {
    const state = initialPortfolio(101);
    replayPortfolioBlock(state, [{ symbol: 'AAAUSDT', bars: [bar(origin, 115)] }], settings, origin, origin + 3600, 3600);
    expect(state.positions.AAAUSDT?.stop).toBe(95);
    expect(state.positions.AAAUSDT?.first).toBeCloseTo(110.022, 10);
    expect(state.positions.AAAUSDT?.executions[0]).toMatchObject({ at: origin + 60, candleOpenAt: origin, timing: 'INTRABAR' });
  });
  it('does not use a later low below the previous wick to cancel an already completed TP', () => {
    const document = bar(); document.candle.low = 85;
    document.intrabarCandles![2] = candle(origin + 120, [112, 112, 85, 112], 60);
    const state = initialPortfolio(101);
    replayPortfolioBlock(state, [{ symbol: 'AAAUSDT', bars: [document] }], settings, origin, origin + 3600, 3600);
    expect(state.exitReasons).toEqual({ FULL_TP: 1 });
    expect(state.trades[0]?.signal.stop).toBe(95);
  });
  it('fills a minute opening gap at observed price if it is within K2', () => {
    const document = bar(origin, 115);
    document.intrabarCandles![1] = candle(origin + 60, [111, 115, 111, 112], 60);
    const state = initialPortfolio(101);
    replayPortfolioBlock(state, [{ symbol: 'AAAUSDT', bars: [document] }], settings, origin, origin + 3600, 3600);
    expect(state.positions.AAAUSDT?.first).toBeCloseTo(111 * 1.0002, 10);
    expect(state.positions.AAAUSDT?.signal.breakoutLevel).toBe(110);
  });
  it('does not chase an opening gap beyond K2, even if price later returns', () => {
    const document = bar();
    document.intrabarCandles![1] = candle(origin + 60, [121, 125, 105, 112], 60);
    const state = initialPortfolio(101);
    replayPortfolioBlock(state, [{ symbol: 'AAAUSDT', bars: [document] }], settings, origin, origin + 3600, 3600);
    expect(state.entries).toBe(0);
  });
});

describe('shared intrabar account chronology', () => {
  it('does not recycle same-bar TP proceeds into another unknown earlier touch', () => {
    const state = initialPortfolio(101);
    const documents: PreparedSymbol[] = [{ symbol: 'ZZZUSDT', bars: [bar()] }, { symbol: 'AAAUSDT', bars: [bar()] }];
    replayPortfolioBlock(state, documents, settings, origin, origin + 3600, 3600);
    expect(state.entries).toBe(1); expect(state.closed).toBe(1); expect(state.insufficientFunds).toBe(1);
    expect(state.trades[0]?.symbol).toBe('AAAUSDT'); expect(state.cash).toBeGreaterThan(101);
  });
  it('does not finance a new touch with a holding closed later in the same parent candle', () => {
    const state = initialPortfolio(101);
    replayPortfolioBlock(state, [{ symbol: 'AAAUSDT', bars: [bar(origin, 115)] }], settings, origin, origin + 3600, 3600);
    const next: PreparedBar = { candle: candle(origin + 3600, [112, 125, 110, 114]), signal: null, ma20: null, ma60Exit: null };
    replayPortfolioBlock(state, [{ symbol: 'AAAUSDT', bars: [next] }, { symbol: 'ZZZUSDT', bars: [bar(origin + 3600)] }], settings, origin + 3600, origin + 7200, 3600);
    expect(state.closed).toBe(1); expect(state.entries).toBe(1); expect(state.insufficientFunds).toBe(1);
  });
  it('does not exit a holding and retroactively re-enter it at an earlier touch', () => {
    const state = initialPortfolio(101);
    replayPortfolioBlock(state, [{ symbol: 'AAAUSDT', bars: [bar(origin, 115)] }], settings, origin, origin + 3600, 3600);
    replayPortfolioBlock(state, [{ symbol: 'AAAUSDT', bars: [bar(origin + 3600)] }], settings, origin + 3600, origin + 7200, 3600);
    expect(state.entries).toBe(1); expect(state.closed).toBe(1);
  });
});
