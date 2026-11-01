import { enrichCandles, intervalSeconds } from './api';
import { volatilityParameters } from './backtestSettings';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import { bandFor, envelopeParameters, priorMovingAverages, projectEnvelopeBands } from './envelope';
import type {
  BacktestResult,
  BacktestSettings,
  BacktestTrade,
  Candle,
  ChartData,
  EnrichedCandle,
  EnvelopeBand,
  BacktestInterval,
  Execution,
  PriceLine,
  Signal,
  Strategy,
  Wave,
} from './types';

const FEE = 0.00055;
const SLIPPAGE = 0.0002;

interface InternalWave {
  startIndex: number;
  endIndex: number;
  startTime: number;
  endTime: number;
  low: number;
  high: number;
  tailLow: number;
  tailHigh: number;
  first: boolean;
  second: boolean;
}

interface WaveBucket {
  previousPrevious: InternalWave | null;
  previous: InternalWave | null;
  current: InternalWave | null;
}

export interface WaveState {
  trend: number;
  lastBodyHigh: number | null;
  lastBodyLow: number | null;
  lastTailLow: number | null;
  lastTailHigh: number | null;
  lastIndex: number | null;
  lastAt: number | null;
  LONG: WaveBucket;
  SHORT: WaveBucket;
}

interface Position {
  side: 'LONG' | 'SHORT';
  signal: Signal;
  signalCandle: Candle;
  entryAt: number;
  entryIndex: number;
  firstEntry: number;
  averageEntry: number;
  quantity: number;
  firstQuantity: number;
  margin: number;
  reserved: number;
  reservedFee: number;
  pendingSecond: boolean;
  secondPrice: number;
  leverage: number;
  target: number;
  partial: number | null;
  partialDone: boolean;
  activeStop: number;
  initialStop: number;
  executions: Execution[];
  netProfit: number;
}

interface SimulationState {
  cash: number;
  realized: number;
  fees: number;
  position: Position | null;
  trades: BacktestTrade[];
  entries: number;
  secondFills: number;
  signals: number;
  insufficientFunds: number;
  exitReasons: Record<string, number>;
  equityCurve: { at: number; equityUsdt: number }[];
}

export type ProgressCallback = (completed: number, total: number) => void;

const bodyHigh = (candle: Candle): number => Math.max(candle.open, candle.close);
const bodyLow = (candle: Candle): number => Math.min(candle.open, candle.close);

function publicWave(
  wave: InternalWave,
  label: Wave['label'],
  side: 'LONG' | 'SHORT',
): Wave {
  return {
    label,
    direction: side === 'LONG' ? 'UP' : 'DOWN',
    startIndex: wave.startIndex,
    endIndex: wave.endIndex,
    startTime: wave.startIndex,
    endTime: wave.endIndex,
    complete: label !== 'CURRENT',
    low: wave.low,
    high: wave.high,
  };
}

function toWave(
  wave: InternalWave,
  label: Wave['label'],
  candles: Candle[],
  side: 'LONG' | 'SHORT',
): Wave {
  const start = wave.startTime;
  const end = wave.endTime;
  return {
    ...publicWave(wave, label, side),
    startTime: start,
    endTime: end,
  };
}

function emptyBucket(): WaveBucket {
  return { previousPrevious: null, previous: null, current: null };
}

function initialWaveState(): WaveState {
  return {
    trend: 0,
    lastBodyHigh: null,
    lastBodyLow: null,
    lastTailLow: null,
    lastTailHigh: null,
    lastIndex: null,
    lastAt: null,
    LONG: emptyBucket(),
    SHORT: emptyBucket(),
  };
}

function advanceWaveState(state: WaveState, candle: Candle, index: number): void {
  const low = bodyLow(candle);
  const high = bodyHigh(candle);
  if (state.lastBodyLow === null || state.lastBodyHigh === null) {
    state.lastBodyLow = low;
    state.lastBodyHigh = high;
    state.lastTailLow = candle.low;
    state.lastTailHigh = candle.high;
    state.lastIndex = index;
    state.lastAt = candle.openTime;
    return;
  }
  const oldTrend = state.trend;
  const highUp = high >= state.lastBodyHigh;
  const lowDown = low <= state.lastBodyLow;
  let trend: number;
  if (highUp && !lowDown) trend = 1;
  else if (lowDown && !highUp) trend = -1;
  else if (highUp && lowDown) {
    trend = candle.close === candle.open ? state.trend || 1 : candle.close > candle.open ? 1 : -1;
  } else trend = state.trend || -1;

  const previousIndex = state.lastIndex ?? Math.max(index - 1, 0);
  for (const [name, wanted] of [['LONG', 1], ['SHORT', -1] as const] as const) {
    const bucket = state[name];
    if (trend === wanted && trend !== oldTrend) {
      if (bucket.current?.first && bucket.current.second) {
        bucket.previousPrevious = bucket.previous;
        bucket.previous = bucket.current;
      }
      bucket.current = {
        startIndex: previousIndex,
        endIndex: previousIndex,
        startTime: state.lastAt ?? candle.openTime,
        endTime: state.lastAt ?? candle.openTime,
        low: state.lastBodyLow,
        high: state.lastBodyHigh,
        tailLow: state.lastTailLow ?? candle.low,
        tailHigh: state.lastTailHigh ?? candle.high,
        first: true,
        second: false,
      };
    }
    if (bucket.current) {
      bucket.current.endIndex = index;
      bucket.current.endTime = candle.openTime;
      bucket.current.low = Math.min(bucket.current.low, low);
      bucket.current.high = Math.max(bucket.current.high, high);
      bucket.current.tailLow = Math.min(bucket.current.tailLow, candle.low);
      bucket.current.tailHigh = Math.max(bucket.current.tailHigh, candle.high);
      if (trend === -wanted) bucket.current.second = true;
    }
  }
  state.trend = trend;
  state.lastBodyLow = low;
  state.lastBodyHigh = high;
  state.lastTailLow = candle.low;
  state.lastTailHigh = candle.high;
  state.lastIndex = index;
  state.lastAt = candle.openTime;
}

