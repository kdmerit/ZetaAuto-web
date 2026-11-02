import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EnvelopeBestSettings, EnvelopeStatisticsStatus } from './EnvelopeStatisticsPanel';
import { EnvelopeSymbolSettings, VirtualEvaluationFields, VirtualPeriodNotice } from './EnvelopeWorkspace';
import type { EnvelopeStatisticsJob } from '../envelopeStatistics';
import type { BacktestSettings } from '../types';

const error = 'BTCUSDT의 유지증거금·위험한도 자료가 부족합니다. 임의의 LIQ로 계산하지 않습니다.';
function job(overrides: Partial<EnvelopeStatisticsJob> = {}): EnvelopeStatisticsJob {
  // Only the displayed fixed leverage is needed; a calculation is not run here.
  return { id: 'paused-v40', version: '2.10.40', settings: { leverage: '5' } as BacktestSettings, status: 'PAUSED', intervalIndex: 0,
    periodIndex: 0, step: 1, exitIndex: 0, updatedAt: Date.now(), message: error, rows: [], maxSteps: {}, skippedIntervals: {}, ...overrides };
}
describe('envelope fixed-leverage statistics status', () => {
  it('shows the entered 5x without risk-loading notices and displays a pause message only once', () => {
    const html = renderToStaticMarkup(<EnvelopeStatisticsStatus job={job()} />);
    expect(html).not.toContain('이전 고정 레버리지');
    expect(html).toContain('적용 레버리지 5배 고정');
    expect(html.split(error)).toHaveLength(2); // The same error is displayed only once.
    expect(html).toContain('개별통계 일시정지'); expect(html).not.toContain('위험한도 확인 대기');
  });
  it('does not wait for risk data during a current fixed-leverage calculation', () => {
    const html = renderToStaticMarkup(<EnvelopeStatisticsStatus job={job({ status: 'RUNNING', message: '캔들 확인' })} />);
    expect(html).toContain('적용 레버리지 5배 고정'); expect(html).not.toContain('자료를 확인하는 중입니다.');
  });
  it('reserves the legacy notice for an actual old-version report', () => {
    const html = renderToStaticMarkup(<EnvelopeStatisticsStatus job={job({ version: '2.10.36', status: 'COMPLETED', message: '이전 분석 완료' })} />);
    expect(html).toContain('이전 버전의 고정 레버리지'); expect(html).not.toContain('이어하기를 누르면');
  });
  it('labels old automatic-leverage archives with their original method', () => {
    const html = renderToStaticMarkup(<EnvelopeStatisticsStatus job={job({ version: '2.10.38', status: 'COMPLETED' })} />);
    expect(html).toContain('이전 자동 레버리지 탐색 결과'); expect(html).not.toContain('적용 레버리지 5배 고정');
  });
  it('does not display a saved risk snapshot maximum as the applied leverage', () => {
    const risk = { symbol: 'BTCUSDT', checkedAt: Date.now(), model: 'ISOLATED_ESTIMATE_V1' as const, maxLeverage: 100,
      tiers: [{ limit: 1000000, maintenanceRate: 0.005, deduction: 0, maxLeverage: 100 }] };
    const html = renderToStaticMarkup(<EnvelopeStatisticsStatus job={job({ risk, status: 'RUNNING', message: '캔들 확인' })} />);
    expect(html).toContain('적용 레버리지 5배 고정'); expect(html).not.toContain('종목 최대 100배');
  });
  it('uses the selected-period progress total instead of the four-period total', () => {
    const html = renderToStaticMarkup(<EnvelopeStatisticsStatus job={job({ version: '2.10.41', settings: { leverage: '5', envelopeStatisticsInterval: '1h' } as BacktestSettings })} />);
    expect(html).toContain('4,800'); expect(html).not.toContain('19,200'); expect(html).toContain('적용 레버리지 5배 고정');
  });
  it('uses both directional case counts for current reports, without changing old report totals', () => {
    const html = renderToStaticMarkup(<EnvelopeStatisticsStatus job={job({ version: '2.10.42', settings: { leverage: '5', side: 'BOTH', envelopeStatisticsInterval: '1h' } as BacktestSettings })} />);
    expect(html).toContain('9,600'); expect(html).not.toContain('이전 롱·숏 합산');
  });
  it('shows two independent best settings including a losing best instead of substituting an overall winner', () => {
    const common = { interval: '1h' as const, maPeriod: 5, deviationPercent: 1, exitMode: 'CENTER' as const, leverage: 5,
      returnPercent: -4.5, profitUsdt: -45, realizedProfitUsdt: -45, feesUsdt: 2, entryCount: 3, closedTradeCount: 3, winCount: 1, lossCount: 2, winRatePercent: 33.33, maxDrawdownPercent: 5, openPositionCount: 0 };
    const bestBySide = { LONG: { ...common, side: 'LONG' as const }, SHORT: { ...common, side: 'SHORT' as const, interval: '4h' as const, maPeriod: 60, returnPercent: 18, profitUsdt: 180 } };
    const settings = { leverage: '5', side: 'BOTH' } as BacktestSettings;
    const current = job({ version: '2.10.42', status: 'COMPLETED', settings, bestBySide, rows: Object.values(bestBySide) });
    const individual = renderToStaticMarkup(<EnvelopeBestSettings job={current} disabled={false} onChoose={() => {}} />);
    expect(individual).toContain('롱 해당 기간 최고 수익률 -4.5%'); expect(individual).toContain('숏 해당 기간 최고 수익률 18%');
    expect(individual).toContain('SMA5'); expect(individual).toContain('SMA60');
    const all = renderToStaticMarkup(<EnvelopeSymbolSettings row={{ symbol: 'BTCUSDT', launchAt: 0, status: 'OK', best: bestBySide.SHORT, bestBySide }} settings={settings} disabled={false} onChoose={() => {}} />);
    expect(all).toContain('롱 최고 수익률'); expect(all).toContain('-4.5%'); expect(all).toContain('숏 최고 수익률'); expect(all).toContain('18%');
    expect(all).toContain('SMA5'); expect(all).toContain('SMA60');
  });
  it('does not invent a return or setting for a direction with no trades', () => {
    const html = renderToStaticMarkup(<EnvelopeBestSettings job={job({ version: '2.10.42', status: 'COMPLETED', settings: { side: 'BOTH' } as BacktestSettings, bestBySide: { LONG: null, SHORT: null } })} disabled={false} onChoose={() => {}} />);
    expect(html).toContain('롱 해당 기간 최고 수익률 —'); expect(html).toContain('숏 해당 기간 최고 수익률 —'); expect(html).not.toContain('0%');
    expect((html.match(/disabled/g) ?? []).length).toBe(2);
  });
  it('shows the reduced fixed-exit total and the required trade/win-loss counts', () => {
    const current = job({ version: '2.10.43', settings: { side: 'BOTH', leverage: '5', envelopeStatisticsInterval: '1h' } as BacktestSettings });
    expect(renderToStaticMarkup(<EnvelopeStatisticsStatus job={current} />)).toContain('3,200');
    const row = { interval: '1h' as const, side: 'LONG' as const, maPeriod: 5, deviationPercent: 1, exitMode: 'OPPOSITE' as const, leverage: 5,
      returnPercent: 3, profitUsdt: 30, realizedProfitUsdt: 30, feesUsdt: 1, entryCount: 5, closedTradeCount: 5, winCount: 3, lossCount: 2, winRatePercent: 60, maxDrawdownPercent: 1, openPositionCount: 0 };
    const html = renderToStaticMarkup(<EnvelopeBestSettings job={{ ...current, status: 'COMPLETED', rows: [row], bestBySide: { LONG: row, SHORT: null } }} disabled={false} onChoose={() => {}} />);
    expect(html).toContain('진입 5회'); expect(html).toContain('승/패 3/2'); expect(html).toContain('승률 60%');
    const all = renderToStaticMarkup(<EnvelopeSymbolSettings settings={current.settings} row={{ symbol: 'BTCUSDT', launchAt: 0, status: 'OK', best: row, bestBySide: { LONG: row, SHORT: null }, tradedSides: { SHORT: true } }} disabled={false} onChoose={() => {}} />);
    expect(all).toContain('진입 5회'); expect(all).toContain('승/패 3/2'); expect(all).toContain('최적 기준 미달');
  });
  it('renders independent evaluation inputs and labels overlapping or backward-looking evaluations', () => {
    const training = { startDate: '2026-02-01', startTime: '09:00', endDate: '2026-02-11', endTime: '09:00', envelopeStatisticsInterval: '1h' } as BacktestSettings;
    const evaluation = { ...training, startDate: '2026-03-01', endDate: '2026-03-11', initialCapitalUsdt: '1500', betAmountUsdt: '50', leverage: '3' };
    const html = renderToStaticMarkup(<VirtualEvaluationFields settings={evaluation} disabled={false} onChange={() => {}} />);
    for (const marker of ['가상매매 분석 기간', '2026-03-01', '가상 초기자금', '1500', '고정 베팅액', '50', '레버리지']) expect(html).toContain(marker);
    expect(renderToStaticMarkup(<VirtualPeriodNotice evaluation={evaluation} training={training} />)).toContain('선정 이후');
    expect(renderToStaticMarkup(<VirtualPeriodNotice evaluation={training} training={training} />)).toContain('겹칩니다');
    expect(renderToStaticMarkup(<VirtualPeriodNotice evaluation={{ ...evaluation, startDate: '2026-01-01', endDate: '2026-01-11' }} training={training} />)).toContain('선정 이전');
  });
});
