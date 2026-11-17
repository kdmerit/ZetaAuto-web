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
  /** The last fully closed 1d candle before the parent candle's open. */
  dailyLongAllowed?: boolean;
  dailyShortAllowed?: boolean;
}

export function newHighPeriod(settings: BacktestSettings): number {
  const text = settings.newHighLookback ?? '20';
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 1000) throw new Error('신고가 기준 봉수는 1~1000 정수로 입력해 주세요.');
  if (settings.interval !== '1h' && settings.interval !== '4h' && settings.interval !== '1d') throw new Error('신고가 백테스트는 1h·4h·1d만 사용할 수 있습니다.');
  return Number(text);
}
function breakoutCandleSizeMultiplier(text: string, label: string): number {
  const value = Number(text);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || !Number.isFinite(value) || value < 0.1 || value > 10) {
    throw new Error(`신고가 ${label} 배수는 0.1~10.0으로 입력해 주세요.`);
  }
  return value;
}
export function newHighBreakoutCandleMinMultiplier(settings: BacktestSettings): number {
  return breakoutCandleSizeMultiplier(settings.newHighBreakoutCandleMinAtr ?? '1', '돌파봉 최소크기');
}
export function newHighBreakoutCandleMaxMultiplier(settings: BacktestSettings): number {
  return breakoutCandleSizeMultiplier(settings.newHighBreakoutCandleMaxAtr ?? '2', '돌파봉 최대크기');
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
export function newHighTpMultiplier(settings: BacktestSettings): number {
  const text = settings.newHighTpMultiplier ?? '2';
  const value = Number(text);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || !Number.isFinite(value) || value < 0.1 || value > 10) {
    throw new Error('신고가 TP 배수는 0.1~10.0으로 입력해 주세요.');
  }
  return value;
}
export function newHighTrailingStopMultiplier(settings: BacktestSettings): number {
  const text = settings.newHighTrailingStopMultiplier ?? '3';
  const value = Number(text);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || !Number.isFinite(value) || value < 0.1 || value > 10) {
    throw new Error('신고가 트레일링 스탑 배수는 0.1~10.0으로 입력해 주세요.');
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
  return Math.max(atrWindowSeconds + intervalSeconds(settings.interval), (newHighPeriod(settings) + 20) * intervalSeconds(settings.interval));
}
export function currentNewHighSettings(settings: BacktestSettings): BacktestSettings {
  const slEnabled = settings.newHighSlEnabled !== false;
  const tpEnabled = settings.newHighTpEnabled !== false;
  return { ...settings, interval: settings.interval === '1d' ? '1d' : settings.interval === '4h' ? '4h' : '1h', newHighLookback: settings.newHighLookback ?? '20', newHighBreakoutCandleMinEnabled: settings.newHighBreakoutCandleMinEnabled === true, newHighBreakoutCandleMinAtr: settings.newHighBreakoutCandleMinAtr ?? '1', newHighBreakoutCandleMaxEnabled: settings.newHighBreakoutCandleMaxEnabled === true, newHighBreakoutCandleMaxAtr: settings.newHighBreakoutCandleMaxAtr ?? '2', newHighSlEnabled: slEnabled, newHighSlMultiplier: settings.newHighSlMultiplier ?? '2', newHighTpEnabled: tpEnabled, newHighTpMultiplier: settings.newHighTpMultiplier ?? '2', newHighTrailingStopEnabled: settings.newHighTrailingStopEnabled === true, newHighTrailingStopMultiplier: settings.newHighTrailingStopMultiplier ?? '3', newHighMa60Enabled: false, newHighMa10Enabled: false, newHighDailyMa20Enabled: settings.newHighDailyMa20Enabled === true, newHighSizingMode: slEnabled && settings.newHighSizingMode === 'RISK' ? 'RISK' : 'BET', newHighRiskAmount: settings.newHighRiskAmount ?? settings.betAmountUsdt, partialTpEnabled: false };
}

interface DailyMa20Filter {
  dailyLongAllowed: boolean;
  dailyShortAllowed: boolean;
}

