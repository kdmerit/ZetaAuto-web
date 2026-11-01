/** Evaluate leverage cash flows from one price-path trace, then replay the winning leverage exactly. */
import type { PreparedSymbol } from './engine';
import { initialPortfolio, portfolioResult, replayPortfolioBlock } from './portfolio';
import { estimatedLiquidation, safeLeverageLimit, takerFee, UnsupportedContractRisk } from './contractRisk';
import type { BacktestResult, BacktestSettings, ContractRisk, Execution } from './types';

interface TracePosition {
  entryAt: number; entry: number; side: 'LONG' | 'SHORT'; stop: number;
  executions: Execution[]; mark: number; gapOpen?: number;
}
export const yieldAnalysis = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

export async function bestEnvelopeLeverage(
  document: PreparedSymbol, settings: BacktestSettings, risk: ContractRisk, seconds: number, signal: AbortSignal,
  progress: (label: string) => Promise<void>,
): Promise<{ result: BacktestResult; leverage: number; safeMaximum: number; tested: number }> {
  const maximum = safeLeverageLimit(risk, Number(settings.betAmountUsdt), Number(settings.envelopeDeviationPercent), settings.side);
  if (!maximum) throw new UnsupportedContractRisk('설정한 베팅액·SL에서 안전한 레버리지가 없습니다.');
  const positions = new Map<number, TracePosition>();
  const source = { ...settings, leverage: '1', envelopeRisk: undefined };
  const traceState = initialPortfolio(0);
  for (let cursor = 0; cursor < document.bars.length; cursor += 512) {
    signal.throwIfAborted();
    const bars = document.bars.slice(cursor, cursor + 512);
    replayPortfolioBlock(traceState, [{ ...document, bars }], source, bars[0]!.candle.openTime, bars.at(-1)!.candle.closeTime, seconds, {
      fundingCheck: false,
      onFrame: (state, at, rows) => {
        const collect = (opened: number, entry: number, side: 'LONG' | 'SHORT', stop: number, executions: Execution[], mark: number, reason?: string): void => {
          let item = positions.get(opened);
          if (!item) { item = { entryAt: opened, entry, side, stop, executions: [], mark }; positions.set(opened, item); }
          if (item.executions.length !== executions.length) item.executions = executions.map(fill => ({ ...fill }));
          item.mark = mark;
          const open = rows[0]!.bar.candle.open;
          if (reason === 'SL' && (side === 'LONG' ? open <= stop : open >= stop)) item.gapOpen = open;
        };
        for (const trade of state.trades.slice(-2)) if (trade.executions.at(-1)?.candleOpenAt === at) {
          collect(trade.entryAt, trade.entryPrice, trade.side, trade.signal.activeStop ?? trade.signal.stop, trade.executions, trade.exitPrice, trade.reason);
        }
        const p = state.positions[document.symbol];
        if (p) collect(p.opened, p.entry, p.signal.side, p.stop, p.executions, p.mark);
      },
    });
    await progress(`가격 경로 ${Math.min(cursor + 512, document.bars.length)}/${document.bars.length}봉`);
    await yieldAnalysis();
  }
  const trace = [...positions.values()];
  const capital = Number(settings.initialCapitalUsdt); const bet = Number(settings.betAmountUsdt);
  let best = 1; let bestEquity = -Infinity;
  for (let leverage = 1; leverage <= maximum; leverage += 1) {
    signal.throwIfAborted();
    let cash = capital; let equity = capital; let entered = 0;
    for (const position of trace) {
      if (cash + 1e-10 < bet * (1 + leverage * takerFee)) break;
      entered += 1;
      cash -= bet * (1 + leverage * takerFee);
      let margin = bet; let quantity = position.executions[0]!.quantity;
      for (const fill of position.executions.slice(1)) {
        const liq = position.gapOpen !== undefined && fill.kind === 'CLOSE'
          ? estimatedLiquidation(position.side, position.entry, quantity * leverage, margin, risk) : null;
        if (liq !== null && (position.side === 'LONG' ? position.gapOpen! <= liq : position.gapOpen! >= liq)) {
          margin = 0; quantity = 0; break;
        }
        const released = margin * fill.quantity / quantity;
        cash += released + (fill.price - position.entry) * fill.quantity * leverage * (position.side === 'LONG' ? 1 : -1) - fill.price * fill.quantity * leverage * takerFee;
        margin -= released; quantity -= fill.quantity;
      }
      equity = cash + margin + (position.mark - position.entry) * quantity * leverage * (position.side === 'LONG' ? 1 : -1) - position.mark * quantity * leverage * takerFee;
    }
    if ((entered > 0 || !trace.length) && equity > bestEquity + 1e-9) { bestEquity = equity; best = leverage; }
    if (leverage % 16 === 0) { await progress(`레버리지 ${leverage}/${maximum}배`); await yieldAnalysis(); }
  }
  const parameters = { ...settings, leverage: String(best), envelopeRisk: risk };
  if (!Number.isFinite(bestEquity)) bestEquity = capital;
  const state = initialPortfolio(capital);
  for (let cursor = 0; cursor < document.bars.length; cursor += 512) {
    signal.throwIfAborted();
    const bars = document.bars.slice(cursor, cursor + 512);
    replayPortfolioBlock(state, [{ ...document, bars }], parameters, bars[0]!.candle.openTime, bars.at(-1)!.candle.closeTime, seconds);
    await yieldAnalysis();
  }
  const result = portfolioResult(state, parameters);
  if (Math.abs(result.finalEquityUsdt - bestEquity) > Math.max(1e-6, Math.abs(bestEquity) * 1e-9)) throw new Error('레버리지 현금흐름 검증이 일치하지 않습니다. 결과를 저장하지 않았습니다.');
  return { result, leverage: best, safeMaximum: maximum, tested: maximum };
}
