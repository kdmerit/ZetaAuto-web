import { describe, expect, it } from 'vitest';
import type { PreparedSymbol } from './engine';
import { initialPortfolio, portfolioEquity, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestSettings, Candle } from './types';

const origin = Date.UTC(2026, 0, 1) / 1000;
const day = 86400;
const settings: BacktestSettings = { mode: 'ALL', symbol: 'AAA', interval: '1d', startDate: '2026-01-01', startTime: '09:00', endDate: '2026-01-04', endTime: '09:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1', side: 'BOTH', partialTpEnabled: false,
  fullTpWavePercent: '100', minDisparityPercent: '1', ma20HalfCloseEnabled: false, roiClosePercent: '100', minVolatilityPercent: '0.5',
  volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
  envelopeDeviationPercent: '3', envelopeMaPeriod: '3', envelopeMa20Enabled: false, envelopeSideRatio50Enabled: true };

function document(symbol: string, side: 'LONG' | 'SHORT', entryAt = 0, overrides: Record<number, number[]> = {}, blocks = 1): PreparedSymbol {
  const entry = side === 'LONG' ? 97 : 103;
  const children: Candle[] = Array.from({ length: blocks * 96 }, (_, index) => {
    const price = index < entryAt || index % 96 === 95 ? 100 : entry;
    const row = overrides[index] ?? [price, price, price, price];
    return { openTime: origin + index * 900, closeTime: origin + (index + 1) * 900,
      open: row[0]!, high: row[1]!, low: row[2]!, close: row[3]!, volume: 10 };
  });
  return { symbol, bars: Array.from({ length: blocks }, (_, index) => {
    const rows = children.slice(index * 96, (index + 1) * 96);
    return { candle: { ...rows[0]!, closeTime: rows.at(-1)!.closeTime, high: Math.max(...rows.map(row => row.high)), low: Math.min(...rows.map(row => row.low)), close: rows.at(-1)!.close },
      signal: null, ma20: null, ma60Exit: null,
      envelope: { center: 100, lower: 97, upper: 103, long: side === 'LONG', short: side === 'SHORT' }, envelopeIntrabarCandles: rows };
  }) };
}

function replay(documents: PreparedSymbol[], input = settings, amounts: Record<string, number> = {}) {
  const state = initialPortfolio(Number(input.initialCapitalUsdt));
  const options = { settingsForSymbol: Object.fromEntries(Object.entries(amounts).map(([symbol, bet]) => [symbol, { ...input, betAmountUsdt: String(bet) }])) };
  replayPortfolioBlock(state, documents, input, origin, documents[0]!.bars.at(-1)!.candle.closeTime, day, options);
  return { state, options };
}

