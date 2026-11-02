import { describe, expect, it } from 'vitest';
import { compareEnvelopeRows, defaultEnvelopeResultOptions, envelopeBests, matchesEnvelopeFilters, profitRatio, retainEnvelopeCandidates, selectedEnvelopeRows, validateEnvelopeResultOptions } from './envelopeResults';
import type { EnvelopeStatisticsRow } from './envelopeStatistics';

const row: EnvelopeStatisticsRow = { side: 'LONG', interval: '1h', maPeriod: 5, deviationPercent: 1, exitMode: 'OPPOSITE', entryCount: 10, closedTradeCount: 10, winCount: 6, lossCount: 4,
  winRatePercent: 60, returnPercent: 10, profitRatioPercent: 80, winningProfitUsdt: 80, losingLossUsdt: 20, profitUsdt: 60, realizedProfitUsdt: 60, feesUsdt: 1, maxDrawdownPercent: 1, openPositionCount: 0 };
const options = { minTrades: '10', minReturnPercent: '10', minProfitRatioPercent: '80', sort: 'returnPercent' as const };

describe('user result filters and optimal-setting ordering', () => {
  it('uses the final profit share formula, not signed net profit, return, trade counts or profit factor', () => {
    expect(profitRatio(80, 20)).toBe(80); expect(profitRatio(35, -65)).toBe(35); expect(profitRatio(35, 65)).toBe(35);
    expect(profitRatio(0, 10)).toBe(0); expect(profitRatio(10, 0)).toBe(100); expect(profitRatio(0, 0)).toBeNull();
    expect(profitRatio(Infinity, 1)).toBeNull(); expect(profitRatio(-1, 10)).toBeNull();
  });
  it('requires all three inclusive lower bounds and excludes uncomputed or nonfinite ratios', () => {
    expect(matchesEnvelopeFilters(row, options)).toBe(true);
    for (const failed of [{ entryCount: 9 }, { returnPercent: 9.99999 }, { profitRatioPercent: 79.99999 }, { profitRatioPercent: null }, { profitRatioPercent: NaN }, { returnPercent: -30 }]) {
      expect(matchesEnvelopeFilters({ ...row, ...failed }, options)).toBe(false);
    }
    expect(matchesEnvelopeFilters({ ...row, winRatePercent: 40 }, options)).toBe(true); // No hidden old 60% win-rate gate.
    expect(selectedEnvelopeRows([{ ...row, entryCount: 9 }, row], options)).toEqual([row]);
  });
  it('changes directional optimal settings when sorting switches from return to win rate, after filtering', () => {
    const maximumReturn = { ...row, maPeriod: 5, returnPercent: 40, winRatePercent: 60 };
    const maximumWin = { ...row, maPeriod: 120, returnPercent: 12, winRatePercent: 95 };
    const excluded = { ...row, returnPercent: 100, winRatePercent: 100, profitRatioPercent: 79 };
    const short = { ...row, side: 'SHORT' as const, returnPercent: 20, winRatePercent: 80 };
    const rows = [maximumReturn, maximumWin, excluded, short];
    expect(envelopeBests(rows, options).bestBySide).toEqual({ LONG: maximumReturn, SHORT: short });
    const sorted = { ...options, sort: 'winRatePercent' as const };
    expect(envelopeBests(rows, sorted)).toEqual({ best: maximumWin, bestBySide: { LONG: maximumWin, SHORT: short } });
    expect(selectedEnvelopeRows(rows, sorted).map(value => value.winRatePercent)).toEqual([95, 80, 60]);
  });
  it('returns empty winners instead of a fallback setting when filters exclude everything', () => {
    expect(envelopeBests([row], { ...options, minTrades: '11' })).toEqual({ best: null, bestBySide: { LONG: null, SHORT: null } });
    expect(matchesEnvelopeFilters({ ...row, entryCount: 0, profitRatioPercent: null }, { ...options, minTrades: '0' })).toBe(false);
  });
  it('validates editable input independently, allowing negative return thresholds but only 0–100 profit share', () => {
    expect(() => validateEnvelopeResultOptions({ ...options, minTrades: '0', minReturnPercent: '-100', minProfitRatioPercent: '0' })).not.toThrow();
    for (const invalid of [{ minTrades: '' }, { minTrades: '-1' }, { minTrades: '1.5' }, { minReturnPercent: 'Infinity' }, { minProfitRatioPercent: '-30' }, { minProfitRatioPercent: '101' }, { sort: 'entryCount' }]) {
      expect(() => validateEnvelopeResultOptions({ ...options, ...invalid } as typeof options)).toThrow();
    }
  });
  it('uses deterministic tie-breakers without changing the selected primary metric', () => {
    expect(compareEnvelopeRows({ ...row, maxDrawdownPercent: 0 }, row, options)).toBeLessThan(0);
    expect(compareEnvelopeRows({ ...row, winRatePercent: 50, returnPercent: 11 }, row, options)).toBeLessThan(0);
  });
  it('retains exact possible ALL winners for either ordering and arbitrary later thresholds, separately by side', () => {
    let seed = 593;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const rows = Array.from({ length: 150 }, (_, index) => ({ ...row, side: index % 2 ? 'LONG' as const : 'SHORT' as const,
      maPeriod: [5, 10, 20, 40, 60, 80, 100, 120][index % 8]!, deviationPercent: index / 10,
      entryCount: Math.floor(next() * 50), returnPercent: next() * 50 - 10, winRatePercent: next() * 100, profitRatioPercent: next() * 100, maxDrawdownPercent: next() * 10 }));
    const retained = retainEnvelopeCandidates(rows);
    expect(retained.length).toBeLessThan(rows.length);
    for (const sort of ['returnPercent', 'winRatePercent'] as const) for (const trades of [0, 10, 30]) for (const roi of [-10, 2, 10, 30]) for (const ratio of [0, 50, 80]) {
      const filter = { ...defaultEnvelopeResultOptions, sort, minTrades: String(trades), minReturnPercent: String(roi), minProfitRatioPercent: String(ratio) };
      expect(envelopeBests(retained, filter)).toEqual(envelopeBests(rows, filter));
    }
  });
});