/** Resolve only fully closed daily candles so intraday bars cannot see future OHLC. */
function dailyMa20FiltersAt(parentCandles: Candle[], dailyCandles: Candle[]): (DailyMa20Filter | undefined)[] {
  const rows = [...dailyCandles].sort((a, b) => a.openTime - b.openTime);
  const prefix = [0];
  for (const row of rows) prefix.push(prefix.at(-1)! + row.close);
  let latest = -1;
  return parentCandles.map(parent => {
    while (latest + 1 < rows.length && rows[latest + 1]!.closeTime <= parent.openTime) latest += 1;
    if (latest < 19) return undefined;
    const daily = rows[latest]!;
    const ma20 = (prefix[latest + 1]! - prefix[latest - 19]!) / 20;
    return { dailyLongAllowed: daily.low > ma20, dailyShortAllowed: daily.high < ma20 };
  });
}

/** The signal is fixed at the completed current candle; its channel and prior MA zone use only earlier candles. */
export function prepareNewHigh(candles: Candle[], settings: BacktestSettings, dailyCandles: Candle[] = []): (PreparedNewHigh | undefined)[] {
  const period = newHighPeriod(settings); const minSizeEnabled = settings.newHighBreakoutCandleMinEnabled === true; const maxSizeEnabled = settings.newHighBreakoutCandleMaxEnabled === true;
  const minSize = minSizeEnabled ? newHighBreakoutCandleMinMultiplier(settings) : null; const maxSize = maxSizeEnabled ? newHighBreakoutCandleMaxMultiplier(settings) : null;
  if (minSize !== null && maxSize !== null && minSize > maxSize) throw new Error('신고가 돌파봉 최소크기 배수는 최대크기 배수보다 클 수 없습니다.');
  const enriched = enrichCandles(candles); const atr = calendarAtr(candles, settings.interval);
  const sums = [0]; for (const row of candles) sums.push(sums.at(-1)! + row.close);
  const dailyFilters = settings.newHighDailyMa20Enabled === true ? dailyMa20FiltersAt(candles, dailyCandles) : [];
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
    if (index < Math.max(period, 20)) return undefined;
    const current = enriched[index]!;
    const previous = enriched[index - 1];
    const prior = enriched.slice(index - period, index);
    const previousHigh = highs[index - 1];
    const previousLow = lows[index - 1];
    const currentLongMa = current.ma10 !== null && current.ma20 !== null && current.ma10 > current.ma20;
    const currentShortMa = current.ma10 !== null && current.ma20 !== null && current.ma10 < current.ma20;
    const priorLongMa = prior.some(row => row.ma10 !== null && row.ma20 !== null && row.ma10 < row.ma20);
    const priorShortMa = prior.some(row => row.ma10 !== null && row.ma20 !== null && row.ma10 > row.ma20);
    const currentAtr = atr[index]!.complete ? atr[index]!.value : null;
    const breakoutSize = _candle.high - _candle.low;
    const sizeTolerance = currentAtr === null ? 0 : Math.max(1, Math.abs(breakoutSize), Math.abs(currentAtr)) * 1e-10;
    const breakoutSizeAllowed = currentAtr !== null && Number.isFinite(breakoutSize)
      && (!minSizeEnabled || breakoutSize + sizeTolerance >= currentAtr * minSize!)
      && (!maxSizeEnabled || breakoutSize - sizeTolerance <= currentAtr * maxSize!);
    const firstLongBreak = previous === undefined || previousHigh === undefined || !Number.isFinite(previousHigh) || previous.close <= previousHigh;
    const firstShortBreak = previous === undefined || previousLow === undefined || !Number.isFinite(previousLow) || previous.close >= previousLow;
    return { atr: atr[index]!.complete ? atr[index]!.value : null,
      sum4: sums[index]! - sums[index - 4]!, sum9: sums[index]! - sums[index - 9]!, sum19: sums[index]! - sums[index - 19]!,
      ...(index >= 59 ? { sum59: sums[index]! - sums[index - 59]! } : {}),
      high: highs[index]!, low: lows[index]!,
      long: settings.side !== 'SHORT' && Number.isFinite(highs[index]!) && _candle.close > highs[index]! && firstLongBreak && currentLongMa && priorLongMa && breakoutSizeAllowed,
      short: settings.side !== 'LONG' && Number.isFinite(lows[index]!) && _candle.close < lows[index]! && firstShortBreak && currentShortMa && priorShortMa && breakoutSizeAllowed,
      ...(dailyFilters[index] ?? {}),
    };
  });
}