function pullbackSignals(
  candles: Candle[],
  settings: BacktestSettings,
  state: WaveState = initialWaveState(),
): Signal[] {
  const enriched = enrichCandles(candles);
  const signals: Signal[] = [];
  const percentage = Number(settings.fullTpWavePercent || '100') / 100;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (!candle) continue;
    if (state.lastAt !== null && candle.openTime <= state.lastAt) continue;
    const oldTrend = state.trend;
    const lastHigh = state.lastBodyHigh;
    const lastLow = state.lastBodyLow;
    advanceWaveState(state, candle, index);
    if (index < 21 || !oldTrend || state.trend === oldTrend) continue;
    const side = state.trend === 1 ? 'LONG' : 'SHORT';
    if (settings.side !== 'BOTH' && settings.side !== side) continue;
    const direction = side === 'LONG' ? 1 : -1;
    const bucket = state[side];
    const previous = bucket.previous;
    const older = bucket.previousPrevious;
    const ma10 = [enriched[index - 2]?.ma10, enriched[index - 1]?.ma10, enriched[index]?.ma10];
    const ma20 = [enriched[index - 2]?.ma20, enriched[index - 1]?.ma20, enriched[index]?.ma20];
    const spreads = ma10.map((value, cursor) =>
      value !== null && value !== undefined && ma20[cursor] !== null && ma20[cursor] !== undefined
        ? value - (ma20[cursor] as number)
        : null,
    );
    if (!previous || !older || ma10.some((value) => value == null) || ma20.some((value) => value == null) || spreads.some((value) => value == null)) continue;
    const currentBodyExtreme = side === 'LONG' ? bodyHigh(candle) : bodyLow(candle);
    const previousExtreme = side === 'LONG' ? lastHigh : lastLow;
    const height = previous.high - previous.low;
    const stop = side === 'LONG' ? previous.tailLow : previous.tailHigh;
    const second = (candle.close + stop) / 2;
    const targetAnchor = side === 'LONG' ? bodyLow(candle) : bodyHigh(candle);
    const target = targetAnchor + direction * height * percentage;
    const conditions =
      direction * (previous.low - older.low) > 0 &&
      direction * (previous.high - older.high) > 0 &&
      previousExtreme !== null && direction * (currentBodyExtreme - previousExtreme) > 0 &&
      [ma10, ma20, spreads].every((values) =>
        direction * ((values[1] as number) - (values[0] as number)) > 0 &&
        direction * ((values[2] as number) - (values[1] as number)) > 0,
      ) &&
      height > 0 &&
      target > 0 &&
      direction * (target - candle.close) > 0 &&
      direction * (candle.close - stop) > 0 &&
      direction * (candle.close - second) > 0 &&
      direction * (second - stop) > 0;
    if (!conditions) continue;
    signals.push({
      strategy: 'PULLBACK',
      side,
      index,
      entry: candle.close,
      second,
      stop,
      partial: (candle.close + target) / 2,
      target,
      initialTarget: target,
      waves: [
        toWave(older, 'PREVIOUS_PREVIOUS', candles, side),
        toWave(previous, 'PREVIOUS', candles, side),
        ...(bucket.current ? [toWave(bucket.current, 'CURRENT', candles, side)] : []),
      ],
    });
  }
  return signals;
}

