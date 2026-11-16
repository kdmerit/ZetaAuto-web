import type { BacktestSettings, Candle } from '../types';

/** Explicit synthetic minute path for integration tests; production never interpolates candles. */
export function minuteRows(parents: Candle[]): Candle[] {
  return parents.flatMap(parent => Array.from({ length: (parent.closeTime - parent.openTime) / 60 }, (_, index) => {
    const values = index === 0 ? [parent.open, parent.open, parent.open, parent.open]
      : index === 1 ? [parent.open, parent.open, parent.low, parent.low]
        : index === 2 ? [parent.low, parent.high, parent.low, parent.high]
          : index === 3 ? [parent.high, parent.high, Math.min(parent.high, parent.close), parent.close]
            : [parent.close, parent.close, parent.close, parent.close];
    return { openTime: parent.openTime + index * 60, closeTime: parent.openTime + (index + 1) * 60,
      open: values[0]!, high: values[1]!, low: values[2]!, close: values[3]!, volume: parent.volume * 60 / (parent.closeTime - parent.openTime) };
  }));
}

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
