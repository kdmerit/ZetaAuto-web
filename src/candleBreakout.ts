import { enrichCandles, intervalSeconds } from './api';
import { atrWindowSeconds, calendarAtr } from './atr';
import type { BacktestInterval, BacktestSettings, Candle, Signal } from './types';

/**
 * The setup is evaluated only after the current candle has closed.  ATR is the
 * completed calendar-day average available before that candle opened, so the
 * current candle cannot leak its own range into the setup filter.
 */
export function candleBreakoutSignals(candles: Candle[], settings: BacktestSettings): Signal[] {
  const enriched = enrichCandles(candles);
  const atrs = calendarAtr(candles, settings.interval);
  const signals: Signal[] = [];

  for (let index = 2; index < candles.length; index += 1) {
    const older = candles[index - 2]!;
    const previous = candles[index - 1]!;
    const current = candles[index]!;
    const atrRow = atrs[index];
    const atr = atrRow?.value;
    const ma5 = enriched[index]?.ma5;
    const olderMa5 = enriched[index - 2]?.ma5;
    const previousMa5 = enriched[index - 1]?.ma5;
    if (!atrRow?.complete || atr === null || atr === undefined || !Number.isFinite(atr) || atr <= 0
      || ma5 === null || ma5 === undefined || !Number.isFinite(ma5)
      || olderMa5 === null || olderMa5 === undefined || !Number.isFinite(olderMa5)
      || previousMa5 === null || previousMa5 === undefined || !Number.isFinite(previousMa5)) continue;

    const olderBody = Math.abs(older.close - older.open);
    const previousBody = Math.abs(previous.close - previous.open);
    const olderBearish = older.close < older.open;
    const previousBearish = previous.close < previous.open;
    const olderBullish = older.close > older.open;
    const previousBullish = previous.close > previous.open;
    const long = olderBearish && previousBearish
      && olderBody < atr && previousBody < atr
      && older.close > previous.close
      && current.close > current.open
      && current.close > Math.max(bodyHigh(older), bodyHigh(previous))
      && bodyHigh(older) < olderMa5
      && bodyHigh(previous) < previousMa5
      // “돌파” means the current body starts below MA5 and closes above it.
      && current.open < ma5 && current.close > ma5;

    const short = olderBullish && previousBullish
      && olderBody < atr && previousBody < atr
      && older.close < previous.close
      && current.close < current.open
      && current.close < Math.min(bodyLow(older), bodyLow(previous))
      && bodyLow(older) > olderMa5
      && bodyLow(previous) > previousMa5
      && current.open > ma5 && current.close < ma5;

    if (!long && !short) continue;
    const side: Signal['side'] = long ? 'LONG' : 'SHORT';
    if (settings.side !== 'BOTH' && settings.side !== side) continue;
    const body = Math.abs(current.close - current.open);
    const target = side === 'LONG' ? current.close + body * 2 : current.close - body * 2;
    const stop = side === 'LONG' ? current.low : current.high;
    if (!Number.isFinite(body) || body <= 0 || !Number.isFinite(target) || target <= 0 || !Number.isFinite(stop) || stop <= 0) continue;
    signals.push({
      strategy: 'CANDLE_BREAKOUT',
      side,
      index,
      entry: current.close,
      stop,
      initialStop: stop,
      target,
      initialTarget: target,
      candleBreakoutEntryAtr: atr,
      exitMode: 'CANDLE_BREAKOUT_TP',
    });
  }
  return signals;
}

function bodyHigh(candle: Candle): number {
  return Math.max(candle.open, candle.close);
}

function bodyLow(candle: Candle): number {
  return Math.min(candle.open, candle.close);
}

export function candleBreakoutWarmup(settings: BacktestSettings): number {
  return Math.max(atrWindowSeconds + intervalSeconds(settings.interval), 5 * intervalSeconds(settings.interval));
}

export function candleBreakoutIntervalDescription(interval: BacktestInterval): string {
  return `선택한 ${interval.toUpperCase()} 캔들의 ATR·MA5를 사용합니다.`;
}