function disparitySignals(
  candles: Candle[],
  settings: BacktestSettings,
): Signal[] {
  const enriched = enrichCandles(candles);
  const minimum = Number(settings.minDisparityPercent || '1.0');
  const signals: Signal[] = [];
  for (let index = 59; index < candles.length; index += 1) {
    const candle = candles[index];
    const current = enriched[index];
    if (!candle || !current || current.ma20 === null || current.ma60 === null) continue;
    const previousBodyHigh = Math.max(...candles.slice(index - 5, index).map(bodyHigh));
    const previousBodyLow = Math.min(...candles.slice(index - 5, index).map(bodyLow));
    const midpoint = (candle.high + candle.low) / 2;
    const long =
      candle.close > current.ma20 && candle.close < current.ma60 &&
      midpoint >= current.ma20 && bodyHigh(candle) > previousBodyHigh &&
      candle.close > candle.open && ((candle.close - candle.open) / candle.open) * 100 >= 0.5;
    const short =
      candle.close < current.ma20 && candle.close > current.ma60 &&
      midpoint <= current.ma20 && bodyLow(candle) < previousBodyLow &&
      candle.close < candle.open && ((candle.open - candle.close) / candle.open) * 100 >= 0.5;
    if (!long && !short) continue;
    const side = long ? 'LONG' : 'SHORT';
    if (settings.side !== 'BOTH' && settings.side !== side) continue;
    const direction = long ? 1 : -1;
    const disparity = direction * (current.ma60 - candle.close) / current.ma60 * 100;
    if (disparity < minimum) continue;
    const previousMa20 = candles.slice(index - 10, index).every((row, offset) => {
      const ma20 = enriched[index - 10 + offset]?.ma20;
      return ma20 !== null && ma20 !== undefined && (long ? row.close <= ma20 : row.close >= ma20);
    });
    if (!previousMa20) continue;
    const stop = long
      ? Math.min(...candles.slice(index - 10, index).map((row) => row.low))
      : Math.max(...candles.slice(index - 10, index).map((row) => row.high));
    signals.push({
      strategy: 'DISPARITY',
      side,
      index,
      entry: candle.close,
      stop,
      partial: (candle.close + current.ma60) / 2,
      target: current.ma60,
      initialTarget: current.ma60,
      disparityPercent: disparity,
      ma20: current.ma20,
      ma60: current.ma60,
    });
  }
  return signals;
}

function volatilitySignals(
  candles: Candle[],
  settings: BacktestSettings,
): Signal[] {
  const { minimum, k1, k2 } = volatilityParameters(settings);
  const signals: Signal[] = [];
  for (let index = 2; index < candles.length; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    const older = candles[index - 2];
    if (!candle || !previous || !older || previous.close <= 0) continue;
    const range = Math.abs(previous.close - previous.open);
    if (!Number.isFinite(range) || range <= 0) continue;
    const rangePercent = range / previous.close * 100;
    if (rangePercent + 1e-10 < minimum) continue;
    // Only the two preceding bars are confirmed. Direction and running wick
    // extrema of the current bar are checked at the touch, never at final close.
    const long = older.close < older.open && previous.close > previous.open && previous.low < candle.open;
    const short = older.close > older.open && previous.close < previous.open && previous.high > candle.open;
    if (!long && !short) continue;
    const side = long ? 'LONG' : 'SHORT';
    if (settings.side !== 'BOTH' && settings.side !== side) continue;
    const direction = long ? 1 : -1;
    const entry = candle.open + direction * range * k1;
    if (long ? candle.high < entry : candle.low > entry) continue;
    const target = entry + direction * range * k1;
    if (!Number.isFinite(entry) || entry <= 0) continue;
    if (!Number.isFinite(target) || target <= 0 && settings.volatilityTpEnabled !== false) continue;
    signals.push({
      strategy: 'VOLATILITY',
      side,
      index,
      entry,
      // Initial placeholder is the only current-bar extreme known at open.
      // Replay replaces it with the running low/high at the actual path touch.
      stop: candle.open,
      volatilityStopEnabled: true,
      volatilityPriorExtreme: long ? previous.low : previous.high,
      volatilityEntryLimit: candle.open + direction * range * k2,
      volatilityTpEnabled: settings.volatilityTpEnabled !== false,
      volatilityNextCloseEnabled: settings.volatilityNextCloseEnabled === true,
      target,
      initialTarget: target,
      volatilityK1: k1,
      volatilityK2: k2,
      breakoutRange: range,
      breakoutRangePercent: rangePercent,
      breakoutLevel: entry,
      exitMode: 'VOLATILITY_TP',
    });
  }
  return signals;
}

export interface PreparedEnvelope extends EnvelopeBand { long: boolean; short: boolean; parentOpenTime?: number; sourceInterval?: BacktestInterval }
export interface PreparedBar {
  candle: Candle;
  signal: Signal | null;
  ma20: number | null;
  ma60Exit: number | null;
  intrabarCandles?: Candle[];
  envelope?: PreparedEnvelope;
  envelopeBySide?: Partial<Record<'LONG' | 'SHORT', PreparedEnvelope>>;
}

export interface PreparedSymbol {
  symbol: string;
  bars: PreparedBar[];
  waveState?: WaveState;
}

