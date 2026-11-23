import { enrichCandles, intervalSeconds } from './api';
import { atrWindowSeconds, calendarAtr } from './atr';
import { priorMovingAverages } from './envelope';
import type { BacktestInterval, BacktestSettings, Candle, EnrichedCandle, Signal } from './types';

const longLookback = 10;
const shortLookback = 5;
const longHighLookback = 20;

export interface NewHighExitLevels {
  previousLow: number | null;
  ma60Touch: number | null;
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
  // The oldest comparison in the long setup is 10 bars before the oldest
  // potential prior signal. ATR needs one more close to form its first TR.
  const atrLookback = settings.side === 'SHORT' ? shortLookback : 2 * longLookback;
  const maLookback = settings.side === 'LONG' ? 19 + 2 * longLookback : 59 + shortLookback;
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

function matchesLong(rows: EnrichedCandle[], gaps: (number | null)[], atrs: (number | null)[], index: number): boolean {
  if (index < longHighLookback) return false;
  const { open, high, low, close, volume, ma5, ma10, ma20 } = rows[index]!;
  const previous = rows[index - 1]!;
  const body = close - open;
  // Price subtraction can round an exact 5× body or 1.5× wick comparison.
  const candleTolerance = Number.EPSILON * 8 * Math.max(high, previous.high);
  if (body <= 0 || body + candleTolerance < 5 * Math.abs(previous.close - previous.open)
    || volume < 5 * previous.volume || body <= 1.5 * (high - close) + candleTolerance) return false;
  if (ma5 === null || ma10 === null || ma20 === null) return false;
  const tolerance = Math.max(ma5, ma10, ma20) * 1e-10;
  if (!((high + low) / 2 > ma5 + tolerance && ma5 > ma10 + tolerance && ma10 > ma20 + tolerance)) return false;
  if (!gapChanges(gaps, index, 1, tolerance)) return false;
  if (!rows.slice(index - longHighLookback, index).every(row => close > row.high)) return false;
  for (let earlier = index - longLookback; earlier < index; earlier += 1) {
    const gap = gaps[earlier];
    const atr = atrs[earlier];
    if (gap != null && atr != null && Math.abs(gap) + rows[earlier]!.close * 1e-10 < atr) return true;
  }
  return false;
}

function matchesShort(rows: EnrichedCandle[], gaps: (number | null)[], atrs: (number | null)[], index: number): boolean {
  const { open, close, ma10, ma20, ma60 } = rows[index]!;
  const atr = atrs[index];
  if (index < shortLookback || close >= open || ma10 === null || ma20 === null || ma60 === null || atr == null) return false;
  const tolerance = Math.max(ma10, ma20, ma60) * 1e-10;
  if (!(close < ma10 - tolerance && close < ma20 - tolerance && close > ma60 + tolerance && ma20 > ma60 + tolerance)) return false;
  if (!(close - ma60 > atr + tolerance && Math.abs(ma20 - ma60) > 2 * Math.abs(ma10 - ma20) + tolerance)) return false;
  if (!gapChanges(gaps, index, -1, tolerance)) return false;
  const prior = rows.slice(index - shortLookback, index);
  return prior.every(row => close < row.low)
    && prior.some(row => row.ma20 !== null && row.close > row.ma20 + row.ma20 * 1e-10)
    && prior.some(row => row.ma10 !== null && row.ma20 !== null && row.ma10 > row.ma20 + row.ma20 * 1e-10);
}

export function prepareNewHigh(candles: Candle[], settings: BacktestSettings): { signal: Signal | null; newHigh: NewHighExitLevels }[] {
  const seconds = newHighIntervalSeconds(settings.interval);
  const rows = enrichCandles(candles);
  const atrs = calendarAtr(candles, settings.interval).map(atr => atr.complete ? atr.value : null);
  const gaps = rows.map(row => row.ma10 === null || row.ma20 === null ? null : row.ma10 - row.ma20);
  // Price = (59 completed closes + price) / 60 at the touch, so the
  // crossing level is the mean of those 59 closes, known at the bar open.
  const ma60Touches = priorMovingAverages(candles, 59);
  const riskAmount = settings.newHighSizingMode === 'RISK' ? newHighRiskAmount(settings) : undefined;
  let lastLongSetup = -Infinity;
  let lastShortSetup = -Infinity;
  return rows.map((row, index) => {
    const long = settings.side !== 'SHORT' && matchesLong(rows, gaps, atrs, index);
    const short = settings.side !== 'LONG' && matchesShort(rows, gaps, atrs, index);
    const firstLong = long && index - lastLongSetup > longLookback;
    const firstShort = short && index - lastShortSetup > shortLookback;
    // A matching setup blocks a repeat even if no order was placed at that setup.
    if (long) lastLongSetup = index;
    if (short) lastShortSetup = index;
    let signal: Signal | null = null;
    if (firstLong || firstShort) {
      const side = firstLong ? 'LONG' : 'SHORT';
      const older = rows[index - 2]!;
      const previous = rows[index - 1]!;
      const stop = firstLong ? Math.min(older.low, previous.low, row.low) : Math.max(older.high, previous.high, row.high);
      signal = {
        strategy: 'NEW_HIGH', side, index: row.openTime / seconds, entry: row.close,
        stop, initialStop: stop, target: 0, initialTarget: 0, exitMode: 'NEW_HIGH_TOUCH',
        ...(riskAmount === undefined ? {} : { riskAmount }),
      };
    }
    return { signal, newHigh: { previousLow: rows[index - 1]?.low ?? null, ma60Touch: ma60Touches[index] ?? null } };
  });
}

export const newHighRules = {
  long: [
    '현재 봉이 양봉이고, 몸통 길이와 거래량이 각각 직전 봉의 5배 이상이어야 합니다.',
    '현재 몸통 길이가 윗꼬리의 1.5배보다 커야 합니다.',
    '직전 10봉 중 적어도 한 봉에서 |MA10 − MA20|이 해당 봉의 ATR보다 작아야 합니다.',
    '현재 봉의 고가·저가 중간값 > MA5 > MA10 > MA20이어야 합니다.',
    '현재 봉을 포함한 최근 3봉에서 MA10 − MA20 값이 연속으로 증가해야 합니다.',
    '현재 종가가 직전 20봉의 최고가를 넘어야 합니다.',
    '직전 10봉에 위 진입 조건을 모두 충족한 봉이 없으면 현재 봉 종가에 진입합니다.',
    '손절가는 진입봉을 포함한 최근 3봉의 최저가에 고정합니다.',
    '진입 후 종가가 실제 매수가보다 높고 직전 봉 저가보다 낮은 봉이 나오면 그 종가에 청산합니다.',
  ],
  short: [
    '현재 봉이 음봉이고 종가가 직전 5봉의 최저가보다 낮아야 합니다.',
    '직전 5봉 안에 종가 > MA20인 봉과 MA10 > MA20인 봉이 각각 있어야 합니다.',
    '현재 종가는 MA10과 MA20보다 낮고 MA60보다 높아야 합니다. MA20도 MA60보다 높아야 합니다.',
    '현재 종가 − MA60이 현재 봉의 ATR보다 커야 합니다.',
    '|MA20 − MA60|이 |MA10 − MA20|의 2배보다 커야 합니다.',
    '현재 봉을 포함한 최근 3봉에서 MA10 − MA20 값이 연속으로 감소해야 합니다.',
    '직전 5봉에 위 진입 조건을 모두 충족한 봉이 없으면 현재 봉 종가에 진입합니다.',
    '손절가는 진입봉을 포함한 최근 3봉의 최고가에 고정합니다.',
    '진입 다음 봉부터 가격이 선택 주기의 MA60에 닿으면 청산합니다. 터치 가격은 직전 완료 59봉의 종가 평균으로 계산합니다.',
  ],
  common: '이동평균은 선택 주기의 종가를 사용합니다. ATR은 각 봉이 시작하기 전 20일간 선택 주기의 실제 변동폭(TR) 평균입니다. 손절과 숏의 MA60 터치는 진입 다음 봉부터 15분봉 순서로 확인합니다. 같은 15분봉 안에서 두 선을 모두 건드려 순서를 알 수 없으면 손절을 우선합니다. 진입·청산 슬리피지 0.02%와 편도 수수료 0.055%를 반영합니다.',
};
