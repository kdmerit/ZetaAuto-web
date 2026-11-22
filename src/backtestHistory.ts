import type { BacktestSettings, Strategy } from './types';
import { defaultEnvelopeTakeProfitPercent } from './envelope';
import { isCurrentEnvelopeStatisticsVersion, statisticsCenterRange, statisticsPercentRange, usesCustomStatisticsRanges, usesOptimizedEnvelopeStopLoss } from './envelopeStatistics';
import { statisticsRangeLabels } from './envelopeStatisticsRanges';

/** Which input form produced the history card. */
export type BacktestHistorySettingsKind = 'BACKTEST' | 'ENVELOPE_STATISTICS';

const sideLabel = (side: BacktestSettings['side']): string =>
  side === 'LONG' ? '롱' : side === 'SHORT' ? '숏' : '롱 + 숏';

const valueOrCurrent = (value: string | undefined): string => value || '현재';

const intervalFor = (
  settings: BacktestSettings,
  kind: BacktestHistorySettingsKind,
): string => {
  if (kind !== 'BACKTEST' && settings.envelopeStatisticsInterval) {
    return settings.envelopeStatisticsInterval;
  }
  return settings.interval;
};

const add = (values: string[], label: string, value: string | number): void => {
  values.push(`${label} ${value}`);
};

const addEnabled = (values: string[], enabled: boolean, label: string, value = '적용'): void => {
  if (enabled) add(values, label, value);
};

const resultSortLabel = (value: string): string =>
  value === 'winRatePercent' ? '승률' : '수익률';

/**
 * Returns the saved inputs in the same compact order for every backtest
 * history card. Times are intentionally omitted; dates are retained.
 */
