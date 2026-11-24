import { enrichCandles, intervalSeconds } from './api';
import { atrWindowSeconds, calendarAtr } from './atr';
import type { BacktestInterval, BacktestSettings, Candle, EnrichedCandle, Signal } from './types';

const setupLookback = 5;

export interface NewHighExitLevels {
  ma20: number | null;
}

function newHighIntervalSeconds(interval: BacktestInterval): number {
  if (interval === '15m') throw new Error('신고가 백테스트는 1h·4h·1d만 사용할 수 있습니다.');
  return intervalSeconds(interval);
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
  const seconds = newHighIntervalSeconds(settings.interval);
  // The oldest possible prior setup needs three consecutive MA60s and five earlier ATRs.
  // ATR needs one additional close to form its first true range.
  const atrLookback = 2 * setupLookback;
  const maLookback = 59 + 2 + setupLookback;
  return Math.max(atrWindowSeconds + (atrLookback + 1) * seconds, maLookback * seconds);
}

export function currentNewHighSettings(settings: BacktestSettings): BacktestSettings {
  const {
    newHighLookback: _lookback,
    newHighBreakoutCandleMinEnabled: _minEnabled,
    newHighBreakoutCandleMinAtr: _minAtr,
    newHighBreakoutCandleMaxEnabled: _maxEnabled,
    newHighBreakoutCandleMaxAtr: _maxAtr,
    newHighSlEnabled: _slEnabled,
    newHighSlMultiplier: _sl,
    newHighTpEnabled: _tpEnabled,
    newHighTpMultiplier: _tp,
    newHighTrailingStopEnabled: _trailingEnabled,
    newHighTrailingStopMultiplier: _trailing,
    newHighMa60Enabled: _ma60,
    newHighMa10Enabled: _ma10,
    newHighDailyMa20Enabled: _dailyMa20,
    ...current
  } = settings;
  return {
    ...current,
    interval: current.interval === '15m' ? '1h' : current.interval,
    newHighSizingMode: current.newHighSizingMode ?? 'BET',
    newHighRiskAmount: current.newHighRiskAmount ?? current.betAmountUsdt,
    partialTpEnabled: false,
  };
}

function gapChanges(gaps: (number | null)[], index: number, direction: 1 | -1, tolerance: number): boolean {
  const older = gaps[index - 2];
  const previous = gaps[index - 1];
  const current = gaps[index];
  return older != null && previous != null && current != null
    && direction * (previous - older) > tolerance
    && direction * (current - previous) > tolerance;
}

function crossesMa60(before: EnrichedCandle, after: EnrichedCandle, direction: 1 | -1): boolean {
  if (before.ma60 === null || after.ma60 === null) return false;
  const beforePrice = direction === 1 ? before.high : before.low;
  const afterPrice = direction === 1 ? after.high : after.low;
  return direction * (beforePrice - before.ma60) < -before.ma60 * 1e-10
    && direction * (afterPrice - after.ma60) > after.ma60 * 1e-10;
}

function matchingSetup(
  rows: EnrichedCandle[],
  ma10Ma20Gaps: (number | null)[],
  ma20Ma60Gaps: (number | null)[],
  atrs: (number | null)[],
  index: number,
): { side: Signal['side']; stop: number } | null {
  if (index < setupLookback) return null;
  const current = rows[index]!;
  const { open, high, low, close, ma5, ma10, ma20, ma60 } = current;
  const atr = atrs[index];
  if (ma5 === null || ma10 === null || ma20 === null || ma60 === null || atr == null) return null;

  const previous = rows[index - 1]!;
  const long = close > open;
  const direction = long ? 1 : -1;
  const body = Math.abs(close - open);
  const wick = long ? high - close : close - low;
  // Price subtraction can round exact body and wick ratios.
  const candleTolerance = Number.EPSILON * 8 * Math.max(high, previous.high);
  if (body === 0 || body + candleTolerance < 1.5 * Math.abs(previous.close - previous.open)
    || body <= 1.5 * wick + candleTolerance) return null;
  const ma20Ma60Tolerance = Math.max(ma20, ma60) * 1e-10;
  if (Math.abs(ma20 - ma60) > atr + ma20Ma60Tolerance) return null;

  const tolerance = Math.max(ma5, ma10, ma20) * 1e-10;
  const midpoint = (high + low) / 2;
  const breakoutPrice = long ? high : low;
  if (direction * (midpoint - ma5) <= tolerance || direction * (ma5 - ma10) <= tolerance
    || direction * (ma10 - ma20) <= tolerance
    || direction * (breakoutPrice - ma60) <= ma20Ma60Tolerance) return null;
  if (!crossesMa60(previous, current, direction) && !crossesMa60(rows[index - 2]!, previous, direction)) return null;
  if (!gapChanges(ma10Ma20Gaps, index, direction, tolerance)
    || !gapChanges(ma20Ma60Gaps, index, direction, ma20Ma60Tolerance)) return null;

  const prior = rows.slice(index - setupLookback, index);
  const highest = Math.max(...prior.map(row => row.high));
  const lowest = Math.min(...prior.map(row => row.low));
  if (long ? high <= highest : low >= lowest) return null;
  const stop = long ? lowest : highest;
  const stopBoundary = long ? Math.min(ma10, ma20, ma60) : Math.max(ma10, ma20, ma60);
  if (direction * (stopBoundary - stop) <= stopBoundary * 1e-10) return null;

  for (let earlier = index - setupLookback; earlier < index; earlier += 1) {
    const gap = ma10Ma20Gaps[earlier];
    const earlierAtr = atrs[earlier];
    if (gap != null && earlierAtr != null && Math.abs(gap) + rows[earlier]!.close * 1e-10 < earlierAtr) {
      return { side: long ? 'LONG' : 'SHORT', stop };
    }
  }
  return null;
}

