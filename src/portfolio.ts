/** Shared virtual account replay, with conservative OHLC paths and resumable JSON state. */
import type { PreparedBar, PreparedSymbol } from './engine';
import type { BacktestResult, BacktestSettings, BacktestTrade, Candle, ContractRisk, Execution, PriceLine, Signal } from './types';
import { validateMinuteCandles } from './intrabar';
import { envelopeHalfCandleAllowsEntry, envelopeParameters } from './envelope';
import { newHighRiskAmount, newHighSlMultiplier } from './newHigh';
import { estimatedLiquidation } from './contractRisk';

const feeRate = 0.00055;
const slippage = 0.0002;

interface Holding {
  symbol: string;
  signal: Signal;
  opened: number;
  first: number;
  entry: number;
  betAmountUsdt: number;
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
  newHighTrailLevels?: { step: number; price: number; reachedPrice?: number }[];
  newHighEntryParentOpenTime?: number;
  newHighEntryParentLow?: number;
  newHighEntryParentHigh?: number;
  /** State for the post-entry volatility candle rule. */
  volatilityEntryOpen?: number;
  volatilityEntryClose?: number;
  volatilityEntryLow?: number;
  volatilityEntryHigh?: number;
  volatilityRuleStage?: number;
  volatilityPreviousBody?: number;
  volatilitySecondFilled?: boolean;
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
  /** A reference setup may be attempted only once across its reference/next-bar window. */
  referenceAttempts?: Record<string, boolean>;
}

