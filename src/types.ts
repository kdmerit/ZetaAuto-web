export type Strategy = 'PULLBACK' | 'DISPARITY' | 'VOLATILITY';
export type BacktestInterval = '15m' | '1h' | '4h' | '1d';
export type BacktestMode = 'SINGLE' | 'ALL';
export type BacktestSide = 'BOTH' | 'LONG' | 'SHORT';

export interface BacktestSettings {
  mode: BacktestMode;
  symbol: string;
  interval: BacktestInterval;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  initialCapitalUsdt: string;
  betAmountUsdt: string;
  leverage: string;
  side: BacktestSide;
  partialTpEnabled: boolean;
  fullTpWavePercent: string;
  minDisparityPercent: string;
  ma20HalfCloseEnabled: boolean;
  roiClosePercent: string;
  volatilityK: string;
}

export interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface EnrichedCandle extends Candle {
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  ma120: number | null;
}

export interface Wave {
  label: 'PREVIOUS_PREVIOUS' | 'PREVIOUS' | 'CURRENT';
  direction: 'UP' | 'DOWN';
  startIndex: number;
  endIndex: number;
  startTime: number;
  endTime: number;
  complete: boolean;
  low: number;
  high: number;
}

export type MarkerKind = 'ENTRY' | 'SPLIT_ENTRY' | 'PARTIAL_TP' | 'CLOSE';

export interface ChartMarker {
  id: string;
  orderId: string;
  kind: MarkerKind;
  label: 'B' | 'S' | 'C';
  openTime: number;
  price: number;
  quantity: number;
  candleIndex: number;
}

export type PriceLineKind =
  | 'ENTRY'
  | 'FIRST_ENTRY'
  | 'SECOND_ENTRY'
  | 'AVERAGE_ENTRY'
  | 'SL'
  | 'INITIAL_SL'
  | 'INITIAL_TP'
  | 'TP'
  | 'PARTIAL_TP';

export interface PriceLine {
  kind: PriceLineKind;
  price: number;
}

export interface ChartData {
  symbol: string;
  interval: BacktestInterval;
  side: 'LONG' | 'SHORT';
  referenceAt: string;
  referenceIndex: number | null;
  candles: EnrichedCandle[];
  waves: Wave[];
  markers: ChartMarker[];
  executions?: ChartMarker[];
  priceLines: PriceLine[];
}

export interface Execution {
  kind: MarkerKind;
  at: number;
  candleOpenAt: number;
  price: number;
  quantity: number;
}

export interface BacktestTrade {
  tradeId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryAt: number;
  exitAt: number;
  reason: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  netProfitUsdt: number;
  signalIndex: number;
  entryIndex: number;
  exitIndex: number;
  signal: Signal;
  executions: Execution[];
  chart?: ChartData;
}

export interface Signal {
  strategy: Strategy;
  side: 'LONG' | 'SHORT';
  index: number;
  entry: number;
  second?: number;
  stop: number;
  partial?: number;
  target: number;
  initialTarget: number;
  initialStop?: number;
  activeStop?: number;
  averageEntry?: number;
  secondTarget?: number;
  disparityPercent?: number;
  ma20?: number;
  ma60?: number;
  volatilityK?: number;
  breakoutRange?: number;
  breakoutLevel?: number;
  exitMode?: 'BAR_CLOSE';
  waves?: Wave[];
}

export interface BacktestResult {
  initialCapitalUsdt: number;
  finalEquityUsdt: number;
  returnPercent: number;
  realizedProfitUsdt: number;
  unrealizedProfitUsdt: number;
  feesUsdt: number;
  maxDrawdownPercent: number;
  entryCount: number;
  closedTradeCount: number;
  winCount: number;
  lossCount: number;
  breakevenCount: number;
  winRatePercent: number | null;
  openPositionCount: number;
  insufficientFundsCount: number;
  betAmountUsdt: number;
  secondFillCount: number;
  signalCount: number;
  observedBars: number;
  dataStartAt: number | null;
  dataEndAt: number | null;
  exitReasons: Record<string, number>;
  recentTrades: BacktestTrade[];
  equityCurve: { at: number; equityUsdt: number }[];
  candles: Candle[];
}

export type JobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'FAILED'
  | 'CANCELLED';

export interface ServerJob {
  jobId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  request: Record<string, unknown>;
  strategyVersion: string;
  phase: 'UNIVERSE' | 'DATA' | 'REPLAY' | 'DONE';
  processedSymbols: number;
  universeCount: number;
  excludedCount: number;
  failedCount: number;
  completedBars: number;
  totalBars: number;
  message: string | null;
  assumptions: string[];
  result: BacktestResult | null;
}

export interface ApiEnvelope<T> {
  requestId: string;
  job: T;
}

export interface AuthConfig {
  apiBaseUrl: string;
  cognitoDomain: string;
  clientId: string;
  redirectUri: string;
  logoutUri: string;
}
