import { enrichCandles, intervalSeconds } from './api';
import { atrWindowSeconds, calendarAtr } from './atr';
import { priorMovingAverages } from './envelope';
import type { BacktestSettings, Candle, EnrichedCandle, Signal } from './types';

const setupLookback = 3;
const ma60PriorBars = 59;

export function currentMaDisparitySettings(settings: BacktestSettings): BacktestSettings {
  return {
    ...settings,
    interval: settings.interval === '15m' ? '1h' : settings.interval,
    partialTpEnabled: false,
    envelopeExecutionModel: undefined,
  };
}

export function maDisparityWarmup(settings: BacktestSettings): number {
  const seconds = intervalSeconds(settings.interval);
  return Math.max(ma60PriorBars * seconds, atrWindowSeconds + seconds);
}

function matchingSignal(
  rows: EnrichedCandle[], index: number, atr: number | null, settings: BacktestSettings, seconds: number,
): Signal | null {
  const current = rows[index]!;
  const { open, high, low, close, ma10, ma20, ma60 } = current;
  if (index < setupLookback || atr === null || ma10 === null || ma20 === null || ma60 === null || close === open) return null;

  const long = close > open;
  const side = long ? 'LONG' : 'SHORT';
  const direction = long ? 1 : -1;
  if (settings.side !== 'BOTH' && settings.side !== side) return null;
  const previous = rows[index - 1]!;
  const body = Math.abs(close - open);
  const wick = long ? high - close : close - low;
  const priceTolerance = Number.EPSILON * 8 * Math.max(high, previous.high);
  if (body + priceTolerance < 2 * Math.abs(previous.close - previous.open) || body <= 1.5 * wick + priceTolerance) return null;

  const maTolerance = Math.max(ma10, ma20, ma60) * 1e-10;
  const targetDistance = direction * (ma60 - close);
  // Closing beyond MA20 also guarantees that the high or low has crossed it.
  if (direction * (close - ma20) <= maTolerance || targetDistance <= maTolerance
    || Math.abs(ma20 - ma10) * 3 > direction * (ma60 - ma20) + maTolerance
    || targetDistance + maTolerance < 2 * atr) return null;

  let previousGap = Infinity;
  let hasOpposingMaOrder = false;
  let stop = long ? low : high;
  for (let before = index - setupLookback; before < index; before += 1) {
    const row = rows[before]!;
    if (row.closeTime !== rows[before + 1]!.openTime || row.ma10 === null || row.ma20 === null) return null;
    const extreme = long ? row.high : row.low;
    if (direction * (row.ma20 - extreme) <= maTolerance) return null;
    const gap = direction * (row.ma20 - row.ma10);
    if (previousGap - gap <= maTolerance) return null;
    previousGap = gap;
    hasOpposingMaOrder ||= gap > maTolerance;
    stop = long ? Math.min(stop, row.low) : Math.max(stop, row.high);
  }
  if (!hasOpposingMaOrder) return null;
  return {
    strategy: 'MA_DISPARITY', side, index: current.openTime / seconds, entry: close,
    stop, initialStop: stop, target: ma60, initialTarget: ma60, ma20, ma60,
  };
}

export function prepareMaDisparity(candles: Candle[], settings: BacktestSettings): { signal: Signal | null; ma60Exit: number | null }[] {
  const seconds = intervalSeconds(settings.interval);
  const rows = enrichCandles(candles);
  const atrs = calendarAtr(candles, settings.interval);
  // Price equals (sum of the prior 59 closes + live price) / 60 at their mean.
  const touchLevels = priorMovingAverages(candles, ma60PriorBars);
  return rows.map((_row, index) => ({
    signal: matchingSignal(rows, index, atrs[index]!.complete ? atrs[index]!.value : null, settings, seconds),
    ma60Exit: touchLevels[index]!,
  }));
}

export const maDisparitySummary = '직전 3봉이 MA20 한쪽에 머물다가 처음 돌파하고 이격·ATR 조건을 충족하면 확정 종가에 진입합니다. 손절은 진입봉 포함 4봉의 최저가(롱)·최고가(숏)에 두고, MA60에 닿으면 전량 청산합니다.';

export const maDisparityRules = {
  long: [
    '현재 봉은 양봉이고 몸통은 직전 봉의 2배 이상이어야 합니다.',
    '현재 봉의 몸통은 윗꼬리의 1.5배보다 커야 합니다.',
    '직전 3봉 중 MA20 > MA10인 봉이 하나 이상 있어야 합니다.',
    '직전 3봉의 고가는 각각 해당 봉의 MA20보다 낮고, 현재 봉의 고가는 MA20을 넘어야 합니다.',
    '직전 3봉에서 MA20 − MA10 값이 순서대로 감소해야 합니다.',
    '현재 봉에서 MA60 > 종가 > MA20이어야 합니다.',
    '현재 봉에서 3 × |MA20 − MA10| ≤ MA60 − MA20이어야 합니다.',
    '현재 봉에서 MA60 − 종가 ≥ 2 × ATR이어야 합니다.',
    '손절가는 진입봉과 직전 3봉의 최저가입니다. 이후 가격이 MA60에 닿으면 전량 청산합니다.',
  ],
  short: [
    '현재 봉은 음봉이고 몸통은 직전 봉의 2배 이상이어야 합니다.',
    '현재 봉의 몸통은 아랫꼬리의 1.5배보다 커야 합니다.',
    '직전 3봉 중 MA20 < MA10인 봉이 하나 이상 있어야 합니다.',
    '직전 3봉의 저가는 각각 해당 봉의 MA20보다 높고, 현재 봉의 저가는 MA20 아래로 내려가야 합니다.',
    '직전 3봉에서 MA10 − MA20 값이 순서대로 감소해야 합니다.',
    '현재 봉에서 MA60 < 종가 < MA20이어야 합니다.',
    '현재 봉에서 3 × |MA20 − MA10| ≤ MA20 − MA60이어야 합니다.',
    '현재 봉에서 종가 − MA60 ≥ 2 × ATR이어야 합니다.',
    '손절가는 진입봉과 직전 3봉의 최고가입니다. 이후 가격이 MA60에 닿으면 전량 청산합니다.',
  ],
  common: '진입은 확정 종가에 판단합니다. ATR은 진입봉이 시작하기 전 20일간 선택 주기의 실제 변동폭(TR) 평균입니다. 진입 다음 봉부터 진행 중인 봉의 가격을 포함한 MA60 터치와 손절을 15분봉 순서로 확인합니다. 같은 15분봉에서 순서를 알 수 없으면 손절을 우선합니다.',
};
