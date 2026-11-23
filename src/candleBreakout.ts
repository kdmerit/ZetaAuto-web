import { intervalSeconds } from './api';
import { atrWindowSeconds, calendarAtr } from './atr';
import type { BacktestSettings, Candle, Signal } from './types';

export function currentCandleBreakoutSettings(settings: BacktestSettings): BacktestSettings {
  const {
    candleBreakoutCloseMa20Enabled: _aboveMa20,
    candleBreakoutCloseMa20BelowEnabled: _belowMa20,
    candleBreakoutCloseMa60Enabled: _aboveMa60,
    candleBreakoutMa20DistanceEnabled: _ma20Distance,
    candleBreakoutMa20AboveMa60Enabled: _maAlignment,
    candleBreakoutAtrStopEnabled: _atrStop,
    ...current
  } = settings;
  return { ...current, partialTpEnabled: false };
}

/**
 * The setup is evaluated only after the current candle has closed.  ATR is the
 * completed calendar-day average available before that candle opened, so the
 * current candle cannot leak its own range into the setup filter.
 */
export function candleBreakoutSignals(candles: Candle[], settings: BacktestSettings): Signal[] {
  const atrs = calendarAtr(candles, settings.interval);
  const signals: Signal[] = [];

  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1]!;
    const current = candles[index]!;
    const { value: atr, complete } = atrs[index]!;
    if (previous.closeTime !== current.openTime || !complete || atr === null || !Number.isFinite(atr) || atr <= 0) continue;

    const previousBody = previous.close - previous.open;
    const currentBody = current.close - current.open;
    const previousRange = previous.high - previous.low;
    const currentRange = current.high - current.low;
    // Equal decimal price differences can round to slightly different numbers.
    const tolerance = Number.EPSILON * 8 * Math.max(current.high, previous.high);
    if (!(Math.abs(currentBody) > Math.abs(previousBody) + tolerance
      && currentRange > previousRange + tolerance
      && currentRange > atr + tolerance)) continue;

    const long = previousBody < 0 && currentBody > 0;
    const short = previousBody > 0 && currentBody < 0;
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
    });
  }
  return signals;
}

export function candleBreakoutWarmup(settings: BacktestSettings): number {
  return atrWindowSeconds + intervalSeconds(settings.interval);
}
