import type { Candle } from '../types';

export function maDisparityEntryCandles(entryOpenAt: number, seconds: number, historyBars = 80): Candle[] {
  const recentCloses = [100, 101, 101.5, 102, 107];
  return Array.from({ length: historyBars + 1 }, (_, index) => {
    const offset = index - historyBars;
    const openTime = entryOpenAt + offset * seconds;
    const close = offset < -20 ? 120 : offset < -11 ? 107 : offset < -4 ? 99 : recentCloses[offset + 4]!;
    const open = offset === 0 ? 105 : offset === -1 ? 101 : close;
    return {
      openTime, closeTime: openTime + seconds, open, close,
      high: close + (offset === 0 ? 0.5 : 0.25), low: offset === -3 ? 98.5 : Math.min(open, close) - 0.25, volume: 10,
    };
  });
}
