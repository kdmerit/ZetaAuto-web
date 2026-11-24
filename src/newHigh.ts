import { enrichCandles, intervalSeconds } from './api';
import { atrWindowSeconds, calendarAtr } from './atr';
import type { BacktestInterval, BacktestSettings, Candle, EnrichedCandle, Signal } from './types';

const setupLookback = 10;
const breakoutLookback = 10;

export interface NewHighExitLevels {
  ma10: number | null;
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
  // The oldest possible prior setup needs its own MA60 and ten earlier ATRs.
  // ATR needs one additional close to form its first true range.
  const atrLookback = 2 * setupLookback;
  const maLookback = 59 + setupLookback;
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

function matchingSetup(rows: EnrichedCandle[], gaps: (number | null)[], atrs: (number | null)[], index: number): Signal['side'] | null {
  if (index < breakoutLookback) return null;
  const { open, high, low, close, volume, ma5, ma10, ma20, ma60 } = rows[index]!;
  const atr = atrs[index];
  if (ma5 === null || ma10 === null || ma20 === null || ma60 === null || atr == null) return null;

  const previous = rows[index - 1]!;
  const long = close > open;
  const direction = long ? 1 : -1;
  const body = Math.abs(close - open);
  const wick = long ? high - close : close - low;
  // Price subtraction can round an exact 5× body or 1.5× wick comparison.
  const candleTolerance = Number.EPSILON * 8 * Math.max(high, previous.high);
  if (body === 0 || body + candleTolerance < 5 * Math.abs(previous.close - previous.open)
    || volume < 5 * previous.volume || body <= 1.5 * wick + candleTolerance) return null;
  if (Math.abs(ma20 - ma60) > atr + Math.max(ma20, ma60) * 1e-10) return null;

  const tolerance = Math.max(ma5, ma10, ma20) * 1e-10;
  const midpoint = (high + low) / 2;
  if (direction * (midpoint - ma5) <= tolerance || direction * (ma5 - ma10) <= tolerance
    || direction * (ma10 - ma20) <= tolerance || !gapChanges(gaps, index, direction, tolerance)) return null;
  if (!rows.slice(index - breakoutLookback, index).every(row => long ? close > row.high : close < row.low)) return null;

  for (let earlier = index - setupLookback; earlier < index; earlier += 1) {
    const gap = gaps[earlier];
    const earlierAtr = atrs[earlier];
    if (gap != null && earlierAtr != null && Math.abs(gap) + rows[earlier]!.close * 1e-10 < earlierAtr) return long ? 'LONG' : 'SHORT';
  }
  return null;
}

export function prepareNewHigh(candles: Candle[], settings: BacktestSettings): { signal: Signal | null; newHigh: NewHighExitLevels }[] {
  const seconds = newHighIntervalSeconds(settings.interval);
  const rows = enrichCandles(candles);
  const atrs = calendarAtr(candles, settings.interval).map(atr => atr.complete ? atr.value : null);
  const gaps = rows.map(row => row.ma10 === null || row.ma20 === null ? null : row.ma10 - row.ma20);
  const riskAmount = settings.newHighSizingMode === 'RISK' ? newHighRiskAmount(settings) : undefined;
  const lastSetup = { LONG: -Infinity, SHORT: -Infinity };
  return rows.map((row, index) => {
    const side = matchingSetup(rows, gaps, atrs, index);
    let signal: Signal | null = null;
    if (side && (settings.side === 'BOTH' || settings.side === side)) {
      if (index - lastSetup[side] > setupLookback) {
        const stop = side === 'LONG' ? row.low : row.high;
        signal = {
          strategy: 'NEW_HIGH', side, index: row.openTime / seconds, entry: row.close,
          stop, initialStop: stop, target: 0, initialTarget: 0, exitMode: 'NEW_HIGH_TOUCH',
          ...(riskAmount === undefined ? {} : { riskAmount }),
        };
      }
      // A matching setup blocks a repeat even if no order was placed at that setup.
      lastSetup[side] = index;
    }
    return { signal, newHigh: { ma10: row.ma10 } };
  });
}

export const newHighRules = {
  long: [
    '현재 봉이 양봉이고, 몸통 길이와 거래량이 각각 직전 봉의 5배 이상이어야 합니다.',
    '현재 몸통 길이가 윗꼬리의 1.5배보다 커야 합니다.',
    '직전 10봉 중 적어도 한 봉에서 |MA10 − MA20|이 해당 봉의 ATR보다 작아야 합니다.',
    '현재 봉의 고가·저가 중간값 > MA5 > MA10 > MA20이어야 합니다.',
    '현재 봉의 |MA20 − MA60|이 해당 봉의 ATR 이하여야 합니다.',
    '현재 봉을 포함한 최근 3봉에서 MA10 − MA20 값이 연속으로 증가해야 합니다.',
    '현재 종가가 직전 10봉의 최고가를 넘어야 합니다.',
    '직전 10봉에 위 진입 조건을 모두 충족한 봉이 없으면 현재 봉 종가에 진입합니다.',
    '손절가는 진입봉의 저가에 고정합니다.',
    '진입 후 종가가 해당 봉의 MA10보다 낮으면 그 종가에 청산합니다.',
  ],
  short: [
    '현재 봉이 음봉이고, 몸통 길이와 거래량이 각각 직전 봉의 5배 이상이어야 합니다.',
    '현재 몸통 길이가 아랫꼬리의 1.5배보다 커야 합니다.',
    '직전 10봉 중 적어도 한 봉에서 |MA10 − MA20|이 해당 봉의 ATR보다 작아야 합니다.',
    '현재 봉의 고가·저가 중간값 < MA5 < MA10 < MA20이어야 합니다.',
    '현재 봉의 |MA20 − MA60|이 해당 봉의 ATR 이하여야 합니다.',
    '현재 봉을 포함한 최근 3봉에서 MA10 − MA20 값이 연속으로 감소해야 합니다.',
    '현재 종가가 직전 10봉의 최저가보다 낮아야 합니다.',
    '직전 10봉에 위 진입 조건을 모두 충족한 봉이 없으면 현재 봉 종가에 진입합니다.',
    '손절가는 진입봉의 고가에 고정합니다.',
    '진입 후 종가가 해당 봉의 MA10보다 높으면 그 종가에 청산합니다.',
  ],
  common: '이동평균은 판단하는 봉까지의 선택 주기 확정 종가로 계산합니다. ATR은 각 봉이 시작하기 전 20일간 선택 주기의 실제 변동폭(TR) 평균입니다. 손절은 진입 다음 봉부터 15분봉 순서로 확인하며 종가 청산보다 우선합니다. 진입·청산 슬리피지 0.02%와 편도 수수료 0.055%를 반영합니다.',
};