/** Prepare a bounded time block; warm-up bars inform indicators but never place orders. */
export function prepareSymbolBlock(
  symbol: string,
  candles: Candle[],
  settings: BacktestSettings,
  strategy: Strategy,
  start: number,
  end: number,
  previousWaveState?: WaveState,
  minuteCandles?: Candle[],
): PreparedSymbol {
  if (strategy === 'ENVELOPE') {
    const { percent, period } = envelopeParameters(settings);
    const centers = priorMovingAverages(candles, period);
    return { symbol, bars: candles.flatMap((candle, index) => {
      if (candle.openTime < start || candle.openTime >= end) return [];
      const center = centers[index];
      return [{ candle, signal: null, ma20: center ?? null, ma60Exit: null,
        ...(center === null || center === undefined ? {} : { envelope: {
          ...bandFor(center, percent), long: settings.side !== 'SHORT', short: settings.side !== 'LONG',
        } }),
      }];
    }) };
  }
  const waveState = strategy === 'PULLBACK' ? structuredClone(previousWaveState ?? initialWaveState()) : undefined;
  const signals = strategy === 'PULLBACK' ? pullbackSignals(candles, settings, waveState)
    : strategy === 'DISPARITY' ? disparitySignals(candles, settings) : volatilitySignals(candles, settings);
  const seconds = intervalSeconds(settings.interval);
  const minuteGroups = new Map<number, Candle[]>();
  for (const minute of minuteCandles ?? []) {
    const at = Math.floor(minute.openTime / seconds) * seconds;
    const rows = minuteGroups.get(at) ?? [];
    rows.push(minute);
    minuteGroups.set(at, rows);
  }
  const byTime = new Map(signals.flatMap(signal => {
    const time = candles[signal.index]?.openTime;
    return time === undefined ? [] : [[time, {
      ...signal, index: time / seconds,
      waves: signal.waves?.map(wave => ({ ...wave, startIndex: wave.startTime / seconds, endIndex: wave.endTime / seconds })),
    }] as const];
  }));
  return {
    symbol,
    bars: enrichCandles(candles).filter(candle => candle.openTime >= start && candle.openTime < end).map(candle => ({
      candle,
      signal: byTime.get(candle.openTime) ?? null,
      ma20: candle.ma20,
      // The intrabar MA60 touch equals the previous 59 closes' mean, independent of the final close.
      ma60Exit: candle.ma60 === null ? null : (candle.ma60 * 60 - candle.close) / 59,
      ...(byTime.get(candle.openTime)?.exitMode === 'VOLATILITY_TP' && minuteGroups.has(candle.openTime)
        ? { intrabarCandles: minuteGroups.get(candle.openTime) } : {}),
    })),
    waveState,
  };
}

function profit(position: Position, price: number): number {
  return (price - position.averageEntry) * position.quantity * (position.side === 'LONG' ? 1 : -1);
}

function roiStop(position: Position, settings: BacktestSettings): number | null {
  if (position.signal.strategy !== 'DISPARITY') return null;
  const percent = Number(settings.roiClosePercent || '100');
  const leverage = Number(settings.leverage);
  if (!Number.isFinite(percent) || !Number.isFinite(leverage) || leverage <= 0) return null;
  const fraction = percent / (100 * leverage);
  return position.averageEntry * (position.side === 'LONG' ? 1 - fraction : 1 + fraction);
}

function countReason(state: SimulationState, reason: string): void {
  state.exitReasons[reason] = (state.exitReasons[reason] ?? 0) + 1;
}

function closePosition(
  state: SimulationState,
  position: Position,
  price: number,
  reason: string,
  candle: Candle,
  quantity: number,
  signal: Signal,
  index: number,
  opening = false,
): void {
  if (position.pendingSecond && qtyAtLeast(quantity, position.quantity)) {
    cancelPendingSecond(state, position);
  }
  const marketExit = ['SL', 'ROI_LOSS', 'MA60_TOUCH', 'MA20_HALF_BREAK', 'SESSION_CLOSE', 'VOLATILITY_CLOSE'].includes(reason);
  const fill = marketExit
    ? price * (position.side === 'LONG' ? 1 - SLIPPAGE : 1 + SLIPPAGE)
    : price;
  const qty = Math.min(quantity, position.quantity);
  const gross = (fill - position.averageEntry) * qty * (position.side === 'LONG' ? 1 : -1);
  const fee = fill * qty * FEE;
  const released = position.margin * qty / position.quantity;
  state.cash += released + gross - fee;
  state.realized += gross - fee;
  state.fees += fee;
  position.netProfit += gross - fee;
  position.quantity -= qty;
  position.margin -= released;
  countReason(state, reason);
  const execution: Execution = {
    kind: reason === 'PARTIAL_TP' ? 'PARTIAL_TP' : 'CLOSE',
    at: opening ? candle.openTime : candle.closeTime,
    candleOpenAt: candle.openTime,
    price: fill,
    quantity: qty,
  };
  position.executions.push(execution);
  const trade: BacktestTrade = {
    tradeId: `local-${candle.openTime}-${position.executions.length}-${state.trades.length}`,
    symbol: 'LOCAL',
    side: position.side,
    entryAt: position.entryAt,
    exitAt: opening ? candle.openTime : candle.closeTime,
    reason,
    quantity: qty,
    entryPrice: position.averageEntry,
    exitPrice: fill,
    netProfitUsdt: gross - fee,
    signalIndex: signal.index,
    entryIndex: position.entryIndex,
    exitIndex: index,
    signal: {
      ...signal,
      target: position.target,
      initialStop: position.initialStop,
      activeStop: position.activeStop,
      averageEntry: position.averageEntry,
      secondTarget: position.target !== signal.initialTarget ? position.target : undefined,
    },
    executions: [...position.executions],
  };
  state.trades.push(trade);
  if (position.quantity <= 1e-12) state.position = null;
}

