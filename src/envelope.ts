/** Frozen, prior-completed SMA bands: the current candle never defines its own orders. */
import type { BacktestSettings, Candle, ChartData, EnvelopeBand, EnvelopeExitMode } from './types';

export const envelopePeriod = 20;
export const envelopePeriods = [5, 10, 20, 40, 60, 80, 100, 120];
export const envelopeExitModes: EnvelopeExitMode[] = ['CENTER', 'OPPOSITE', 'HALF'];
export const envelopeExitLabels: Record<EnvelopeExitMode, string> = {
  CENTER: '중심선 전량 청산', OPPOSITE: '반대 밴드 전량 청산', HALF: '중심선 50% · 반대 밴드 나머지',
};

/** The current pullback strategy uses a user-entered SMA period and band width. */
export function currentPullbackSettings(settings: BacktestSettings): BacktestSettings {
  return { ...settings, envelopeMaPeriod: settings.envelopeMaPeriod ?? '20', envelopeDeviationPercent: settings.envelopeDeviationPercent ?? '5.0' };
}

export function pullbackEnvelopeParameters(settings: BacktestSettings): { percent: number; period: number } {
  const value = settings.envelopeDeviationPercent ?? '5.0';
  const percent = Number(value);
  if (!/^\d+(\.\d)?$/.test(value) || !Number.isFinite(percent) || percent < 0.1 || percent > 20) {
    throw new Error('엔벨로프 이격은 0.1~20.0%로 입력해 주세요. (소수 한 자리)');
  }
  const periodValue = settings.envelopeMaPeriod ?? '20';
  const period = Number(periodValue);
  if (!/^\d+$/.test(periodValue) || !Number.isInteger(period) || period < 1 || period > 120) {
    throw new Error('엔벨로프 SMA는 1~120 정수로 입력해 주세요.');
  }
  return { percent, period };
}

/** Current strategy only; archived settings without this marker retain their original replay. */
export function currentEnvelopeSettings(settings: BacktestSettings): BacktestSettings {
  return { ...settings, interval: '1h', envelopeStatisticsInterval: '1h', envelopeDailyTrend: settings.envelopeDailyTrend ?? true,
    envelopeEntryMode: 'RECLAIM', envelopeExitMode: 'CENTER', envelopeMoveSlOnCenter: false, envelopeRisk: undefined };
}

/** MA20 of the last closed daily candle versus five daily candles earlier, never the live daily bar. */
export function projectDailyTrend(rows: Candle[], targets: Candle[]): Map<number, number | null> {
  const averages: (number | null)[] = [];
  let sum = 0;
  for (let index = 0; index < rows.length; index += 1) {
    sum += rows[index]!.close;
    if (index >= 20) sum -= rows[index - 20]!.close;
    averages.push(index >= 19 ? sum / 20 : null);
  }
  const changes = new Map<number, number | null>();
  let cursor = 0;
  for (const target of targets) {
    while (cursor < rows.length && rows[cursor]!.closeTime <= target.openTime) cursor += 1;
    const latest = averages[cursor - 1]; const previous = averages[cursor - 6];
    changes.set(target.openTime, latest != null && previous != null && previous > 0 ? (latest / previous - 1) * 100 : null);
  }
  return changes;
}

export function dailyTrendAllows(change: number | null | undefined, side: 'LONG' | 'SHORT'): boolean {
  return change != null && Number.isFinite(change) && (side === 'LONG' ? change >= 0.5 - 1e-10 : change <= -0.5 + 1e-10);
}

export function envelopeParameters(settings: BacktestSettings): { percent: number; exit: EnvelopeExitMode; period: number } {
  const value = settings.envelopeDeviationPercent ?? '0.5';
  const percent = Number(value);
  if (!/^\d+(\.\d)?$/.test(value) || !Number.isFinite(percent) || percent < 0.1 || percent > 20) {
    throw new Error('엔벨로프 이격은 0.1~20.0%로 입력해 주세요. (소수 한 자리)');
  }
  const exit = settings.envelopeExitMode ?? 'CENTER';
  if (!envelopeExitModes.includes(exit)) throw new Error('엔벨로프 청산 방식을 선택해 주세요.');
  const period = Number(settings.envelopeMaPeriod ?? '20');
  if (!envelopePeriods.includes(period)) throw new Error('중심선 봉수는 5·10·20·40·60·80·100·120 중에서 선택해 주세요.');
  return { percent, exit, period };
}

export function bandFor(center: number, percent: number): EnvelopeBand {
  return { center, upper: center * (1 + percent / 100), lower: center * (1 - percent / 100) };
}

export function priorMovingAverages(candles: Candle[], period = envelopePeriod): (number | null)[] {
  let sum = 0;
  return candles.map((candle, index) => {
    const center = index >= period ? sum / period : null;
    sum += candle.close;
    if (index >= period) sum -= candles[index - period]!.close;
    return center;
  });
}

/** Source-period bands projected at each display candle's open, using only already closed source bars. */
export function projectEnvelopeBands(rows: Candle[], targets: Candle[], definition: Omit<NonNullable<ChartData['envelope']>, 'bands'>): NonNullable<ChartData['envelope']> {
  let cursor = 0;
  let sum = 0;
  const bands: NonNullable<ChartData['envelope']>['bands'] = [];
  for (const candle of targets) {
    while (cursor < rows.length && rows[cursor]!.closeTime <= candle.openTime) {
      sum += rows[cursor]!.close;
      if (cursor >= definition.period) sum -= rows[cursor - definition.period]!.close;
      cursor += 1;
    }
    if (cursor >= definition.period) bands.push({ openTime: candle.openTime, ...bandFor(sum / definition.period, definition.deviationPercent) });
  }
  return { ...definition, bands };
}
