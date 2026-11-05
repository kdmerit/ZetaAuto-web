import { enrichCandles, intervalSeconds } from './api';
import { atrWindowSeconds, calendarAtr } from './atr';
import type { BacktestInterval, BacktestSettings, Candle } from './types';

export interface PreparedNewHigh {
  atr: number | null;
  sum4: number;
  sum9: number;
  sum19: number;
  /** Sum of the 59 completed closes immediately before the execution candle. */
  sum59?: number;
  high: number;
  low: number;
  long: boolean;
  short: boolean;
}

export function newHighPeriod(settings: BacktestSettings): number {
  const text = settings.newHighLookback ?? '20';
  if (!/^\d+$/.test(text) || Number(text) < 6 || Number(text) > 1000) throw new Error('신고가 기준 봉수는 최근 5봉 제외를 위해 6~1000 정수로 입력해 주세요.');
  if (settings.interval !== '1h' && settings.interval !== '4h' && settings.interval !== '1d') throw new Error('신고가 백테스트는 1h·4h·1d만 사용할 수 있습니다.');
  return Number(text);
}
export function newHighExecutionInterval(interval: BacktestInterval): BacktestInterval | null {
  return interval === '1h' || interval === '4h' || interval === '1d' ? '15m' : null;
}
export function newHighSlMultiplier(settings: BacktestSettings): number {
  const text = settings.newHighSlMultiplier ?? '2';
  const value = Number(text);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || !Number.isFinite(value) || value < 0.1 || value > 10) {
    throw new Error('신고가 SL 배수는 0.1~10.0으로 입력해 주세요.');
  }
  return value;
}
export function newHighRiskAmount(settings: BacktestSettings): number {
  const text = settings.newHighRiskAmount ?? settings.betAmountUsdt;
  const value = Number(text);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || !Number.isFinite(value) || value <= 0) {
    throw new Error('신고가 고정 손실액은 0보다 큰 금액으로 입력해 주세요.');
  }
  return value;
}
export function newHighWarmup(settings: BacktestSettings): number {
  return Math.max(atrWindowSeconds + intervalSeconds(settings.interval), (newHighPeriod(settings) + 40) * intervalSeconds(settings.interval));
}
export function currentNewHighSettings(settings: BacktestSettings): BacktestSettings {
  return { ...settings, interval: settings.interval === '1d' ? '1d' : settings.interval === '4h' ? '4h' : '1h', newHighLookback: settings.newHighLookback ?? '20', newHighSlMultiplier: settings.newHighSlMultiplier ?? '2', newHighMa60Enabled: settings.newHighMa60Enabled === true, newHighSizingMode: settings.newHighSizingMode === 'RISK' ? 'RISK' : 'BET', newHighRiskAmount: settings.newHighRiskAmount ?? settings.betAmountUsdt, partialTpEnabled: false };
}

/** Every field is fixed from candles strictly before the execution candle. */
export function prepareNewHigh(candles: Candle[], settings: BacktestSettings): (PreparedNewHigh | undefined)[] {
  const period = newHighPeriod(settings); const enriched = enrichCandles(candles); const atr = calendarAtr(candles, settings.interval);
  const sums = [0]; for (const row of candles) sums.push(sums.at(-1)! + row.close);
  const extremes = (field: 'high' | 'low', direction: number): number[] => {
    const deque: number[] = []; let left = 0;
    return candles.map((_row, index) => {
      while (left < deque.length && deque[left]! < index - period) left += 1;
      const extreme = left < deque.length ? candles[deque[left]!]![field] : NaN;
      while (deque.length > left && direction * candles[deque.at(-1)!]![field] <= direction * candles[index]![field]) deque.pop();
      deque.push(index); return extreme;
    });
  };
  const highs = extremes('high', 1); const lows = extremes('low', -1);
  return candles.map((_candle, index) => {
    if (index < Math.max(period, 40)) return undefined;
    const recent = candles.slice(index - 5, index);
    const cross = enriched.slice(index - 20, index);
    return { atr: atr[index]!.complete ? atr[index]!.value : null,
      sum4: sums[index]! - sums[index - 4]!, sum9: sums[index]! - sums[index - 9]!, sum19: sums[index]! - sums[index - 19]!,
      ...(index >= 59 ? { sum59: sums[index]! - sums[index - 59]! } : {}),
      high: highs[index]!, low: lows[index]!,
      long: settings.side !== 'SHORT' && recent.every(row => row.high < highs[index]!) && cross.some(row => row.ma10 !== null && row.ma20 !== null && row.ma10 < row.ma20),
      short: settings.side !== 'LONG' && recent.every(row => row.low > lows[index]!) && cross.some(row => row.ma10 !== null && row.ma20 !== null && row.ma10 > row.ma20),
    };
  });
}