export const newHighRules = {
  long: [
    '현재 봉 종가가 이전 N봉의 최고가를 처음으로 돌파하면 종가에서 매수합니다. N은 입력값입니다.',
    '매수 봉의 MA10이 MA20보다 높아야 하고, 이전 N봉 안에 MA10이 MA20보다 낮았던 봉이 하나 이상 있어야 합니다.',
    'SL을 체크하면 손절가는 실제 매수가 − (입력한 손절 배수×ATR)입니다.',
    'TP를 체크하면 목표가는 실제 매수가 + (입력한 TP 배수×ATR)입니다. 체크한 청산 조건에 닿으면 전량 청산하며, 트레일링 스탑을 켜면 입력한 ATR 간격으로 손절선이 유리한 방향으로만 따라갑니다.',
  ],
  short: [
    '현재 봉 종가가 이전 N봉의 최저가를 처음으로 이탈하면 종가에서 매도합니다. N은 입력값입니다.',
    '매도 봉의 MA10이 MA20보다 낮아야 하고, 이전 N봉 안에 MA10이 MA20보다 높았던 봉이 하나 이상 있어야 합니다.',
    'SL을 체크하면 손절가는 실제 매도가 + (입력한 손절 배수×ATR)입니다.',
    'TP를 체크하면 목표가는 실제 매도가 − (입력한 TP 배수×ATR)입니다. 체크한 청산 조건에 닿으면 전량 청산하며, 트레일링 스탑을 켜면 입력한 ATR 간격으로 손절선이 유리한 방향으로만 따라갑니다.',
  ],
  common: 'ATR은 선택 주기 TR의 직전 20일 단순평균(1h 480봉·4h 120봉·1d 20봉)이며 현재 봉이 시작할 때 확정합니다. 매수는 현재 선택 주기 봉이 완전히 끝난 종가에서만 합니다. 돌파봉 최소크기·최대크기를 체크하면 현재 돌파봉의 고가−저가를 확정 ATR×입력 배수와 비교합니다. 1h·4h·1d 모두 15분봉을 보조 데이터로 사용해 다음 봉부터 체크한 SL·TP·트레일링 스탑의 도달 순서를 확인합니다. 매수한 봉 안에서는 청산 조건을 소급하지 않습니다. 트레일링 스탑을 켜면 진입 후 가장 유리했던 가격에서 입력한 ATR×배수만큼 떨어진 손절선을 유지하며, 손절선은 불리한 방향으로 되돌리지 않습니다. 자료가 부족하면 신규 진입하지 않습니다. 1d MA20 필터를 켜면 선택 주기와 관계없이 진입 전에 확정된 1d 캔들의 저가가 1d MA20보다 높은 경우에만 롱, 고가가 1d MA20보다 낮은 경우에만 숏으로 진입합니다. 1d 캔들이 MA20에 닿거나 걸치면 진입하지 않습니다. 고정 베팅액 또는 고정 손실액 중 선택한 기준으로 종목당 한 번만 진입합니다. 고정 손실액을 선택하면 손절 거리와 수수료·슬리피지를 기준으로 수량을 계산합니다. SL을 끄면 고정 베팅액 기준으로 전환합니다. 자금이 부족하거나 활성화된 손절가가 유효하지 않으면 진입하지 않습니다. 단계형 트레일링, 다음 캔들 진입봉 이탈 청산, MA5·MA20 청산은 사용하지 않습니다. 진입·청산 0.02% 슬리피지·편도 0.055% 수수료를 반영합니다. 보조 봉 안의 OHLC 경로를 시간순으로 확인하고, 같은 봉에서 순서를 알 수 없으면 계좌에 더 불리한 경로를 선택합니다. 정확한 틱 재현은 아닙니다. 한 선택 주기에서 청산 후 재진입하지 않으며 전체종목은 한 계좌·종목명 순서·봉 시작 가용자금만 사용합니다.',
};
