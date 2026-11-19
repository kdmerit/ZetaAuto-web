/** Fixed user leverage only; no contract-risk queries, leverage sweep, or automatic cap. */
import type { PreparedBar, PreparedSymbol } from './engine';
import { initialPortfolio, portfolioResult, replayPortfolioBlock, type ReplayOptions } from './portfolio';
import type { BacktestResult, BacktestSettings } from './types';
import { envelopeParameters } from './envelope';
import { validateLowerTimeframeCandles } from './intrabar';

export const yieldAnalysis = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

export function fixedEnvelopeSettings(settings: BacktestSettings): BacktestSettings {
  envelopeParameters(settings);
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(settings.leverage) || Number(settings.leverage) < 1 || Number(settings.leverage) > 100) {
    throw new Error('고정 레버리지는 1~100배, 소수 둘째 자리까지 입력해 주세요.');
  }
  return { ...settings, envelopeRisk: undefined };
}

export function validateEnvelopeMinuteRanges(document: PreparedSymbol): WeakMap<PreparedBar, { low: number; high: number }> {
  const ranges = new WeakMap<PreparedBar, { low: number; high: number }>();
  for (const bar of document.bars) {
    const minutes = bar.envelopeIntrabarCandles;
    if (!minutes) continue;
    validateLowerTimeframeCandles(bar.candle, minutes, 60, '1분봉');
    let low = Infinity;
    let high = -Infinity;
    for (const minute of minutes) {
      low = Math.min(low, minute.open);
      high = Math.max(high, minute.open);
    }
    ranges.set(bar, { low, high });
  }
  return ranges;
}

export async function replayFixedEnvelope(
  document: PreparedSymbol, settings: BacktestSettings, seconds: number, signal: AbortSignal,
  progress: (label: string) => Promise<void>, options: ReplayOptions & { shouldYield?: () => boolean } = {},
): Promise<BacktestResult> {
  const parameters = fixedEnvelopeSettings(settings);
  const state = initialPortfolio(Number(parameters.initialCapitalUsdt));
  const blockSize = settings.envelopeExecutionModel === 'MINUTE_POLL' ? Math.max(1, Math.floor(86400 / seconds)) : 512;
  for (let cursor = 0; cursor < document.bars.length; cursor += blockSize) {
    signal.throwIfAborted();
    const bars = document.bars.slice(cursor, cursor + blockSize);
    replayPortfolioBlock(state, [{ ...document, bars }], parameters, bars[0]!.candle.openTime, bars.at(-1)!.candle.closeTime, seconds, options);
    if (options.shouldYield?.() ?? true) {
      await progress(`${parameters.leverage}배 고정 · ${Math.min(cursor + blockSize, document.bars.length)}/${document.bars.length}봉`);
      await yieldAnalysis();
    }
  }
  return portfolioResult(state, parameters);
}