export function initialPortfolio(capital: number): PortfolioState {
  return {
    cash: capital, realized: 0, fees: 0, positions: {}, trades: [], entries: 0, closed: 0,
    wins: 0, losses: 0, winningProfit: 0, losingLoss: 0, breakeven: 0, signals: 0, insufficientFunds: 0, secondFills: 0,
    exitReasons: {}, peak: capital, maxDrawdown: 0, observedBars: 0,
    dataStartAt: null, dataEndAt: null, equityCurve: [],
    referenceAttempts: {},
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
  if (p.signal.strategy === 'NEW_HIGH') return [{ kind: 'ENTRY', price: p.first },
    ...(p.newHighTrailLevels ?? []).flatMap(level => level.reachedPrice === undefined ? [] : [{ kind: 'TRAILING_REACHED' as const, price: level.reachedPrice, stage: level.step }]),
    ...(p.newHighTrailLevels ?? []).map(level => ({ kind: 'TRAILING_SL' as const, price: level.price, stage: level.step })),
    { kind: 'SL', price: p.stop },
    ...(p.stop !== p.signal.stop ? [{ kind: 'INITIAL_SL' as const, price: p.signal.stop }] : [])];
  if (p.signal.strategy === 'ENVELOPE') {
    if (p.signal.exitMode === 'ENVELOPE_MA20_CLOSE') return [{ kind: 'ENTRY', price: p.first }]
    const lines: PriceLine[] = [
      { kind: 'ENTRY', price: p.first },
      ...(p.signal.second !== undefined ? [{ kind: 'SECOND_ENTRY' as const, price: p.second }] : []),
      ...(p.secondFill !== undefined ? [{ kind: 'AVERAGE_ENTRY' as const, price: p.entry }] : []),
      { kind: 'SL', price: p.stop },
      { kind: 'TP', price: p.target },
    ];
    return lines.filter(line => Number.isFinite(line.price) && line.price > 0);
  }
  if (p.signal.strategy === 'VOLATILITY') return [
    { kind: 'ENTRY', price: p.first },
    ...(p.signal.exitMode === 'VOLATILITY_WICK_RULE' ? [
      { kind: 'SL' as const, price: p.stop },
      ...(p.stop !== p.signal.stop ? [{ kind: 'INITIAL_SL' as const, price: p.signal.stop }] : []),
      ...(p.target > 0 ? [{ kind: 'TP' as const, price: p.target }] : []),
    ] : []),
    ...(p.secondFill !== undefined ? [{ kind: 'SECOND_ENTRY' as const, price: p.secondFill }, { kind: 'AVERAGE_ENTRY' as const, price: p.entry }] : []),
    ...(p.signal.exitMode !== 'VOLATILITY_WICK_RULE' && p.signal.volatilityStopEnabled === true ? [{ kind: 'SL' as const, price: p.stop }] : []),
    ...(p.signal.exitMode !== 'VOLATILITY_WICK_RULE' && p.stop !== p.signal.stop ? [{ kind: 'INITIAL_SL' as const, price: p.signal.stop }] : []),
    ...(p.signal.exitMode === 'VOLATILITY_CANDLE_RULE' && p.target > 0
      || p.signal.exitMode === 'VOLATILITY_CLOSE'
      || p.signal.exitMode === 'VOLATILITY_TP' && p.signal.volatilityTpEnabled !== false ? [{ kind: 'TP' as const, price: p.target }] : []),
  ];
  if (p.signal.strategy === 'REFERENCE') return [
    { kind: 'ENTRY', price: p.first },
    { kind: 'SL', price: p.stop },
    { kind: 'TP', price: p.target },
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
  const intrabarMode = p.signal.exitMode === 'VOLATILITY_TP' || p.signal.exitMode === 'VOLATILITY_CANDLE_RULE' || p.signal.exitMode === 'ENVELOPE_TOUCH' || p.signal.exitMode === 'PULLBACK_ENVELOPE' || p.signal.exitMode === 'NEW_HIGH_TOUCH' || p.signal.exitMode === 'REFERENCE_TOUCH'
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
  const market = ['SL', 'ROI_LOSS', 'MA60_TOUCH', 'MA20_HALF_BREAK', 'SESSION_CLOSE', 'VOLATILITY_CLOSE', 'VOLATILITY_MA5_EXIT', 'VOLATILITY_CANDLE_EXIT', 'VOLATILITY_WICK_EXIT', 'NEXT_CANDLE_CLOSE', 'NEW_HIGH_TRAILING', 'NEW_HIGH_NEXT_CANDLE_BREAK', 'NEW_HIGH_BREAKOUT_FAIL', 'NEW_HIGH_CANDLE_REJECTION', 'PULLBACK_MA_EXIT', 'ENVELOPE_MA20_CLOSE', 'ENVELOPE_CLOSE_CONFIRM'].includes(reason);
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
    reason === 'NEXT_CANDLE_CLOSE' || reason === 'VOLATILITY_MA5_EXIT' || reason === 'VOLATILITY_CANDLE_EXIT' || reason === 'VOLATILITY_WICK_EXIT' || reason === 'ENVELOPE_MA20_CLOSE' || reason === 'ENVELOPE_CLOSE_CONFIRM');
  state.trades.push({
    tradeId: `local:${p.symbol}:${p.opened}:${candle.openTime}:${p.executions.length}`,
    symbol: p.symbol, side: p.signal.side, entryAt: p.opened,
    exitAt: p.executions.at(-1)!.at,
    entryPrice: p.entry, exitPrice: fill, quantity: qty, reason, netProfitUsdt: p.signal.strategy === 'NEW_HIGH' ? p.net : profit - fee, betAmountUsdt: p.betAmountUsdt,
    ...(p.signal.strategy === 'NEW_HIGH' ? { newHighTrailStep: p.newHighTrailStep ?? 0, newHighTrailLevels: structuredClone(p.newHighTrailLevels ?? []) } : {}),
    signalIndex: p.signal.index, entryIndex: p.signal.index, exitIndex: -1,
    signal: { ...p.signal, target: p.target, partial: p.partial ?? undefined,
      second: p.signal.strategy === 'ENVELOPE' && p.signal.envelopeEntryMode === 'BAND_TOUCH' ? undefined
        : p.signal.strategy === 'ENVELOPE' ? p.second : p.secondFill ?? p.second,
      initialStop: p.signal.initialStop ?? p.signal.stop, activeStop: p.stop, averageEntry: p.entry },
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

function enter(state: PortfolioState, symbol: string, signal: Signal, candle: Candle, settings: BacktestSettings, confirmedClose = false): void {
  if (state.positions[symbol] || settings.side !== 'BOTH' && settings.side !== signal.side) return;
  state.signals += 1;
  const leverage = Number(settings.leverage);
  const split = signal.strategy === 'ENVELOPE' && signal.second !== undefined
    || signal.strategy === 'PULLBACK' && signal.exitMode !== 'PULLBACK_ENVELOPE';
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
  if (signal.exitMode !== 'ENVELOPE_MA20_CLOSE'
    && signal.exitMode !== 'VOLATILITY_CANDLE_RULE'
    && signal.exitMode !== 'VOLATILITY_WICK_RULE'
    && (!Number.isFinite(target) || target <= 0 && (signal.exitMode !== 'VOLATILITY_TP' || signal.volatilityTpEnabled !== false))) return;
  const margin = split ? bet / 2 : bet;
  const fee = margin * leverage * feeRate;
  const activeStop = signal.strategy === 'VOLATILITY'
    && signal.exitMode !== 'VOLATILITY_CANDLE_RULE'
    && signal.exitMode !== 'VOLATILITY_WICK_RULE'
    && signal.volatilityAtr !== undefined
    ? entry - direction * signal.volatilityAtr * 2
    : signal.stop;
  const envelopeStop = signal.strategy === 'ENVELOPE' && signal.envelopeEntryMode === 'BAND_TOUCH'
    ? entry * (1 - direction * signal.envelopeDeviationPercent! / 100)
    : signal.strategy === 'ENVELOPE' && signal.second !== undefined
      ? signal.second - direction * Math.abs(entry - signal.second)
      : activeStop;
  if (signal.strategy === 'ENVELOPE' && signal.exitMode !== 'ENVELOPE_MA20_CLOSE' && (!Number.isFinite(envelopeStop) || envelopeStop <= 0)) return;
  const effectiveSignal = envelopeStop === signal.stop ? signal : { ...signal, stop: envelopeStop };
  const intrabarEntry = signal.exitMode === 'VOLATILITY_TP' || signal.exitMode === 'VOLATILITY_MA5' || signal.exitMode === 'VOLATILITY_CANDLE_RULE' || signal.exitMode === 'ENVELOPE_TOUCH' || signal.exitMode === 'NEW_HIGH_TOUCH' || signal.exitMode === 'REFERENCE_TOUCH';
  const p: Holding = {
    symbol, signal: effectiveSignal, opened: intrabarEntry && !confirmedClose ? candle.openTime : candle.closeTime, first: entry, entry, betAmountUsdt: bet, qty: riskSizedQuantity ?? margin * leverage / entry,
    margin, reserved: bet - margin, reservedFee: (bet - margin) * leverage * feeRate,
    pending: split,
    second: split ? signal.strategy === 'ENVELOPE' && signal.second !== undefined ? signal.second : (entry + signal.stop) / 2 : entry,
    ...(signal.strategy === 'ENVELOPE' && settings.envelopeRisk?.symbol === symbol ? { risk: settings.envelopeRisk } : {}),
    target,
    partial: settings.partialTpEnabled && signal.strategy !== 'VOLATILITY' && signal.strategy !== 'ENVELOPE' && signal.strategy !== 'NEW_HIGH' && signal.strategy !== 'REFERENCE' && signal.exitMode !== 'PULLBACK_ENVELOPE' ? (entry + signal.initialTarget) / 2 : null,
    partialDone: false, stop: envelopeStop, mark: candle.close, net: -fee, executions: [],
    ...(signal.exitMode === 'VOLATILITY_CANDLE_RULE' ? {
      volatilityEntryOpen: candle.open,
      volatilityEntryClose: candle.close,
      volatilityEntryLow: candle.low,
      volatilityEntryHigh: candle.high,
      volatilityRuleStage: 0,
      volatilityPreviousBody: Math.abs(candle.close - candle.open),
      volatilitySecondFilled: false,
    } : {}),
    ...(signal.exitMode === 'VOLATILITY_WICK_RULE' ? {
      volatilityRuleStage: 0,
      volatilityPreviousBody: Math.abs(candle.close - candle.open),
    } : {}),
  };
  if (signal.strategy === 'ENVELOPE') {
    p.signal = { ...effectiveSignal, stop: p.stop, initialStop: signal.envelopeEntryMode === 'BAND_TOUCH' ? p.stop : signal.second ?? signal.stop };
    p.envelopeCenter = signal.envelopeCenter;
  }
  state.positions[symbol] = p;
  state.cash -= bet + bet * leverage * feeRate;
  state.realized -= fee;
  state.fees += fee;
  state.entries += 1;
  const entryAtOpen = intrabarEntry && !confirmedClose;
  recordFill(p, 'ENTRY', entry, p.qty, candle, entryAtOpen, confirmedClose);
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
  if (p.signal.strategy === 'PULLBACK') {
    p.target = (p.entry + p.first) / 2;
    p.partial = null;
  }
  state.secondFills += 1;
  recordFill(p, 'SPLIT_ENTRY', price, qty, candle, opening);
}

/**
 * The volatility rule's second entry is confirmed only after the following
 * candle is complete. It uses exactly the first entry quantity, rather than a
 * second fixed-bet notional, and therefore keeps the requested quantity
 * symmetry even when the close price differs from the first fill.
 */
function fillVolatilitySecond(state: PortfolioState, p: Holding, candle: Candle, settings: BacktestSettings): boolean {
  if (p.volatilitySecondFilled) return false;
  const leverage = Number(settings.leverage);
  const price = candle.close * (p.signal.side === 'LONG' ? 1 + slippage : 1 - slippage);
  const quantity = p.qty;
  const margin = quantity * price / leverage;
  const fee = price * quantity * feeRate;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(margin) || margin <= 0 || state.cash + 1e-10 < margin + fee) {
    state.insufficientFunds += 1;
    return false;
  }
  const oldQuantity = p.qty;
  p.entry = (p.entry * oldQuantity + price * quantity) / (oldQuantity + quantity);
  p.qty += quantity;
  p.margin += margin;
  p.secondFill = price;
  p.target = p.signal.side === 'LONG'
    ? Math.max(p.volatilityEntryOpen ?? p.first, p.volatilityEntryClose ?? p.first)
    : Math.min(p.volatilityEntryOpen ?? p.first, p.volatilityEntryClose ?? p.first);
  p.signal = { ...p.signal, target: p.target, secondTarget: p.target, averageEntry: p.entry };
  p.volatilitySecondFilled = true;
  state.cash -= margin + fee;
  state.realized -= fee;
  state.fees += fee;
  p.net -= fee;
  state.secondFills += 1;
  recordFill(p, 'SPLIT_ENTRY', price, quantity, candle, false, true);
  return true;
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
  const confirmedEnvelopeExit = p.signal.strategy === 'ENVELOPE' && p.signal.envelopeCloseOnConfirmedBreakout === true;
  const targetEnabled = !confirmedEnvelopeExit && p.signal.exitMode !== 'VOLATILITY_TP' && p.signal.exitMode !== 'VOLATILITY_MA5'
    && (p.signal.exitMode !== 'VOLATILITY_CANDLE_RULE' || p.target > 0)
    && (p.signal.exitMode !== 'VOLATILITY_WICK_RULE' || p.target > 0)
    || p.signal.exitMode === 'VOLATILITY_TP' && p.signal.volatilityTpEnabled !== false;
  if (targetEnabled && (long ? price >= p.target : price <= p.target)) {
    const disparity = p.signal.strategy === 'DISPARITY';
    const reason = p.signal.strategy === 'ENVELOPE' ? 'ENVELOPE_OPPOSITE'
      : p.signal.strategy === 'PULLBACK' && p.signal.exitMode === 'PULLBACK_ENVELOPE' ? 'PULLBACK_ENVELOPE'
      : p.signal.strategy === 'REFERENCE' ? 'REFERENCE_TP'
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
  const confirmedEnvelopeExit = p.signal.strategy === 'ENVELOPE' && p.signal.envelopeCloseOnConfirmedBreakout === true;
  const targetEnabled = !confirmedEnvelopeExit && p.signal.exitMode !== 'VOLATILITY_TP' && p.signal.exitMode !== 'VOLATILITY_MA5'
    && (p.signal.exitMode !== 'VOLATILITY_CANDLE_RULE' || p.target > 0)
    && (p.signal.exitMode !== 'VOLATILITY_WICK_RULE' || p.target > 0)
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

/** Close an envelope position only when the selected parent candle confirms a breakout. */
function closeEnvelopeOnConfirmedClose(state: PortfolioState, symbol: string, candle: Candle): void {
  const position = state.positions[symbol];
  if (!position || position.signal.strategy !== 'ENVELOPE' || position.signal.envelopeCloseOnConfirmedBreakout !== true) return;
  const confirmed = position.signal.side === 'LONG' ? candle.close > position.target : candle.close < position.target;
  if (confirmed) close(state, position, candle.close, position.qty, 'ENVELOPE_CLOSE_CONFIRM', candle);
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

/** Replay a reference/next-bar entry-line retest using lower-timeframe closes. */
function replayReferenceEntry(symbol: string, bar: PreparedBar, settings: BacktestSettings, available: number): PortfolioState {
  if (bar.referenceIntrabarCandles?.length) return replayReferenceIntrabarEntry(symbol, bar, settings, available);
  return referenceEntryPath(symbol, bar, settings, available);
}

function referenceRetestConfirmed(signal: Signal, candle: Candle): boolean {
  return signal.side === 'LONG'
    ? candle.high > signal.entry && candle.close <= signal.entry
    : candle.low < signal.entry && candle.close >= signal.entry;
}

/**
 * A reference entry is confirmed by the lower-timeframe close: a long must
 * break above the entry line and finish back at/below it, with the inverse for a
 * short. The confirming candle is never replayed for exits after the fill.
 */
function replayReferenceIntrabarEntry(symbol: string, bar: PreparedBar, settings: BacktestSettings, available: number): PortfolioState {
  const state = initialPortfolio(available);
  let attempted = false;
  const confirmedAt = bar.signal?.referenceRole === 'REFERENCE' ? bar.referenceLineConfirmedAt : undefined;
  if (bar.signal?.referenceRole === 'REFERENCE' && confirmedAt === undefined) return state;
  for (const candle of [...bar.referenceIntrabarCandles!].sort((a, b) => a.openTime - b.openTime)) {
    if (confirmedAt !== undefined && candle.openTime < confirmedAt) continue;
    if (!attempted && referenceRetestConfirmed(bar.signal!, candle)) {
      attempted = true;
      enter(state, symbol, bar.signal!, candle, settings);
      continue;
    }
    if (state.positions[symbol]) {
      const current = state.positions[symbol]!;
      const childBar: PreparedBar = { ...bar, candle, signal: null };
      const selected = worstPath([
        replayPath(current, childBar, settings, true),
        replayPath(current, childBar, settings, false),
      ]);
      mergePath(state, selected, symbol);
    }
    if (attempted && !state.positions[symbol]) break;
  }
  return state;
}

function referenceEntryPath(symbol: string, bar: PreparedBar, settings: BacktestSettings, available: number): PortfolioState {
  const state = initialPortfolio(available);
  const signal = bar.signal!;
  const candle = { ...bar.candle, parentOpenTime: bar.candle.openTime };
  if (referenceRetestConfirmed(signal, candle)) enter(state, symbol, signal, candle, settings);
  return state;
}

function replayIntrabarEntry(symbol: string, bar: PreparedBar, settings: BacktestSettings, available: number): PortfolioState {
  if (bar.signal?.exitMode === 'VOLATILITY_MA5' || bar.signal?.exitMode === 'VOLATILITY_CANDLE_RULE') return replayVolatilityMa5Entry(symbol, bar, settings, available);
  if (bar.signal?.exitMode === 'REFERENCE_TOUCH') return replayReferenceEntry(symbol, bar, settings, available);
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

/** Replay band-limit fills in both OHLC orders; only movement after a fill can exit it. */
function envelopeEntryPath(symbol: string, bar: PreparedBar, settings: BacktestSettings, available: number,
  settingsBySide?: Partial<Record<'LONG' | 'SHORT', BacktestSettings>>): PortfolioState {
  const candle = bar.candle;
  const definitions = (['LONG', 'SHORT'] as const).flatMap(side => {
    const band = bar.envelopeBySide ? bar.envelopeBySide[side] : bar.envelope;
    const parameters = settingsBySide?.[side] ?? settings;
    if (!band || !(side === 'LONG' ? band.long : band.short) || parameters.side !== 'BOTH' && parameters.side !== side) return [];
    if (parameters.envelopeMa20Enabled === true && (bar.ma20 == null || !Number.isFinite(bar.ma20)
      || !(side === 'LONG' ? candle.low > bar.ma20 : candle.high < bar.ma20))) return [];
    if (parameters.envelopeMa20BelowEnabled === true && (bar.ma20 == null || !Number.isFinite(bar.ma20)
      || !(side === 'LONG' ? candle.high < bar.ma20 : candle.low > bar.ma20))) return [];
    if (!envelopeHalfCandleAllowsEntry(candle, band, side, parameters.interval)) return [];
    return [{ side, band, parameters, price: side === 'LONG' ? band.lower : band.upper }];
  });
  if (bar.envelopeIntrabarCandles?.length) {
    const simulate = (lowFirst: boolean): PortfolioState => {
      const state = initialPortfolio(available);
      let attempted = false;
      let enteredSettings = settings;
      const fill = (definition: typeof definitions[number], price: number, executionCandle: Candle): void => {
        attempted = true;
        const { side, band, parameters } = definition;
        const { percent, period } = envelopeParameters(parameters);
        const target = side === 'LONG' ? band.upper : band.lower;
        enteredSettings = parameters;
        enter(state, symbol, {
          strategy: 'ENVELOPE', side, index: candle.openTime, entry: price,
          stop: price * (1 + (side === 'LONG' ? -1 : 1) * percent / 100), target, initialTarget: target,
          exitMode: 'ENVELOPE_TOUCH', envelopeDeviationPercent: percent, envelopeExitMode: 'OPPOSITE',
          envelopeCloseOnConfirmedBreakout: parameters.envelopeCloseOnConfirmedBreakout === true,
          envelopeMaPeriod: period, envelopeCenter: band.center, envelopeMoveSlOnCenter: false,
          envelopeEntryMode: 'BAND_TOUCH',
          ...(band.sourceInterval ? { envelopeSourceInterval: band.sourceInterval } : {}),
        }, executionCandle, parameters);
      };
      for (const rawCandle of [...(bar.envelopeIntrabarCandles ?? [])].sort((a, b) => a.openTime - b.openTime)) {
        if (attempted && !state.positions[symbol]) break;
        const executionCandle = { ...rawCandle, parentOpenTime: candle.openTime };
        const path = lowFirst
          ? [executionCandle.open, executionCandle.low, executionCandle.high, executionCandle.close]
          : [executionCandle.open, executionCandle.high, executionCandle.low, executionCandle.close];
        let before = path[0]!;
        if (attempted && state.positions[symbol]) {
          atPrice(state, symbol, executionCandle.open, executionCandle, enteredSettings, true);
        }
        if (!attempted) {
          const atOpen = definitions.find(definition => definition.side === 'LONG'
            ? executionCandle.open <= definition.price : executionCandle.open >= definition.price);
          if (atOpen) fill(atOpen, executionCandle.open, executionCandle);
        }
        for (let index = 1; index < path.length && (!attempted || state.positions[symbol]); index += 1) {
          const after = path[index]!;
          if (!attempted) {
            const crossed = definitions.filter(definition => definition.price >= Math.min(before, after) && definition.price <= Math.max(before, after))
              .sort((a, b) => Math.abs(a.price - before) - Math.abs(b.price - before));
            const first = crossed[0];
            if (first) { fill(first, first.price, executionCandle); before = first.price; }
          }
          const position = state.positions[symbol];
          if (position) replaySegment(state, position, before, after, executionCandle, enteredSettings);
          before = after;
        }
      }
      return state;
    };
    const selected = worstPath([simulate(true), simulate(false)]);
    closeEnvelopeOnConfirmedClose(selected, symbol, candle);
    return selected;
  }
  const simulate = (lowFirst: boolean): PortfolioState => {
    const state = initialPortfolio(available);
    const path = lowFirst ? [candle.open, candle.low, candle.high, candle.close] : [candle.open, candle.high, candle.low, candle.close];
    let attempted = false;
    let enteredSettings = settings;
    const fill = (definition: typeof definitions[number], price: number): void => {
      attempted = true;
      const { side, band, parameters } = definition;
      const { percent, period } = envelopeParameters(parameters);
      const target = side === 'LONG' ? band.upper : band.lower;
      enteredSettings = parameters;
      enter(state, symbol, {
        strategy: 'ENVELOPE', side, index: candle.openTime, entry: price,
        stop: price * (1 + (side === 'LONG' ? -1 : 1) * percent / 100), target, initialTarget: target,
        exitMode: 'ENVELOPE_TOUCH', envelopeDeviationPercent: percent, envelopeExitMode: 'OPPOSITE',
        envelopeCloseOnConfirmedBreakout: parameters.envelopeCloseOnConfirmedBreakout === true,
        envelopeMaPeriod: period, envelopeCenter: band.center, envelopeMoveSlOnCenter: false,
        envelopeEntryMode: 'BAND_TOUCH',
        ...(band.sourceInterval ? { envelopeSourceInterval: band.sourceInterval } : {}),
      }, candle, parameters);
    };
    const atOpen = definitions.find(definition => definition.side === 'LONG' ? candle.open <= definition.price : candle.open >= definition.price);
    if (atOpen) fill(atOpen, candle.open);
    for (let index = 1; index < path.length; index += 1) {
      let before = path[index - 1]!;
      const after = path[index]!;
      if (!attempted) {
        const crossed = definitions.filter(definition => definition.price >= Math.min(before, after) && definition.price <= Math.max(before, after))
          .sort((a, b) => Math.abs(a.price - before) - Math.abs(b.price - before));
        const first = crossed[0];
        if (first) { fill(first, first.price); before = first.price; }
      }
      const position = state.positions[symbol];
      if (position) replaySegment(state, position, before, after, candle, enteredSettings);
    }
    return state;
  };
  const selected = worstPath([simulate(true), simulate(false)]);
  closeEnvelopeOnConfirmedClose(selected, symbol, candle);
  return selected;
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

function updateVolatilityStop(p: Holding, candidate: number): void {
  const long = p.signal.side === 'LONG';
  p.stop = long ? Math.max(p.stop, candidate) : Math.min(p.stop, candidate);
  p.signal = { ...p.signal, activeStop: p.stop };
}

/** Replay a higher-timeframe holding through chronological 15-minute candles. */
function replayVolatilityIntrabarHolding(state: PortfolioState, symbol: string, bar: PreparedBar, settings: BacktestSettings): void {
  for (const candle of [...(bar.volatilityIntrabarCandles ?? [])].sort((a, b) => a.openTime - b.openTime)) {
    const position = state.positions[symbol];
    if (!position) return;
    const childBar: PreparedBar = { ...bar, candle, signal: null, volatilityIntrabarCandles: undefined };
    const selected = worstPath([
      replayPath(position, childBar, settings, true),
      replayPath(position, childBar, settings, false),
    ]);
    mergePath(state, selected, symbol);
  }
}

/** Replay the replacement wick-pattern volatility rule after the entry bar. */
function processVolatilityWickRule(state: PortfolioState, symbol: string, bar: PreparedBar, settings: BacktestSettings): void {
  const position = state.positions[symbol];
  if (!position) return;
  if (bar.volatilityIntrabarCandles?.length) {
    replayVolatilityIntrabarHolding(state, symbol, bar, settings);
  } else {
    const selected = worstPath([
      replayPath(position, bar, settings, true),
      replayPath(position, bar, settings, false),
    ]);
    mergePath(state, selected, symbol);
  }
  const remaining = state.positions[symbol];
  if (!remaining) return;

  const candle = bar.candle;
  const long = remaining.signal.side === 'LONG';
  const body = Math.abs(candle.close - candle.open);
  const previousBody = remaining.volatilityPreviousBody ?? body;
  const beyondEntry = long ? candle.close > remaining.first : candle.close < remaining.first;
  const sameDirection = long ? candle.close > candle.open : candle.close < candle.open;

  // A close on the non-profit side simply holds. Once the close is beyond the
  // first entry, only a larger same-direction body can keep the position open.
  if (beyondEntry) {
    if (sameDirection && body > previousBody) {
      updateVolatilityStop(remaining, long ? candle.low : candle.high);
    } else {
      close(state, remaining, candle.close, remaining.qty, 'VOLATILITY_WICK_EXIT', candle);
    }
  }

  const after = state.positions[symbol];
  if (after) {
    after.volatilityRuleStage = 1;
    after.volatilityPreviousBody = body;
    after.mark = candle.close;
  }
}

/**
 * Apply the replacement volatility exits after the entry candle. The existing
 * The stop is replayed through both admissible OHLC paths first; only if the
 * position survives the candle do we use its confirmed direction/body size to
 * update the rule. This prevents a newly discovered stop from being
 * retroactively triggered inside the candle that created it.
 */
function processVolatilityCandleRule(state: PortfolioState, symbol: string, bar: PreparedBar, settings: BacktestSettings): void {
  const position = state.positions[symbol];
  if (!position) return;
  const selected = worstPath([
    replayPath(position, bar, settings, true),
    replayPath(position, bar, settings, false),
  ]);
  mergePath(state, selected, symbol);
  const remaining = state.positions[symbol];
  if (!remaining) return;

  const candle = bar.candle;
  const long = remaining.signal.side === 'LONG';
  const body = Math.abs(candle.close - candle.open);
  const previousBody = remaining.volatilityPreviousBody ?? Math.abs((remaining.volatilityEntryClose ?? remaining.first) - (remaining.volatilityEntryOpen ?? remaining.first));
  const firstFollowing = (remaining.volatilityRuleStage ?? 0) === 0;
  const bearish = candle.close < candle.open;
  const bullish = candle.close > candle.open;
  const secondEntry = firstFollowing && (long
    ? bearish && candle.low >= (remaining.volatilityEntryLow ?? remaining.stop)
    : bullish && candle.high <= (remaining.volatilityEntryHigh ?? remaining.stop));

  if (secondEntry) {
    fillVolatilitySecond(state, remaining, candle, settings);
  } else {
    const favorable = long ? bullish : bearish;
    if (favorable && body > previousBody) {
      updateVolatilityStop(remaining, long ? candle.low : candle.high);
    } else if (!favorable || body < previousBody) {
      close(state, remaining, candle.close, remaining.qty, 'VOLATILITY_CANDLE_EXIT', candle);
    }
  }

  const after = state.positions[symbol];
  if (after) {
    after.volatilityRuleStage = 1;
    after.volatilityPreviousBody = body;
    after.mark = candle.close;
  }
}

/** Replay a held envelope position through chronological 15-minute candles. */
function replayEnvelopeIntrabarHolding(position: Holding, bar: PreparedBar, settings: BacktestSettings): PortfolioState {
  const state = initialPortfolio(0);
  state.positions[position.symbol] = structuredClone(position);
  for (const rawCandle of [...bar.envelopeIntrabarCandles!].sort((a, b) => a.openTime - b.openTime)) {
    const current = state.positions[position.symbol];
    if (!current) break;
    const executionCandle = { ...rawCandle, parentOpenTime: bar.candle.openTime };
    const childBar: PreparedBar = { ...bar, candle: executionCandle, signal: null, envelopeIntrabarCandles: undefined };
    const selected = worstPath([
      replayPath(current, childBar, settings, true),
      replayPath(current, childBar, settings, false),
    ]);
    mergePath(state, selected, position.symbol);
  }
  return state;
}

function processBar(state: PortfolioState, symbol: string, bar: PreparedBar, settings: BacktestSettings): void {
  const position = state.positions[symbol];
  if (!position) return;
  if (position.signal.strategy === 'NEW_HIGH') return; // Replayed with intrabar funding together below.
  if (position.signal.strategy === 'VOLATILITY' && position.signal.exitMode === 'VOLATILITY_WICK_RULE') {
    processVolatilityWickRule(state, symbol, bar, settings);
    return;
  }
  if (position.signal.strategy === 'VOLATILITY' && position.signal.exitMode === 'VOLATILITY_CANDLE_RULE') {
    processVolatilityCandleRule(state, symbol, bar, settings);
    return;
  }
  if (position.signal.strategy === 'REFERENCE' && bar.referenceIntrabarCandles?.length) {
    const selected = replayReferenceIntrabarHolding(position, bar, settings);
    mergePath(state, selected, symbol);
    return;
  }
  if (position.signal.strategy === 'DISPARITY') {
    if (bar.ma60Exit === null) throw new Error(`${symbol}의 MA60 계산에 필요한 캔들이 부족합니다.`);
    position.target = bar.ma60Exit;
  }
  if (position.signal.strategy === 'ENVELOPE') {
    if (position.signal.exitMode === 'ENVELOPE_MA20_CLOSE') {
      const ma20 = bar.ma20;
      const long = position.signal.side === 'LONG';
      if (ma20 !== null && ma20 !== undefined && (long ? bar.candle.close < ma20 : bar.candle.close > ma20)) {
        close(state, position, bar.candle.close, position.qty, 'ENVELOPE_MA20_CLOSE', bar.candle);
      } else if (state.positions[symbol]) {
        position.mark = bar.candle.close;
      }
      return;
    }
    if (position.signal.envelopeEntryMode === 'BAND_TOUCH') {
      if (!bar.envelope) throw new Error(`${symbol}의 엔벨로프 계산에 필요한 캔들이 부족합니다.`);
      position.target = position.signal.side === 'LONG' ? bar.envelope.upper : bar.envelope.lower;
      if (bar.envelopeIntrabarCandles?.length) {
        const selected = replayEnvelopeIntrabarHolding(position, bar, settings);
        mergePath(state, selected, symbol);
        closeEnvelopeOnConfirmedClose(state, symbol, bar.candle);
        return;
      }
    }
  }
  if (position.signal.strategy === 'PULLBACK' && position.signal.exitMode === 'PULLBACK_ENVELOPE') {
    if (!bar.pullbackEnvelope) throw new Error(`${symbol}의 눌림목 엔벨로프 계산에 필요한 캔들이 부족합니다.`);
    position.target = position.signal.side === 'LONG' ? bar.pullbackEnvelope.upper : bar.pullbackEnvelope.lower;
    position.pullbackMa60Exit = bar.ma60 ?? undefined;
  }
  const candidates = [replayPath(position, bar, settings, true), replayPath(position, bar, settings, false)];
  mergePath(state, worstPath(candidates), symbol);
  closeEnvelopeOnConfirmedClose(state, symbol, bar.candle);
  const remaining = state.positions[symbol];
  if (remaining?.signal.strategy === 'PULLBACK' && remaining.signal.exitMode === 'PULLBACK_ENVELOPE') {
    const long = remaining.signal.side === 'LONG';
    const aligned = bar.ma20 !== null && bar.ma20 !== undefined && bar.ma60 !== null && bar.ma60 !== undefined
      && bar.ma120 !== null && bar.ma120 !== undefined
      && (long ? bar.ma20 > bar.ma60 && bar.ma60 > bar.ma120 : bar.ma20 < bar.ma60 && bar.ma60 < bar.ma120);
    if (!aligned) close(state, remaining, bar.candle.close, remaining.qty, 'PULLBACK_MA_EXIT', bar.candle);
  }
}

/** Replay a held reference position through chronological 15m candles. */
function replayReferenceIntrabarHolding(position: Holding, bar: PreparedBar, settings: BacktestSettings): PortfolioState {
  const state = initialPortfolio(0);
  state.positions[position.symbol] = structuredClone(position);
  for (const candle of [...bar.referenceIntrabarCandles!].sort((a, b) => a.openTime - b.openTime)) {
    const current = state.positions[position.symbol];
    if (!current) break;
    const childBar: PreparedBar = { ...bar, candle, signal: null };
    const selected = worstPath([
      replayPath(current, childBar, settings, true),
      replayPath(current, childBar, settings, false),
    ]);
    mergePath(state, selected, position.symbol);
  }
  return state;
}

interface NewHighPath { state: PortfolioState; spent: number }
/** Causal price-dependent MA5/10/20 with optional 15m execution candles and post-entry candle confirmation. */
function newHighPath(symbol: string, bar: PreparedBar, settings: BacktestSettings, available: number, holding: Holding | undefined, lowFirst: boolean): NewHighPath {
  const state = initialPortfolio(available); const definition = bar.newHigh!; const candle = bar.candle;
  if (holding) state.positions[symbol] = structuredClone(holding);
  let spent = 0; let attempted = holding !== undefined; let enteredThisCandle = false;
  const leverage = Number(settings.leverage);
  const riskAmount = settings.newHighSizingMode === 'RISK' ? newHighRiskAmount(settings) : undefined;
  const ma10 = (price: number) => (definition.sum9 + price) / 10;
  const ma20 = (price: number) => (definition.sum19 + price) / 20;
  const ma60 = (price: number): number | null => definition.sum59 !== undefined && Number.isFinite(definition.sum59)
    ? (definition.sum59 + price) / 60 : null;
  const slMultiplier = newHighSlMultiplier(settings);
  const tolerance = (...values: number[]) => Math.max(Number.MIN_VALUE, ...values.map(value => Math.abs(value) * Number.EPSILON * 16));
  const advanceTrail = (p: Holding, price: number): boolean => {
    const atr = p.signal.newHighAtr ?? Math.abs(p.target - p.first) / 2;
    if (!Number.isFinite(atr) || atr <= 0) return false;
    const direction = p.signal.side === 'LONG' ? 1 : -1;
    const progress = direction * (price - p.first) / atr;
    const step = progress >= 1 ? Math.floor(progress + 1e-10) : 0;
    const currentStep = p.newHighTrailStep ?? 0;
    if (step <= currentStep) return false;
    p.newHighTrailLevels ??= [];
    for (let reached = currentStep + 1; reached <= step; reached += 1) {
      const lockedAtr = reached === 1 ? 0.5 : reached - 0.5;
      const nextStop = p.first + direction * lockedAtr * atr;
      if (direction * (nextStop - p.stop) > 0) p.stop = nextStop;
      if (!p.newHighTrailLevels.some(level => level.step === reached)) {
        p.newHighTrailLevels.push({ step: reached, price: nextStop, reachedPrice: p.first + direction * reached * atr });
      }
    }
    p.newHighTrailStep = step;
    return true;
  };
  const stopReason = (p: Holding): string => (p.newHighTrailStep ?? 0) > 0 ? 'NEW_HIGH_TRAILING' : 'SL';
  const attempt = (side: 'LONG' | 'SHORT', price: number, executionCandle: Candle = candle): void => {
    attempted = true;
    const direction = side === 'LONG' ? 1 : -1;
    if (direction * (price - candle.open) < 0) return;
    const fill = price * (1 + direction * slippage);
    const boundary = side === 'LONG' ? definition.high : definition.low;
    const currentMa60 = ma60(price);
    if (direction * (ma10(price) - ma20(price)) <= 0
      || settings.newHighMa60Enabled === true && (currentMa60 === null || direction * (price - currentMa60) <= 0)
      || settings.newHighMa10Enabled === true && direction * (price - ma10(price)) >= 0
      || direction * (fill - boundary) < 0.5 * definition.atr! - tolerance(fill, boundary, definition.atr!)
      || direction * (fill - boundary) > definition.atr! + tolerance(fill, boundary, definition.atr!)) return;
    const stop = fill - direction * slMultiplier * definition.atr!;
    if (!(stop > 0) || (side === 'LONG' ? stop >= price : stop <= price)) return;
    const target = fill + direction * 2 * definition.atr!;
    enter(state, symbol, { strategy: 'NEW_HIGH', side, index: candle.openTime / (candle.closeTime - candle.openTime),
      entry: price, stop, target, initialTarget: target, exitMode: 'NEW_HIGH_TOUCH', newHighAtr: definition.atr!, ...(riskAmount !== undefined ? { riskAmount } : {}) }, executionCandle, settings);
    const p = state.positions[symbol];
    if (p) {
      p.newHighTrailStep = 0;
      p.newHighEntryParentOpenTime = candle.openTime;
      p.newHighEntryParentLow = candle.low;
      p.newHighEntryParentHigh = candle.high;
      enteredThisCandle = true;
      spent += p.margin + p.margin * leverage * feeRate;
    }
  };
  const eligible = (side: 'LONG' | 'SHORT'): boolean => definition.atr !== null && definition.atr > 0 && (side === 'LONG' ? definition.long : definition.short);
  const longEntry = definition.high + 0.5 * definition.atr!; const shortEntry = definition.low - 0.5 * definition.atr!;
  const parentSeconds = candle.closeTime - candle.openTime;
  const isNextEntryParent = (p: Holding): boolean => p.newHighEntryParentOpenTime !== undefined
    && candle.openTime === p.newHighEntryParentOpenTime + parentSeconds;
  const nextEntryBreakPrice = (p: Holding): number | null => {
    if (!isNextEntryParent(p)) return null;
    return p.signal.side === 'LONG' ? p.newHighEntryParentLow ?? null : p.newHighEntryParentHigh ?? null;
  };
  const atOpen = state.positions[symbol];
  let trailReachedAtParentOpen = false;
  if (atOpen) {
    trailReachedAtParentOpen = advanceTrail(atOpen, candle.open);
    const long = atOpen.signal.side === 'LONG';
    const breakPrice = nextEntryBreakPrice(atOpen);
    if (breakPrice !== null && (long ? candle.open < breakPrice : candle.open > breakPrice)) {
      close(state, atOpen, candle.open, atOpen.qty, 'NEW_HIGH_NEXT_CANDLE_BREAK', candle, true);
    } else if (long ? candle.open <= atOpen.stop : candle.open >= atOpen.stop) {
      close(state, atOpen, candle.open, atOpen.qty, stopReason(atOpen), candle, true);
    }
  }
  const processExecutionCandle = (executionCandle: Candle): void => {
    // A 15m candle that first reaches an ATR stage cannot also close through
    // the newly moved stop. The stop becomes active from the next 15m candle.
    let trailReachedThisCandle = trailReachedAtParentOpen;
    trailReachedAtParentOpen = false;
    const noteTrailAdvance = (p: Holding, price: number): void => {
      const advanced = advanceTrail(p, price);
      trailReachedThisCandle ||= advanced;
    };
    const openingPosition = state.positions[symbol];
    if (openingPosition && !enteredThisCandle) {
      noteTrailAdvance(openingPosition, executionCandle.open);
      const long = openingPosition.signal.side === 'LONG';
      const breakPrice = nextEntryBreakPrice(openingPosition);
      if (breakPrice !== null && (long ? executionCandle.open < breakPrice : executionCandle.open > breakPrice)) {
        close(state, openingPosition, executionCandle.open, openingPosition.qty, 'NEW_HIGH_NEXT_CANDLE_BREAK', executionCandle, true);
        return;
      }
      if (long ? executionCandle.open <= openingPosition.stop : executionCandle.open >= openingPosition.stop) {
        close(state, openingPosition, executionCandle.open, openingPosition.qty, stopReason(openingPosition), executionCandle, true);
        return;
      }
    } else if (!openingPosition && !attempted) {
      if (eligible('LONG') && executionCandle.open >= longEntry) attempt('LONG', executionCandle.open, executionCandle);
      else if (eligible('SHORT') && executionCandle.open <= shortEntry) attempt('SHORT', executionCandle.open, executionCandle);
    }
    const path = lowFirst
      ? [executionCandle.open, executionCandle.low, executionCandle.high, executionCandle.close]
      : [executionCandle.open, executionCandle.high, executionCandle.low, executionCandle.close];
    for (let i = 1; i < path.length; i += 1) {
      let before = path[i - 1]!; const after = path[i]!;
      for (let count = 0; count < 3; count += 1) {
        const p = state.positions[symbol];
        const events: { price: number; kind: 'SL' | 'NEXT_CANDLE_BREAK' | 'LONG' | 'SHORT' }[] = [];
        if (p && !enteredThisCandle) {
          noteTrailAdvance(p, before);
          noteTrailAdvance(p, after);
          const long = p.signal.side === 'LONG';
          const breakPrice = nextEntryBreakPrice(p);
          if (breakPrice !== null && (long ? before >= breakPrice && after < breakPrice : before <= breakPrice && after > breakPrice)) {
            events.push({ price: breakPrice, kind: 'NEXT_CANDLE_BREAK' });
          }
          if (!trailReachedThisCandle && (long ? before >= p.stop && after <= p.stop : before <= p.stop && after >= p.stop)) {
            events.push({ price: p.stop, kind: 'SL' });
          }
        } else if (!p && !attempted) {
          if (eligible('LONG') && before < longEntry && after >= longEntry) events.push({ price: longEntry, kind: 'LONG' });
          if (eligible('SHORT') && before > shortEntry && after <= shortEntry) events.push({ price: shortEntry, kind: 'SHORT' });
        }
        events.sort((a, b) => Math.abs(a.price - before) - Math.abs(b.price - before));
        const event = events[0]; if (!event) break;
        if (event.kind === 'SL' || event.kind === 'NEXT_CANDLE_BREAK') {
          close(state, p!, event.price, p!.qty, event.kind === 'NEXT_CANDLE_BREAK' ? 'NEW_HIGH_NEXT_CANDLE_BREAK' : stopReason(p!), executionCandle);
          return;
        }
        const direction = event.kind === 'LONG' ? 1 : -1;
        attempt(event.kind, event.price + direction * tolerance(event.price), executionCandle);
        before = event.price;
      }
    }
  };
  const executionCandles = bar.newHighIntrabarCandles?.length ? bar.newHighIntrabarCandles : [candle];
  for (const executionCandle of executionCandles) processExecutionCandle(executionCandle);
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
    // Prefer the lower-equity OHLC path; a favorable raised SL must not hide the other path's earlier loss.
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
      const intrabarSignal = bar.signal?.exitMode === 'VOLATILITY_TP' || bar.signal?.exitMode === 'VOLATILITY_MA5' || bar.signal?.exitMode === 'VOLATILITY_CANDLE_RULE' || bar.signal?.exitMode === 'REFERENCE_TOUCH';
      const hasIntrabarData = intrabarSignal;
      if (occupiedAtOpen.has(symbol) || !hasIntrabarData && !hasEnvelope) continue;
      const referenceKey = bar.signal?.exitMode === 'REFERENCE_TOUCH' && bar.signal.referenceOpenTime !== undefined
        ? `${symbol}:${bar.signal.referenceOpenTime}` : null;
      if (referenceKey && state.referenceAttempts?.[referenceKey]) continue;
      const available = Math.max(0, Math.min(intrabarBudget, state.cash));
      const selected = hasEnvelope
        ? envelopeEntryPath(symbol, bar, parameters, available, options.settingsForSymbolSide?.[symbol])
        : replayIntrabarEntry(symbol, bar, parameters, available);
      mergePath(state, selected, symbol, available);
      if (referenceKey && selected.entries) {
        state.referenceAttempts ??= {};
        state.referenceAttempts[referenceKey] = true;
      }
      if (selected.entries) {
        intrabarBudget = Math.max(0, intrabarBudget - Number(parameters.betAmountUsdt) * (1 + Number(parameters.leverage) * feeRate));
      }
    }
    for (const { symbol, bar } of rows) {
      const signal = bar.signal;
      const completedEntry = signal?.exitMode !== 'VOLATILITY_MA5' && signal?.exitMode !== 'VOLATILITY_CANDLE_RULE' && signal?.exitMode !== 'REFERENCE_TOUCH';
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
