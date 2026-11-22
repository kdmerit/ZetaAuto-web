import { useEffect, useMemo, useState } from 'react';
import { defaultVerificationResultOptions, isVerificationDeviationSlMultiplier, parseVerificationMonths, verificationDeviationSlMultiplierRange, verificationKey, verificationMetrics, verificationSummaryFor, verificationValue, type EnvelopeVerificationReport, type VerificationDirection, type VerificationFilterOptions, type VerificationMetric, type VerificationResultOptions, type VerificationSource } from '../envelopeVerification';
import { isEnvelopeVerificationRunning, pauseEnvelopeVerification, restoreEnvelopeVerification, startEnvelopeVerification, subscribeEnvelopeVerification } from '../envelopeVerificationClient';
import { loadEnvelopeVerificationPreferences, saveEnvelopeVerificationPreferences, type EnvelopeVerificationPreferences } from '../envelopeVerificationPreferences';
import type { EnvelopeStatisticsRow } from '../envelopeStatistics';
import type { EnvelopeResultOptions } from '../types';
import { ProgressBar } from './ProgressBar';

const directionLabel = (direction: VerificationDirection): string => direction === 'PAST' ? '과거' : '미래';
const format = (value: number): string => value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });

export function useEnvelopeVerification(source: VerificationSource, sourceId?: string) {
  const [preferences, setPreferences] = useState(() => loadEnvelopeVerificationPreferences(source));
  const { direction, months, options } = preferences;
  const [view, setView] = useState<EnvelopeVerificationReport | null>(null);
  const [activeKey, setActiveKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const target = useMemo(() => sourceId ? { source, sourceId, direction } : null, [source, sourceId, direction]);
  const key = target ? verificationKey(target) : '';

  const updatePreferences = (changes: Partial<EnvelopeVerificationPreferences>): void => {
    const next = { ...preferences, ...changes };
    setPreferences(next);
    saveEnvelopeVerificationPreferences(source, next);
  };

  useEffect(() => {
    setError(null);
    if (!target) { setActiveKey(''); return; }
    let mounted = true;
    let received = false;
    let failed = false;
    setActiveKey(isEnvelopeVerificationRunning(target) ? key : '');
    const restore = () => {
      void restoreEnvelopeVerification(target).then(saved => {
        if (mounted && !received) setView(saved);
      }).catch(() => { if (mounted && !received) setError('저장된 검증 결과를 불러오지 못했습니다.'); });
    };
    const unsubscribe = subscribeEnvelopeVerification(event => {
      if (verificationKey(event.target) !== key) return;
      received = true;
      if (event.type === 'START') { setActiveKey(key); setView(null); setError(null); }
      if (event.type === 'UPDATE') setView(event.report);
      if (event.type === 'ERROR') { failed = true; setError(event.message); }
      if (event.type === 'IDLE') {
        setActiveKey('');
        if (failed) { received = false; restore(); }
      }
    });
    restore();
    return () => { mounted = false; unsubscribe(); };
  }, [target, key]);

  const report = view && key === verificationKey(view.request) ? view : null;
  const running = Boolean(key && activeKey === key);
  const results = report && report.status !== 'RUNNING' ? report : null;
  const hasVerificationData = useMemo(() => results !== null && Object.values(results.summaries).some(summary => summary.months > 0), [results]);
  const start = (resultOptions: EnvelopeResultOptions, resume = false): void => {
    if (!target) return;
    try {
      setError(null);
      startEnvelopeVerification({ ...target, months: resume && report ? report.request.months : parseVerificationMonths(months),
        resultOptions, ...(resume && report ? { resumeId: report.id } : {}) });
    } catch (error) {
      setError(error instanceof Error ? error.message : '검증을 시작하지 못했습니다.');
    }
  };
  return { ...preferences, updatePreferences, target, running, report, results, hasVerificationData, error, start,
    resultOptions: hasVerificationData ? options : defaultVerificationResultOptions };
}

type VerificationState = ReturnType<typeof useEnvelopeVerification>;
const metricOptions = Object.entries(verificationMetrics).map(([value, label]) => <option key={value} value={value}>{label}</option>);
function VerificationFilters({ options, draft, onChange, onDraftChange }: {
  options: VerificationResultOptions; draft: VerificationFilterOptions;
  onChange: (options: VerificationResultOptions) => void; onDraftChange: (draft: VerificationFilterOptions) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const apply = (): void => {
    const threshold = draft.threshold.trim();
    if (threshold && !Number.isFinite(Number(threshold))) { setError('필터 기준값을 숫자로 입력해 주세요.'); return; }
    if (draft.deviationSlEnabled && !isVerificationDeviationSlMultiplier(draft.deviationSlMultiplier)) {
      setError('N은 0.1~10.0으로 입력해 주세요.');
      return;
    }
    setError(null);
    onChange({ ...options, ...draft, threshold });
  };
  return <fieldset className="analysis-fields verification-filters" aria-label="검증 결과 정렬 및 필터">
    <h3>검증 결과 정렬·필터</h3>
    <div className="field-grid two">
      <label className="field-label">정렬 기준<select value={options.sortBy} onChange={event => onChange({ ...options, sortBy: event.target.value as VerificationResultOptions['sortBy'] })}><option value="">통계 정렬 유지</option>{metricOptions}</select></label>
      <label className="field-label">정렬 순서<select value={options.sortOrder} disabled={!options.sortBy} onChange={event => onChange({ ...options, sortOrder: event.target.value as VerificationResultOptions['sortOrder'] })}><option value="HIGH">높은 순</option><option value="LOW">낮은 순</option></select></label>
    </div>
    <div className="field-grid two">
      <label className="field-label">필터 기준<select value={draft.filterBy} onChange={event => onDraftChange({ ...draft, filterBy: event.target.value as VerificationMetric })}>{metricOptions}</select></label>
      <label className="field-label">조건<select value={draft.comparison} onChange={event => onDraftChange({ ...draft, comparison: event.target.value as VerificationFilterOptions['comparison'] })}><option value="MIN">이상</option><option value="MAX">이하</option></select></label>
    </div>
    <label className="field-label">기준값<input type="number" step="any" inputMode="decimal" placeholder="비우면 이 조건 생략" value={draft.threshold} onChange={event => onDraftChange({ ...draft, threshold: event.target.value })} /></label>
    <label className="checkbox-row"><input type="checkbox" checked={draft.deviationSlEnabled} onChange={event => onDraftChange({ ...draft, deviationSlEnabled: event.target.checked })} /><span>이격 ≥ SL × N</span></label>
    <label className="field-label">N (배수)
      <input type="number" inputMode="decimal" {...verificationDeviationSlMultiplierRange} step="any" disabled={!draft.deviationSlEnabled}
        value={draft.deviationSlMultiplier} onChange={event => onDraftChange({ ...draft, deviationSlMultiplier: event.target.value })} />
      <small>0.1~10.0</small>
    </label>
    <button className="outline-button" type="button" onClick={apply}>검증 필터 적용</button>
    {error ? <p className="error" role="alert">{error}</p> : null}
  </fieldset>;
}

export function EnvelopeVerificationControls({ verification, candidates, resultOptions, disabled, incompatible }: {
  verification: VerificationState; candidates: number; resultOptions: EnvelopeResultOptions; disabled: boolean; incompatible?: boolean;
}) {
  const { direction, months, target, running, report, hasVerificationData, error, start, options, filterDraft, updatePreferences } = verification;
  const reportCompleted = report?.status === 'COMPLETED';
  return <section className="envelope-verification" aria-label="월별 검증">
    <h3>월별 검증</h3>
    <fieldset className="analysis-fields" disabled={running}>
      <div className="field-grid two">
        <div className="field-label">검증 방향<div className="segmented" role="group" aria-label="검증 방향">
          {(['PAST', 'FUTURE'] as const).map(value => <button key={value} type="button" className={direction === value ? 'selected' : ''} aria-pressed={value === direction} onClick={() => updatePreferences({ direction: value })}>{directionLabel(value)}</button>)}
        </div></div>
        <label className="field-label">검증 개월 수<input type="number" inputMode="numeric" min="1" step="1" value={months} onChange={event => updatePreferences({ months: event.target.value })} /></label>
      </div>
      <p className="muted small">{direction === 'PAST' ? '통계 시작일 전' : '통계 종료일 후'}부터 완전한 한 달씩 검증합니다. 월마다 초기자금과 포지션을 초기 상태로 되돌립니다.</p>
      {target && candidates > 0 ? <p className="muted small">통계 필터를 통과한 설정 {candidates.toLocaleString()}개</p> : null}
      <button className="primary-button full-width" type="button" disabled={disabled || !target || candidates === 0} onClick={() => start(resultOptions)}>검증</button>
      {report?.status === 'PAUSED' && !running ? <button className="outline-button full-width" type="button" disabled={disabled} onClick={() => start(resultOptions, true)}>검증 이어하기 · {report.request.months}개월</button> : null}
    </fieldset>
    {incompatible ? <p className="muted small">현재 체결 방식으로 완료한 통계에서 월별 검증을 실행할 수 있습니다.</p> : null}
    {running ? <button className="danger-button full-width" type="button" onClick={pauseEnvelopeVerification}>검증 일시정지</button> : null}
    {report ? <>
      {running ? <ProgressBar completed={report.completed} total={report.total} label={report.message} /> : <p className="notice">{directionLabel(direction)} {report.request.months}개월 · {report.targetCount.toLocaleString()}개 설정 · {report.message}</p>}
      {reportCompleted && report.plan.limit ? <p className="muted small">{report.plan.limit === 'PRESENT' ? '현재까지 채워진 마지막 한 달에서 검증을 끝냈습니다.' : '최근 5년 안의 완전한 달까지만 검증했습니다.'}</p> : null}
      {report.dataStops > 0 ? <p className="muted small">{report.dataStops.toLocaleString()}개 종목·주기는 완전한 캔들 데이터를 확보하지 못한 달에서 멈췄습니다.</p> : null}
    </> : running ? <p className="notice" role="status">검증 준비 중</p> : null}
    {hasVerificationData ? <VerificationFilters options={options} draft={filterDraft}
      onChange={options => updatePreferences({ options })} onDraftChange={filterDraft => updatePreferences({ filterDraft })} /> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
  </section>;
}

export function EnvelopeVerificationSummary({ report, symbol, row }: { report: EnvelopeVerificationReport | null; symbol: string; row: EnvelopeStatisticsRow }) {
  if (!report) return null;
  const summary = verificationSummaryFor(report, symbol, row);
  if (!summary) return <small>월별 검증 미실행</small>;
  const monthCount = `${directionLabel(report.request.direction)} 검증 ${summary.months}/${report.request.months}개월`;
  if (summary.months === 0) return <small>{monthCount} · 완료된 달 없음</small>;
  const meanProfit = summary.profitMonths ? `${format(verificationValue(summary, 'averageProfit'))}%` : '—';
  const meanLoss = summary.lossMonths ? `${format(verificationValue(summary, 'averageLoss'))}%` : '—';
  return <span className="envelope-verification-summary">
    <span>{monthCount} · 수익 {summary.profitMonths} · 손실 {summary.lossMonths} · 손익 없음 {verificationValue(summary, 'flatMonths')}</span>
    <span>평균 수익률 {meanProfit} · 평균 손실률 {meanLoss}</span>
    <span>수익금 합계 {format(summary.profitUsdt)} USDT · 손실금 합계 {format(summary.lossUsdt)} USDT</span>
  </span>;
}
