import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EnvelopeStatisticsStatus } from './EnvelopeStatisticsPanel';
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
});
