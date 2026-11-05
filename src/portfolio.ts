/** Shared virtual account replay, with conservative OHLC paths and resumable JSON state. */
import type { PreparedBar, PreparedSymbol } from './engine';
import type { BacktestResult, BacktestSettings, BacktestTrade, Candle, ContractRisk, Execution, PriceLine, Signal } from './types';
import { validateMinuteCandles } from './intrabar';
import { dailyTrendAllows, envelopeParameters } from './envelope';
import { newHighEntryAtrLimit, newHighRiskAmount, newHighSlMultiplier } from './newHigh';
import { estimatedLiquidation } from './contractRisk';

const feeRate = 0.00055;
const slippage = 0.0002;

interface Holding {
  symbol: string;
  signal: Signal;
  opened: number;
  first: number;
  entry: number;
  qty: number;
  margin: number;
  reserved: number;
  reservedFee: number;
  pending: boolean;
  second: number;
  secondFill?: number;
  target: number;
  partial: number | null;
  partialDone: boolean;
  stop: number;
  mark: number;
  net: number;
  executions: Execution[];
  risk?: ContractRisk;
  envelopeCenter?: number;
  centerStopMoved?: boolean;
  pullbackMa60Exit?: number;
  newHighTrailStep?: number;
}

export interface PortfolioState {
  cash: number;
  realized: number;
  fees: number;
  positions: Record<string, Holding>;
  trades: BacktestTrade[];
  entries: number;
  closed: number;
  wins: number;
  losses: number;
  winningProfit?: number;
  losingLoss?: number;
  breakeven: number;
  signals: number;
  insufficientFunds: number;
  secondFills: number;
  exitReasons: Record<string, number>;
  peak: number;
  maxDrawdown: number;
  observedBars: number;
  dataStartAt: number | null;
  dataEndAt: number | null;
  equityCurve: { at: number; equityUsdt: number }[];
  envelopeParents?: Record<string, { openTime: number; blocked: boolean }>;
  envelopeReclaims?: Record<string, { outsideAt: number }>;
}

export function initialPortfolio(capital: number): PortfolioState {
  return {
    cash: capital, realized: 0, fees: 0, positions: {}, trades: [], entries: 0, closed: 0,
    wins: 0, losses: 0, winningProfit: 0, losingLoss: 0, breakeven: 0, signals: 0, insufficientFunds: 0, secondFills: 0,
    exitReasons: {}, peak: capital, maxDrawdown: 0, observedBars: 0,
    dataStartAt: null, dataEndAt: null, equityCurve: [],
  };
}

function gross(p: Holding, price: number, qty = p.qty): number {
  return (price - p.entry) * qty * (p.signal.side === 'LONG' ? 1 : -1);
}

function holdingEquity(p: Holding): number {
  return p.margin + p.reserved + p.reservedFee + gross(p, p.mark) - p.mark * p.qty * feeRate;
}

export function portfolioEquity(state: PortfolioState): number {
  return state.cash + Object.values(state.positions).reduce((total, p) => total + holdingEquity(p), 0);
}

function priceLines(p: Holding): PriceLine[] {
  if (p.signal.strategy === 'NEW_HIGH') return [{ kind: 'ENTRY', price: p.first }, { kind: 'SL', price: p.stop },
    ...(p.stop !== p.signal.stop ? [{ kind: 'INITIAL_SL' as const, price: p.signal.stop }] : [])];
  if (p.signal.strategy === 'ENVELOPE') return [{ kind: 'ENTRY', price: p.first }, { kind: 'SL', price: p.stop },
    ...(p.stop !== p.signal.stop ? [{ kind: 'INITIAL_SL' as const, price: p.signal.stop }] : [])];
  if (p.signal.strategy === 'VOLATILITY') return [
    { kind: 'ENTRY', price: p.first },
    ...(p.signal.volatilityStopEnabled === true ? [{ kind: 'SL' as const, price: p.stop }] : []),
    ...(p.signal.exitMode === 'VOLATILITY_CLOSE' || p.signal.exitMode === 'VOLATILITY_TP' && p.signal.volatilityTpEnabled !== false ? [{ kind: 'TP' as const, price: p.target }] : []),
  ];
  if (p.signal.strategy === 'PULLBACK' && p.signal.exitMode === 'PULLBACK_ENVELOPE') return [{ kind: 'ENTRY', price: p.first }];
  const split = p.signal.strategy === 'PULLBACK';
  const lines: PriceLine[] = [{ kind: split ? 'FIRST_ENTRY' : 'ENTRY', price: p.first }];
  if (split) lines.push({ kind: 'SECOND_ENTRY', price: p.secondFill ?? p.second });
  if (p.secondFill !== undefined) lines.push({ kind: 'AVERAGE_ENTRY', price: p.entry }, { kind: 'INITIAL_TP', price: p.signal.initialTarget });
  lines.push({ kind: 'SL', price: p.stop });
  if (p.stop !== p.signal.stop) lines.push({ kind: 'INITIAL_SL', price: p.signal.stop });
  lines.push({ kind: 'TP', price: p.target });
  if (p.partial !== null) lines.push({ kind: 'PARTIAL_TP', price: p.partial });
  return lines.filter(line => Number.isFinite(line.price) && line.price > 0);
}

function recordFill(p: Holding, kind: Execution['kind'], price: number, quantity: number, candle: Candle, opening = false, confirmedClose = false): void {
  const intrabarMode = p.signal.exitMode === 'VOLATILITY_TP' || p.signal.exitMode === 'ENVELOPE_TOUCH' || p.signal.exitMode === 'PULLBACK_ENVELOPE' || p.signal.exitMode === 'NEW_HIGH_TOUCH'
    || p.signal.exitMode === 'VOLATILITY_MA5';
  const intrabar = intrabarMode && !confirmedClose && (kind === 'ENTRY' ? opening : !opening);
  const parentOpenTime = (candle as Candle & { parentOpenTime?: number }).parentOpenTime ?? candle.openTime;
  p.executions.push({ kind, price, quantity, at: opening || intrabar ? candle.openTime : candle.closeTime, candleOpenAt: parentOpenTime,
    ...(intrabar ? { timing: 'INTRABAR' as const } : confirmedClose ? { timing: 'BAR_CLOSE' as const } : {}) });
}

function cancelSecond(state: PortfolioState, p: Holding): void {
  if (!p.pending) return;
  state.cash += p.reserved + p.reservedFee;
  p.pending = false;
  p.reserved = p.reservedFee = 0;
}