describe('envelope 50 percent direction allocation', () => {
  it.each(['LONG', 'SHORT'] as const)('caps simultaneous %s buys at five 100 USDT positions', side => {
    const documents = Array.from({ length: 6 }, (_, index) => document(`COIN${index}USDT`, side));
    const { state } = replay(documents);
    expect(state.entries).toBe(5);
    expect(Object.keys(state.positions)).toHaveLength(5);
    expect(state.positions.COIN5USDT).toBeUndefined();
    const uncapped = replay(documents, { ...settings, envelopeSideRatio50Enabled: false }).state;
    expect(uncapped.entries).toBe(6);
  });

  it('blocks an order that would exceed the cap while independently allowing the opposite side', () => {
    const { state } = replay([document('AAAUSDT', 'LONG'), document('BBBUSDT', 'LONG'), document('CCCUSDT', 'SHORT')], settings,
      { AAAUSDT: 400, BBBUSDT: 200, CCCUSDT: 200 });
    expect(Object.keys(state.positions)).toEqual(['AAAUSDT', 'CCCUSDT']);
    expect(state.positions.AAAUSDT!.margin).toBe(400);
    expect(state.positions.CCCUSDT!.margin).toBe(200);
  });

  it('rejects a first buy larger than half the account instead of resizing it', () => {
    const { state } = replay([document('AAAUSDT', 'LONG')], settings, { AAAUSDT: 600 });
    expect(state.entries).toBe(0);
    expect(state.cash).toBe(1000);
  });

  it('blocks further buys when the direction is already exactly 50 percent', () => {
    const quotes = Object.fromEntries(Array.from({ length: 96 }, (_, index) => [96 + index, [100, 100, 100, 100]]));
    const documents = [document('AAAUSDT', 'LONG', 0, quotes, 2), document('BBBUSDT', 'LONG', 96, {}, 2)];
    const options = { settingsForSymbol: { AAAUSDT: { ...settings, betAmountUsdt: '400' }, BBBUSDT: { ...settings, betAmountUsdt: '1' } } };
    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, documents, settings, origin, origin + day, day, options);
    const allocated = portfolioEquity(state) - state.cash;
    state.cash = allocated;
    expect(allocated / portfolioEquity(state)).toBeCloseTo(0.5, 12);
    replayPortfolioBlock(state, documents, settings, origin + day, origin + 2 * day, day, options);
    expect(state.positions.BBBUSDT).toBeUndefined();
    expect(state.positions.AAAUSDT).toBeDefined();
  });

  it('applies the limit to directional settings used by virtual portfolio evaluation', () => {
    const documents = [document('AAAUSDT', 'LONG'), document('BBBUSDT', 'LONG'), document('CCCUSDT', 'SHORT')];
    for (const data of documents) for (const bar of data.bars) {
      const band = bar.envelope!;
      bar.envelopeBySide = band.long ? { LONG: band } : { SHORT: band };
      delete bar.envelope;
    }
    const state = initialPortfolio(1000);
    replayPortfolioBlock(state, documents, settings, origin, origin + day, day, { settingsForSymbolSide: {
      AAAUSDT: { LONG: { ...settings, side: 'LONG', betAmountUsdt: '400' } },
      BBBUSDT: { LONG: { ...settings, side: 'LONG', betAmountUsdt: '200' } },
      CCCUSDT: { SHORT: { ...settings, side: 'SHORT', betAmountUsdt: '200' } },
    } });
    expect(Object.keys(state.positions)).toEqual(['AAAUSDT', 'CCCUSDT']);
  });

  it.each([1, 10, 100])('uses position equity rather than contract notional at %sx leverage', leverage => {
    const { state } = replay([document('AAAUSDT', 'LONG')], { ...settings, leverage: String(leverage) }, { AAAUSDT: 400 });
    expect(state.entries).toBe(1);
    expect(state.positions.AAAUSDT!.margin).toBe(400);
  });

  it('allocates to the earlier 15m signal even when its symbol sorts last', () => {
    const { state } = replay([document('AAAUSDT', 'LONG', 3), document('ZZZUSDT', 'LONG', 0)], settings, { AAAUSDT: 400, ZZZUSDT: 400 });
    expect(Object.keys(state.positions)).toEqual(['ZZZUSDT']);
  });

  it('does not free direction capacity with a future exit, but permits buys after that exit', () => {
    const onlyAt = (index: number): Record<number, number[]> => Object.fromEntries(Array.from({ length: 96 }, (_, at) => [at, at === index ? [100, 100, 97, 100] : [100, 100, 100, 100]]));
    const { state } = replay([
      document('AAAUSDT', 'LONG', 0, { 1: [97, 98, 97, 98], 2: [98, 103, 98, 103] }),
      document('BBBUSDT', 'LONG', 1, onlyAt(1)),
      document('CCCUSDT', 'LONG', 3, onlyAt(3)),
    ], settings, { AAAUSDT: 400, BBBUSDT: 200, CCCUSDT: 200 });
    expect(state.entries).toBe(2);
    expect(state.trades[0]).toMatchObject({ symbol: 'AAAUSDT', reason: 'ENVELOPE_OPPOSITE', exitAt: origin + 1800 });
    expect(state.positions.BBBUSDT).toBeUndefined();
    expect(state.positions.CCCUSDT).toBeDefined();
  });

  it.each([true, false])('uses unrealized PnL at the buy time instead of the daily close, earlier profit=%s', earlierProfit => {
    const at = earlierProfit ? 1 : 2;
    const changes: Record<number, number[]> = { [at]: [102, 102, 102, 102] };
    const quote = Object.fromEntries(Array.from({ length: 96 }, (_, index) => [index, index === 1 ? [97, 97, 97, 97] : [100, 100, 100, 100]]));
    const { state } = replay([document('AAAUSDT', 'LONG', 0, changes), document('BBBUSDT', 'LONG', 1, quote)], settings, { AAAUSDT: 490, BBBUSDT: 1 });
    expect(!!state.positions.BBBUSDT).toBe(!earlierProfit);
    expect(state.positions.AAAUSDT).toBeDefined();
  });

  it('preserves the allocation and center-touch state over a checkpoint', () => {
    const input = { ...settings, envelopeCloseOnCenterReturn: true };
    const documents = [document('AAAUSDT', 'LONG', 0, {}, 2), document('BBBUSDT', 'LONG', 100, {}, 2)];
    const { state: whole, options } = replay(documents, input, { AAAUSDT: 400, BBBUSDT: 200 });
    const first = initialPortfolio(1000);
    replayPortfolioBlock(first, documents, input, origin, origin + day, day, options);
    expect(first.positions.AAAUSDT!.envelopeCenterTouched).toBe(true);
    const resumed: typeof first = JSON.parse(JSON.stringify(first));
    replayPortfolioBlock(resumed, documents, input, origin + day, origin + 2 * day, day, options);
    expect(portfolioResult(resumed, input)).toEqual(portfolioResult(whole, input));
    expect(resumed.positions).toEqual(whole.positions);
  });

  it('requires complete 15m data for allocation rather than using a daily OHLC guess', () => {
    const data = document('AAAUSDT', 'LONG');
    delete data.bars[0]!.envelopeIntrabarCandles;
    expect(() => replay([data])).toThrow('15분봉');
  });
});
