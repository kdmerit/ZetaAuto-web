import { useEffect, useMemo, useRef, useState } from 'react';
import { envelopeExitLabels, envelopeExitModes, envelopePeriods } from '../envelope';
import { envelopeOptimizerVersion, statisticsIntervals, statisticsProgress, statisticsTotal, type EnvelopeStatisticsJob, type EnvelopeStatisticsRow } from '../envelopeStatistics';
import { isEnvelopeStatisticsRunning, pauseEnvelopeStatistics, restoreEnvelopeStatistics, startEnvelopeStatistics, subscribeEnvelopeStatistics } from '../envelopeStatisticsClient';
import type { BacktestSettings, EnvelopeExitMode } from '../types';
import { loadEnvelopeStatisticsHistory, loadEnvelopeStatisticsReport, type EnvelopeStatisticsHistoryEntry } from '../envelopeStatisticsHistory';
import { ProgressBar } from './ProgressBar';

type Metric = 'returnPercent' | 'profitUsdt' | 'winCount' | 'winRatePercent' | 'entryCount' | 'leverage';
const metrics: Record<Metric, string> = { returnPercent: '수익률', profitUsdt: '순손익', winCount: '수익횟수', winRatePercent: '승률', entryCount: '진입횟수', leverage: '최적 레버리지' };
const colors = ['#88aaff', '#51d4a3', '#eea757', '#cf9bff'];
const number = (value: number | null | undefined): string => value == null ? '—' : value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });

export function EnvelopeStatisticsStatus({ job }: { job: EnvelopeStatisticsJob }) {
  const legacy = job.version !== envelopeOptimizerVersion;
  return <>
    {legacy ? <p className="notice small">이전 고정 레버리지 통계입니다. 새 개별통계부터 레버리지를 최적화합니다.</p>
      : job.risk ? <p className="notice small">종목 최대 {job.risk.maxLeverage}배 · 1배씩 비교 · LIQ 안전 여유 0.3% · 추가 증거금 없는 격리마진 예상치 · 현재 공개 위험한도 기준</p>
        : <p className="notice small">{job.status === 'RUNNING' ? '최대 레버리지와 위험한도 자료를 확인하는 중입니다.'
          : job.status === 'PAUSED' ? '위험한도 자료를 아직 확인하지 못했습니다. 이어하기를 누르면 다시 조회합니다.'
            : '이 보고서의 위험한도 자료를 확인하지 못했습니다.'}</p>}
    {job.status !== 'COMPLETED' ? <ProgressBar completed={statisticsProgress(job)} total={statisticsTotal} label={job.status === 'PAUSED' ? job.risk ? '개별통계 일시정지' : '위험한도 확인 대기' : job.message} /> : <p className="notice">{job.message}</p>}
    {job.status === 'PAUSED' ? <p className="notice" role="status">{job.message}</p> : null}
  </>;
}

function ComparisonGraph({ rows, metric }: { rows: EnvelopeStatisticsRow[]; metric: Metric }) {
  const [point, setPoint] = useState<number | null>(null);
  const values = rows.flatMap(row => row[metric] === null ? [] : [row[metric]!]);
  const maxX = Math.max(0.1, ...rows.map(row => row.deviationPercent));
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(1, ...values);
  const span = maximum - minimum || 1;
  const y = (value: number): number => 176 - (value - minimum) / span * 150;
  const x = (value: number): number => 52 + value / maxX * 410;
  const chosen = point === null ? [] : rows.filter(row => Math.round(row.deviationPercent * 10) === point);
  return <div className="envelope-stat-graph">
    <svg viewBox="0 0 480 218" role="img" aria-label={`이격별 ${metrics[metric]} 비교 그래프`} onPointerDown={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      setPoint(Math.max(1, Math.min(Math.round(maxX * 10), Math.round(((event.clientX - rect.left) / rect.width * 480 - 52) / 410 * maxX * 10))));
    }}>
      {[0, 1, 2, 3].map(index => {
        const value = minimum + span * index / 3;
        return <g key={index}><line x1="52" x2="462" y1={y(value)} y2={y(value)} stroke="#40516a" /><text x="47" y={y(value) + 4} textAnchor="end">{number(value)}</text></g>;
      })}
      {statisticsIntervals.map((interval, index) => {
        const points = rows.filter(row => row.interval === interval && row[metric] !== null).sort((a, b) => a.deviationPercent - b.deviationPercent);
        return <g key={interval}>
          <polyline points={points.map(row => `${x(row.deviationPercent)},${y(row[metric]!)}`).join(' ')} fill="none" stroke={colors[index]} strokeWidth="2.4" />
          {points.length === 1 ? <circle cx={x(points[0]!.deviationPercent)} cy={y(points[0]![metric]!)} r="3" fill={colors[index]} /> : null}
        </g>;
      })}
      {point !== null ? <line x1={x(point / 10)} x2={x(point / 10)} y1="20" y2="180" stroke="#e6ecf5" strokeDasharray="3 3" /> : null}
      <text x="52" y="201">0%</text><text x="462" y="201" textAnchor="end">이격 {maxX.toFixed(1)}%</text>
    </svg>
    <div className="envelope-stat-legend">{statisticsIntervals.map((interval, index) => <span key={interval} style={{ color: colors[index] }}>{interval}</span>)}</div>
    {chosen.length ? <p className="small">이격 {(point! / 10).toFixed(1)}% · {chosen.map(row => `${row.interval} ${number(row[metric])}${metric === 'returnPercent' || metric === 'winRatePercent' ? '%' : ''}`).join(' / ')}</p> : null}
  </div>;
}