function close(state: PortfolioState, p: Holding, price: number, quantity: number, reason: string, candle: Candle, opening = false): void {
  cancelSecond(state, p);
  const market = ['SL', 'ROI_LOSS', 'MA60_TOUCH', 'MA20_HALF_BREAK', 'SESSION_CLOSE', 'VOLATILITY_CLOSE', 'VOLATILITY_MA5_EXIT', 'NEXT_CANDLE_CLOSE', 'NEW_HIGH_CONDITIONAL_EXIT', 'NEW_HIGH_TRAILING', 'NEW_HIGH_BREAKOUT_FAIL', 'NEW_HIGH_CANDLE_REJECTION', 'PULLBACK_MA_EXIT'].includes(reason);
  const fill = market ? price * (p.signal.side === 'LONG' ? 1 - slippage : 1 + slippage) : price;
  const qty = Math.min(p.qty, quantity);
  const profit = gross(p, fill, qty);
  const fee = fill * qty * feeRate;
  const released = p.margin * qty / p.qty;
  state.cash += released + profit - fee;
  state.realized += profit - fee;
  state.fees += fee;
  p.net += profit - fee;
  p.margin -= released;
  p.qty -= qty;
  state.exitReasons[reason] = (state.exitReasons[reason] ?? 0) + 1;
  recordFill(p, reason === 'PARTIAL_TP' ? 'PARTIAL_TP' : 'CLOSE', fill, qty, candle, opening,
    reason === 'NEXT_CANDLE_CLOSE' || reason === 'VOLATILITY_MA5_EXIT');
  state.trades.push({
    tradeId: `local:${p.symbol}:${p.opened}:${candle.openTime}:${p.executions.length}`,
    symbol: p.symbol, side: p.signal.side, entryAt: p.opened,
    exitAt: p.executions.at(-1)!.at,
    entryPrice: p.entry, exitPrice: fill, quantity: qty, reason, netProfitUsdt: p.signal.strategy === 'NEW_HIGH' ? p.net : profit - fee,
    signalIndex: p.signal.index, entryIndex: p.signal.index, exitIndex: -1,
    signal: { ...p.signal, target: p.target, partial: p.partial ?? undefined, second: p.secondFill ?? p.second,
      initialStop: p.signal.stop, activeStop: p.stop, averageEntry: p.entry },
    executions: structuredClone(p.executions), priceLines: [...priceLines(p), { kind: 'EXIT', price: fill }],
  });
  state.trades = state.trades.slice(-100);
  if (p.qty === 0) {
    state.closed += 1;
    state.wins += Number(p.net > 0);
    state.losses += Number(p.net < 0);
    state.breakeven += Number(p.net === 0);
    state.winningProfit = (state.winningProfit ?? 0) + Math.max(0, p.net);
    state.losingLoss = (state.losingLoss ?? 0) + Math.max(0, -p.net);
    delete state.positions[p.symbol];
  }
}

function enter(state: PortfolioState, symbol: string, signal: Signal, candle: Candle, settings: BacktestSettings): void {
  if (state.positions[symbol] || settings.side !== 'BOTH' && settings.side !== signal.side) return;
  state.signals += 1;
  const leverage = Number(settings.leverage);
  const split = signal.strategy === 'PULLBACK' && signal.exitMode !== 'PULLBACK_ENVELOPE';
  const entry = signal.entry * (signal.side === 'LONG' ? 1 + slippage : 1 - slippage);
  const direction = signal.side === 'LONG' ? 1 : -1;
  let bet = Number(settings.betAmountUsdt);
  let riskSizedQuantity: number | null = null;
  if (signal.strategy === 'NEW_HIGH' && signal.riskAmount !== undefined) {
    const stopFill = signal.stop * (signal.side === 'LONG' ? 1 - slippage : 1 + slippage);
    const riskPerUnit = Math.abs(entry - stopFill) + entry * feeRate + stopFill * feeRate;
    if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0 || !Number.isFinite(signal.riskAmount) || signal.riskAmount <= 0) return;
    riskSizedQuantity = signal.riskAmount / riskPerUnit;
    bet = riskSizedQuantity * entry / leverage;
  }
  if (!Number.isFinite(bet) || bet <= 0) return;
  if (state.cash + 1e-10 < bet * (1 + leverage * feeRate)) { state.insufficientFunds += 1; return; }
  const target = signal.exitMode === 'VOLATILITY_TP' ? entry + direction * signal.breakoutRange! * signal.volatilityK1!
    : signal.exitMode === 'VOLATILITY_CLOSE' ? entry + direction * signal.breakoutRange! : signal.target;
  if (!Number.isFinite(target) || target <= 0 && (signal.exitMode !== 'VOLATILITY_TP' || signal.volatilityTpEnabled !== false)) return;
  const margin = split ? bet / 2 : bet;
  const fee = margin * leverage * feeRate;
  const activeStop = signal.strategy === 'VOLATILITY' && signal.volatilityAtr !== undefined
    ? entry - direction * signal.volatilityAtr * 2
    : signal.strategy === 'ENVELOPE' ? entry * (1 - direction * signal.envelopeDeviationPercent! / 100) : signal.stop;
  const effectiveSignal = activeStop === signal.stop ? signal : { ...signal, stop: activeStop };
  const p: Holding = {
    symbol, signal: effectiveSignal, opened: signal.exitMode === 'VOLATILITY_TP' || signal.exitMode === 'VOLATILITY_MA5' || signal.exitMode === 'ENVELOPE_TOUCH' || signal.exitMode === 'NEW_HIGH_TOUCH' ? candle.openTime : candle.closeTime, first: entry, entry, qty: riskSizedQuantity ?? margin * leverage / entry,
    margin, reserved: bet - margin, reservedFee: (bet - margin) * leverage * feeRate,
    pending: split, second: split ? (entry + signal.stop) / 2 : entry,
    ...(signal.strategy === 'ENVELOPE' && settings.envelopeRisk?.symbol === symbol ? { risk: settings.envelopeRisk } : {}),
    target,
    partial: settings.partialTpEnabled && signal.strategy !== 'VOLATILITY' && signal.strategy !== 'ENVELOPE' && signal.strategy !== 'NEW_HIGH' && signal.exitMode !== 'PULLBACK_ENVELOPE' ? (entry + signal.initialTarget) / 2 : null,
    partialDone: false, stop: activeStop, mark: candle.close, net: -fee, executions: [],
  };
  if (signal.strategy === 'ENVELOPE') {
    p.signal = { ...effectiveSignal, stop: p.stop, initialStop: p.stop };
    p.envelopeCenter = signal.envelopeCenter;
    if (signal.envelopeExitMode === 'HALF') p.partial = signal.partial ?? null;
  }
  state.positions[symbol] = p;
  state.cash -= bet + bet * leverage * feeRate;
  state.realized -= fee;
  state.fees += fee;
  state.entries += 1;
  const entryAtOpen = signal.exitMode === 'VOLATILITY_TP' || signal.exitMode === 'VOLATILITY_MA5'
    || signal.exitMode === 'ENVELOPE_TOUCH' || signal.exitMode === 'NEW_HIGH_TOUCH';
  recordFill(p, 'ENTRY', entry, p.qty, candle, entryAtOpen);
  if (signal.exitMode === 'BAR_CLOSE') close(state, p, candle.close, p.qty, 'SESSION_CLOSE', candle);
}