export function formatBacktestHistorySettings(
  settings: BacktestSettings,
  strategy: Strategy,
  kind: BacktestHistorySettingsKind = 'BACKTEST',
  version?: string,
): string[] {
  const values: string[] = [];
  add(values, '방향', sideLabel(settings.side));
  values.push(intervalFor(settings, kind).toUpperCase());
  values.push(`${settings.startDate} ~ ${valueOrCurrent(settings.endDate)}`);
  add(values, '가상 초기자금', `${settings.initialCapitalUsdt} USDT`);
  if (strategy !== 'NEW_HIGH') {
    add(values, '고정 베팅액', `${settings.betAmountUsdt} USDT`);
  }
  add(values, '레버리지', `${settings.leverage}배`);
  add(values, '분석 대상', settings.mode === 'ALL' ? '전체 종목' : '개별 종목');

  if (strategy === 'NEW_HIGH') {
    add(values, '신고가 기준 봉수', settings.newHighLookback ?? '20');
    addEnabled(values, settings.newHighBreakoutCandleMinEnabled === true, '돌파봉 최소크기', `${settings.newHighBreakoutCandleMinAtr ?? '1'} ATR`);
    addEnabled(values, settings.newHighBreakoutCandleMaxEnabled === true, '돌파봉 최대크기', `${settings.newHighBreakoutCandleMaxAtr ?? '2'} ATR`);
    addEnabled(values, settings.newHighSlEnabled !== false, 'SL 배수', `${settings.newHighSlMultiplier ?? '2'} ATR`);
    addEnabled(values, settings.newHighTpEnabled !== false, 'TP 배수', `${settings.newHighTpMultiplier ?? '2'} ATR`);
    addEnabled(values, settings.newHighTrailingStopEnabled === true, '트레일링 스탑 배수', `${settings.newHighTrailingStopMultiplier ?? '3'} ATR`);
    add(values, '포지션 금액 기준', settings.newHighSizingMode === 'RISK' && settings.newHighSlEnabled !== false ? '고정 손실액' : '고정 베팅액');
    if (settings.newHighSizingMode === 'RISK' && settings.newHighSlEnabled !== false) {
      add(values, '고정 손실액', `${settings.newHighRiskAmount ?? settings.betAmountUsdt} USDT`);
    } else {
      add(values, '고정 베팅액', `${settings.betAmountUsdt} USDT`);
    }
    addEnabled(values, settings.newHighDailyMa20Enabled === true, '1d MA20 방향 필터');
    return values;
  }

  if (strategy === 'PULLBACK') {
    add(values, '엔벨로프 SMA', settings.envelopeMaPeriod ?? '20');
    add(values, '엔벨로프 이격', `${settings.envelopeDeviationPercent ?? '5.0'}%`);
    return values;
  }

  if (strategy === 'DISPARITY') {
    add(values, 'MA60 최소 이격률', `${settings.minDisparityPercent}%`);
    addEnabled(values, settings.ma20HalfCloseEnabled, '캔들 절반 MA20 청산');
    add(values, 'ROI 손실 청산', `${settings.roiClosePercent}%`);
    addEnabled(values, settings.partialTpEnabled, '부분 TP 50%');
    return values;
  }

  if (strategy === 'VOLATILITY') {
    addEnabled(values, settings.volatilityMa10Enabled === true, 'MA10 이격 조건', `${settings.volatilityMa10DistancePercent ?? '1'}%`);
    addEnabled(values, settings.volatilityMa60Enabled === true, 'MA60 위·아래 방향 필터');
    addEnabled(values, settings.volatilityMa60BelowEnabled === true, 'MA60 아래·위 방향 필터');
    addEnabled(values, settings.partialTpEnabled, '부분 TP 50%');
    return values;
  }

  if (strategy === 'REFERENCE') {
    add(values, 'TP 비율', `${settings.referenceTpPercent ?? '80'}%`);
    addEnabled(values, settings.referenceMa10Enabled === true, '기준봉 MA10 위치 조건');
    addEnabled(values, settings.partialTpEnabled, '부분 TP 50%');
    return values;
  }

  if (strategy === 'CANDLE_BREAKOUT') {
    addEnabled(values, settings.candleBreakoutCloseMa20Enabled === true, '종가 MA20 위 필터');
    addEnabled(values, settings.candleBreakoutCloseMa20BelowEnabled === true, 'MA20 아래 필터');
    addEnabled(values, settings.candleBreakoutCloseMa60Enabled === true, '종가 MA60 위 필터');
    addEnabled(values, settings.candleBreakoutMa20DistanceEnabled === true, '종가 MA20보다 1% 아래');
    addEnabled(values, settings.candleBreakoutMa20AboveMa60Enabled === true, 'MA20 > MA60 필터');
    addEnabled(values, settings.candleBreakoutAtrStopEnabled === true, 'SL 매수가−ATR');
    addEnabled(values, settings.partialTpEnabled, '부분 TP 50%');
    return values;
  }

  if (strategy === 'ENVELOPE' || strategy === 'ATR_ENVELOPE') {
    addEnabled(values, settings.envelopeMa20Enabled === true, 'MA20 위·아래 방향 필터');
    addEnabled(values, settings.envelopeCloseOnCenterReturn === true, '중심선 터치후 이탈시 매도');
    addEnabled(values, strategy === 'ENVELOPE' && settings.envelopeCloseOnCenterTouch === true, '중심선 터치시 청산');
    addEnabled(values, settings.envelopeSideRatio50Enabled === true, '롱·숏 비율 50%');
    addEnabled(values, settings.envelopeCloseOnlyEntryEnabled === true, '종가에서만 매수');
    addEnabled(values, settings.envelopeHalfCandleEnabled === true, '캔들 절반 엔벨 이내');
    addEnabled(values, settings.envelopeCandleFilterEnabled === true, '매수금지 캔들 필터');

    const statistics = kind === 'ENVELOPE_STATISTICS';
    const searchesTakeProfit = statistics && isCurrentEnvelopeStatisticsVersion(version) && settings.envelopeTakeProfitEnabled === true;
    if (strategy === 'ATR_ENVELOPE') {
      const atr = settings.atrEnvelope;
      add(values, 'EMA', atr?.emaPeriod ?? '3');
      add(values, 'ATR', atr?.atrPeriod ?? '3');
      add(values, 'N', atr?.atrMultiplier ?? '0.5');
      add(values, 'SL 배수', `${settings.atrEnvelopeStopMultiplier ?? '0'} ATR`);
    } else if (statistics && usesCustomStatisticsRanges(version)) {
      values.push(...statisticsRangeLabels(settings, searchesTakeProfit), 'SL ≤ 이격 × 2');
    } else if (statistics && usesOptimizedEnvelopeStopLoss(version)) {
      add(values, '중심선 탐색', `${statisticsCenterRange}봉`);
      add(values, '이격 탐색', statisticsPercentRange);
      add(values, 'SL 탐색', statisticsPercentRange);
    } else {
      add(values, '엔벨로프 중심선 봉수', settings.envelopeMaPeriod ?? '20');
      add(values, '엔벨로프 이격', `${settings.envelopeDeviationPercent ?? '3'}%`);
      add(values, 'SL', `${settings.envelopeStopLossPercent ?? '3'}%`);
    }
    addEnabled(values, strategy === 'ENVELOPE' && settings.envelopeTakeProfitEnabled === true && !searchesTakeProfit, 'TP', `${settings.envelopeTakeProfitPercent ?? defaultEnvelopeTakeProfitPercent}%`);
    addEnabled(values, settings.envelopeTrailingStopEnabled === true, '트레일링 스탑', `${settings.envelopeTrailingStopPercent ?? '3'}%`);

    if (statistics) {
      const options = settings.envelopeResultOptions;
      if (options) {
        add(values, '최소 진입횟수', options.minTrades);
        add(values, '최소 수익률', `${options.minReturnPercent}%`);
        add(values, '최소 수익비', `${options.minProfitRatioPercent}%`);
        add(values, '정렬 기준', resultSortLabel(options.sort));
      }
    }
  }

  return values;
}
