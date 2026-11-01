/** Frozen, prior-completed SMA bands: the current candle never defines its own orders. */
import type { BacktestSettings, Candle, ChartData, EnvelopeBand, EnvelopeExitMode } from './types';

export const envelopePeriod = 20;
export const envelopePeriods = [5, 10, 20, 40, 60, 80, 100, 120];
export const envelopeExitModes: EnvelopeExitMode[] = ['CENTER', 'OPPOSITE', 'HALF'];
export const envelopeExitLabels: Record<EnvelopeExitMode, string> = {
  CENTER: '중심선 전량 청산', OPPOSITE: '반대 밴드 전량 청산', HALF: '중심선 50% · 반대 밴드 나머지',
};

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
