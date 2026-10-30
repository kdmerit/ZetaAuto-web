import { buildLocalChart } from './engine';
import { candleWindow, fetchBybitCandles, parseCsv } from './api';
import { candleCacheKey, loadCandles, saveCandles } from './storage';
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
    const cacheKey = candleCacheKey(window.symbol, settings.interval, window.start, window.end);
    const cached = await loadCandles(cacheKey);
    if (cached && cached.length >= 20) {
      candles = cached;
      onProgress?.({ phase: 'DATA', completed: candles.length, total: candles.length });
    } else {
      candles = await fetchBybitCandles(settings, (completed, total) =>
        onProgress?.({ phase: 'DATA', completed, total }),
      );
      await saveCandles(cacheKey, candles);
    }
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
