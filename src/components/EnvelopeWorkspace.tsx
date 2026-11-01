import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiContext } from '../api';
import { useAnalysisBusy } from '../analysisActivity';
import { loadSettings, saveSettings } from '../storage';
import { analysisWindow } from '../marketData';
import { envelopeExitLabels } from '../envelope';
import { envelopeBatchView, loadEnvelopeBatchHistory, loadEnvelopeBatchReport, type BatchHistoryEntry, type EnvelopeBatchKind, type EnvelopeBatchView } from '../envelopeBatch';
import { isEnvelopeBatchRunning, pauseEnvelopeBatch, restoreEnvelopeBatch, startEnvelopeBatch, subscribeEnvelopeBatch } from '../envelopeBatchClient';
import type { BacktestSettings } from '../types';
import { defaultSettings, formatDateInput, formatTimeInput, StrategyBacktest } from './StrategyBacktest';
import { EnvelopeStatisticsPanel } from './EnvelopeStatisticsPanel';
import { ProgressBar } from './ProgressBar';

type View = 'SINGLE' | 'ALL' | 'SINGLE_STATS' | 'ALL_STATS';
const views: { id: View; label: string }[] = [{ id: 'SINGLE', label: '개별분석' }, { id: 'ALL', label: '전체분석' }, { id: 'SINGLE_STATS', label: '개별통계' }, { id: 'ALL_STATS', label: '전체통계' }];
const num = (value: number | undefined | null): string => value == null ? '—' : value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
function readSettings(view: string): BacktestSettings {
  const fallback = { ...loadSettings('ENVELOPE', defaultSettings()), mode: view === 'SINGLE_STATS' ? 'SINGLE' as const : 'ALL' as const };
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(`zetaauto.web.envelope.${view}.settings`) ?? '{}'), mode: fallback.mode }; } catch { return fallback; }
}
function storeSettings(view: string, settings: BacktestSettings): void { try { localStorage.setItem(`zetaauto.web.envelope.${view}.settings`, JSON.stringify(settings)); } catch { /* Keep inputs usable without storage. */ } }
function validateSearch(settings: BacktestSettings): void {
  if (settings.mode === 'SINGLE' && !/^[A-Z0-9]{1,36}$/.test(settings.symbol.replace(/USDT$/, ''))) throw new Error('종목명을 입력해 주세요.');
  if (!/^\d+(\.\d{1,2})?$/.test(settings.initialCapitalUsdt) || Number(settings.initialCapitalUsdt) < 10) throw new Error('초기자금을 확인해 주세요.');
  if (!/^\d+(\.\d{1,2})?$/.test(settings.betAmountUsdt) || Number(settings.betAmountUsdt) < 1 || Number(settings.betAmountUsdt) > Number(settings.initialCapitalUsdt)) throw new Error('고정 베팅액을 확인해 주세요.');
  analysisWindow({ ...settings, interval: '15m' });
}
function SearchFields({ settings, onChange, disabled, single }: { settings: BacktestSettings; onChange: (settings: BacktestSettings) => void; disabled: boolean; single: boolean }) {
  const update = <K extends keyof BacktestSettings>(key: K, value: BacktestSettings[K]): void => onChange({ ...settings, [key]: value });
  return <section className="surface-card form-card"><fieldset className="analysis-fields" disabled={disabled}>
    {single ? <label className="field-label">종목명<span className="suffix-field"><input value={settings.symbol} onChange={event => update('symbol', event.target.value.toUpperCase().replace(/USDT/g, '').replace(/[^A-Z0-9]/g, '').slice(0, 36))} /><b>USDT</b></span></label> : <p className="notice">슬리피지 필터 없이 모든 활성 USDT 종목을 분석합니다. 일반 전체분석의 주간 필터 목록은 사용하지 않습니다.</p>}
    <h2>분석 방향</h2><div className="segmented three">{(['BOTH', 'LONG', 'SHORT'] as const).map(side => <button key={side} type="button" className={settings.side === side ? 'selected' : ''} onClick={() => update('side', side)}>{side === 'BOTH' ? '롱 + 숏' : side === 'LONG' ? '롱' : '숏'}</button>)}</div>
    <h2>분석 기간 (한국시간)</h2><div className="field-grid two">
      <label className="field-label">시작일<input inputMode="numeric" value={settings.startDate} onChange={event => update('startDate', formatDateInput(event.target.value))} /></label>
      <label className="field-label">시작시간<input inputMode="numeric" value={settings.startTime} onChange={event => update('startTime', formatTimeInput(event.target.value))} /></label>
      <label className="field-label">종료일 (선택)<input inputMode="numeric" value={settings.endDate} onChange={event => update('endDate', formatDateInput(event.target.value))} placeholder="현재까지" /></label>
      <label className="field-label">종료시간<input inputMode="numeric" value={settings.endTime} onChange={event => update('endTime', formatTimeInput(event.target.value))} /></label>
    </div><div className="field-grid two"><label className="field-label">가상 초기자금<input inputMode="decimal" value={settings.initialCapitalUsdt} onChange={event => update('initialCapitalUsdt', event.target.value)} /></label><label className="field-label">고정 베팅액<input inputMode="decimal" value={settings.betAmountUsdt} onChange={event => update('betAmountUsdt', event.target.value)} /></label></div>
    <p className="muted small">4개 주기·8개 SMA·이격 0.1~20.0%·3개 청산 방식과 레버리지를 함께 비교합니다. 레버리지는 1배부터 종목 최대까지 1씩 올리며 롱 LIQ ≤ SL×0.997, 숏 LIQ ≥ SL×1.003 범위를 넘으면 중단합니다.</p>
    <p className="muted small">LIQ는 추가 증거금 없는 격리마진 예상치입니다. 현재 공개 유지증거금·위험한도·청산 수수료를 반영하며 실제 계좌·과거 거래소 청산가와 다를 수 있습니다. 긴 기간·전체종목은 오래 걸릴 수 있으며 중지 후 이어갈 수 있습니다.</p>
  </fieldset></section>;
}

