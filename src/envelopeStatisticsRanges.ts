import { envelopeMaxPeriod } from './envelope';
import type { BacktestSettings, EnvelopeStatisticsRange, EnvelopeStatisticsRanges } from './types';

export const statisticsAxes = [
  { key: 'center', label: '중심선', unit: '봉', min: 1, max: envelopeMaxPeriod, scale: 1 },
  { key: 'deviation', label: '이격', unit: '%', min: 0.1, max: 20, scale: 10 },
  { key: 'stopLoss', label: 'SL', unit: '%', min: 0.1, max: 20, scale: 10 },
] as const;

const defaults: EnvelopeStatisticsRanges = {
  center: { start: '1', end: '10', increment: '1' },
  deviation: { start: '0.1', end: '10.0', increment: '0.1' },
  stopLoss: { start: '0.1', end: '10.0', increment: '0.1' },
};

type RangeSettings = Pick<BacktestSettings, 'envelopeStatisticsRanges'>;

export function statisticsRanges(settings: RangeSettings): EnvelopeStatisticsRanges {
  const saved = settings.envelopeStatisticsRanges;
  return {
    center: { ...defaults.center, ...saved?.center },
    deviation: { ...defaults.deviation, ...saved?.deviation },
    stopLoss: { ...defaults.stopLoss, ...saved?.stopLoss },
  };
}

export function statisticsRangeLabels(settings: RangeSettings): string[] {
  const ranges = statisticsRanges(settings);
  return statisticsAxes.map(({ key, label, unit }) => {
    const { start, end, increment } = ranges[key];
    return `${label} 탐색 ${start}~${end}${unit} · ${increment}${unit}씩`;
  });
}

function rangeSteps(range: EnvelopeStatisticsRange, axis: typeof statisticsAxes[number]): number[] {
  const format = axis.scale === 1 ? /^\d+$/ : /^(?:\d+(?:\.\d)?|\.\d)$/;
  const toStep = (value: string): number => {
    const number = Number(value);
    if (typeof value !== 'string' || !format.test(value.trim()) || number < axis.min || number > axis.max) {
      const precision = axis.scale === 1 ? '정수' : '소수 한 자리까지';
      throw new Error(`${axis.label}의 시작값·종료값·증가값을 ${axis.min}~${axis.max}${axis.unit} 범위에서 입력해 주세요 (${precision}).`);
    }
    return Math.round(number * axis.scale);
  };
  const start = toStep(range.start);
  const end = toStep(range.end);
  const increment = toStep(range.increment);
  if (end < start) throw new Error(`${axis.label} 종료값은 시작값 이상이어야 합니다.`);
  const steps: number[] = [];
  for (let step = start; step <= end; step += increment) steps.push(step);
  return steps;
}

export function compileStatisticsGrid(settings: RangeSettings) {
  const ranges = statisticsRanges(settings);
  const periods = rangeSteps(ranges.center, statisticsAxes[0]);
  const deviationSteps = rangeSteps(ranges.deviation, statisticsAxes[1]);
  const stopSteps = rangeSteps(ranges.stopLoss, statisticsAxes[2]);
  const deviations: { step: number; stopCount: number; precedingCount: number }[] = [];
  let stopCount = 0;
  let combinationsPerGroup = 0;
  // Both percentages are integer tenths, so the 2× boundary is exact.
  for (const step of deviationSteps) {
    while (stopCount < stopSteps.length && stopSteps[stopCount]! <= step * 2) stopCount += 1;
    if (stopCount === 0) continue;
    deviations.push({ step, stopCount, precedingCount: combinationsPerGroup });
    combinationsPerGroup += stopCount;
  }
  if (!combinationsPerGroup) throw new Error('SL이 이격의 2배 이하인 조합이 없습니다. 이격 또는 SL 범위를 조정해 주세요.');
  return { periods, deviations, stopSteps, combinationsPerGroup };
}