function fillSecond(state: PortfolioState, p: Holding, price: number, candle: Candle, settings: BacktestSettings, opening: boolean): void {
  const notional = p.reserved * Number(settings.leverage);
  const qty = notional / price;
  p.entry = (p.entry * p.qty + notional) / (p.qty + qty);
  p.qty += qty;
  p.margin += p.reserved;
  state.realized -= p.reservedFee;
  state.fees += p.reservedFee;
  p.net -= p.reservedFee;
  p.reserved = p.reservedFee = 0;
  p.pending = false;
  p.secondFill = price;
  p.target = (p.entry + p.first) / 2;
  p.partial = null;
  state.secondFills += 1;
  recordFill(p, 'SPLIT_ENTRY', price, qty, candle, opening);
}

function roiPrice(p: Holding, settings: BacktestSettings): number | null {
  if (p.signal.strategy !== 'DISPARITY') return null;
  const fraction = Number(settings.roiClosePercent) / (100 * Number(settings.leverage));
  return p.entry * (p.signal.side === 'LONG' ? 1 - fraction : 1 + fraction);
}

function atPrice(state: PortfolioState, symbol: string, price: number, candle: Candle, settings: BacktestSettings, opening = false): void {
  const p = state.positions[symbol];
  if (!p) return;
  const long = p.signal.side === 'LONG';
  if (p.risk) {
    const liq = estimatedLiquidation(p.signal.side, p.entry, p.qty, p.margin, p.risk);
    if (liq !== null && (long ? price <= liq : price >= liq)) {
      // Isolated liquidation exhausts remaining collateral (including close-fee reserve).
      const bankruptcy = long ? (p.entry - p.margin / p.qty) / (1 - feeRate) : (p.entry + p.margin / p.qty) / (1 + feeRate);
      close(state, p, Math.max(Number.EPSILON, bankruptcy), p.qty, 'LIQ', candle, opening); return;
    }
  }
  const stopped = p.signal.exitMode !== 'PULLBACK_ENVELOPE'
    && (p.signal.exitMode !== 'VOLATILITY_CLOSE' || p.signal.volatilityStopEnabled === true)
    && (long ? price <= p.stop : price >= p.stop);
  if (p.pending && !stopped && (long ? price <= p.second : price >= p.second)) fillSecond(state, p, opening ? price : p.second, candle, settings, opening);
  if (stopped) { close(state, p, opening ? price : p.stop, p.qty, 'SL', candle, opening); return; }
  const roi = roiPrice(p, settings);
  if (roi !== null && (long ? price <= roi : price >= roi)) { close(state, p, opening ? price : roi, p.qty, 'ROI_LOSS', candle, opening); return; }
  if (p.signal.strategy === 'PULLBACK' && p.signal.exitMode === 'PULLBACK_ENVELOPE'
    && p.pullbackMa60Exit !== undefined && (long ? price <= p.pullbackMa60Exit : price >= p.pullbackMa60Exit)) {
    close(state, p, opening ? price : p.pullbackMa60Exit, p.qty, 'PULLBACK_MA60', candle, opening);
    return;
  }
  if (p.signal.envelopeMoveSlOnCenter === true && !p.centerStopMoved && p.envelopeCenter !== undefined
    && (long ? p.envelopeCenter > p.entry && price >= p.envelopeCenter : p.envelopeCenter < p.entry && price <= p.envelopeCenter)) {
    const next = (p.entry + p.envelopeCenter) / 2;
    p.stop = long ? Math.max(p.stop, next) : Math.min(p.stop, next);
    p.centerStopMoved = true;
  }
  if (p.partial !== null && !p.partialDone && (long ? price >= p.partial : price <= p.partial)) {
    p.partialDone = true;
    if (p.signal.strategy === 'DISPARITY') p.stop = p.first;
    close(state, p, p.partial, p.qty / 2, 'PARTIAL_TP', candle, opening);
  }
  const targetEnabled = p.signal.exitMode !== 'VOLATILITY_TP' && p.signal.exitMode !== 'VOLATILITY_MA5'
    || p.signal.exitMode === 'VOLATILITY_TP' && p.signal.volatilityTpEnabled !== false;
  if (targetEnabled && (long ? price >= p.target : price <= p.target)) {
    const disparity = p.signal.strategy === 'DISPARITY';
    const reason = p.signal.strategy === 'ENVELOPE' ? p.signal.envelopeExitMode === 'CENTER' ? 'ENVELOPE_CENTER' : 'ENVELOPE_OPPOSITE'
      : p.signal.strategy === 'PULLBACK' && p.signal.exitMode === 'PULLBACK_ENVELOPE' ? 'PULLBACK_ENVELOPE'
      : disparity ? 'MA60_TOUCH' : 'FULL_TP';
    close(state, p, disparity ? price : p.target, p.qty, reason, candle, opening);
  }
}

function replaySegment(state: PortfolioState, p: Holding, before: number, after: number, candle: Candle, settings: BacktestSettings): void {
  const levels = new Set<number>();
  if (p.risk) {
    const liq = estimatedLiquidation(p.signal.side, p.entry, p.qty, p.margin, p.risk);
    if (liq !== null) levels.add(liq);
  }
  const targetEnabled = p.signal.exitMode !== 'VOLATILITY_TP' && p.signal.exitMode !== 'VOLATILITY_MA5'
    || p.signal.exitMode === 'VOLATILITY_TP' && p.signal.volatilityTpEnabled !== false;
  if (targetEnabled) levels.add(p.target);
  if (p.signal.exitMode !== 'PULLBACK_ENVELOPE' && (p.signal.exitMode !== 'VOLATILITY_CLOSE' || p.signal.volatilityStopEnabled === true)) levels.add(p.stop);
  if (p.signal.strategy === 'PULLBACK' && p.signal.exitMode === 'PULLBACK_ENVELOPE' && p.pullbackMa60Exit !== undefined) levels.add(p.pullbackMa60Exit);
  if (p.pending) levels.add(p.second);
  if (p.partial !== null && !p.partialDone) levels.add(p.partial);
  if (p.signal.envelopeMoveSlOnCenter === true && !p.centerStopMoved && p.envelopeCenter !== undefined) levels.add(p.envelopeCenter);
  const roi = roiPrice(p, settings);
  if (roi !== null) levels.add(roi);
  const crossed = [...levels].filter(level => level !== before && level >= Math.min(before, after) && level <= Math.max(before, after)).sort((a, b) => after < before ? b - a : a - b);
  for (const price of crossed) {
    if (!state.positions[p.symbol]) break;
    atPrice(state, p.symbol, price, candle, settings);
  }
  if (state.positions[p.symbol]) p.mark = after;
}

