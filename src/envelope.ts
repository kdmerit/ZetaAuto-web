/** Frozen, prior-completed SMA bands: the current candle never defines its own orders. */
import type { BacktestInterval, BacktestSettings, Candle, ChartData, EnvelopeBand, EnvelopeExitMode } from './types';

export const envelopePeriod = 20;
export const envelopePeriods = [3, 5, 20, 60, 120];
export const legacyEnvelopePeriods = [5, 10, 20, 40, 60, 80, 100, 120];
export const envelopeModelVersion = '2.10.89';
export const envelopeExitModes: EnvelopeExitMode[] = ['MA20', 'CENTER', 'OPPOSITE', 'HALF'];
export const envelopeExitLabels: Record<EnvelopeExitMode, string> = {
  CENTER: '중심선 전량 청산', OPPOSITE: '반대 밴드 전량 청산', HALF: '중심선 50% · 반대 밴드 나머지', MA20: 'MA20 이탈 종가 청산',
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
  const interval = settings.interval === '4h' || settings.interval === '1d' ? settings.interval : '1h';
  const statisticsInterval = settings.envelopeStatisticsInterval === '4h' || settings.envelopeStatisticsInterval === '1d' ? settings.envelopeStatisticsInterval : '1h';
  const { envelopeDailyTrend: _trend, ...current } = settings;
  return { ...current, interval, envelopeStatisticsInterval: statisticsInterval,
    envelopeMaPeriod: envelopePeriods.includes(Number(settings.envelopeMaPeriod)) ? settings.envelopeMaPeriod : '20',
    envelopeMa20Enabled: settings.envelopeMa20Enabled === true,
    // Retain these legacy fields for archived results, but never enable the
    // removed controls for a new envelope analysis.
    envelopeMa20BelowEnabled: false,
    envelopeCloseOnConfirmedBreakout: false,
    envelopeEntryMode: 'BAND_TOUCH', envelopeExitMode: 'OPPOSITE', envelopeMoveSlOnCenter: false, envelopeRisk: undefined };
}

export function envelopeMa20FilterLabel(settings: Pick<BacktestSettings, 'envelopeMa20Enabled' | 'envelopeMa20BelowEnabled'>): string {
  return settings.envelopeMa20Enabled === true ? '위(롱)·아래(숏)' : '사용 안 함';
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
  const exit = settings.envelopeExitMode ?? 'OPPOSITE';
  if (!envelopeExitModes.includes(exit)) throw new Error('엔벨로프 청산 방식을 선택해 주세요.');
  const period = Number(settings.envelopeMaPeriod ?? '20');
  if (!envelopePeriods.includes(period)) throw new Error('중심선 봉수는 3·5·20·60·120 중에서 선택해 주세요.');
  return { percent, exit, period };
}

export function bandFor(center: number, percent: number): EnvelopeBand {
  return { center, upper: center * (1 + percent / 100), lower: center * (1 - percent / 100) };
}

/**
 * On daily envelope entries, reject a candle with at least
 * half of its full range beyond the entry band.  The midpoint is used so
 * equality is also rejected; lower-timeframe envelope rules are unchanged.
 */
export function envelopeHalfCandleAllowsEntry(
  candle: Pick<Candle, 'high' | 'low'>,
  band: Pick<EnvelopeBand, 'upper' | 'lower'>,
  side: 'LONG' | 'SHORT',
  interval: BacktestInterval,
): boolean {
  if (interval !== '1d') return true;
  const midpoint = (candle.high + candle.low) / 2;
  if (!Number.isFinite(midpoint)) return false;
  return side === 'LONG' ? midpoint > band.lower : midpoint < band.upper;
}

/**
 * The current envelope setup needs a completed touch from one of the previous
 * candles.  The current candle is deliberately excluded so its own high/low
 * cannot arm its entry condition retrospectively.
 */
export function priorEnvelopeTouchFlags(
  candles: Candle[],
  centers: (number | null)[],
  index: number,
  percent: number,
  lookback = 15,
): { upper: boolean; lower: boolean } {
  let upper = false;
  let lower = false;
  for (let cursor = Math.max(0, index - lookback); cursor < index; cursor += 1) {
    const candle = candles[cursor];
    const center = centers[cursor];
    if (!candle || center === null || center === undefined) continue;
    const band = bandFor(center, percent);
    upper ||= candle.high >= band.upper;
    lower ||= candle.low <= band.lower;
  }
  return { upper, lower };
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