function qtyAtLeast(left: number, right: number): boolean {
  return left >= right - 1e-12;
}

function cancelPendingSecond(state: SimulationState, position: Position): void {
  if (!position.pendingSecond) return;
  state.cash += position.reserved + position.reservedFee;
  position.pendingSecond = false;
  position.reserved = 0;
  position.reservedFee = 0;
}

function fillSecond(
  state: SimulationState,
  position: Position,
  candle: Candle,
): void {
  if (!position.pendingSecond) return;
  const addQty = position.reserved * position.leverage / position.secondPrice;
  position.averageEntry =
    (position.averageEntry * position.quantity + position.secondPrice * addQty) /
    (position.quantity + addQty);
  position.quantity += addQty;
  position.margin += position.reserved;
  state.realized -= position.reservedFee;
  state.fees += position.reservedFee;
  position.netProfit -= position.reservedFee;
  position.reserved = 0;
  position.reservedFee = 0;
  position.pendingSecond = false;
  position.target = (position.averageEntry + position.firstEntry) / 2;
  position.signal = {
    ...position.signal,
    target: position.target,
    averageEntry: position.averageEntry,
    secondTarget: position.target,
  };
  position.partial = null;
  state.secondFills += 1;
  position.executions.push({
    kind: 'SPLIT_ENTRY',
    at: candle.closeTime,
    candleOpenAt: candle.openTime,
    price: position.secondPrice,
    quantity: addQty,
  });
}

function handlePrice(
  state: SimulationState,
  position: Position,
  price: number,
  candle: Candle,
  index: number,
  settings: BacktestSettings,
): void {
  if (state.position !== position || position.quantity <= 0) return;
  const long = position.side === 'LONG';
  const stopped = (position.signal.exitMode !== 'VOLATILITY_CLOSE' || position.signal.volatilityStopEnabled === true)
    && (long ? price <= position.activeStop : price >= position.activeStop);
  if (stopped) {
    closePosition(state, position, position.activeStop, 'SL', candle, position.quantity, position.signal, index);
    return;
  }
  if (position.pendingSecond && (long ? price <= position.secondPrice : price >= position.secondPrice)) {
    fillSecond(state, position, candle);
  }
  if (state.position !== position) return;
  const roi = roiStop(position, settings);
  if (roi !== null && (long ? price <= roi : price >= roi)) {
    closePosition(state, position, roi, 'ROI_LOSS', candle, position.quantity, position.signal, index);
    return;
  }
  if (position.partial !== null && !position.partialDone && (long ? price >= position.partial : price <= position.partial)) {
    position.partialDone = true;
    if (position.signal.strategy === 'DISPARITY') {
      position.activeStop = position.firstEntry;
      position.signal = { ...position.signal, activeStop: position.activeStop };
    }
    if (position.signal.strategy === 'PULLBACK') {
      cancelPendingSecond(state, position);
    }
    closePosition(state, position, position.partial, 'PARTIAL_TP', candle, position.quantity / 2, position.signal, index);
    if (state.position !== position) return;
  }
  const targetHit = long ? price >= position.target : price <= position.target;
  if (targetHit) {
    closePosition(state, position, position.target, position.signal.strategy === 'DISPARITY' ? 'MA60_TOUCH' : 'FULL_TP', candle, position.quantity, position.signal, index);
  }
}

function processCandle(
  state: SimulationState,
  position: Position,
  candle: Candle,
  index: number,
  settings: BacktestSettings,
  enriched: EnrichedCandle,
): void {
  // A stop gap cannot fill at the better stop price. Existing non-volatility
  // simulations keep their conventions; live local jobs use the shared replay.
  if (position.signal.volatilityStopEnabled && (position.side === 'LONG' ? candle.open <= position.activeStop : candle.open >= position.activeStop)) {
    closePosition(state, position, candle.open, 'SL', candle, position.quantity, position.signal, index, true);
    return;
  }
  const path = position.side === 'LONG'
    ? [candle.open, candle.low, candle.high, candle.close]
    : [candle.open, candle.high, candle.low, candle.close];
  for (let cursor = 1; cursor < path.length && state.position === position; cursor += 1) {
    const before = path[cursor - 1] as number;
    const after = path[cursor] as number;
    const levels = [
      ...(position.signal.exitMode !== 'VOLATILITY_CLOSE' || position.signal.volatilityStopEnabled === true ? [position.activeStop] : []),
      ...(position.pendingSecond ? [position.secondPrice] : []),
      ...(position.partial !== null && !position.partialDone ? [position.partial] : []),
      ...(roiStop(position, settings) !== null ? [roiStop(position, settings) as number] : []),
      position.target,
    ];
    const crossed = levels.filter((level) =>
      level !== before && Math.min(before, after) <= level && level <= Math.max(before, after),
    ).sort((a, b) => after >= before ? a - b : b - a);
    for (const level of crossed) {
      handlePrice(state, position, level, candle, index, settings);
      if (state.position !== position) break;
    }
  }
  if (state.position === position && settings.ma20HalfCloseEnabled && position.signal.strategy === 'DISPARITY' && enriched.ma20 !== null) {
    const midpoint = (candle.high + candle.low) / 2;
    const halfBreak = position.side === 'LONG' ? midpoint <= enriched.ma20 : midpoint >= enriched.ma20;
    if (halfBreak) closePosition(state, position, candle.close, 'MA20_HALF_BREAK', candle, position.quantity, position.signal, index);
  }
  if (state.position === position && position.signal.exitMode === 'VOLATILITY_CLOSE') {
    const direction = position.side === 'LONG' ? 1 : -1;
    const threshold = position.firstEntry + direction * position.signal.breakoutRange! * position.signal.volatilityK1!;
    if (direction * (candle.close - threshold) >= 0) closePosition(state, position, candle.close, 'VOLATILITY_CLOSE', candle, position.quantity, position.signal, index);
  }
  void index;
}