function BatchPanel({ kind, settings, onRestore, selectedSource, onSelectSource, onChoose }: { kind: EnvelopeBatchKind; settings: BacktestSettings; onRestore: (settings: BacktestSettings) => void; selectedSource: string; onSelectSource: (id: string) => void; onChoose: (settings: BacktestSettings) => void }) {
  const [view, setView] = useState<EnvelopeBatchView | null>(null); const [latest, setLatest] = useState<EnvelopeBatchView | null>(null);
  const [running, setRunning] = useState(() => isEnvelopeBatchRunning(kind)); const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<BatchHistoryEntry[]>([]); const [historyOpen, setHistoryOpen] = useState(false); const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<BatchHistoryEntry[]>([]); const [limit, setLimit] = useState(30); const busy = useAnalysisBusy();
  const mounted = useRef(true); const request = useRef(0); const label = kind === 'ALL_STATS' ? '전체통계' : '가상매매';
  useEffect(() => {
    mounted.current = true; let received = false; let sourceRequest = 0;
    const receive = (value: EnvelopeBatchView, select: boolean): void => { setView(value); setLatest(value); if (select && value.kind === 'ALL_STATS' && value.status === 'COMPLETED') onSelectSource(value.id); };
    void restoreEnvelopeBatch(kind).then(saved => { if (saved && mounted.current && !received && request.current === 0) receive(saved, !selectedSource); }).catch(failure => { if (mounted.current) setError(String(failure)); });
    const refreshSources = async (preferred?: string): Promise<void> => {
      const current = ++sourceRequest;
      try { const value = await loadEnvelopeBatchHistory('ALL_STATS'); if (mounted.current && current === sourceRequest) { setSources(value); const chosen = preferred ?? selectedSource; if (value.some(item => item.id === chosen)) { if (preferred) onSelectSource(chosen); } else if (value.length) onSelectSource(value[0]!.id); } }
      catch { if (mounted.current && current === sourceRequest) setError('전체통계 이력을 불러오지 못했습니다.'); }
    };
    if (kind === 'VIRTUAL') void refreshSources();
    const unsubscribeSources = kind === 'VIRTUAL' ? subscribeEnvelopeBatch('ALL_STATS', event => { if (event.type === 'UPDATE' && event.view.status === 'COMPLETED') void refreshSources(event.view.id); }) : () => {};
    const unsubscribe = subscribeEnvelopeBatch(kind, event => { received = true; if (event.type === 'UPDATE') receive(event.view, true); else if (event.type === 'ERROR') setError(event.message); else setRunning(false); });
    return () => { mounted.current = false; unsubscribe(); unsubscribeSources(); };
  }, [kind, onSelectSource]);
  const start = (resume = false): void => {
    try { if (!resume && kind === 'ALL_STATS') validateSearch(settings); if (!resume && kind === 'VIRTUAL' && !selectedSource) throw new Error('완료된 전체통계 결과를 먼저 선택해 주세요.');
      startEnvelopeBatch(kind, settings, resume ? latest?.id : undefined, selectedSource); request.current += 1; setHistoryOpen(false); setError(null); setRunning(true); if (!resume) setView(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '분석을 시작하지 못했습니다.'); }
  };
  const toggleHistory = async (): Promise<void> => {
    if (historyOpen) { setHistoryOpen(false); return; } setLoading(true); setError(null);
    try { const entries = await loadEnvelopeBatchHistory(kind); if (mounted.current) { setHistory(entries); setHistoryOpen(true); } }
    catch { if (mounted.current) setError('이력을 불러오지 못했습니다.'); } finally { if (mounted.current) setLoading(false); }
  };
  const openHistory = async (id: string): Promise<void> => {
    setLoading(true); request.current += 1;
    try { const saved = await loadEnvelopeBatchReport(id); if (!saved) throw new Error('저장된 결과가 없거나 보관 기간이 지났습니다.');
      if (!mounted.current) return; setView(envelopeBatchView(saved)); setHistoryOpen(false); setError(null); setLimit(30); onRestore(saved.settings); if (saved.kind === 'ALL_STATS') onSelectSource(id); else if (saved.sourceId) onSelectSource(saved.sourceId);
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '이력을 불러오지 못했습니다.'); } finally { if (mounted.current) setLoading(false); }
  };
  const openSetting = async (symbol: string): Promise<void> => {
    if (!view) return; setLoading(true);
    try { const report = await loadEnvelopeBatchReport(view.id); const row = report?.rows.find(value => value.symbol === symbol);
      if (!report || !row?.best || !row.risk) throw new Error('저장된 최적 세팅을 찾지 못했습니다.');
      if (mounted.current) onChoose({ ...report.settings, mode: 'SINGLE', symbol: symbol.replace(/USDT$/, ''), interval: row.best.interval, envelopeMaPeriod: String(row.best.maPeriod), envelopeDeviationPercent: String(row.best.deviationPercent), envelopeExitMode: row.best.exitMode, leverage: String(row.best.leverage), envelopeRisk: row.risk });
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '설정을 불러오지 못했습니다.'); } finally { if (mounted.current) setLoading(false); }
  };
  const sorted = [...(view?.rows ?? [])].sort((a, b) => (b.best?.returnPercent ?? -Infinity) - (a.best?.returnPercent ?? -Infinity));
  const source = sources.find(value => value.id === selectedSource);
  return <section className="surface-card form-card envelope-batch" aria-label={label}>
    {kind === 'VIRTUAL' ? <><label className="field-label">전체통계 결과 선택<select value={selectedSource} disabled={busy || loading} onChange={event => onSelectSource(event.target.value)}><option value="">완료된 전체통계를 선택하세요</option>{sources.map(item => <option key={item.id} value={item.id}>{new Date(item.at).toLocaleString('ko-KR')} · {item.optimized}/{item.symbols}종목 · {item.settings.startDate}~{item.settings.endDate}</option>)}</select></label>
      {!sources.length ? <p className="notice">전체통계분석을 먼저 완료해야 가상매매를 실행할 수 있습니다.</p> : null}
      {source ? <p className="muted small">초기자금 {source.settings.initialCapitalUsdt} USDT · 종목당 고정 베팅 {source.settings.betAmountUsdt} USDT · {source.settings.startDate} {source.settings.startTime} ~ {source.settings.endDate} {source.settings.endTime}</p> : null}
      <p className="notice">동일 기간에서 고른 최적값을 다시 사용하는 사후 분석입니다. 미래 성과 검증이 아닙니다. 15분봉으로 중심선 주기를 유지해 시간순으로 재검증하고 모든 종목이 한 계좌의 자금을 공유하므로 개별 수익률 합계와 다릅니다.</p></> : null}
    <button className="primary-button" type="button" disabled={busy || loading || kind === 'VIRTUAL' && !selectedSource} onClick={() => start()}>{running ? `${label} 진행 중` : `${label} 분석 시작`}</button>
    {running ? <button className="danger-button" type="button" onClick={pauseEnvelopeBatch}>{label} 일시정지</button> : null}
    {!running && latest?.status === 'PAUSED' ? <button className="outline-button" type="button" disabled={busy || loading} onClick={() => start(true)}>{label} 이어하기</button> : null}
    <button className="outline-button" type="button" disabled={busy || loading} aria-expanded={historyOpen} onClick={() => { void toggleHistory(); }}>{historyOpen ? `${label} 이력 닫기` : `${label} 이력보기`}</button>
    {historyOpen ? <div className="history-list">{history.length ? history.map(item => <button className="history-card" type="button" key={item.id} onClick={() => { void openHistory(item.id); }} disabled={loading}><strong>{item.settings.startDate} ~ {item.settings.endDate} · {item.kind === 'ALL_STATS' ? `${item.optimized}/${item.symbols}종목` : `${num(item.returnPercent)}%`}</strong><small>{new Date(item.at).toLocaleString('ko-KR')}</small></button>) : <p className="muted">{label} 이력이 없습니다.</p>}</div> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
    {view ? <><h2>{label} {view.status === 'COMPLETED' ? '결과' : view.status === 'PAUSED' ? '일시정지' : '진행 중'}</h2><p className="muted small">{view.settings.startDate} {view.settings.startTime} ~ {view.settings.endDate} {view.settings.endTime} (한국시간)</p>
      {view.status !== 'COMPLETED' ? <ProgressBar completed={view.completed} total={view.total} label={view.message} /> : <p className="notice">{view.message}</p>}
      {view.status === 'PAUSED' ? <p className="notice">{view.message}</p> : null}
      {kind === 'ALL_STATS' ? <><p className="muted small">종목별 최고 수익률 세팅 1개만 표시합니다. 비교 자금은 종목별로 독립적이며 수익률을 합산하지 않습니다. 지원 불가·체결 없음도 별도로 표시합니다. 최적 세팅은 기기에 저장됩니다.</p><div className="envelope-stat-rows">{sorted.slice(0, limit).map(row => <button className="envelope-stat-row" key={row.symbol} type="button" disabled={busy || loading || view.status !== 'COMPLETED' || !row.best} onClick={() => { void openSetting(row.symbol); }}><strong>{row.symbol} <span className={(row.best?.returnPercent ?? 0) >= 0 ? 'long-text' : 'short-text'}>{row.best ? `${num(row.best.returnPercent)}%` : row.status === 'NO_TRADES' ? '체결 없음' : '지원 불가'}</span></strong>{row.best ? <><span>{row.best.interval} · SMA{row.best.maPeriod} · 이격 {row.best.deviationPercent}% · {row.best.leverage}배</span><span>{envelopeExitLabels[row.best.exitMode]} · 순손익 {num(row.best.profitUsdt)} USDT · 승률 {num(row.best.winRatePercent)}%</span><small>개별분석에 이 세팅 불러오기 ›</small></> : <span>{row.message ?? '기간 내 진입 가능한 세팅이 없습니다.'}</span>}</button>)}</div>{sorted.length > limit ? <button className="outline-button" type="button" onClick={() => setLimit(value => value + 30)}>종목 더 보기 ({Math.min(limit, sorted.length)}/{sorted.length})</button> : null}</> : null}
      {kind === 'VIRTUAL' && view.result ? <div className="virtual-results" aria-label="가상매매 결과"><div className="result-heading"><h2>공유 계좌 수익률</h2><strong className={`big-number ${view.result.returnPercent >= 0 ? 'positive' : 'negative'}`}>{num(view.result.returnPercent)}%</strong></div><div className="metric-grid">
        <div><span>최종 평가금액</span><strong>{num(view.result.finalEquityUsdt)} USDT</strong></div><div><span>실현 손익</span><strong>{num(view.result.realizedProfitUsdt)} USDT</strong></div><div><span>승률</span><strong>{num(view.result.winRatePercent)}%</strong></div><div><span>진입 · 청산</span><strong>{view.result.entryCount} · {view.result.closedTradeCount}</strong></div><div><span>최대 낙폭</span><strong>{num(view.result.maxDrawdownPercent)}%</strong></div><div><span>미청산</span><strong>{view.result.openPositionCount}</strong></div>
      </div><p className="muted small">적용 종목 {view.rows.length}개 · 수수료 {num(view.result.feesUsdt)} USDT · 자금 부족 {view.result.insufficientFundsCount}회 · 추정 LIQ {view.result.exitReasons.LIQ ?? 0}회</p><p className="muted small">시가 갭이 SL·LIQ를 모두 넘으면 남은 격리 증거금을 소진하는 추정 청산으로 처리합니다. 실제 거래소 체결가를 재현한 것은 아닙니다.</p></div> : null}
    </> : null}
  </section>;
}

