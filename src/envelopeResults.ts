/** Result selection is independent of replay: saved candidates can be filtered/sorted without new analysis. */
import type { EnvelopeStatisticsRow, DirectionalBests } from './envelopeStatistics';
import type { EnvelopeResultOptions } from './types';

export const defaultEnvelopeResultOptions: EnvelopeResultOptions = {
  minTrades: '2', minReturnPercent: '2', minProfitRatioPercent: '60', sort: 'returnPercent',
};
export const resultSortLabel = (options: EnvelopeResultOptions): string => options.sort === 'winRatePercent' ? '승률' : '수익률';
export function validateEnvelopeResultOptions(options: EnvelopeResultOptions): void {
  if (!/^\d+$/.test(options.minTrades) || !Number.isSafeInteger(Number(options.minTrades))) throw new Error('매매횟수는 0 이상의 정수로 입력해 주세요.');
  if (!/^-?\d+(\.\d+)?$/.test(options.minReturnPercent) || !Number.isFinite(Number(options.minReturnPercent))) throw new Error('최소 수익률을 숫자로 입력해 주세요.');
  if (!/^\d+(\.\d+)?$/.test(options.minProfitRatioPercent) || !Number.isFinite(Number(options.minProfitRatioPercent)) || Number(options.minProfitRatioPercent) > 100) throw new Error('최소수익비는 0~100%로 입력해 주세요.');
  if (!['returnPercent', 'winRatePercent'].includes(options.sort)) throw new Error('수익률·승률 정렬을 선택해 주세요.');
}
export function profitRatio(profit: number, loss: number): number | null {
  const total = profit + Math.abs(loss);
  return Number.isFinite(profit) && Number.isFinite(loss) && profit >= 0 && total > 0 ? profit / total * 100 : null;
}
export function matchesEnvelopeFilters(row: EnvelopeStatisticsRow, options = defaultEnvelopeResultOptions): boolean {
  return row.entryCount > 0 && row.entryCount >= Number(options.minTrades) && Number.isFinite(row.returnPercent)
    && row.returnPercent >= Number(options.minReturnPercent) && row.profitRatioPercent != null && Number.isFinite(row.profitRatioPercent)
    && row.profitRatioPercent >= Number(options.minProfitRatioPercent);
}
export function compareEnvelopeRows(a: EnvelopeStatisticsRow, b: EnvelopeStatisticsRow, options = defaultEnvelopeResultOptions): number {
  const other = options.sort === 'returnPercent' ? 'winRatePercent' : 'returnPercent';
  return (b[options.sort] ?? -Infinity) - (a[options.sort] ?? -Infinity)
    || (b[other] ?? -Infinity) - (a[other] ?? -Infinity)
    || (b.profitRatioPercent ?? -Infinity) - (a.profitRatioPercent ?? -Infinity)
    || b.entryCount - a.entryCount || a.maxDrawdownPercent - b.maxDrawdownPercent
    || a.maPeriod - b.maPeriod || a.deviationPercent - b.deviationPercent || (a.side ?? '').localeCompare(b.side ?? '');
}
export function selectedEnvelopeRows(rows: EnvelopeStatisticsRow[], options = defaultEnvelopeResultOptions): EnvelopeStatisticsRow[] {
  return rows.filter(row => matchesEnvelopeFilters(row, options)).sort((a, b) => compareEnvelopeRows(a, b, options));
}
export function envelopeBests(rows: EnvelopeStatisticsRow[], options = defaultEnvelopeResultOptions): { best: EnvelopeStatisticsRow | null; bestBySide: DirectionalBests } {
  const selected = selectedEnvelopeRows(rows, options);
  return { best: selected[0] ?? null, bestBySide: { LONG: selected.find(row => row.side === 'LONG') ?? null, SHORT: selected.find(row => row.side === 'SHORT') ?? null } };
}
export function betterFilteredEnvelopeSetting(row: EnvelopeStatisticsRow, previous?: EnvelopeStatisticsRow | null, options = defaultEnvelopeResultOptions): boolean {
  return matchesEnvelopeFilters(row, options) && (!previous || compareEnvelopeRows(row, previous, options) < 0);
}

/** ALL displays one winner per side. Keep the exact Pareto frontier for any lower-bound filter and either sort.
 * Never mix sides or discard a candidate that could win after a later filter change. */
export function retainEnvelopeCandidates(rows: EnvelopeStatisticsRow[]): EnvelopeStatisticsRow[] {
  const frontier: EnvelopeStatisticsRow[] = [];
  const dominates = (a: EnvelopeStatisticsRow, b: EnvelopeStatisticsRow): boolean => a.side === b.side
    && a.entryCount >= b.entryCount && a.returnPercent >= b.returnPercent
    && (a.profitRatioPercent ?? -Infinity) >= (b.profitRatioPercent ?? -Infinity)
    && (a.winRatePercent ?? -Infinity) >= (b.winRatePercent ?? -Infinity)
    && a.maxDrawdownPercent <= b.maxDrawdownPercent
    && compareEnvelopeRows(a, b) <= 0 && compareEnvelopeRows(a, b, { ...defaultEnvelopeResultOptions, sort: 'winRatePercent' }) <= 0;
  for (const row of rows) {
    if (!row.entryCount || row.profitRatioPercent == null || !Number.isFinite(row.profitRatioPercent)) continue;
    if (frontier.some(previous => dominates(previous, row))) continue;
    for (let index = frontier.length - 1; index >= 0; index -= 1) if (dominates(row, frontier[index]!)) frontier.splice(index, 1);
    frontier.push(row);
  }
  return frontier;
}
