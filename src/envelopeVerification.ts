import { readValue, retentionMs } from './database';
import type { EnvelopeStatisticsRow } from './envelopeStatistics';
import type { BacktestSettings, EnvelopeResultOptions } from './types';

export type VerificationDirection = 'PAST' | 'FUTURE';
export type VerificationSource = 'SINGLE_STATS';
export interface VerificationTarget {
  source: VerificationSource;
  sourceId: string;
  direction: VerificationDirection;
}

export interface VerificationRequest extends VerificationTarget {
  months: number;
  resultOptions: EnvelopeResultOptions;
  resumeId?: string;
}

export interface VerificationMonth { start: number; end: number }
export interface VerificationPlan {
  windows: VerificationMonth[];
  earliest: number;
  limit: 'HISTORY' | 'PRESENT' | null;
}

const koreaOffset = 9 * 3600;

function shiftMonths(timestamp: number, months: number): number {
  const date = new Date((timestamp + koreaOffset) * 1000);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.getTime() / 1000 - koreaOffset;
}

export function parseVerificationMonths(value: string): number {
  const months = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(months) || months < 1) {
    throw new Error('검증할 개월 수를 1 이상의 정수로 입력해 주세요.');
  }
  return months;
}

export function planEnvelopeVerification(
  settings: Pick<BacktestSettings, 'startDate' | 'startTime' | 'endDate' | 'endTime'>,
  direction: VerificationDirection, months: number, now: number, savedEnd: number,
): VerificationPlan {
  parseVerificationMonths(String(months));
  const fromDate = (date: string, time: string) => Date.parse(`${date}T${time}:00+09:00`) / 1000;
  const anchor = direction === 'PAST' ? fromDate(settings.startDate, settings.startTime)
    : settings.endDate ? fromDate(settings.endDate, settings.endTime) : savedEnd;
  if (!Number.isFinite(anchor)) throw new Error('저장된 통계의 분석 기간을 확인할 수 없습니다.');

  const earliest = shiftMonths(now, -60);
  const windows: VerificationMonth[] = [];
  let limit: VerificationPlan['limit'] = null;
  for (let index = 0; index < months; index += 1) {
    const start = shiftMonths(anchor, direction === 'PAST' ? -index - 1 : index);
    const end = shiftMonths(anchor, direction === 'PAST' ? -index : index + 1);
    if (start < earliest) { limit = 'HISTORY'; break; }
    if (end > now) { limit = 'PRESENT'; break; }
    windows.push({ start, end });
  }
  return { windows, earliest, limit };
}

export interface VerificationSummary {
  months: number;
  profitMonths: number;
  lossMonths: number;
  profitReturnSum: number;
  lossReturnSum: number;
  profitUsdt: number;
  lossUsdt: number;
}

export const emptyVerificationSummary: VerificationSummary = {
  months: 0, profitMonths: 0, lossMonths: 0, profitReturnSum: 0, lossReturnSum: 0, profitUsdt: 0, lossUsdt: 0,
};

export function recordVerificationMonth(summary: VerificationSummary, initial: number, final: number): VerificationSummary {
  const result = { ...summary, months: summary.months + 1 };
  const profit = final - initial;
  const percent = profit / initial * 100;
  if (profit > 1e-8) {
    result.profitMonths += 1;
    result.profitReturnSum += percent;
    result.profitUsdt += profit;
  } else if (profit < -1e-8) {
    result.lossMonths += 1;
    result.lossReturnSum -= percent;
    result.lossUsdt -= profit;
  }
  return result;
}

export interface EnvelopeVerificationReport {
  id: string;
  request: VerificationRequest;
  status: 'RUNNING' | 'PAUSED' | 'COMPLETED';
  updatedAt: number;
  plan: VerificationPlan;
  nextGroup: number;
  nextMonth: number;
  dataStops: number;
  completed: number;
  total: number;
  targetCount: number;
  message: string;
  summaries: Record<string, VerificationSummary>;
}

export const verificationKey = ({ source, sourceId, direction }: VerificationTarget): string => `envelope-verification:${source}:${sourceId}:${direction}`;
export async function loadEnvelopeVerification(target: VerificationTarget): Promise<EnvelopeVerificationReport | null> {
  const report = await readValue<EnvelopeVerificationReport>('results', verificationKey(target));
  if (!report || Date.now() - report.updatedAt > retentionMs) return null;
  return report.status === 'RUNNING' ? { ...report, status: 'PAUSED', message: '마지막으로 완료된 달 다음부터 이어갈 수 있습니다.' } : report;
}

export const verificationRowKey = (symbol: string, row: EnvelopeStatisticsRow): string =>
  [symbol, row.side, row.interval, row.maPeriod, row.deviationPercent, row.stopLossPercent, row.exitMode, row.leverage].join(':');