function StatisticsPage({ all, onChoose, selectedSource, onSelectSource }: { all: boolean; onChoose: (settings: BacktestSettings) => void; selectedSource: string; onSelectSource: (id: string) => void }) {
  const id = all ? 'ALL_STATS' : 'SINGLE_STATS'; const [settings, setSettings] = useState(() => readSettings(id)); const busy = useAnalysisBusy(); const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<EnvelopeBatchKind>('ALL_STATS');
  const update = (next: BacktestSettings): void => { const value = { ...next, mode: all ? 'ALL' as const : 'SINGLE' as const }; setSettings(value); storeSettings(id, value); };
  return <div className="strategy-content envelope-statistics-page">
    {all ? <div className="segmented"><button type="button" className={kind === 'ALL_STATS' ? 'selected' : ''} onClick={() => setKind('ALL_STATS')}>전체통계분석</button><button type="button" className={kind === 'VIRTUAL' ? 'selected' : ''} onClick={() => setKind('VIRTUAL')}>가상매매</button></div> : null}
    {!all || kind === 'ALL_STATS' ? <SearchFields settings={settings} onChange={update} disabled={busy || loading} single={!all} /> : null}
    {all ? <BatchPanel key={kind} kind={kind} settings={settings} onRestore={update} selectedSource={selectedSource} onSelectSource={onSelectSource} onChoose={onChoose} /> : <section className="surface-card form-card"><EnvelopeStatisticsPanel settings={settings} disabled={busy} validate={() => validateSearch(settings)} onBusyChange={setLoading} onChoose={(next, source) => { if (source === 'history') update(next); else onChoose(next); }} /></section>}
  </div>;
}