function replayPath(position: Holding, bar: PreparedBar, settings: BacktestSettings, lowFirst: boolean): PortfolioState {
  const state = initialPortfolio(0);
  const { risk, ...holding } = position;
  const p: Holding = { ...structuredClone(holding), ...(risk ? { risk } : {}) };
  state.positions[p.symbol] = p;
  const candle = bar.candle;
  const path = lowFirst ? [candle.open, candle.low, candle.high, candle.close] : [candle.open, candle.high, candle.low, candle.close];
  atPrice(state, p.symbol, candle.open, candle, settings, true);
  for (let i = 1; i < path.length && state.positions[p.symbol]; i += 1) {
    const before = path[i - 1]!;
    const after = path[i]!;
    replaySegment(state, p, before, after, candle, settings);
    if (state.positions[p.symbol]) {
      const halfBreak = p.signal.strategy === 'DISPARITY' && settings.ma20HalfCloseEnabled && bar.ma20 !== null
        && (p.signal.side === 'LONG' ? (candle.high + candle.low) / 2 <= bar.ma20 : (candle.high + candle.low) / 2 >= bar.ma20);
      const direction = p.signal.side === 'LONG' ? 1 : -1;
      const volatilityClose = p.signal.exitMode === 'VOLATILITY_CLOSE'
        && p.signal.breakoutRange !== undefined && p.signal.volatilityK1 !== undefined
        && direction * (after - (p.first + direction * p.signal.breakoutRange * p.signal.volatilityK1)) >= 0;
      const volatilityMa5Exit = p.signal.exitMode === 'VOLATILITY_MA5'
        && i === path.length - 1
        && bar.ma5Exit !== null && bar.ma5Exit !== undefined
        && (p.signal.side === 'LONG' ? after > p.entry : after < p.entry)
        && (p.signal.side === 'LONG'
          ? (candle.high + candle.low) / 2 <= bar.ma5Exit
          : (candle.high + candle.low) / 2 >= bar.ma5Exit);
      const nextClose = p.signal.exitMode === 'VOLATILITY_TP' && p.signal.volatilityNextCloseEnabled === true
        && !('parentOpenTime' in candle) && candle.openTime > p.opened;
      if (i === path.length - 1 && nextClose) close(state, p, after, p.qty, 'NEXT_CANDLE_CLOSE', candle);
      else if (i === path.length - 1 && volatilityClose) close(state, p, after, p.qty, 'VOLATILITY_CLOSE', candle);
      else if (volatilityMa5Exit) close(state, p, after, p.qty, 'VOLATILITY_MA5_EXIT', candle);
      else if (halfBreak && i === path.length - 1) close(state, p, after, p.qty, 'MA20_HALF_BREAK', candle);
      else p.mark = after;
    }
  }
  return state;
}

/** Two admissible OHLC paths, with running extrema frozen only at the touch. */
function intrabarEntryPath(symbol: string, bar: PreparedBar, candle: Candle, settings: BacktestSettings, available: number, lowFirst: boolean, runningLow: number, runningHigh: number): PortfolioState {
  const state = initialPortfolio(available);
  const signal = bar.signal!;
  const path = lowFirst ? [candle.open, candle.low, candle.high, candle.close] : [candle.open, candle.high, candle.low, candle.close];
  const direction = signal.side === 'LONG' ? 1 : -1;
  let low = Math.min(runningLow, candle.open);
  let high = Math.max(runningHigh, candle.open);
  let attempted = false;
  const attempt = (price: number): void => {
    attempted = true;
    low = Math.min(low, price);
    high = Math.max(high, price);
    const stop = direction === 1 ? low : high;
    const prior = signal.volatilityPriorExtreme!;
    const limit = signal.volatilityEntryLimit!;
    const eligible = direction * (price - bar.candle.open) > 0
      && direction * (stop - prior) > 0 && direction * (limit - price) >= -Math.max(1e-12, Math.abs(limit)) * 1e-12;
    if (eligible) enter(state, symbol, { ...signal, entry: price, stop, initialStop: stop, activeStop: stop }, candle, settings);
  };
  // A jump in the next minute fills at its observed open, not a better trigger.
  // An opening fill beyond K2 is rejected rather than chased on a later return.
  if (direction * (candle.open - signal.entry) >= 0) attempt(candle.open);
  for (let i = 1; i < path.length; i += 1) {
    let before = path[i - 1]!;
    const after = path[i]!;
    if (!attempted && direction * (before - signal.entry) < 0 && direction * (after - signal.entry) >= 0) {
      attempt(signal.entry);
      before = signal.entry;
    }
    const position = state.positions[symbol];
    if (position) replaySegment(state, position, before, after, candle, settings);
    low = Math.min(low, after);
    high = Math.max(high, after);
  }
  return state;
}

function replayVolatilityMa5Entry(symbol: string, bar: PreparedBar, settings: BacktestSettings, available: number): PortfolioState {
  const state = initialPortfolio(available);
  const signal = bar.signal!;
  const executionCandle = { ...bar.candle, parentOpenTime: bar.candle.openTime };
  enter(state, symbol, signal, executionCandle, settings);
  return state;
}

function replayIntrabarEntry(symbol: string, bar: PreparedBar, settings: BacktestSettings, available: number): PortfolioState {
  if (bar.signal?.exitMode === 'VOLATILITY_MA5') return replayVolatilityMa5Entry(symbol, bar, settings, available);
  const minutes = bar.intrabarCandles ?? [];
  validateMinuteCandles(bar.candle, minutes);
  let state = initialPortfolio(available);
  let attempted = false;
  let low = bar.candle.open;
  let high = bar.candle.open;
  const direction = bar.signal!.side === 'LONG' ? 1 : -1;
  for (const minute of minutes) {
    const executionCandle = { ...minute, parentOpenTime: bar.candle.openTime };
    const touched = direction === 1 ? minute.high >= bar.signal!.entry : minute.low <= bar.signal!.entry;
    if (!attempted && touched) {
      attempted = true;
      state = worstPath([intrabarEntryPath(symbol, bar, executionCandle, settings, available, true, low, high),
        intrabarEntryPath(symbol, bar, executionCandle, settings, available, false, low, high)]);
    } else if (state.positions[symbol]) {
      const position = state.positions[symbol]!;
      const next = { ...bar, candle: executionCandle, signal: null };
      mergePath(state, worstPath([replayPath(position, next, settings, true), replayPath(position, next, settings, false)]), symbol);
    }
    low = Math.min(low, minute.low);
    high = Math.max(high, minute.high);
    if (attempted && !state.positions[symbol]) break;
  }
  return state;
}

