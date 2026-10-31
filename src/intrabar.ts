import type { Candle } from './types';

/** Never silently replace missing 1m ordering with a parent-bar OHLC guess. */
export function validateMinuteCandles(parent: Candle, minutes: Candle[]): void {
  const count = (parent.closeTime - parent.openTime) / 60;
  if (minutes.length !== count || minutes.some((candle, i) => candle.openTime !== parent.openTime + i * 60
    || candle.closeTime !== candle.openTime + 60 || !Object.values(candle).every(Number.isFinite)
    || Math.min(candle.open, candle.high, candle.low, candle.close) <= 0
    || candle.low > Math.min(candle.open, candle.close) || candle.high < Math.max(candle.open, candle.close) || candle.high < candle.low)) {
    throw new Error('봉 중간 체결에 필요한 1분봉이 누락되거나 손상됐습니다. 분석을 다시 이어가 주세요.');
  }
  const values = [minutes[0]!.open, Math.max(...minutes.map(candle => candle.high)), Math.min(...minutes.map(candle => candle.low)), minutes.at(-1)!.close];
  if ([parent.open, parent.high, parent.low, parent.close].some((value, i) => Math.abs(value - values[i]!) > Math.max(Math.abs(value), Math.abs(values[i]!), 1e-12) * 1e-8)) {
    throw new Error('선택 주기와 1분봉의 가격이 일치하지 않습니다. 분석 데이터를 확인해 주세요.');
  }
}