export const newHighRules = {
  long: [
    '현재 봉을 제외한 이전 N봉 최고가를 돌파하는 중 MA10 > MA20 등 진입 조건이 충족되면 봉 중간에 매수합니다. N은 입력값(기본 20)이며 실제 체결가는 돌파선 +0.5~1.0ATR 사이로 고정됩니다.',
    '진입 시점의 현재가를 반영한 MA10 > MA20이고, 이전 20봉 안에 MA10 < MA20인 봉이 하나 이상 있어야 합니다.',
    '진입 시 현재 가격이 시가보다 높은 양봉 방향이어야 합니다. SL은 실제 매수가 − (입력 SL 배수×ATR)입니다.',
    '수익이 +1ATR에 도달하면 SL을 매수가+0.5ATR, +2ATR에 도달하면 매수가+1.5ATR로 옮깁니다. +3ATR부터는 도달 배수−0.5만큼의 수익 구간에 SL을 계속 올립니다. 청산은 초기 SL 또는 단계형 트레일링 SL로만 합니다.',
  ],
  short: [
    '현재 봉을 제외한 이전 N봉 최저가를 돌파하는 중 MA10 < MA20 등 진입 조건이 충족되면 봉 중간에 매수합니다. 실제 체결가는 돌파선 −0.5~1.0ATR 사이로 고정됩니다.',
    '진입 시점의 현재가를 반영한 MA10 < MA20이고, 이전 20봉 안에 MA10 > MA20인 봉이 하나 이상 있어야 합니다.',
    '진입 시 현재 가격이 시가보다 낮은 음봉 방향이어야 합니다. SL은 실제 매수가 + (입력 SL 배수×ATR)입니다.',
    '수익이 +1ATR에 도달하면 SL을 매수가−0.5ATR, +2ATR에 도달하면 매수가−1.5ATR로 옮깁니다. +3ATR부터는 도달 배수−0.5만큼의 수익 구간에 SL을 계속 내립니다. 청산은 초기 SL 또는 단계형 트레일링 SL로만 합니다.',
  ],
  common: 'ATR은 선택 주기 TR의 직전 20일 단순평균(1h 480봉·4h 120봉·1d 20봉)이며 매 봉 시작 전에 확정합니다. 1h·4h·1d 모두 15분봉을 보조 데이터로 사용해 봉 안의 진입·SL·단계형 트레일링 순서를 확인합니다. 자료가 부족하면 신규 진입하지 않습니다. 고정 베팅액 또는 고정 손실액 중 선택한 기준으로 종목당 한 번만 진입합니다. 고정 손실액을 선택하면 초기 SL 거리와 수수료·슬리피지를 기준으로 수량을 계산합니다. 자금이 부족하거나 SL 가격이 유효하지 않으면 진입하지 않습니다. 현재가 MA60 조건을 켜면 롱은 체결 순간 현재가가 MA60보다 높고 숏은 MA60보다 낮아야 합니다. 진입 캔들에서는 초기 SL·단계형 트레일링 SL을 발동하지 않고, 다음 선택 주기 캔들부터 단계형 트레일링 SL을 적용합니다. ATR 단계에 처음 도달한 15분봉에서는 새로 이동한 트레일링 SL을 발동하지 않고, 다음 15분봉부터 그 SL 접촉을 청산으로 처리합니다. 별도 MA5·MA20 청산은 사용하지 않습니다. MA10·MA20·양봉/음봉 조건은 캔들 진행 중 체결 시점에 판단합니다. 매수는 돌파선 +0.5ATR에 도달한 순간부터 +1.0ATR 이내에서만 시도합니다. 진입/청산 0.02% 슬리피지·편도 0.055% 수수료를 반영합니다. 보조 봉 안의 OHLC 경로 중 낮은 계좌 평가액을 선택하고 동시 경계는 SL 우선입니다. 정확한 틱 재현은 아닙니다. 한 선택 주기에서 청산 후 재진입하지 않으며 전체종목은 한 계좌·종목명 순서·봉 시작 가용자금만 사용합니다.',
};