function worstPath(candidates: PortfolioState[]): PortfolioState {
  const stopped = candidates.filter(candidate => candidate.exitReasons.SL);
  return (stopped.length ? stopped : candidates).sort((a, b) => portfolioEquity(a) - portfolioEquity(b))[0]!;
}

/** One entry at the first eligible band touch on each admissible path; no retrospective fills. */
function envelopeEntryPath(symbol: string, bar: PreparedBar, settings: BacktestSettings, available: number, lowFirst: boolean,
  settingsBySide?: Partial<Record<'LONG' | 'SHORT', BacktestSettings>>, openingPriority: 'LONG' | 'SHORT' = 'LONG',
  reclaimAllowed?: Partial<Record<'LONG' | 'SHORT', boolean>>): PortfolioState {
  const state = initialPortfolio(available);
  const definition = (side: 'LONG' | 'SHORT') => ({ band: bar.envelopeBySide ? bar.envelopeBySide[side] : bar.envelope,
    parameters: settingsBySide?.[side] ?? settings });
  const eligible = (side: 'LONG' | 'SHORT'): boolean => {
    const { band, parameters } = definition(side);
    return !!band && (side === 'LONG' ? band.long : band.short) && (parameters.side === 'BOTH' || parameters.side === side)
      && (!parameters.envelopeDailyTrend || dailyTrendAllows(band.dailyTrendChangePercent, side))
      && (parameters.envelopeEntryMode !== 'RECLAIM' || reclaimAllowed?.[side] === true);
  };
  const candle = bar.candle;
  const path = lowFirst ? [candle.open, candle.low, candle.high, candle.close] : [candle.open, candle.high, candle.low, candle.close];
  let attempted = false;
  let enteredSettings = settings;
  const attempt = (side: 'LONG' | 'SHORT', price: number): void => {
    attempted = true;
    const { band, parameters } = definition(side);
    if (!band) return;
    enteredSettings = parameters;
    const { percent, exit, period } = envelopeParameters(parameters);
    const direction = side === 'LONG' ? 1 : -1;
    const target = exit === 'CENTER' ? band.center : side === 'LONG' ? band.upper : band.lower;
    enter(state, symbol, { strategy: 'ENVELOPE', side, index: candle.openTime,
      entry: price, stop: price * (1 - direction * percent / 100), target, initialTarget: target,
      partial: exit === 'HALF' ? band.center : undefined,
      exitMode: 'ENVELOPE_TOUCH', envelopeDeviationPercent: percent, envelopeExitMode: exit, envelopeMaPeriod: period,
      envelopeCenter: band.center, envelopeMoveSlOnCenter: parameters.envelopeMoveSlOnCenter === true,
      ...(parameters.envelopeEntryMode === 'RECLAIM' ? { envelopeEntryMode: 'RECLAIM' as const } : {}),
      ...(band.sourceInterval ? { envelopeSourceInterval: band.sourceInterval } : {}),
    }, candle, parameters);
  };
  const openingSides = openingPriority === 'LONG' ? ['LONG', 'SHORT'] as const : ['SHORT', 'LONG'] as const;
  const missed = new Set<'LONG' | 'SHORT'>();
  for (const side of openingSides) if (!attempted && eligible(side)) {
    const { band, parameters } = definition(side);
    if (parameters.envelopeEntryMode === 'RECLAIM') {
      const boundary = side === 'LONG' ? band!.lower : band!.upper;
      const halfway = (boundary + band!.center) / 2;
      if (side === 'LONG' ? candle.open >= boundary : candle.open <= boundary) {
        if (side === 'LONG' ? candle.open <= halfway : candle.open >= halfway) attempt(side, candle.open);
        else missed.add(side); // A gap past the entry window is not chased later in this candle.
      }
    } else if (side === 'LONG' ? candle.open <= band!.lower : candle.open >= band!.upper) attempt(side, candle.open);
  }
  for (let index = 1; index < path.length; index += 1) {
    let before = path[index - 1]!;
    const after = path[index]!;
    if (!attempted) {
      const long = definition('LONG').band; const short = definition('SHORT').band;
      const longCross = long && (definition('LONG').parameters.envelopeEntryMode === 'RECLAIM' ? before < long.lower && after >= long.lower : before > long.lower && after <= long.lower);
      const shortCross = short && (definition('SHORT').parameters.envelopeEntryMode === 'RECLAIM' ? before > short.upper && after <= short.upper : before < short.upper && after >= short.upper);
      if (eligible('LONG') && !missed.has('LONG') && longCross) { attempt('LONG', long!.lower); before = long!.lower; }
      else if (eligible('SHORT') && !missed.has('SHORT') && shortCross) { attempt('SHORT', short!.upper); before = short!.upper; }
    }
    const position = state.positions[symbol];
    if (position) replaySegment(state, position, before, after, candle, enteredSettings);
  }
  return state;
}

function mergePath(state: PortfolioState, selected: PortfolioState, symbol: string, baseline = 0): void {
  state.cash += selected.cash - baseline;
  for (const field of ['realized', 'fees', 'closed', 'wins', 'losses', 'breakeven', 'secondFills', 'entries', 'signals', 'insufficientFunds'] as const) state[field] += selected[field];
  state.winningProfit = (state.winningProfit ?? 0) + (selected.winningProfit ?? 0);
  state.losingLoss = (state.losingLoss ?? 0) + (selected.losingLoss ?? 0);
  for (const [reason, count] of Object.entries(selected.exitReasons)) state.exitReasons[reason] = (state.exitReasons[reason] ?? 0) + count;
  state.trades = [...state.trades, ...selected.trades].slice(-100);
  if (selected.positions[symbol]) state.positions[symbol] = selected.positions[symbol];
  else delete state.positions[symbol];
}