export function EnvelopeWorkspace({ context }: { context: ApiContext }) {
  const [preset, setPreset] = useState<BacktestSettings>();
  const [view, setView] = useState<View>(() => { try { const saved = localStorage.getItem('zetaauto.web.envelope.view'); return views.some(item => item.id === saved) ? saved as View : 'SINGLE'; } catch { return 'SINGLE'; } });
  const [source, setSource] = useState(() => { try { return localStorage.getItem('zetaauto.web.envelope.selectedAllStatistics') ?? ''; } catch { return ''; } });
  const selectSource = useCallback((id: string) => { setSource(id); try { localStorage.setItem('zetaauto.web.envelope.selectedAllStatistics', id); } catch { /* Optional preference. */ } }, []);
  const navigate = (next: View): void => { setPreset(undefined); setView(next); try { localStorage.setItem('zetaauto.web.envelope.view', next); } catch { /* Optional preference. */ } };
  const choose = (settings: BacktestSettings): void => { const selected = { ...settings, mode: 'SINGLE' as const }; saveSettings('ENVELOPE', selected); navigate('SINGLE'); setPreset(selected); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  return <main className="screen"><div className="content strategy-content envelope-workspace"><header className="page-header strategy-header"><div><p className="eyebrow">ENVELOPE · BACKTEST</p><h1>엔벨로프 백테스트</h1></div></header>
    <h2>분석 대상</h2><div className="segmented four envelope-mode-tabs" role="group" aria-label="엔벨로프 분석 대상">{views.map(item => <button key={item.id} type="button" aria-pressed={view === item.id} className={view === item.id ? 'selected' : ''} onClick={() => navigate(item.id)}>{item.label}</button>)}</div>
    {view === 'SINGLE' || view === 'ALL' ? <StrategyBacktest key={view} strategy="ENVELOPE" context={context} embedded forcedMode={view} preferredSettings={view === 'SINGLE' ? preset : undefined} /> : <StatisticsPage key={view} all={view === 'ALL_STATS'} onChoose={choose} selectedSource={source} onSelectSource={selectSource} />}
  </div></main>;
}