export function prepareNewHigh(candles: Candle[], settings: BacktestSettings): { signal: Signal | null; newHigh: NewHighExitLevels }[] {
  const seconds = newHighIntervalSeconds(settings.interval);
  const rows = enrichCandles(candles);
  const atrs = calendarAtr(candles, settings.interval).map(atr => atr.complete ? atr.value : null);
  const ma10Ma20Gaps = rows.map(row => row.ma10 === null || row.ma20 === null ? null : row.ma10 - row.ma20);
  const ma20Ma60Gaps = rows.map(row => row.ma20 === null || row.ma60 === null ? null : row.ma20 - row.ma60);
  const riskAmount = settings.newHighSizingMode === 'RISK' ? newHighRiskAmount(settings) : undefined;
  const lastSetup = { LONG: -Infinity, SHORT: -Infinity };
  return rows.map((row, index) => {
    const setup = matchingSetup(rows, ma10Ma20Gaps, ma20Ma60Gaps, atrs, index);
    let signal: Signal | null = null;
    if (setup && (settings.side === 'BOTH' || settings.side === setup.side)) {
      const { side, stop } = setup;
      if (index - lastSetup[side] > setupLookback) {
        signal = {
          strategy: 'NEW_HIGH', side, index: row.openTime / seconds, entry: row.close,
          stop, initialStop: stop, target: 0, initialTarget: 0, exitMode: 'NEW_HIGH_TOUCH',
          ...(riskAmount === undefined ? {} : { riskAmount }),
        };
      }
      // A matching setup blocks a repeat even if no order was placed at that setup.
      lastSetup[side] = index;
    }
    return { signal, newHigh: { ma20: row.ma20 } };
  });
}

export const newHighRules = {
  long: [
    '현재 봉이 양봉이고, 몸통 길이가 직전 봉 몸통의 1.5배 이상이어야 합니다.',
    '현재 몸통 길이가 윗꼬리의 1.5배보다 커야 합니다.',
    '직전 5봉 중 적어도 한 봉에서 |MA10 − MA20|이 해당 봉의 ATR보다 작아야 합니다.',
    '현재 봉의 고가·저가 중간값 > MA5 > MA10 > MA20이고, 현재 봉의 고가 > MA60이어야 합니다. 직전 5봉의 최저가는 현재 봉의 MA10·MA20·MA60보다 모두 낮아야 합니다. 현재 봉이나 직전 봉에서 고가가 MA60 아래에서 위로 돌파해야 합니다.',
    '현재 봉의 |MA20 − MA60|이 해당 봉의 ATR 이하여야 합니다.',
    '현재 봉을 포함한 최근 3봉에서 MA10 − MA20과 MA20 − MA60이 각각 연속으로 증가해야 합니다. MA20 − MA60이 음수에서 양수로 바뀌는 경우도 증가로 봅니다.',
    '현재 봉의 고가가 직전 5봉의 최고가를 넘어야 합니다.',
    '직전 5봉에 위 진입 조건을 모두 충족한 봉이 없으면 현재 봉의 확정 종가에 진입합니다.',
    '손절가는 진입봉 직전 5봉의 최저가에 고정합니다.',
    '실제 매수가에서 손절 거리만큼 상승하면 최초 수량의 50%를 한 번 익절합니다. 진입 후 종가가 해당 봉의 MA20보다 낮으면 그 종가에 남은 수량을 전부 청산합니다.',
  ],
  short: [
    '현재 봉이 음봉이고, 몸통 길이가 직전 봉 몸통의 1.5배 이상이어야 합니다.',
    '현재 몸통 길이가 아랫꼬리의 1.5배보다 커야 합니다.',
    '직전 5봉 중 적어도 한 봉에서 |MA10 − MA20|이 해당 봉의 ATR보다 작아야 합니다.',
    '현재 봉의 고가·저가 중간값 < MA5 < MA10 < MA20이고, 현재 봉의 저가 < MA60이어야 합니다. 직전 5봉의 최고가는 현재 봉의 MA10·MA20·MA60보다 모두 높아야 합니다. 현재 봉이나 직전 봉에서 저가가 MA60 위에서 아래로 돌파해야 합니다.',
    '현재 봉의 |MA20 − MA60|이 해당 봉의 ATR 이하여야 합니다.',
    '현재 봉을 포함한 최근 3봉에서 MA10 − MA20과 MA20 − MA60이 각각 연속으로 감소해야 합니다. MA20 − MA60이 양수에서 음수로 바뀌는 경우도 감소로 봅니다.',
    '현재 봉의 저가가 직전 5봉의 최저가보다 낮아야 합니다.',
    '직전 5봉에 위 진입 조건을 모두 충족한 봉이 없으면 현재 봉의 확정 종가에 진입합니다.',
    '손절가는 진입봉 직전 5봉의 최고가에 고정합니다.',
    '실제 매수가에서 손절 거리만큼 하락하면 최초 수량의 50%를 한 번 익절합니다. 진입 후 종가가 해당 봉의 MA20보다 높으면 그 종가에 남은 수량을 전부 청산합니다.',
  ],
  common: '이동평균은 판단하는 봉까지의 선택 주기 확정 종가로 계산합니다. MA60 돌파는 각 봉의 고가·저가를 그 봉의 MA60과 비교해서 판단합니다. ATR은 각 봉이 시작하기 전 20일간 선택 주기 실제 변동폭(TR)의 평균입니다. 손절과 부분 익절은 진입 다음 봉부터 15분봉 순서로 확인합니다. 같은 15분봉에서 순서를 알 수 없으면 손절을 우선합니다. 시장가 체결에 슬리피지 0.02%, 모든 체결에 편도 수수료 0.055%를 반영합니다.',
};
