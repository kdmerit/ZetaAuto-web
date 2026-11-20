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
    const ma20 = enriched[index]?.ma20;
    const ma60 = enriched[index]?.ma60;
    const ma20CloseEnabled = settings.candleBreakoutCloseMa20Enabled === true;
    const ma20BelowEnabled = settings.candleBreakoutCloseMa20BelowEnabled === true;
    const ma60CloseEnabled = settings.candleBreakoutCloseMa60Enabled === true;
    const ma20DistanceEnabled = settings.candleBreakoutMa20DistanceEnabled === true;
    const ma20AboveMa60Enabled = settings.candleBreakoutMa20AboveMa60Enabled === true;
    const needsMa20 = ma20CloseEnabled || ma20BelowEnabled || ma20DistanceEnabled || ma20AboveMa60Enabled;
    const needsMa60 = ma60CloseEnabled || ma20AboveMa60Enabled;
    if (!atrRow?.complete || atr === null || atr === undefined || !Number.isFinite(atr) || atr <= 0
      || ma5 === null || ma5 === undefined || !Number.isFinite(ma5)
      || olderMa5 === null || olderMa5 === undefined || !Number.isFinite(olderMa5)
      || previousMa5 === null || previousMa5 === undefined || !Number.isFinite(previousMa5)
      || (needsMa20 && (ma20 === null || ma20 === undefined || !Number.isFinite(ma20)))
      || (needsMa60 && (ma60 === null || ma60 === undefined || !Number.isFinite(ma60)))) continue;

    const currentMa20 = ma20 ?? Number.NaN;
    const currentMa60 = ma60 ?? Number.NaN;
    const longCloseFilters = (!ma20CloseEnabled || current.close > currentMa20)
      && (!ma20BelowEnabled || current.close < currentMa20)
      && (!ma60CloseEnabled || current.close > currentMa60)
      && (!ma20DistanceEnabled || current.close <= currentMa20 * 0.99)
      && (!ma20AboveMa60Enabled || currentMa20 > currentMa60);
    const shortCloseFilters = (!ma20CloseEnabled || current.close < currentMa20)
      && (!ma20BelowEnabled || current.close > currentMa20)
      && (!ma60CloseEnabled || current.close < currentMa60)
      && (!ma20DistanceEnabled || current.close >= currentMa20 * 1.01)
      && (!ma20AboveMa60Enabled || currentMa20 < currentMa60);

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
      && current.open < ma5 && current.close > ma5
      && longCloseFilters;

    const short = olderBullish && previousBullish
      && olderBody < atr && previousBody < atr
      && older.close < previous.close
      && current.close < current.open
      && current.close < Math.min(bodyLow(older), bodyLow(previous))
      && bodyLow(older) > olderMa5
      && bodyLow(previous) > previousMa5
      && current.open > ma5 && current.close < ma5
      && shortCloseFilters;

    if (!long && !short) continue;
    const side: Signal['side'] = long ? 'LONG' : 'SHORT';
    if (settings.side !== 'BOTH' && settings.side !== side) continue;
    const stop = side === 'LONG' ? current.low : current.high;
    if (!Number.isFinite(current.close) || current.close <= 0 || !Number.isFinite(stop) || stop <= 0) continue;
    signals.push({
      strategy: 'CANDLE_BREAKOUT',
      side,
      index,
      entry: current.close,
      stop,
      initialStop: stop,
      target: 0,
      initialTarget: 0,
      candleBreakoutEntryAtr: atr,
      ...(settings.candleBreakoutAtrStopEnabled === true ? { candleBreakoutAtrStopDistance: atr } : {}),
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