function processBar(state: PortfolioState, symbol: string, bar: PreparedBar, settings: BacktestSettings): void {
  const position = state.positions[symbol];
  if (!position) return;
  if (position.signal.strategy === 'NEW_HIGH') return; // Replayed with intrabar funding together below.
  if (position.signal.strategy === 'DISPARITY') {
    if (bar.ma60Exit === null) throw new Error(`${symbol}의 MA60 계산에 필요한 캔들이 부족합니다.`);
    position.target = bar.ma60Exit;
  }
  if (position.signal.strategy === 'ENVELOPE') {
    if (!bar.envelope) throw new Error(`${symbol}의 엔벨로프 중심선 계산에 필요한 캔들이 부족합니다.`);
    position.target = position.signal.envelopeExitMode === 'CENTER' ? bar.envelope.center
      : position.signal.side === 'LONG' ? bar.envelope.upper : bar.envelope.lower;
    position.partial = position.signal.envelopeExitMode === 'HALF' && !position.partialDone ? bar.envelope.center : null;
    position.envelopeCenter = bar.envelope.center;
  }
  if (position.signal.strategy === 'PULLBACK' && position.signal.exitMode === 'PULLBACK_ENVELOPE') {
    if (!bar.pullbackEnvelope) throw new Error(`${symbol}의 눌림목 엔벨로프 계산에 필요한 캔들이 부족합니다.`);
    position.target = position.signal.side === 'LONG' ? bar.pullbackEnvelope.upper : bar.pullbackEnvelope.lower;
    position.pullbackMa60Exit = bar.ma60 ?? undefined;
  }
  const candidates = [replayPath(position, bar, settings, true), replayPath(position, bar, settings, false)];
  mergePath(state, worstPath(candidates), symbol);
  const remaining = state.positions[symbol];
  if (remaining?.signal.strategy === 'PULLBACK' && remaining.signal.exitMode === 'PULLBACK_ENVELOPE') {
    const long = remaining.signal.side === 'LONG';
    const aligned = bar.ma20 !== null && bar.ma20 !== undefined && bar.ma60 !== null && bar.ma60 !== undefined
      && bar.ma120 !== null && bar.ma120 !== undefined
      && (long ? bar.ma20 > bar.ma60 && bar.ma60 > bar.ma120 : bar.ma20 < bar.ma60 && bar.ma60 < bar.ma120);
    if (!aligned) close(state, remaining, bar.candle.close, remaining.qty, 'PULLBACK_MA_EXIT', bar.candle);
  }
}

interface NewHighPath { state: PortfolioState; spent: number }
/** Causal price-dependent MA5/10/20 with intrabar entry and post-entry candle confirmation. */
function newHighPath(symbol: string, bar: PreparedBar, settings: BacktestSettings, available: number, holding: Holding | undefined, lowFirst: boolean): NewHighPath {
  const state = initialPortfolio(available); const definition = bar.newHigh!; const candle = bar.candle;
  if (holding) state.positions[symbol] = structuredClone(holding);
  let spent = 0; let attempted = holding !== undefined; let enteredThisCandle = false;
  const leverage = Number(settings.leverage);
  const riskAmount = settings.newHighSizingMode === 'RISK' ? newHighRiskAmount(settings) : undefined;
  const ma10 = (price: number) => (definition.sum9 + price) / 10;
  const ma20 = (price: number) => (definition.sum19 + price) / 20;
  const ma5 = (price: number) => (definition.sum4 + price) / 5;
  const ma60 = (price: number): number | null => definition.sum59 !== undefined && Number.isFinite(definition.sum59)
    ? (definition.sum59 + price) / 60 : null;
  const slMultiplier = newHighSlMultiplier(settings);
  const entryAtrLimit = newHighEntryAtrLimit(settings);
  const tolerance = (...values: number[]) => Math.max(Number.MIN_VALUE, ...values.map(value => Math.abs(value) * Number.EPSILON * 16));
  const advanceTrail = (p: Holding, price: number): void => {
    const atr = p.signal.newHighAtr ?? Math.abs(p.target - p.first) / 2;
    if (atr === null || !Number.isFinite(atr) || atr <= 0) return;
    const direction = p.signal.side === 'LONG' ? 1 : -1;
    const progress = direction * (price - p.first) / atr;
    const step = progress >= 1 ? Math.floor(progress + 1e-10) : 0;
    const currentStep = p.newHighTrailStep ?? 0;
    if (step <= currentStep) return;
    const lockedAtr = step === 1 ? 0.2 : step - 1;
    const nextStop = p.first + direction * lockedAtr * atr;
    if (direction * (nextStop - p.stop) > 0) p.stop = nextStop;
    p.newHighTrailStep = step;
  };
  const stopReason = (p: Holding): string => (p.newHighTrailStep ?? 0) > 0 ? 'NEW_HIGH_TRAILING' : 'SL';
  const conditionalExitPrice = (p: Holding, before: number, after: number): number | null => {
    const long = p.signal.side === 'LONG';
    const maCross = (definition.sum19 - 4 * definition.sum4) / 3;
    const condition = (price: number) => long
      ? price >= p.target && ma5(price) < ma20(price)
      : price <= p.target && ma5(price) > ma20(price);
    if (!Number.isFinite(maCross) || before === after) return condition(before) ? before : null;
    const change = after - before;
    const points = [0, 1];
    for (const boundary of [p.target, maCross]) {
      const fraction = (boundary - before) / change;
      if (fraction > 0 && fraction < 1) points.push(fraction);
    }
    points.sort((a, b) => a - b);
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index]!; const end = points[index + 1]!;
      if (condition(before + change * ((start + end) / 2))) return before + change * start;
    }
    return condition(after) ? after : null;
  };
  const attempt = (side: 'LONG' | 'SHORT', price: number): void => {
    attempted = true;
    const direction = side === 'LONG' ? 1 : -1;
    if (direction * (price - candle.open) < 0) return;
    const fill = price * (1 + direction * slippage);
    const boundary = side === 'LONG' ? definition.high : definition.low;
    const currentMa60 = ma60(price);
    if (direction * (ma10(price) - ma20(price)) <= 0
      || settings.newHighMa60Enabled === true && (currentMa60 === null || direction * (price - currentMa60) <= 0)
      || direction * (fill - boundary) > entryAtrLimit * definition.atr! + tolerance(fill, boundary, definition.atr!)) return;
    const stop = fill - direction * slMultiplier * definition.atr!;
    if (!(stop > 0) || (side === 'LONG' ? stop >= price : stop <= price)) return;
    const target = fill + direction * 2 * definition.atr!;
    enter(state, symbol, { strategy: 'NEW_HIGH', side, index: candle.openTime / (candle.closeTime - candle.openTime),
      entry: price, stop, target, initialTarget: target, exitMode: 'NEW_HIGH_TOUCH', newHighAtr: definition.atr!, ...(riskAmount !== undefined ? { riskAmount } : {}) }, candle, settings);
    const p = state.positions[symbol];
    if (p) { p.newHighTrailStep = 0; enteredThisCandle = true; spent += p.margin + p.margin * leverage * feeRate; }
  };
  const eligible = (side: 'LONG' | 'SHORT'): boolean => definition.atr !== null && definition.atr > 0 && (side === 'LONG' ? definition.long : definition.short);
  const crossPrice = definition.sum19 - 2 * definition.sum9;
  const longEntry = definition.high; const shortEntry = definition.low;
  const atOpen = state.positions[symbol];
  if (atOpen) {
    advanceTrail(atOpen, candle.open);
    const long = atOpen.signal.side === 'LONG';
    if (long ? candle.open <= atOpen.stop : candle.open >= atOpen.stop) close(state, atOpen, candle.open, atOpen.qty, stopReason(atOpen), candle, true);
    else if (conditionalExitPrice(atOpen, candle.open, candle.open) !== null) close(state, atOpen, candle.open, atOpen.qty, 'NEW_HIGH_CONDITIONAL_EXIT', candle, true);
  } else if (eligible('LONG') && candle.open > longEntry) attempt('LONG', candle.open);
  else if (eligible('SHORT') && candle.open < shortEntry) attempt('SHORT', candle.open);
  const path = lowFirst ? [candle.open, candle.low, candle.high, candle.close] : [candle.open, candle.high, candle.low, candle.close];
  for (let i = 1; i < path.length; i += 1) {
    let before = path[i - 1]!; const after = path[i]!;
    for (let count = 0; count < 3; count += 1) {
      const p = state.positions[symbol];
      const events: { price: number; kind: 'SL' | 'EXIT' | 'LONG' | 'SHORT' }[] = [];
      if (p) {
        advanceTrail(p, before); advanceTrail(p, after);
        const long = p.signal.side === 'LONG';
        if (long ? before >= p.stop && after <= p.stop : before <= p.stop && after >= p.stop) events.push({ price: p.stop, kind: 'SL' });
        const exit = conditionalExitPrice(p, before, after);
        if (exit !== null) events.push({ price: exit, kind: 'EXIT' });
      } else if (!attempted) {
        if (eligible('LONG') && before <= longEntry && after > longEntry) events.push({ price: longEntry, kind: 'LONG' });
        if (eligible('SHORT') && before >= shortEntry && after < shortEntry) events.push({ price: shortEntry, kind: 'SHORT' });
      }
      events.sort((a, b) => Math.abs(a.price - before) - Math.abs(b.price - before));
      const event = events[0]; if (!event) break;
      if (event.kind === 'SL' || event.kind === 'EXIT') { close(state, p!, event.price, p!.qty, event.kind === 'SL' ? stopReason(p!) : 'NEW_HIGH_CONDITIONAL_EXIT', candle); break; }
      if (event.kind === 'LONG' || event.kind === 'SHORT') {
        const direction = event.kind === 'LONG' ? 1 : -1;
        attempt(event.kind, event.price === crossPrice ? event.price + direction * tolerance(event.price) : event.price);
      }
      before = event.price;
    }
  }
  const newEntry = enteredThisCandle ? state.positions[symbol] : undefined;
  if (newEntry) {
    const long = newEntry.signal.side === 'LONG';
    const range = candle.high - candle.low;
    const directionConfirmed = long ? candle.close > candle.open && candle.close > longEntry : candle.close < candle.open && candle.close < shortEntry;
    const wick = range > 0
      ? long
        ? (Math.max(0, candle.high - Math.max(candle.open, candle.close)) + Math.max(0, candle.open - candle.close)) / range
        : (Math.max(0, Math.min(candle.open, candle.close) - candle.low) + Math.max(0, candle.close - candle.open)) / range
      : 0;
    if (!directionConfirmed) close(state, newEntry, candle.close, newEntry.qty, 'NEW_HIGH_BREAKOUT_FAIL', candle);
    else if (wick >= 0.7) close(state, newEntry, candle.close, newEntry.qty, 'NEW_HIGH_CANDLE_REJECTION', candle);
  }
  const remaining = state.positions[symbol];
  if (remaining) remaining.mark = candle.close;
  return { state, spent };
}

