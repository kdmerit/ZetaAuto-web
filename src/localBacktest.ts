/** Page-side worker controller and cache-backed charts. Authentication never enters the worker. */
import { enrichCandles, intervalSeconds } from './api';
import { buildLocalChart } from './engine';
import { loadLocalJob, loadLocalResult, type LocalJobView } from './localJobs';
import { ensureCandles, listInstruments } from './marketData';
import { saveBacktestHistory, saveCachedResult } from './storage';
import type { BacktestResult, BacktestSettings, BacktestTrade, ChartData, Strategy } from './types';

type LocalEvent = { type: 'UPDATE'; view: LocalJobView } | { type: 'ERROR'; message: string } | { type: 'IDLE' };
const listeners = new Map<Strategy, Set<(event: LocalEvent) => void>>();
const views = new Map<Strategy, LocalJobView>();
let worker: Worker | null = null;
let activeStrategy: Strategy | null = null;

export function subscribeLocalBacktest(strategy: Strategy, receive: (event: LocalEvent) => void): () => void {
  if (!listeners.has(strategy)) listeners.set(strategy, new Set());
  listeners.get(strategy)!.add(receive);
  return () => { listeners.get(strategy)?.delete(receive); };
}

function notify(strategy: Strategy, event: LocalEvent): void {
  for (const receive of listeners.get(strategy) ?? []) receive(event);
}

export function isLocalBacktestRunning(strategy: Strategy): boolean {
  return worker !== null && activeStrategy === strategy;
}

export async function restoreLocalBacktest(strategy: Strategy): Promise<LocalJobView | null> {
  const view = isLocalBacktestRunning(strategy) ? views.get(strategy) ?? await loadLocalJob(strategy) : await loadLocalJob(strategy);
  if (view?.status === 'COMPLETED' && !view.result) view.result = (await loadLocalResult(view.id))?.result ?? null;
  return view;
}

export function startLocalBacktest(strategy: Strategy, settings: BacktestSettings, resumeId?: string): void {
  if (worker) throw new Error('다른 분석이 진행 중입니다. 먼저 일시정지해 주세요.');
  if (!resumeId) views.delete(strategy);
  void navigator.storage?.persist?.().catch(() => false);
  activeStrategy = strategy;
  worker = new Worker(new URL('./backtest.worker.ts', import.meta.url), { type: 'module' });
  const instance = worker;
  instance.onmessage = (event: MessageEvent<LocalEvent>) => {
    const message = event.data;
    if (message.type === 'UPDATE') {
      views.set(strategy, message.view);
      const view = message.view;
      if (view.status === 'COMPLETED' && view.result) {
        const compact: BacktestResult = { ...view.result, recentTrades: [], equityCurve: [], candles: [] };
        saveCachedResult(strategy, view.result);
        saveBacktestHistory({
          id: `${strategy}:local:${view.id}`, strategy, savedAt: view.updatedAt,
          mode: view.settings.mode, symbol: view.settings.mode === 'ALL' ? 'ALL' : view.settings.symbol.replace(/USDT$/i, '').toUpperCase(),
          interval: view.settings.interval, settings: view.settings, result: compact, serverJobId: null, localRunId: view.id,
        });
      }
    }
    if (message.type === 'ERROR') {
      const last = views.get(strategy);
      if (last) {
        const paused = { ...last, status: 'PAUSED' as const, message: message.message };
        views.set(strategy, paused);
        notify(strategy, { type: 'UPDATE', view: paused });
      }
    }
    notify(strategy, message);
    if (message.type === 'IDLE') {
      instance.terminate();
      if (worker === instance) { worker = null; activeStrategy = null; }
    }
  };
  instance.onerror = () => {
    instance.terminate();
    worker = null;
    activeStrategy = null;
    const previous = views.get(strategy);
    if (previous) views.set(strategy, { ...previous, status: 'PAUSED' });
    notify(strategy, { type: 'ERROR', message: '분석이 중단되었습니다. 저장된 지점부터 이어가 주세요.' });
    notify(strategy, { type: 'IDLE' });
  };
  instance.postMessage({ type: 'START', strategy, settings, resumeId });
}

export function pauseLocalBacktest(strategy: Strategy): void {
  if (activeStrategy === strategy) worker?.postMessage({ type: 'PAUSE', strategy });
}

/** New results contain a small trade snapshot; candle pages are read on demand for either mode. */
export async function chartForLocalTrade(
  result: BacktestResult,
  trade: BacktestTrade,
  settings: BacktestSettings,
  beforeAt?: number,
): Promise<ChartData> {
  if (!result.localRunId && result.candles.length) return buildLocalChart(result, trade, settings);
  const seconds = intervalSeconds(settings.interval);
  const first = trade.executions.find(execution => execution.kind === 'ENTRY')?.candleOpenAt ?? trade.entryAt - seconds;
  const end = beforeAt ?? Math.min(Math.floor(Date.now() / 1000 / seconds) * seconds, first + 160 * seconds);
  const start = end - 300 * seconds;
  const symbol = trade.symbol === 'LOCAL' ? `${settings.symbol.replace(/USDT$/i, '').toUpperCase()}USDT` : trade.symbol;
  const instrument = (await listInstruments(symbol))[0] ?? { symbol, launchAt: 0 };
  const rows = await ensureCandles(instrument, settings.interval, start - 200 * seconds, end);
  const candles = enrichCandles(rows).filter(candle => candle.openTime >= start);
  if (!candles.length) throw new Error('차트에 표시할 캔들이 없습니다.');
  const indexFor = (time: number): number => candles.findIndex(candle => candle.openTime === time);
  const executions: ChartData['markers'] = trade.executions.map((execution, index) => ({
    id: `${trade.tradeId}:${index}`, orderId: `${trade.tradeId}:${index}`, kind: execution.kind,
    label: execution.kind === 'CLOSE' ? 'C' : execution.kind === 'PARTIAL_TP' ? trade.side === 'LONG' ? 'S' : 'B' : trade.side === 'LONG' ? 'B' : 'S',
    openTime: execution.candleOpenAt, price: execution.price, quantity: execution.quantity,
    candleIndex: indexFor(execution.candleOpenAt),
  }));
  const fallback = buildLocalChart({ ...result, candles: rows }, { ...trade, entryIndex: rows.findIndex(candle => candle.openTime === first), signalIndex: rows.findIndex(candle => candle.openTime === first) }, settings);
  return {
    symbol, interval: settings.interval, side: trade.side, referenceAt: new Date(first * 1000).toISOString(),
    referenceIndex: indexFor(first) < 0 ? null : indexFor(first), candles,
    waves: (trade.signal.waves ?? []).flatMap(wave => {
      const startIndex = candles.findIndex(candle => candle.openTime >= wave.startTime && candle.openTime <= wave.endTime);
      if (startIndex < 0) return [];
      let endIndex = startIndex;
      while (endIndex + 1 < candles.length && candles[endIndex + 1]!.openTime <= wave.endTime) endIndex += 1;
      return [{ ...wave, startIndex, endIndex }];
    }),
    markers: executions.filter(execution => execution.candleIndex >= 0), executions,
    priceLines: trade.priceLines ?? fallback.priceLines,
  };
}
