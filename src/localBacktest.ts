import { buildLocalChart } from './engine';
import { candleWindow, fetchBybitCandlesRange, intervalSeconds, parseCsv } from './api';
import { candleCacheKey, loadCandleRange, saveCandles } from './storage';
import type {
  BacktestResult,
  BacktestSettings,
  BacktestTrade,
  Candle,
  ChartData,
  Strategy,
} from './types';

export interface LocalProgress {
  phase: 'DATA' | 'REPLAY';
  completed: number;
  total: number;
}

interface CandleRange {
  start: number;
  end: number;
}

function missingCandleRanges(
  candles: Candle[],
  start: number,
  end: number,
  seconds: number,
): CandleRange[] {
  const available = new Set(candles.map((candle) => candle.openTime));
  const ranges: CandleRange[] = [];
  let cursor = start;
  while (cursor < end) {
    if (available.has(cursor)) {
      cursor += seconds;
      continue;
    }
    const rangeStart = cursor;
    while (cursor < end && !available.has(cursor)) cursor += seconds;
    ranges.push({ start: rangeStart, end: cursor });
  }
  return ranges;
}

function mergeCandles(first: Candle[], second: Candle[], start: number, end: number): Candle[] {
  const byTime = new Map<number, Candle>();
  [...first, ...second]
    .filter((candle) => candle.openTime >= start && candle.openTime < end)
    .forEach((candle) => byTime.set(candle.openTime, candle));
  return [...byTime.values()].sort((left, right) => left.openTime - right.openTime);
}

export async function runLocalBacktest(
  settings: BacktestSettings,
  strategy: Strategy,
  onProgress?: (progress: LocalProgress) => void,
  sourceFile?: File,
): Promise<BacktestResult> {
  let candles: Candle[];
  if (sourceFile) {
    candles = parseCsv(await sourceFile.text(), settings.interval);
  } else {
    const window = candleWindow(settings);
    const seconds = intervalSeconds(settings.interval);
    const totalBars = Math.ceil((window.end - window.start) / seconds);
    const cached = await loadCandleRange(
      window.symbol,
      settings.interval,
      window.start,
      window.end,
    );
    const ranges = missingCandleRanges(
      cached,
      window.start,
      window.end,
      seconds,
    );
    const initialCachedCount = new Set(cached.map((candle) => candle.openTime)).size;
    let downloadedUnique = 0;
    candles = cached;
    onProgress?.({
      phase: 'DATA',
      completed: Math.min(initialCachedCount, totalBars),
      total: totalBars,
    });
    for (const range of ranges) {
      const fetched = await fetchBybitCandlesRange(
        window.symbol,
        settings.interval,
        range.start,
        range.end,
        (completed, total) => onProgress?.({
          phase: 'DATA',
          completed: Math.min(totalBars, initialCachedCount + downloadedUnique + Math.min(completed, total)),
          total: totalBars,
        }),
      );
      const existing = new Set(candles.map((candle) => candle.openTime));
      fetched.forEach((candle) => {
        if (!existing.has(candle.openTime)) downloadedUnique += 1;
      });
      candles = mergeCandles(candles, fetched, window.start, window.end);
      await saveCandles(
        candleCacheKey(window.symbol, settings.interval, range.start, range.end),
        fetched,
      );
    }
    if (candles.length < 20) throw new Error('분석 기간의 캔들이 부족합니다.');
  }
  const worker = new Worker(new URL('./backtest.worker.ts', import.meta.url), {
    type: 'module',
  });
  return new Promise<BacktestResult>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{
      type: 'PROGRESS' | 'RESULT' | 'ERROR';
      completed?: number;
      total?: number;
      result?: BacktestResult;
      message?: string;
    }>) => {
      if (event.data.type === 'PROGRESS') {
        onProgress?.({
          phase: 'REPLAY',
          completed: event.data.completed ?? 0,
          total: event.data.total ?? candles.length,
        });
      } else if (event.data.type === 'RESULT' && event.data.result) {
        worker.terminate();
        resolve(event.data.result);
      } else if (event.data.type === 'ERROR') {
        worker.terminate();
        reject(new Error(event.data.message ?? '브라우저 분석에 실패했습니다.'));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || '브라우저 분석 worker가 중단되었습니다.'));
    };
    worker.postMessage({ type: 'RUN', candles, settings, strategy });
  });
}

export function chartForLocalTrade(
  result: BacktestResult,
  trade: BacktestTrade,
  settings: BacktestSettings,
): ChartData {
  return buildLocalChart(result, trade, settings);
}