function replayNewHighRows(state: PortfolioState, rows: { symbol: string; bar: PreparedBar }[], settings: BacktestSettings, budget: number): number {
  for (const { symbol, bar } of rows) {
    if (!bar.newHigh) {
      if (state.positions[symbol]?.signal.strategy === 'NEW_HIGH') throw new Error(`${symbol}의 신고가 지표 계산에 필요한 캔들이 부족합니다.`);
      continue;
    }
    const available = Math.max(0, Math.min(budget, state.cash));
    const candidates = [true, false].map(lowFirst => newHighPath(symbol, bar, settings, available, state.positions[symbol], lowFirst));
    // A profitable raised SL must not outrank the other path's earlier losing MA exit.
    const selected = candidates.sort((a, b) => portfolioEquity(a.state) - portfolioEquity(b.state)
      || Number(!!b.state.exitReasons.SL) - Number(!!a.state.exitReasons.SL))[0]!;
    mergePath(state, selected.state, symbol, available); budget = Math.max(0, budget - selected.spent);
  }
  return budget;
}

/** Close-entry strategies reuse exits; intrabar entries use the opening cash budget only. */
export interface ReplayOptions {
  settingsForSymbol?: Record<string, BacktestSettings>;
  settingsForSymbolSide?: Record<string, Partial<Record<'LONG' | 'SHORT', BacktestSettings>>>;
}