export function verificationSummaryFor(report: EnvelopeVerificationReport | null, symbol: string, row: EnvelopeStatisticsRow): VerificationSummary | undefined {
  return report?.summaries[verificationRowKey(symbol, row)];
}

export const verificationMetrics = {
  months: '검증 개월 수', profitMonths: '수익 개월 수', lossMonths: '손실 개월 수', flatMonths: '손익 없는 개월 수',
  averageProfit: '평균 수익률 (%)', averageLoss: '평균 손실률 (%)', profitUsdt: '수익금 합계 (USDT)',
  lossUsdt: '손실금 합계 (USDT)', netUsdt: '순손익 합계 (USDT)',
};

export type VerificationMetric = keyof typeof verificationMetrics;
export interface VerificationFilterOptions {
  filterBy: VerificationMetric;
  comparison: 'MIN' | 'MAX';
  threshold: string;
  deviationSlEnabled: boolean;
  deviationSlMultiplier: string;
}

export interface VerificationResultOptions extends VerificationFilterOptions {
  sortBy: VerificationMetric | '';
  sortOrder: 'HIGH' | 'LOW';
}

export const defaultVerificationFilterOptions: VerificationFilterOptions = {
  filterBy: 'profitMonths', comparison: 'MIN', threshold: '',
  deviationSlEnabled: false, deviationSlMultiplier: '1.0',
};

export const defaultVerificationResultOptions: VerificationResultOptions = {
  ...defaultVerificationFilterOptions, sortBy: '', sortOrder: 'HIGH',
};

export const verificationDeviationSlMultiplierRange = { min: 0.1, max: 10 };

export function isVerificationDeviationSlMultiplier(value: string): boolean {
  const multiplier = Number(value);
  return multiplier >= verificationDeviationSlMultiplierRange.min && multiplier <= verificationDeviationSlMultiplierRange.max;
}

export const hasVerificationFilter = (options: VerificationResultOptions): boolean => Boolean(options.threshold || options.deviationSlEnabled);

export function verificationValue(summary: VerificationSummary, metric: VerificationMetric): number {
  if (metric === 'flatMonths') return summary.months - summary.profitMonths - summary.lossMonths;
  if (metric === 'averageProfit') return summary.profitMonths ? summary.profitReturnSum / summary.profitMonths : 0;
  if (metric === 'averageLoss') return summary.lossMonths ? summary.lossReturnSum / summary.lossMonths : 0;
  if (metric === 'netUsdt') return summary.profitUsdt - summary.lossUsdt;
  return summary[metric];
}

export function matchesVerificationFilter(summary: VerificationSummary | undefined, options: VerificationResultOptions): boolean {
  if (options.threshold === '') return true;
  if (!summary?.months) return false;
  const value = verificationValue(summary, options.filterBy);
  return options.comparison === 'MIN' ? value >= Number(options.threshold) : value <= Number(options.threshold);
}

export function compareVerificationValues(a: VerificationSummary | undefined, b: VerificationSummary | undefined, options: VerificationResultOptions): number {
  if (!options.sortBy) return 0;
  if (!a?.months || !b?.months) return Number(Boolean(b?.months)) - Number(Boolean(a?.months));
  const difference = verificationValue(b, options.sortBy) - verificationValue(a, options.sortBy);
  return options.sortOrder === 'HIGH' ? difference : -difference;
}

export function orderVerificationRows<T>(
  rows: T[], options: VerificationResultOptions, summaryFor: (row: T) => VerificationSummary | undefined,
  settingFor: (row: T) => Pick<EnvelopeStatisticsRow, 'deviationPercent' | 'stopLossPercent'> | null | undefined,
  fixedStopLossPercent = '3',
): T[] {
  if (!options.sortBy && !hasVerificationFilter(options)) return rows;
  const multiplier = Number(options.deviationSlMultiplier);
  const fixedStopLoss = Number(fixedStopLossPercent);
  const matching = options.deviationSlEnabled ? rows.filter(row => {
    const setting = settingFor(row);
    if (!setting) return false;
    const minimumDeviation = (setting.stopLossPercent ?? fixedStopLoss) * multiplier;
    // Preserve equality when multiplying decimal values such as 0.2 × 3.
    return Number.isFinite(minimumDeviation) && minimumDeviation > 0
      && setting.deviationPercent >= minimumDeviation - 2 * Number.EPSILON * minimumDeviation;
  }) : rows;
  if (!options.sortBy && !options.threshold) return matching;
  const selected = matching.map(row => ({ row, summary: summaryFor(row) })).filter(({ summary }) => matchesVerificationFilter(summary, options));
  if (options.sortBy) selected.sort((a, b) => compareVerificationValues(a.summary, b.summary, options));
  return selected.map(({ row }) => row);
}