export function EnvelopeStatisticsPanel({ settings, disabled, validate, onChoose, onBusyChange }: {
  settings: BacktestSettings;
  disabled: boolean;
  validate: () => void;
  onChoose: (settings: BacktestSettings, source?: 'history') => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [job, setJob] = useState<EnvelopeStatisticsJob | null>(null);
  const [latestJob, setLatestJob] = useState<EnvelopeStatisticsJob | null>(null);
  const [running, setRunning] = useState(isEnvelopeStatisticsRunning);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>('returnPercent');
  const [period, setPeriod] = useState(20);
  const [exit, setExit] = useState<EnvelopeExitMode>('CENTER');
  const [limit, setLimit] = useState(30);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<EnvelopeStatisticsHistoryEntry[]>([]);
  const historySymbol = settings.symbol.toUpperCase().replace(/USDT$/, '');
  const historyRequest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let received = false;
    void restoreEnvelopeStatistics().then(saved => { if (mounted.current && !received) { setJob(saved); setLatestJob(saved); } }).catch(() => { if (mounted.current) setError('저장된 개별통계를 불러오지 못했습니다.'); });
    const unsubscribe = subscribeEnvelopeStatistics(event => {
      received = true;
      if (event.type === 'UPDATE') { setJob(event.job); setLatestJob(event.job); }
      if (event.type === 'ERROR') {
        setError(event.message);
        setJob(current => current && current.status === 'RUNNING' ? { ...current, status: 'PAUSED', message: event.message } : current);
        setLatestJob(current => current && current.status === 'RUNNING' ? { ...current, status: 'PAUSED', message: event.message } : current);
      }
      if (event.type === 'IDLE') setRunning(false);
    });
    return () => { mounted.current = false; unsubscribe(); };
  }, []);
  useEffect(() => { onBusyChange(running || historyLoading); }, [running, historyLoading, onBusyChange]);
  useEffect(() => { historyRequest.current += 1; setHistoryOpen(false); setHistoryEntries([]); setHistoryLoading(false); }, [settings.mode, historySymbol]);
  const rows = useMemo(() => [...(job?.rows ?? [])].map(row => ({ ...row, leverage: row.leverage ?? Number(job!.settings.leverage) })).sort((a, b) => Number(b.entryCount > 0) - Number(a.entryCount > 0) || b.returnPercent - a.returnPercent || a.maxDrawdownPercent - b.maxDrawdownPercent), [job]);
  const graphRows = useMemo(() => rows.filter(row => row.maPeriod === period && row.exitMode === exit), [rows, period, exit]);
  const best = rows.find(row => row.entryCount > 0);
  const start = (resume = false): void => {
    try {
      if (!resume) validate();
      setError(null); setLimit(30);
      startEnvelopeStatistics(settings, resume ? latestJob?.id : undefined);
      setJob(resume ? latestJob : null); setHistoryOpen(false); historyRequest.current += 1;
      setRunning(true);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '개별통계를 시작하지 못했습니다.'); }
  };
  const toggleHistory = async (): Promise<void> => {
    if (historyOpen) { setHistoryOpen(false); return; }
    const requestId = ++historyRequest.current;
    setHistoryLoading(true); setError(null);
    try {
      const entries = settings.mode === 'SINGLE' && !historySymbol ? [] : await loadEnvelopeStatisticsHistory(settings.mode === 'SINGLE' ? historySymbol : undefined);
      if (mounted.current && requestId === historyRequest.current) { setHistoryEntries(entries); setHistoryOpen(true); }
    } catch { if (mounted.current && requestId === historyRequest.current) setError('개별통계 이력을 불러오지 못했습니다. 다시 눌러 주세요.'); }
    finally { if (mounted.current && requestId === historyRequest.current) setHistoryLoading(false); }
  };
  const openHistory = async (entry: EnvelopeStatisticsHistoryEntry): Promise<void> => {
    const requestId = ++historyRequest.current;
    setHistoryLoading(true); setError(null);
    try {
      const saved = await loadEnvelopeStatisticsReport(entry.id);
      if (!saved) throw new Error('저장된 개별통계 결과가 없거나 보관 기간이 지났습니다.');
      if (!mounted.current || requestId !== historyRequest.current) return;
      setJob(saved); setLimit(30); setMetric('returnPercent');
      setPeriod(Number(saved.settings.envelopeMaPeriod ?? '20')); setExit(saved.settings.envelopeExitMode ?? 'CENTER');
      setHistoryOpen(false); setHistoryEntries([]);
      onChoose(saved.settings, 'history');
    } catch (failure) { if (mounted.current && requestId === historyRequest.current) setError(failure instanceof Error ? failure.message : '개별통계 이력을 불러오지 못했습니다.'); }
    finally { if (mounted.current && requestId === historyRequest.current) setHistoryLoading(false); }
  };
  return <section className="envelope-statistics" aria-label="엔벨로프 개별통계">
    <button className="primary-button full-width" type="button" disabled={disabled || running || historyLoading || settings.mode !== 'SINGLE'} onClick={() => start()}>{running ? '개별통계 진행 중' : '개별통계 분석 시작'}</button>
    {running ? <button className="danger-button full-width" type="button" onClick={pauseEnvelopeStatistics}>개별통계 일시정지</button> : null}
    {!running && latestJob?.status === 'PAUSED' ? <button className="outline-button full-width" type="button" disabled={disabled || historyLoading || settings.mode !== 'SINGLE' || latestJob.version !== envelopeOptimizerVersion} onClick={() => start(true)}>개별통계 이어하기 · {latestJob.settings.symbol}</button> : null}
    <button className="outline-button full-width" type="button" disabled={disabled || running || historyLoading} aria-expanded={historyOpen} onClick={() => { void toggleHistory(); }}>{historyLoading ? '개별통계 이력 불러오는 중' : historyOpen ? '개별통계 이력 닫기' : `${settings.mode === 'SINGLE' ? `${historySymbol || '해당 종목'} ` : ''}개별통계 이력보기`}</button>
    {historyOpen ? <div className="history-list envelope-stat-history" aria-label="개별통계 이력">
      {historyEntries.length ? historyEntries.map(entry => <button type="button" className="history-card" key={entry.id} disabled={historyLoading || running || disabled} onClick={() => { void openHistory(entry); }}>
        <span className="history-card-heading"><strong>{entry.settings.symbol.toUpperCase().replace(/USDT$/, '')} 개별통계</strong><em className={entry.bestReturnPercent !== null && entry.bestReturnPercent < 0 ? 'negative' : 'positive'}>최고 {entry.bestReturnPercent === null ? '—' : `${number(entry.bestReturnPercent)}%`}</em></span>
        <span>{entry.settings.startDate} {entry.settings.startTime} ~ {entry.settings.endDate || '현재'} {entry.settings.endDate ? entry.settings.endTime : ''}</span>
        <small>{entry.comparedCount.toLocaleString()}개 조건 비교 · 저장 {new Date(entry.savedAt).toLocaleString('ko-KR')}</small>
      </button>) : <p className="muted history-empty">{settings.mode === 'SINGLE' ? `${historySymbol || '해당 종목'} ` : ''}개별통계 이력이 없습니다.</p>}
    </div> : null}
    {error && error !== job?.message ? <p className="error" role="alert">{error}</p> : null}
    {job ? <>
      <h3>{job.settings.symbol} 개별통계 {job.status === 'COMPLETED' ? '결과' : job.status === 'PAUSED' ? '일시정지' : '진행 중'}</h3>
      <p className="muted small">{job.settings.startDate} {job.settings.startTime} ~ {job.settings.endDate} {job.settings.endTime} (한국시간)<br />4개 주기 × 8개 SMA × 0.1~20.0% × 3개 청산 방식 × 안전 범위 내 정수 레버리지</p>
      <EnvelopeStatisticsStatus job={job} />
      <p className="muted small">밴드 접촉이 없는 이격 이후의 조합은 건너뜁니다. 완료한 조건은 기기에 저장되며 화면을 닫아 중단되면 이어갈 수 있습니다.</p>
      {Object.entries(job.skippedIntervals).map(([interval, message]) => <p key={interval} className="notice small">{interval} 제외: {message}</p>)}
      {best ? <div className="envelope-best"><strong>{job.status === 'COMPLETED' ? '해당 기간' : '현재까지'} 최고 수익률 {number(best.returnPercent)}%</strong><span>{best.interval} · SMA{best.maPeriod} · 이격 {best.deviationPercent.toFixed(1)}% · {best.leverage}배 · {envelopeExitLabels[best.exitMode]}</span></div> : null}
      {rows.length ? <>
        <div className="field-grid two">
          <label className="field-label">비교 지표<select value={metric} onChange={event => setMetric(event.target.value as Metric)}>{Object.entries(metrics).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label className="field-label">그래프 중심선<select value={period} onChange={event => setPeriod(Number(event.target.value))}>{envelopePeriods.map(value => <option value={value} key={value}>SMA{value}</option>)}</select></label>
        </div>
        <label className="field-label">그래프 청산 방식<select value={exit} onChange={event => setExit(event.target.value as EnvelopeExitMode)}>{envelopeExitModes.map(value => <option value={value} key={value}>{envelopeExitLabels[value]}</option>)}</select></label>
        {graphRows.length ? <ComparisonGraph rows={graphRows} metric={metric} /> : <p className="muted small">선택한 SMA·청산 방식의 비교 결과가 아직 없습니다.</p>}
        <p className="muted small">과거 기간 내 비교이며 미래 수익을 보장하지 않습니다. 수익률·순손익은 수수료와 미청산 평가손익을 포함하며 수익횟수·승률은 완료된 포지션 기준입니다.</p>
        <h3>세부 결과 · 수익률 순 {rows.length.toLocaleString()}건</h3>
        <div className="envelope-stat-rows">{rows.slice(0, limit).map(row => <button className="envelope-stat-row" type="button" key={`${row.interval}:${row.maPeriod}:${row.deviationPercent}:${row.exitMode}`} disabled={running || historyLoading || disabled} onClick={() => onChoose({ ...job.settings, interval: row.interval, envelopeMaPeriod: String(row.maPeriod), envelopeDeviationPercent: row.deviationPercent.toFixed(1), envelopeExitMode: row.exitMode, leverage: String(row.leverage), envelopeRisk: job.risk })}>
          <strong>{row.interval} · SMA{row.maPeriod} · {row.deviationPercent.toFixed(1)}% <span className={row.returnPercent >= 0 ? 'long-text' : 'short-text'}>{number(row.returnPercent)}%</span></strong>
          <span>{row.leverage}배 · {envelopeExitLabels[row.exitMode]}</span>
          <span>순손익 {number(row.profitUsdt)} USDT · 수익 {row.winCount}회 · 승률 {number(row.winRatePercent)}%</span>
          <span>진입 {row.entryCount} · 청산 {row.closedTradeCount} · 미청산 {row.openPositionCount} · 최대낙폭 {number(row.maxDrawdownPercent)}%</span>
          <small>터치하여 이 조건 불러오기 ›</small>
        </button>)}</div>
        {rows.length > limit ? <button type="button" className="outline-button full-width" onClick={() => setLimit(value => value + 30)}>결과 더 보기 ({Math.min(limit, rows.length)} / {rows.length})</button> : null}
      </> : job.status === 'COMPLETED' ? <p className="muted">선택한 기간·방향에서 엔벨로프 밴드에 접촉한 조건이 없습니다.</p> : null}
    </> : null}
  </section>;
}
