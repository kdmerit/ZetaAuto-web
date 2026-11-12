/** Entry-time 1d/4h shapes built exclusively from already observed 15m prices. */
import type { BacktestSettings, Candle } from './types';

export interface EnvelopeCandleContext {
  daily: Candle;
  previousDaily: Candle;
  beforePreviousDaily: Candle;
  fourHourly: Candle;
  previousFourHourly: Candle;
}

/** Two fully completed daily candles plus the current day's observed prefix. */
export function envelopeCandleDataStart(settings: BacktestSettings, start: number): number {
  return settings.envelopeCandleFilterEnabled === true ? Math.floor(start / 86400) * 86400 - 2 * 86400 : start;
}

interface Aggregate { candle: Candle; next: number; complete: boolean }

/** Snapshots contain the current 15m OPEN only; its later extrema are not visible. */
export function envelopeCandleContexts(rows: Candle[]): Map<number, EnvelopeCandleContext> {
  const snapshots = new Map<number, EnvelopeCandleContext>();
  let daily: Aggregate | undefined;
  let fourHourly: Aggregate | undefined;
  const closedDaily: Candle[] = [];
  let previousFourHourly: Candle | undefined;
  const startAggregate = (row: Candle, seconds: number): Aggregate => {
    const start = Math.floor(row.openTime / seconds) * seconds;
    return { candle: { ...row, openTime: start, closeTime: start + seconds, high: row.open, low: row.open, close: row.open, volume: 0 },
      next: row.openTime, complete: row.openTime === start };
  };
  const append = (aggregate: Aggregate, row: Candle): void => {
    aggregate.complete &&= aggregate.next === row.openTime && row.closeTime === row.openTime + 900;
    aggregate.next = row.closeTime;
    aggregate.candle.high = Math.max(aggregate.candle.high, row.high);
    aggregate.candle.low = Math.min(aggregate.candle.low, row.low);
    aggregate.candle.close = row.close;
    aggregate.candle.volume += row.volume;
  };
  for (const row of [...rows].sort((a, b) => a.openTime - b.openTime)) {
    if (!daily || row.openTime >= daily.candle.closeTime) {
      if (daily?.complete && daily.next === daily.candle.closeTime) closedDaily.push(daily.candle);
      else closedDaily.length = 0;
      while (closedDaily.length > 2) closedDaily.shift();
      daily = startAggregate(row, 86400);
    }
    if (!fourHourly || row.openTime >= fourHourly.candle.closeTime) {
      previousFourHourly = fourHourly?.complete && fourHourly.next === fourHourly.candle.closeTime ? fourHourly.candle : undefined;
      fourHourly = startAggregate(row, 14400);
    }
    const previousDaily = closedDaily.at(-1);
    const beforePreviousDaily = closedDaily.at(-2);
    if (daily.complete && fourHourly.complete && daily.next === row.openTime && fourHourly.next === row.openTime
      && previousDaily?.closeTime === daily.candle.openTime && beforePreviousDaily?.closeTime === previousDaily.openTime
      && previousFourHourly?.closeTime === fourHourly.candle.openTime) {
      const observedOpen = (aggregate: Aggregate): Candle => ({ ...aggregate.candle,
        high: Math.max(aggregate.candle.high, row.open), low: Math.min(aggregate.candle.low, row.open), close: row.open });
      snapshots.set(row.openTime, { daily: observedOpen(daily), previousDaily, beforePreviousDaily,
        fourHourly: observedOpen(fourHourly), previousFourHourly });
    }
    append(daily, row);
    append(fourHourly, row);
  }
  return snapshots;
}

const body = (candle: Candle): number => Math.abs(candle.close - candle.open);
const imbalance = (candle: Candle): number => {
  const upper = candle.high - Math.max(candle.open, candle.close);
  const lower = Math.min(candle.open, candle.close) - candle.low;
  return upper + Math.max(0, candle.open - candle.close) - lower - Math.max(0, candle.close - candle.open);
};

/** Any of the four directional exclusions blocks this entry; equality is literal. */
export function envelopeCandleAllowsEntry(context: EnvelopeCandleContext | undefined, side: 'LONG' | 'SHORT', prices: readonly number[]): boolean {
  if (!context || !prices.length || prices.some(price => !Number.isFinite(price) || price <= 0)) return false;
  const observed = (candle: Candle): Candle => ({ ...candle, high: Math.max(candle.high, ...prices), low: Math.min(candle.low, ...prices), close: prices.at(-1)! });
  const daily = observed(context.daily);
  const fourHourly = observed(context.fourHourly);
  const adverse = (candle: Candle): boolean => side === 'LONG' ? candle.close < candle.open : candle.close > candle.open;
  if (adverse(daily) && body(daily) >= 5 * body(context.previousDaily)) return false;
  if (adverse(context.previousDaily) && body(context.previousDaily) >= 5 * body(context.beforePreviousDaily)) return false;
  if (side === 'LONG') {
    if (imbalance(fourHourly) > 0) return false;
    if (imbalance(context.previousFourHourly) > 0 && fourHourly.high < context.previousFourHourly.high) return false;
  } else {
    if (imbalance(fourHourly) < 0) return false;
    if (imbalance(context.previousFourHourly) < 0 && fourHourly.low > context.previousFourHourly.low) return false;
  }
  return true;
}