function entryPosition(
  state: SimulationState,
  signal: Signal,
  candle: Candle,
  index: number,
  settings: BacktestSettings,
): Position | null {
  const leverage = Number(settings.leverage);
  const bet = Number(settings.betAmountUsdt);
  if (!Number.isFinite(leverage) || !Number.isFinite(bet) || state.cash < bet * (1 + leverage * FEE)) {
    state.insufficientFunds += 1;
    return null;
  }
  const split = signal.strategy === 'PULLBACK';
  const margin = split ? bet / 2 : bet;
  const raw = signal.entry;
  const fill = raw * (signal.side === 'LONG' ? 1 + SLIPPAGE : 1 - SLIPPAGE);
  const target = signal.exitMode === 'VOLATILITY_CLOSE' ? fill + (signal.side === 'LONG' ? 1 : -1) * signal.breakoutRange! : signal.target;
  if (!Number.isFinite(target) || target <= 0) return null;
  const firstQuantity = margin * leverage / fill;
  const firstFee = margin * leverage * FEE;
  const reservedFee = split ? bet / 2 * leverage * FEE : 0;
  const position: Position = {
    side: signal.side,
    signal: { ...signal },
    signalCandle: candle,
    entryAt: candle.closeTime,
    entryIndex: index,
    firstEntry: fill,
    averageEntry: fill,
    quantity: firstQuantity,
    firstQuantity,
    margin,
    reserved: split ? bet / 2 : 0,
    reservedFee,
    pendingSecond: split,
    secondPrice: signal.second ?? fill,
    leverage,
    target,
    partial: settings.partialTpEnabled && signal.strategy !== 'VOLATILITY' ? signal.partial ?? null : null,
    partialDone: false,
    activeStop: signal.stop,
    initialStop: signal.stop,
    executions: [{ kind: 'ENTRY', at: candle.closeTime, candleOpenAt: candle.openTime, price: fill, quantity: firstQuantity }],
    netProfit: -firstFee,
  };
  state.cash -= bet + firstFee + reservedFee;
  state.realized -= firstFee;
  state.fees += firstFee;
  state.position = position;
  state.entries += 1;
  position.signal = { ...signal, initialStop: signal.stop, activeStop: signal.stop, averageEntry: fill };
  return position;
}

function positionEquity(position: Position, mark: number): number {
  return position.margin + position.reserved + position.reservedFee + profit(position, mark) - mark * position.quantity * FEE;
}

function makeResult(
  state: SimulationState,
  candles: Candle[],
  settings: BacktestSettings,
): BacktestResult {
  const last = candles.at(-1);
  const openProfit = state.position && last ? profit(state.position, last.close) : 0;
  const finalEquity = state.cash + (state.position && last ? positionEquity(state.position, last.close) : 0);
  const closed = state.trades.filter((trade) => trade.reason !== 'PARTIAL_TP');
  const netByPosition = new Map<string, number>();
  for (const trade of state.trades) {
    const key = `${trade.entryAt}:${trade.side}`;
    netByPosition.set(key, (netByPosition.get(key) ?? 0) + trade.netProfitUsdt);
  }
  const totals = [...netByPosition.values()];
  const wins = totals.filter((value) => value > 0).length;
  const losses = totals.filter((value) => value < 0).length;
  const breakeven = totals.filter((value) => value === 0).length;
  let peak = Number(settings.initialCapitalUsdt);
  let maxDrawdown = 0;
  for (const point of state.equityCurve) {
    peak = Math.max(peak, point.equityUsdt);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - point.equityUsdt) / peak * 100);
  }
  const symbol = `${settings.symbol.trim().toUpperCase().replace(/USDT$/, '')}USDT`;
  const recentTrades = state.trades.slice(-100).map((trade) => ({
    ...trade,
    symbol,
  }));
  return {
    initialCapitalUsdt: Number(settings.initialCapitalUsdt),
    finalEquityUsdt: finalEquity,
    returnPercent: Number(settings.initialCapitalUsdt) > 0 ? (finalEquity / Number(settings.initialCapitalUsdt) - 1) * 100 : 0,
    realizedProfitUsdt: state.realized,
    unrealizedProfitUsdt: openProfit,
    feesUsdt: state.fees,
    maxDrawdownPercent: maxDrawdown,
    entryCount: state.entries,
    closedTradeCount: closed.length,
    winCount: wins,
    lossCount: losses,
    breakevenCount: breakeven,
    winRatePercent: totals.length > 0 ? wins / totals.length * 100 : null,
    openPositionCount: state.position ? 1 : 0,
    insufficientFundsCount: state.insufficientFunds,
    betAmountUsdt: Number(settings.betAmountUsdt),
    secondFillCount: state.secondFills,
    signalCount: state.signals,
    observedBars: candles.length,
    dataStartAt: candles[0]?.openTime ?? null,
    dataEndAt: last?.closeTime ?? null,
    exitReasons: state.exitReasons,
    recentTrades,
    equityCurve: state.equityCurve,
    candles,
  };
}

