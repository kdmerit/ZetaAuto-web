import type { BacktestSettings, Candle } from '../types';

/** Deterministic, globally consistent daily trend alternates up/down during either fixture month. */
export function dailyTrendRows(settings: Pick<BacktestSettings, 'startDate' | 'startTime' | 'endDate' | 'endTime'>): Candle[] {
  const start = Math.floor(Date.parse(`${settings.startDate}T${settings.startTime}:00+09:00`) / 86400000) * 86400 - 25 * 86400;
  const end = Math.ceil(Date.parse(`${settings.endDate}T${settings.endTime}:00+09:00`) / 86400000) * 86400;
  return Array.from({ length: (end - start) / 86400 }, (_, index) => {
    const at = start + index * 86400;
    const price = 100 + 10 * Math.sin(at / 86400 * Math.PI / 6);
    return { openTime: at, closeTime: at + 86400, open: price, high: price + 1, low: price - 1, close: price, volume: 10 };
  });
}