export function replayPortfolioBlock(state: PortfolioState, documents: PreparedSymbol[], settings: BacktestSettings, start: number, end: number, seconds: number, options: ReplayOptions = {}): void {
  const byTime = new Map<number, { symbol: string; bar: PreparedBar }[]>();
  for (const document of [...documents].sort((a, b) => a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)) {
    for (const bar of document.bars) {
      if (bar.candle.openTime < start || bar.candle.openTime >= end) continue;
      const rows = byTime.get(bar.candle.openTime) ?? [];
      rows.push({ symbol: document.symbol, bar });
      byTime.set(bar.candle.openTime, rows);
    }
  }
  for (let at = start; at < end; at += seconds) {
    const rows = byTime.get(at) ?? [];
    const present = new Set(rows.map(row => row.symbol));
    if (Object.keys(state.positions).some(symbol => !present.has(symbol))) throw new Error('보유 종목의 캔들이 누락되어 계산을 중단했습니다.');
    const occupiedAtOpen = new Set(Object.keys(state.positions));
    const entered = new Set<string>();
    for (const { symbol, bar } of rows) if (bar.envelope?.parentOpenTime !== undefined) {
      state.envelopeParents ??= {};
      const previous = state.envelopeParents[symbol];
      if (!previous || previous.openTime !== bar.envelope.parentOpenTime) state.envelopeParents[symbol] = { openTime: bar.envelope.parentOpenTime, blocked: occupiedAtOpen.has(symbol) };
    }
    for (const { symbol, bar } of rows) for (const side of ['LONG', 'SHORT'] as const) {
      const band = bar.envelopeBySide?.[side];
      if (band?.parentOpenTime === undefined) continue;
      state.envelopeParents ??= {};
      const key = `${symbol}:${side}`; const previous = state.envelopeParents[key];
      if (!previous || previous.openTime !== band.parentOpenTime) state.envelopeParents[key] = { openTime: band.parentOpenTime, blocked: occupiedAtOpen.has(symbol) };
    }
    // A later intrabar/close exit must not finance an earlier breakout touch.
    // No same-bar profit/margin recycling or exit-then-retroactive re-entry.
    let intrabarBudget = Math.max(0, state.cash);
    intrabarBudget = replayNewHighRows(state, rows, settings, intrabarBudget);
    for (const { symbol, bar } of rows) {
      const side = state.positions[symbol]?.signal.side;
      const parameters = side && options.settingsForSymbolSide?.[symbol]?.[side] || options.settingsForSymbol?.[symbol] || settings;
      processBar(state, symbol, side && bar.envelopeBySide ? { ...bar, envelope: bar.envelopeBySide[side] } : bar, parameters);
    }
    for (const { symbol, bar } of rows) {
      const parameters = options.settingsForSymbol?.[symbol] ?? settings;
      const hasEnvelope = !!(bar.envelope || bar.envelopeBySide);
      const intrabarSignal = bar.signal?.exitMode === 'VOLATILITY_TP' || bar.signal?.exitMode === 'VOLATILITY_MA5';
      const hasIntrabarData = intrabarSignal;
      if (occupiedAtOpen.has(symbol) || !hasIntrabarData && !hasEnvelope) continue;
      if (bar.envelope?.parentOpenTime !== undefined && state.envelopeParents?.[symbol]?.blocked) continue;
      if (bar.envelope && parameters.envelopeEntryMode !== 'RECLAIM' && !(bar.envelope.long && bar.candle.low <= bar.envelope.lower)
        && !(bar.envelope.short && bar.candle.high >= bar.envelope.upper)) continue;
      const available = Math.max(0, Math.min(intrabarBudget, state.cash));
      const entryBar = bar.envelopeBySide ? { ...bar, envelopeBySide: Object.fromEntries(Object.entries(bar.envelopeBySide).map(([side, band]) => {
        const blocked = state.envelopeParents?.[`${symbol}:${side}`]?.blocked;
        return [side, { ...band, long: band.long && !blocked, short: band.short && !blocked }];
      })) } : bar;
      const reclaimAllowed: Partial<Record<'LONG' | 'SHORT', boolean>> = {};
      for (const side of ['LONG', 'SHORT'] as const) {
        const band = bar.envelopeBySide ? bar.envelopeBySide[side] : bar.envelope;
        const outside = state.envelopeReclaims?.[`${symbol}:${side}`];
        reclaimAllowed[side] = !!band && !!outside && outside.outsideAt < (band.parentOpenTime ?? bar.candle.openTime);
      }
      const selected = hasEnvelope
        ? worstPath([true, false].flatMap(lowFirst => (bar.envelopeBySide ? ['LONG', 'SHORT'] as const : ['LONG'] as const)
          .map(priority => envelopeEntryPath(symbol, entryBar, parameters, available, lowFirst, options.settingsForSymbolSide?.[symbol], priority, reclaimAllowed))))
        : replayIntrabarEntry(symbol, bar, parameters, available);
      mergePath(state, selected, symbol, available);
      if (selected.entries) {
        entered.add(symbol);
        if (bar.envelope?.parentOpenTime !== undefined) state.envelopeParents![symbol]!.blocked = true;
        if (bar.envelopeBySide) {
          const side = selected.positions[symbol]?.signal.side ?? selected.trades[0]?.side;
          if (side && state.envelopeParents?.[`${symbol}:${side}`]) state.envelopeParents[`${symbol}:${side}`]!.blocked = true;
        }
        intrabarBudget = Math.max(0, intrabarBudget - Number(parameters.betAmountUsdt) * (1 + Number(parameters.leverage) * feeRate));
      }
    }
    // Only a completed candle can arm a later, different parent candle. A same-parent
    // dip and recovery is discarded; a held/just-entered position cannot seed another entry.
    for (const { symbol, bar } of rows) for (const side of ['LONG', 'SHORT'] as const) {
      const parameters = options.settingsForSymbolSide?.[symbol]?.[side] ?? options.settingsForSymbol?.[symbol] ?? settings;
      if (parameters.envelopeEntryMode !== 'RECLAIM') continue;
      const band = bar.envelopeBySide ? bar.envelopeBySide[side] : bar.envelope;
      if (!band && !bar.envelopeBySide && !bar.envelope) continue;
      state.envelopeReclaims ??= {};
      const key = `${symbol}:${side}`;
      if (band && (side === 'LONG' ? band.long && bar.candle.close < band.lower : band.short && bar.candle.close > band.upper)
        && !occupiedAtOpen.has(symbol) && !entered.has(symbol) && !state.positions[symbol]) {
        state.envelopeReclaims[key] ??= { outsideAt: band.parentOpenTime ?? bar.candle.openTime };
      } else delete state.envelopeReclaims[key];
    }
    for (const { symbol, bar } of rows) {
      const signal = bar.signal;
      const completedEntry = signal?.exitMode !== 'VOLATILITY_MA5';
      if (signal && signal.exitMode !== 'VOLATILITY_TP' && completedEntry) enter(state, symbol, signal, bar.candle, options.settingsForSymbol?.[symbol] ?? settings);
    }
    if (!rows.length) continue;
    state.observedBars += 1;
    state.dataStartAt ??= at;
    state.dataEndAt = at + seconds;
    const equity = portfolioEquity(state);
    state.peak = Math.max(state.peak, equity);
    if (state.peak > 0) state.maxDrawdown = Math.max(state.maxDrawdown, (state.peak - equity) / state.peak * 100);
    state.equityCurve.push({ at: at + seconds, equityUsdt: equity });
    if (state.equityCurve.length > 600) state.equityCurve = state.equityCurve.filter((_, index) => index % 2 === 0 || index === state.equityCurve.length - 1);
  }
}

export function portfolioResult(state: PortfolioState, settings: BacktestSettings): BacktestResult {
  const initial = Number(settings.initialCapitalUsdt);
  const equity = portfolioEquity(state);
  return {
    initialCapitalUsdt: initial, finalEquityUsdt: equity, returnPercent: (equity / initial - 1) * 100,
    realizedProfitUsdt: state.realized, unrealizedProfitUsdt: equity - initial - state.realized,
    feesUsdt: state.fees, maxDrawdownPercent: state.maxDrawdown, entryCount: state.entries,
    closedTradeCount: state.closed, winCount: state.wins, lossCount: state.losses, breakevenCount: state.breakeven,
    winRatePercent: state.closed ? state.wins / state.closed * 100 : null,
    winningProfitUsdt: state.winningProfit ?? 0, losingLossUsdt: state.losingLoss ?? 0,
    openPositionCount: Object.keys(state.positions).length, insufficientFundsCount: state.insufficientFunds,
    betAmountUsdt: Number(settings.betAmountUsdt), secondFillCount: state.secondFills,
    signalCount: state.signals, observedBars: state.observedBars, dataStartAt: state.dataStartAt, dataEndAt: state.dataEndAt,
    exitReasons: state.exitReasons, recentTrades: state.trades, equityCurve: state.equityCurve, candles: [],
  };
}
