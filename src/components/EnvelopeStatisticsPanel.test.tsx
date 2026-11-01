import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EnvelopeStatisticsStatus } from './EnvelopeStatisticsPanel';
import type { EnvelopeStatisticsJob } from '../envelopeStatistics';
import type { BacktestSettings } from '../types';

const error = 'BTCUSDT의 유지증거금·위험한도 자료가 부족합니다. 임의의 LIQ로 계산하지 않습니다.';
function job(overrides: Partial<EnvelopeStatisticsJob> = {}): EnvelopeStatisticsJob {
  // The status component does not read settings; a full calculation is not run here.
  return { id: 'paused-v38', version: '2.10.38', settings: {} as BacktestSettings, status: 'PAUSED', intervalIndex: 0,
    periodIndex: 0, step: 1, exitIndex: 0, updatedAt: Date.now(), message: error, rows: [], maxSteps: {}, skippedIntervals: {}, ...overrides };
}
describe('envelope statistics risk loading status', () => {
  it('does not label a current paused risk-loading failure as an old fixed-leverage report', () => {
    const html = renderToStaticMarkup(<EnvelopeStatisticsStatus job={job()} />);
    expect(html).not.toContain('이전 고정 레버리지');
    expect(html).toContain('이어하기를 누르면 다시 조회합니다.');
    expect(html.split(error)).toHaveLength(2); // The same error is displayed only once.
    expect(html).toContain('위험한도 확인 대기');
  });
  it('shows a pending notice for a current job that has not loaded risk data yet', () => {
    const html = renderToStaticMarkup(<EnvelopeStatisticsStatus job={job({ status: 'RUNNING', message: '최대 레버리지·유지증거금 확인' })} />);
    expect(html).toContain('자료를 확인하는 중입니다.'); expect(html).not.toContain('이전 고정 레버리지');
  });
  it('reserves the legacy notice for an actual old-version report', () => {
    const html = renderToStaticMarkup(<EnvelopeStatisticsStatus job={job({ version: '2.10.36', status: 'COMPLETED', message: '이전 분석 완료' })} />);
    expect(html).toContain('이전 고정 레버리지'); expect(html).not.toContain('이어하기를 누르면');
  });
  it('shows confirmed leverage details once risk metadata is loaded', () => {
    const risk = { symbol: 'BTCUSDT', checkedAt: Date.now(), model: 'ISOLATED_ESTIMATE_V1' as const, maxLeverage: 100,
      tiers: [{ limit: 1000000, maintenanceRate: 0.005, deduction: 0, maxLeverage: 100 }] };
    const html = renderToStaticMarkup(<EnvelopeStatisticsStatus job={job({ risk, status: 'RUNNING', message: '캔들 확인' })} />);
    expect(html).toContain('종목 최대 100배'); expect(html).not.toContain('이전 고정 레버리지');
  });
});