export function runBacktest(
  candles: Candle[],
  settings: BacktestSettings,
  strategy: Strategy,
  onProgress?: ProgressCallback,
  minuteCandles?: Candle[],
): BacktestResult {
  if (candles.length < 20) throw new Error('분석 캔들이 부족합니다.');
  if (strategy === 'VOLATILITY' || strategy === 'ENVELOPE') {
    const symbol = `${settings.symbol.trim().toUpperCase().replace(/USDT$/, '')}USDT`;
    const start = candles[0]!.openTime;
    const end = candles.at(-1)!.closeTime;
    const prepared = prepareSymbolBlock(symbol, candles, settings, strategy, start, end, undefined, minuteCandles);
    const state = initialPortfolio(Number(settings.initialCapitalUsdt));
    replayPortfolioBlock(state, [prepared], settings, start, end, intervalSeconds(settings.interval));
    const result = portfolioResult(state, settings);
    const indices = new Map(candles.map((candle, index) => [candle.openTime, index]));
    onProgress?.(candles.length, candles.length);
    return { ...result, candles, recentTrades: result.recentTrades.map(trade => {
      const index = indices.get(trade.executions.find(fill => fill.kind === 'ENTRY')!.candleOpenAt) ?? -1;
      return { ...trade, entryIndex: index, signalIndex: index,
        exitIndex: indices.get(trade.executions.at(-1)!.candleOpenAt) ?? -1,
        signal: { ...trade.signal, index } };
    }) };
  }
  const signals = strategy === 'PULLBACK'
    ? pullbackSignals(candles, settings)
    : strategy === 'DISPARITY'
      ? disparitySignals(candles, settings)
      : volatilitySignals(candles, settings);
  const byIndex = new Map(signals.map((signal) => [signal.index, signal]));
  const enriched = enrichCandles(candles);
  const state: SimulationState = {
    cash: Number(settings.initialCapitalUsdt),
    realized: 0,
    fees: 0,
    position: null,
    trades: [],
    entries: 0,
    secondFills: 0,
    signals: signals.length,
    insufficientFunds: 0,
    exitReasons: {},
    equityCurve: [],
  };
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (!candle) continue;
    const hadPosition = state.position !== null;
    if (state.position && index > state.position.entryIndex) {
      processCandle(state, state.position, candle, index, settings, enriched[index] as EnrichedCandle);
    }
    if (!hadPosition && state.position === null) {
      const signal = byIndex.get(index);
      if (signal) {
        const openedPosition = entryPosition(state, signal, candle, index, settings);
        if (openedPosition && signal.exitMode === 'BAR_CLOSE') {
          closePosition(state, openedPosition, candle.close, 'SESSION_CLOSE', candle, openedPosition.quantity, signal, index);
        }
      }
    }
    const equity = state.cash + (state.position ? positionEquity(state.position, candle.close) : 0);
    state.equityCurve.push({ at: candle.closeTime, equityUsdt: equity });
    if (index % 100 === 0 || index === candles.length - 1) onProgress?.(index + 1, candles.length);
  }
  return makeResult(state, candles, settings);
}

function line(kind: PriceLine['kind'], price: number | undefined): PriceLine | null {
  return price !== undefined && Number.isFinite(price) && price > 0 ? { kind, price } : null;
}

