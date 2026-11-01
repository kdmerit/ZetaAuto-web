/** Fixed user leverage only; no contract-risk queries, leverage sweep, or automatic cap. */
import type { PreparedSymbol } from './engine';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import type { BacktestResult, BacktestSettings } from './types';

export const yieldAnalysis = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

export function fixedEnvelopeSettings(settings: BacktestSettings): BacktestSettings {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(settings.leverage) || Number(settings.leverage) < 1 || Number(settings.leverage) > 100) {
    throw new Error('고정 레버리지는 1~100배, 소수 둘째 자리까지 입력해 주세요.');
  }
  return { ...settings, envelopeRisk: undefined };
}

export async function replayFixedEnvelope(
  document: PreparedSymbol, settings: BacktestSettings, seconds: number, signal: AbortSignal,
  progress: (label: string) => Promise<void>,
): Promise<BacktestResult> {
  const parameters = fixedEnvelopeSettings(settings);
  const state = initialPortfolio(Number(parameters.initialCapitalUsdt));
  for (let cursor = 0; cursor < document.bars.length; cursor += 512) {
    signal.throwIfAborted();
    const bars = document.bars.slice(cursor, cursor + 512);
    replayPortfolioBlock(state, [{ ...document, bars }], parameters, bars[0]!.candle.openTime, bars.at(-1)!.candle.closeTime, seconds);
    await progress(`${parameters.leverage}배 고정 · ${Math.min(cursor + 512, document.bars.length)}/${document.bars.length}봉`);
    await yieldAnalysis();
  }
  return portfolioResult(state, parameters);
}
