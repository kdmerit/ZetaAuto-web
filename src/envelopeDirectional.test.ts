import { describe, expect, it } from 'vitest';
import { prepareSymbolBlock } from './engine';
import { currentEnvelopeSettings } from './envelope';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle } from './types';

const origin = Date.UTC(2026, 1, 1) / 1000;
const base = currentEnvelopeSettings({ mode: 'SINGLE', symbol: 'BTC', interval: '1h', side: 'BOTH', initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1', envelopeMaPeriod: '20', envelopeDeviationPercent: '1' } as BacktestSettings);
function candles(): Candle[] {
  return [...Array.from({ length: 60 }, (_, index) => ({ openTime: origin + index * 3600, closeTime: origin + (index + 1) * 3600, open: 100, high: 100, low: 100, close: 100, volume: 1 })),
    { openTime: origin + 60 * 3600, closeTime: origin + 61 * 3600, open: 100.5, high: 102, low: 100, close: 102, volume: 1 }];
}

describe('direction-specific envelope breakout conditions', () => {
  it('does not enter a short when a candle only breaks the upper band', () => {
    const settings = { ...base, side: 'SHORT' as const };
    const rows = candles(); const document = prepareSymbolBlock('BTCUSDT', rows, settings, 'ENVELOPE', rows[60]!.openTime, rows.at(-1)!.closeTime);
    const state = initialPortfolio(1000); replayPortfolioBlock(state, [document], settings, rows[60]!.openTime, rows.at(-1)!.closeTime, 3600);
    expect(portfolioResult(state, settings).entryCount).toBe(0);
  });

  it('does not enter a long when MA ordering is not bullish', () => {
    const settings = { ...base, side: 'LONG' as const }; const rows = candles(); rows[60] = { ...rows[60]!, close: 102, open: 100.5 };
    // The market data itself is valid, but this fixture is replaced with a
    // falling history so MA5 is no longer above the slower averages.
    for (let index = 0; index < 60; index += 1) rows[index] = { ...rows[index]!, close: 100 + (60 - index) * 0.1, open: 100 + (60 - index) * 0.1 };
    const document = prepareSymbolBlock('BTCUSDT', rows, settings, 'ENVELOPE', rows[60]!.openTime, rows.at(-1)!.closeTime);
    const state = initialPortfolio(1000); replayPortfolioBlock(state, [document], settings, rows[60]!.openTime, rows.at(-1)!.closeTime, 3600);
    expect(portfolioResult(state, settings).entryCount).toBe(0);
  });
});