export function buildLocalChart(
  result: BacktestResult,
  trade: BacktestTrade,
  settings: BacktestSettings,
): ChartData {
  const all = enrichCandles(result.candles);
  const start = Math.max(0, Math.min(trade.entryIndex, trade.signalIndex) - 120);
  const end = Math.min(all.length, Math.max(trade.exitIndex, trade.entryIndex) + 121);
  const candles = all.slice(start, end);
  const indexFor = (time: number): number => Math.max(0, candles.findIndex((candle) => candle.openTime === time));
  const markers: ChartData['markers'] = trade.executions.map((execution, index) => {
    const label = execution.kind === 'CLOSE'
      ? 'C'
      : execution.kind === 'PARTIAL_TP'
        ? trade.side === 'LONG' ? 'S' : 'B'
        : trade.side === 'LONG' ? 'B' : 'S';
    return {
      id: `${trade.tradeId}-${index}`,
      orderId: `${trade.tradeId}-${index}`,
      kind: execution.kind,
      label,
      openTime: execution.candleOpenAt,
      price: execution.price,
      quantity: execution.quantity,
      candleIndex: indexFor(execution.candleOpenAt),
    };
  });
  const signal = trade.signal;
  const lines: Array<PriceLine | null> = [];
  if (signal.strategy === 'PULLBACK') {
    lines.push(line('FIRST_ENTRY', trade.entryPrice));
    lines.push(line('SECOND_ENTRY', signal.second));
    if (signal.averageEntry && signal.averageEntry !== trade.entryPrice) lines.push(line('AVERAGE_ENTRY', signal.averageEntry));
    lines.push(line('SL', signal.activeStop ?? signal.stop));
    if (signal.initialStop !== signal.activeStop) lines.push(line('INITIAL_SL', signal.initialStop));
    if (signal.initialTarget !== signal.target) lines.push(line('INITIAL_TP', signal.initialTarget));
    lines.push(line('TP', signal.target));
    if (signal.partial) lines.push(line('PARTIAL_TP', signal.partial));
  } else if (signal.strategy === 'DISPARITY') {
    lines.push(line('ENTRY', trade.entryPrice));
    lines.push(line('SL', signal.activeStop ?? signal.stop));
    if (signal.initialStop !== signal.activeStop) lines.push(line('INITIAL_SL', signal.initialStop));
    lines.push(line('TP', signal.target));
    if (signal.partial) lines.push(line('PARTIAL_TP', signal.partial));
  } else if (signal.strategy === 'ENVELOPE') {
    lines.push(line('ENTRY', trade.executions.find(fill => fill.kind === 'ENTRY')?.price ?? trade.entryPrice));
    lines.push(line('SL', signal.activeStop ?? signal.stop));
  } else {
    lines.push(line('ENTRY', trade.entryPrice));
    if (signal.volatilityStopEnabled === true) lines.push(line('SL', signal.activeStop ?? signal.stop));
    if (signal.exitMode === 'VOLATILITY_CLOSE' || signal.exitMode === 'VOLATILITY_TP' && signal.volatilityTpEnabled !== false) lines.push(line('TP', signal.target));
  }
  const waves = (signal.waves ?? []).flatMap((wave) => {
    const visibleStart = Math.max(start, wave.startIndex);
    const visibleEnd = Math.min(end - 1, wave.endIndex);
    return visibleStart <= visibleEnd
      ? [{ ...wave, startIndex: visibleStart - start, endIndex: visibleEnd - start }]
      : [];
  });
  const interval = settings.interval;
  return {
    symbol: trade.symbol === 'LOCAL' ? settings.symbol.toUpperCase().replace(/USDT$/, '') + 'USDT' : trade.symbol,
    interval,
    side: trade.side,
    referenceAt: new Date(trade.entryAt * 1000).toISOString(),
    referenceIndex: indexFor(trade.executions.find((execution) => execution.kind === 'ENTRY')?.candleOpenAt ?? result.candles[trade.entryIndex]?.openTime ?? trade.entryAt),
    candles,
    waves,
    markers,
    executions: markers,
    priceLines: lines.filter((value): value is PriceLine => value !== null),
    ...(signal.strategy === 'ENVELOPE' ? { envelope: projectEnvelopeBands(result.candles, candles, {
      interval, period: signal.envelopeMaPeriod ?? Number(settings.envelopeMaPeriod ?? '20'),
      deviationPercent: signal.envelopeDeviationPercent ?? Number(settings.envelopeDeviationPercent ?? '0.5'),
    }) } : {}),
  };
}

export function strategyDescription(strategy: Strategy): string {
  if (strategy === 'ENVELOPE') return '선택한 주기·SMA의 하단 접촉에 롱, 상단 접촉에 숏으로 진입하며 이격 비율 SL과 세 가지 밴드 청산 방식을 비교합니다.';
  if (strategy === 'PULLBACK') {
    return '공통 몸통 파동의 고점·저점 상승과 MA10·MA20·간격의 3봉 연속 증가를 확인한 반전 첫 봉을 2분할 매수합니다.';
  }
  if (strategy === 'DISPARITY') {
    return 'MA20·MA60 사이 이격, 현재 캔들 절반, 직전 5봉 몸통 돌파와 직전 10봉 MA20 조건을 분석합니다.';
  }
  return '직전봉 몸통 변동폭·2봉 방향과 K1 돌파로 봉 중간에 진입하고, 진입 시점 SL·선택형 K1 TP·다음 봉 종가 청산을 적용합니다.';
}

export function estimateBars(settings: BacktestSettings): number {
  const start = Date.parse(`${settings.startDate}T${settings.startTime}:00+09:00`);
  const end = settings.endDate
    ? Date.parse(`${settings.endDate}T${settings.endTime}:00+09:00`)
    : Date.now();
  const seconds = intervalSeconds(settings.interval) * 1000;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.ceil((end - start) / seconds)) : 0;
}
