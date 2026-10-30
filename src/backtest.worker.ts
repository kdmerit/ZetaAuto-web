import { runBacktest } from './engine';
import type { BacktestSettings, Candle, Strategy } from './types';

interface RunMessage {
  type: 'RUN';
  candles: Candle[];
  settings: BacktestSettings;
  strategy: Strategy;
}

self.onmessage = (event: MessageEvent<RunMessage>) => {
  if (event.data.type !== 'RUN') return;
  try {
    const result = runBacktest(
      event.data.candles,
      event.data.settings,
      event.data.strategy,
      (completed, total) => self.postMessage({ type: 'PROGRESS', completed, total }),
    );
    self.postMessage({ type: 'RESULT', result });
  } catch (error) {
    self.postMessage({
      type: 'ERROR',
      message: error instanceof Error ? error.message : '브라우저 분석에 실패했습니다.',
    });
  }
};

export {};
