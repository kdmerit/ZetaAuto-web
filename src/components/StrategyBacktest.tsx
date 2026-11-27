import { useEffect, useMemo, useRef, useState } from 'react';

import type { ApiContext } from '../api';
import { chartForLocalTrade, isLocalBacktestRunning, pauseLocalBacktest, restoreLocalBacktest, startLocalBacktest, subscribeLocalBacktest } from '../localBacktest';
import { canResumeLocalJob, loadLocalResult, skipsSingleSlippage, type LocalJobView } from '../localJobs';
import { estimateBars } from '../engine';
import {
  loadBacktestHistory,
  loadCachedResult,
  loadSettings,
  saveCachedResult,
  saveSettings,
  type BacktestHistoryEntry,
} from '../storage';
import type { BacktestInterval, BacktestResult, BacktestSettings, BacktestTrade, ChartData, Strategy } from '../types';
import { chartTimestamp, mergeChartPages } from '../chartData';
import { chartAtInterval, withChartExecutionTimes } from '../chartIntervals';
import { currentMaDisparitySettings, maDisparityRules, maDisparitySummary } from '../maDisparity';
import { formatBacktestHistorySettings } from '../backtestHistory';
import { useAnalysisBusy } from '../analysisActivity';
import { useBacktestScreenWakeLock } from '../screenWakeLock';
import { ChartModal } from './ChartModal';
import { ProgressBar } from './ProgressBar';

const activeStrategy: Strategy = 'MA_DISPARITY';

interface StrategyBacktestProps {
  /** The active backtest screen has one strategy only. */
  strategy: 'MA_DISPARITY';
  context: ApiContext;
}

/** Previous calendar month in Korean time, clamped to that month's last day. */
function defaultStartDate(): string {
  const today = new Date(Date.now() + 9 * 3_600_000);
  const previousMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
  previousMonth.setUTCDate(Math.min(today.getUTCDate(), previousMonth.getUTCDate()));
  return previousMonth.toISOString().slice(0, 10);
}

/**
 * The form exposes only the active disparity strategy. Optional legacy fields
 * stay in the snapshot so old local history and worker checkpoints remain
 * readable without bringing their screens back into the application.
 */
export function defaultSettings(_strategy?: Strategy): BacktestSettings {
  return {
    mode: 'SINGLE',
    symbol: 'BTC',
    interval: '1d',
    startDate: defaultStartDate(),
    startTime: '00:00',
    endDate: '',
    endTime: '00:00',
    initialCapitalUsdt: '1000',
    betAmountUsdt: '100',
    leverage: '1',
    side: 'BOTH',
    partialTpEnabled: false,
    fullTpWavePercent: '100',
    minDisparityPercent: '1.0',
    ma20HalfCloseEnabled: false,
    roiClosePercent: '100',
    minVolatilityPercent: '0.5',
    volatilityK1: '0.5',
    volatilityK2: '1.0',
    volatilityTpEnabled: true,
    volatilityNextCloseEnabled: false,
    volatilityMa10Enabled: false,
    volatilityMa10DistancePercent: '1',
    volatilityMa60Enabled: false,
    volatilityMa60BelowEnabled: false,
    envelopeDeviationPercent: '3',
    atrEnvelope: { emaPeriod: '3', atrPeriod: '3', atrMultiplier: '0.5' },
    atrEnvelopeStopMultiplier: '0.5',
    envelopeStopLossPercent: '3',
    envelopeTakeProfitEnabled: false,
    envelopeTakeProfitPercent: '6',
    envelopeTrailingStopEnabled: false,
    envelopeTrailingStopPercent: '3',
    envelopeCloseOnlyEntryEnabled: false,
    envelopeHalfCandleEnabled: true,
    envelopeCandleFilterEnabled: false,
    envelopeExitMode: 'OPPOSITE',
    envelopeMaPeriod: '20',
    envelopeStatisticsInterval: '1d',
    envelopeMoveSlOnCenter: false,
    envelopeEntryMode: 'BAND_TOUCH',
    envelopeMa20Enabled: false,
    envelopeMa20BelowEnabled: false,
    envelopeCloseOnConfirmedBreakout: false,
    envelopeCloseOnCenterTouch: false,
    envelopeCloseOnCenterReturn: false,
    envelopeSideRatio50Enabled: false,
    envelopeDailyTrend: false,
    referenceTpPercent: '80',
    referenceMa10Enabled: false,
  };
}

export function formatDateInput(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  return digits.length <= 4
    ? digits
    : digits.length <= 6
      ? `${digits.slice(0, 4)}-${digits.slice(4)}`
      : `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
}

export function formatTimeInput(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 4);
  return digits.length <= 2 ? digits : `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

function baseSymbol(value: string): string {
  return value.toUpperCase().replace(/USDT/g, '').replace(/[^A-Z0-9]/g, '').slice(0, 36);
}

function money(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function percent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(2)}%`;
}

const reasonLabels: Record<string, string> = {
  SL: 'SL',
  LIQ: '격리 LIQ 추정 청산',
  MA60_TOUCH: 'MA60 접촉 청산',
  SESSION_CLOSE: '신호 캔들 마감 청산',
};

function historyScopeSymbol(settings: BacktestSettings): string {
  return settings.mode === 'ALL' ? 'ALL' : baseSymbol(settings.symbol);
}

export function StrategyBacktest({ context: _context, strategy: _strategy }: StrategyBacktestProps) {
  const defaults = useMemo(() => defaultSettings(activeStrategy), []);
  const [settings, setSettings] = useState<BacktestSettings>(() => currentMaDisparitySettings(loadSettings(activeStrategy, defaults)));
  const [result, setResult] = useState<BacktestResult | null>(() => loadCachedResult(activeStrategy));
  const [progress, setProgress] = useState({ phase: '대기 중', completed: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(() => isLocalBacktestRunning(activeStrategy));
  const [localJob, setLocalJob] = useState<LocalJobView | null>(null);
  const [chart, setChart] = useState<ChartData | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [selectedTrade, setSelectedTrade] = useState<BacktestTrade | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);
  const [chartError, setChartError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<BacktestHistoryEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const requestRef = useRef(0);
  const chartHistoryPushed = useRef(false);
  const chartRequestRef = useRef(0);
  const olderRequestRef = useRef(false);
  const analysisSettingsRef = useRef(settings);
  const anyAnalysisBusy = useAnalysisBusy();

  useBacktestScreenWakeLock(running || localJob?.status === 'RUNNING');

  useEffect(() => {
    const requestId = ++requestRef.current;
    const stored = currentMaDisparitySettings(loadSettings(activeStrategy, defaults));
    analysisSettingsRef.current = stored;
    setSettings(stored);
    setResult(loadCachedResult(activeStrategy));
    setChart(null);
    setHistoryOpen(false);
    setHistoryEntries([]);
    setError(null);
    setLocalJob(null);
    setRunning(isLocalBacktestRunning(activeStrategy));

    const receive = (view: LocalJobView): void => {
      if (view.settings.mode !== stored.mode && view.status !== 'COMPLETED') return;
      const snapshot = { ...defaults, ...view.settings };
      analysisSettingsRef.current = snapshot;
      setLocalJob(view);
      if (view.result) setResult(view.result);
      if (view.status !== 'COMPLETED') setSettings(currentMaDisparitySettings(snapshot));
      setRunning(view.status === 'RUNNING' && isLocalBacktestRunning(activeStrategy));
      setProgress({ phase: view.progressLabel, completed: view.completed, total: view.total });
      setNotice(view.message);
      if (view.status === 'PAUSED' && view.message && !view.message.startsWith('분석을 일시정지')) setError(view.message);
    };
    const unsubscribe = subscribeLocalBacktest(activeStrategy, event => {
      if (event.type === 'UPDATE') receive(event.view);
      else if (event.type === 'ERROR') { setError(event.message); setRunning(false); }
      else setRunning(event.type === 'START');
    });
    void restoreLocalBacktest(activeStrategy).then(local => {
      if (requestId !== requestRef.current) return;
      if (local) receive(local);
    }).catch(() => undefined);
    return () => { unsubscribe(); requestRef.current += 1; };
  }, [defaults]);

  useEffect(() => {
    const refreshSharedStorage = (): void => {
      if (document.visibilityState === 'hidden' || running) return;
      const shared = currentMaDisparitySettings(loadSettings(activeStrategy, defaults));
      setSettings(current => JSON.stringify(current) === JSON.stringify(shared) ? current : shared);
      if (historyOpen) setHistoryEntries(loadBacktestHistory(activeStrategy, shared.mode, historyScopeSymbol(shared)));
    };
    window.addEventListener('storage', refreshSharedStorage);
    window.addEventListener('focus', refreshSharedStorage);
    document.addEventListener('visibilitychange', refreshSharedStorage);
    return () => {
      window.removeEventListener('storage', refreshSharedStorage);
      window.removeEventListener('focus', refreshSharedStorage);
      document.removeEventListener('visibilitychange', refreshSharedStorage);
    };
  }, [defaults, historyOpen, running]);

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (event.state?.zetaautoChart) return;
      if (!chartHistoryPushed.current) return;
      chartHistoryPushed.current = false;
      chartRequestRef.current += 1;
      setChart(null);
      setSelectedTrade(null);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (!chart || chartHistoryPushed.current) return;
    const currentState = window.history.state;
    const baseState = currentState && typeof currentState === 'object' ? currentState : {};
    window.history.pushState({ ...baseState, zetaautoChart: true }, '');
    chartHistoryPushed.current = true;
  }, [chart]);

  useEffect(() => () => {
    if (!chartHistoryPushed.current) return;
    chartHistoryPushed.current = false;
    window.history.back();
  }, []);

  const update = <K extends keyof BacktestSettings>(key: K, value: BacktestSettings[K]): void => {
    const next = currentMaDisparitySettings({ ...settings, [key]: value });
    setSettings(next);
    analysisSettingsRef.current = next;
    saveSettings(activeStrategy, next);
  };

  const validate = (): void => {
    if (settings.mode === 'SINGLE' && !baseSymbol(settings.symbol)) throw new Error('종목명을 입력해 주세요.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(settings.startDate) || !/^\d{2}:\d{2}$/.test(settings.startTime)) throw new Error('시작일·시간을 확인해 주세요.');
    if (settings.endDate && (!/^\d{4}-\d{2}-\d{2}$/.test(settings.endDate) || !/^\d{2}:\d{2}$/.test(settings.endTime))) throw new Error('종료일·시간을 확인해 주세요.');
    if (!/^\d+(\.\d{1,2})?$/.test(settings.initialCapitalUsdt) || Number(settings.initialCapitalUsdt) < 10) throw new Error('초기자금을 확인해 주세요.');
    if (!/^\d+(\.\d{1,2})?$/.test(settings.betAmountUsdt) || Number(settings.betAmountUsdt) < 1 || Number(settings.betAmountUsdt) > Number(settings.initialCapitalUsdt)) throw new Error('고정 베팅액을 확인해 주세요.');
    if (!/^\d{1,4}(\.\d{1,2})?$/.test(settings.leverage) || Number(settings.leverage) < 1 || Number(settings.leverage) > 100) throw new Error('레버리지는 1~100배로 입력해 주세요.');
    const start = Date.parse(`${settings.startDate}T${settings.startTime}:00+09:00`);
    const end = settings.endDate ? Date.parse(`${settings.endDate}T${settings.endTime}:00+09:00`) : Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start > Date.now()) throw new Error('분석 기간을 확인해 주세요.');
  };

  const run = (resume = false): void => {
    try {
      if (!resume) validate();
      const snapshot = currentMaDisparitySettings(resume && localJob ? localJob.settings : settings);
      analysisSettingsRef.current = snapshot;
      saveSettings(activeStrategy, snapshot);
      setError(null);
      setNotice('저장된 캔들을 확인하며 이 기기에서 분석합니다.');
      setResult(null);
      setHistoryOpen(false);
      setHistoryEntries([]);
      setChart(null);
      startLocalBacktest(activeStrategy, snapshot, resume ? localJob?.id : undefined);
      if (!resume) setLocalJob(null);
      setSettings(snapshot);
      setRunning(true);
      setProgress({ phase: '분석 준비', completed: 0, total: 1 });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '입력값을 확인해 주세요.');
    }
  };

  const cancel = (): void => {
    if (!isLocalBacktestRunning(activeStrategy)) return;
    setNotice('현재까지의 진행 상태를 저장하고 있습니다.');
    pauseLocalBacktest(activeStrategy);
  };

  const toggleHistory = (): void => {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setHistoryEntries(loadBacktestHistory(activeStrategy, settings.mode, historyScopeSymbol(settings)));
    setHistoryOpen(true);
  };

  const openHistory = async (entry: BacktestHistoryEntry): Promise<void> => {
    const requestId = ++requestRef.current;
    try {
      const restored = entry.localRunId ? (await loadLocalResult(entry.localRunId))?.result : entry.result;
      if (!restored) throw new Error('저장된 분석 결과를 찾지 못했습니다. 다시 분석해 주세요.');
      if (requestId !== requestRef.current) return;
      const snapshot = currentMaDisparitySettings({ ...defaults, ...entry.settings });
      analysisSettingsRef.current = snapshot;
      setSettings(snapshot);
      saveSettings(activeStrategy, snapshot);
      saveCachedResult(activeStrategy, restored);
      setResult(restored);
      setLocalJob(null);
      setHistoryOpen(false);
      setHistoryEntries([]);
      setChart(null);
      setSelectedTrade(null);
      setError(null);
      setNotice('저장된 분석 이력을 불러왔습니다.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '이력을 불러오지 못했습니다.');
    }
  };

  const openTrade = async (trade: BacktestTrade): Promise<void> => {
    const requestId = ++chartRequestRef.current;
    setSelectedTrade(trade);
    setChartLoading(true);
    setChartError(null);
    setHasOlder(true);
    setError(null);
    try {
      if (!result) throw new Error('분석 결과를 찾지 못했습니다.');
      const next = await chartForLocalTrade(result, trade, analysisSettingsRef.current);
      if (requestId === chartRequestRef.current) setChart(withChartExecutionTimes(next, trade));
    } catch (failure) {
      if (requestId === chartRequestRef.current) setChartError(failure instanceof Error ? failure.message : '차트 조회에 실패했습니다.');
    } finally {
      if (requestId === chartRequestRef.current) setChartLoading(false);
    }
  };

  const loadOlder = async (): Promise<boolean> => {
    if (!chart || !selectedTrade || olderRequestRef.current || !hasOlder || !result) return false;
    const oldest = chart.candles[0]?.openTime;
    if (!oldest || !Number.isFinite(oldest)) return false;
    const requestId = chartRequestRef.current;
    olderRequestRef.current = true;
    setLoadingOlder(true);
    setChartError(null);
    try {
      const older = chart.interval !== analysisSettingsRef.current.interval
        ? await chartAtInterval(chart, chart.interval, { beforeAt: oldest })
        : await chartForLocalTrade(result, selectedTrade, analysisSettingsRef.current, oldest);
      if (!older || requestId !== chartRequestRef.current) return false;
      const merged = mergeChartPages(withChartExecutionTimes(older, selectedTrade), chart);
      if (merged.candles.length <= chart.candles.length) {
        setHasOlder(false);
        return false;
      }
      setChart(merged);
      return true;
    } catch (failure) {
      if (requestId === chartRequestRef.current) setChartError(failure instanceof Error ? failure.message : '과거 캔들을 불러오지 못했습니다.');
      return false;
    } finally {
      olderRequestRef.current = false;
      setLoadingOlder(false);
    }
  };

  const focusChartCandle = async (openTime: number): Promise<number | null> => {
    if (!chart || !selectedTrade || olderRequestRef.current || !result) return null;
    const currentCandle = chart.candles.find(candle => candle.openTime <= openTime && openTime < candle.closeTime);
    if (currentCandle) return currentCandle.openTime;
    if (![...chart.markers, ...(chart.executions ?? [])].some(fill => (fill.kind === 'ENTRY' || fill.kind === 'CLOSE') && fill.openTime === openTime)) return null;
    const requestId = ++chartRequestRef.current;
    olderRequestRef.current = true;
    setLoadingOlder(true);
    setChartError(null);
    try {
      const next = chart.interval !== analysisSettingsRef.current.interval
        ? await chartAtInterval(chart, chart.interval, { focusAt: openTime })
        : await chartForLocalTrade(result, selectedTrade, analysisSettingsRef.current, undefined, openTime);
      if (requestId !== chartRequestRef.current) return null;
      const focusedCandle = next?.candles.find(candle => candle.openTime <= openTime && openTime < candle.closeTime);
      if (!next || !focusedCandle) throw new Error('해당 체결 시점의 캔들을 불러오지 못했습니다. 다시 눌러 주세요.');
      setChart(withChartExecutionTimes(next, selectedTrade));
      setHasOlder(true);
      return focusedCandle.openTime;
    } catch (failure) {
      if (requestId === chartRequestRef.current) setChartError(failure instanceof Error ? failure.message : '체결 캔들을 불러오지 못했습니다.');
      return null;
    } finally {
      olderRequestRef.current = false;
      setLoadingOlder(false);
    }
  };

  const changeChartInterval = async (interval: BacktestInterval, focusAt: number): Promise<number | null> => {
    if (!chart || olderRequestRef.current) return null;
    const requestId = ++chartRequestRef.current;
    olderRequestRef.current = true;
    setLoadingOlder(true);
    setChartError(null);
    try {
      const next = await chartAtInterval(chart, interval, { focusAt });
      if (requestId !== chartRequestRef.current) return null;
      setChart(next);
      setHasOlder(true);
      return chartTimestamp(next.referenceAt);
    } catch (failure) {
      if (requestId === chartRequestRef.current) setChartError(failure instanceof Error ? failure.message : '차트 주기를 변경하지 못했습니다.');
      return null;
    } finally {
      olderRequestRef.current = false;
      setLoadingOlder(false);
    }
  };

  const closeChart = (): void => {
    const hadHistoryEntry = chartHistoryPushed.current;
    chartRequestRef.current += 1;
    chartHistoryPushed.current = false;
    setChart(null);
    setSelectedTrade(null);
    if (hadHistoryEntry) window.history.back();
  };

  const resultTrades = result?.recentTrades ? [...result.recentTrades].reverse() : [];
  const currentHistorySymbol = historyScopeSymbol(settings);
  const historyLabel = settings.mode === 'ALL' ? '전체종목 이력보기' : `${currentHistorySymbol || '종목'} 이력보기`;

  return (
    <main className="screen">
      <div className="content strategy-content">
        <header className="page-header strategy-header"><div><p className="eyebrow">MA DISPARITY · BACKTEST</p><h1>이격매매 백테스트</h1></div></header>
        <button className="outline-button detail-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '상세설명접기' : '상세설명보기'}</button>
        {expanded ? <section className="surface-card condition-card"><h3>검색 조건</h3><div className="condition-copy">
          <strong>롱 포지션</strong>{maDisparityRules.long.map((text, index) => <p key={text}>{index + 1}. {text}</p>)}
          <strong>숏 포지션</strong>{maDisparityRules.short.map((text, index) => <p key={text}>{index + 1}. {text}</p>)}
          <strong>공통 체결 기준</strong><p>{maDisparityRules.common}</p>
        </div></section> : null}

        <section className="surface-card form-card">
          <fieldset className="analysis-fields" disabled={running || anyAnalysisBusy}>
            <h2>분석 대상</h2>
            <div className="segmented">{(['SINGLE', 'ALL'] as const).map(mode => <button key={mode} type="button" className={settings.mode === mode ? 'selected' : ''} onClick={() => update('mode', mode)}>{mode === 'SINGLE' ? '개별 종목' : '전체 종목'}</button>)}</div>
            <p className="muted small">저장된 캔들을 우선 사용하고 없는 구간만 조회합니다. 개별 종목은 슬리피지 필터 없이 분석합니다.</p>
            {settings.mode === 'SINGLE' ? <label className="field-label">종목명<span className="suffix-field"><input value={baseSymbol(settings.symbol)} onChange={event => update('symbol', baseSymbol(event.target.value))} placeholder="BTC" /><b>USDT</b></span></label> : null}
            <h2>분석 방향</h2>
            <div className="segmented three">{(['BOTH', 'LONG', 'SHORT'] as const).map(side => <button key={side} type="button" className={settings.side === side ? 'selected' : ''} onClick={() => update('side', side)}>{side === 'BOTH' ? '롱 + 숏' : side === 'LONG' ? '롱' : '숏'}</button>)}</div>
            <h2>캔들 주기</h2>
            <div className="segmented interval-selector">{(['1h', '4h', '1d'] as const).map(interval => <button key={interval} type="button" className={settings.interval === interval ? 'selected' : ''} onClick={() => update('interval', interval)}>{interval.toUpperCase()}</button>)}</div>
            <h2>분석 기간 (한국시간)</h2>
            <div className="field-grid two">
              <label className="field-label">시작일<input inputMode="numeric" value={settings.startDate} onChange={event => update('startDate', formatDateInput(event.target.value))} placeholder="2026-01-01" /></label>
              <label className="field-label">시작시간<input inputMode="numeric" value={settings.startTime} onChange={event => update('startTime', formatTimeInput(event.target.value))} placeholder="00:00" /></label>
              <label className="field-label">종료일 (선택)<input inputMode="numeric" value={settings.endDate} onChange={event => update('endDate', formatDateInput(event.target.value))} placeholder="현재까지" /></label>
              <label className="field-label">종료시간<input inputMode="numeric" value={settings.endTime} onChange={event => update('endTime', formatTimeInput(event.target.value))} placeholder="00:00" /></label>
            </div>
            <div className="field-grid three">
              <label className="field-label">가상 초기자금<input inputMode="decimal" value={settings.initialCapitalUsdt} onChange={event => update('initialCapitalUsdt', event.target.value)} /></label>
              <label className="field-label">고정 베팅액<input inputMode="decimal" value={settings.betAmountUsdt} onChange={event => update('betAmountUsdt', event.target.value)} /></label>
              <label className="field-label">레버리지<input inputMode="decimal" value={settings.leverage} onChange={event => update('leverage', event.target.value)} /><small>1~100배</small></label>
            </div>
            <p className="muted small">{maDisparitySummary}</p>
          </fieldset>
          <div className="action-row"><button className="primary-button" type="button" disabled={running || anyAnalysisBusy} onClick={() => run()}>{running ? '분석 진행 중' : localJob?.status === 'PAUSED' ? '새 분석 시작' : '분석 시작'}</button>{running ? <button className="danger-button" type="button" onClick={cancel}>분석 일시정지</button> : null}</div>
          {!running && localJob?.status === 'PAUSED' && canResumeLocalJob(localJob) ? <button className="outline-button" type="button" onClick={() => run(true)}>분석 이어하기</button> : null}
          {localJob && localJob.status !== 'COMPLETED' ? <p className="muted small">화면을 끄거나 탭을 닫으면 분석이 정지될 수 있습니다. 다시 열어 ‘분석 이어하기’를 누르면 저장된 지점부터 계속합니다.</p> : null}
          <button className="outline-button history-toggle" type="button" disabled={running || anyAnalysisBusy} aria-expanded={historyOpen} onClick={toggleHistory}>{historyOpen ? '이력 닫기' : historyLabel}</button>
          {historyOpen ? <HistoryList entries={historyEntries} emptyMessage={settings.mode === 'ALL' ? '전체종목 분석 이력이 없습니다.' : `${currentHistorySymbol || '해당 종목'} 분석 이력이 없습니다.`} onOpen={openHistory} /> : null}
          {notice && notice !== error ? <p className="notice">{notice}</p> : null}{error ? <p className="error" role="alert">{error}</p> : null}
          {running || localJob?.status === 'PAUSED' ? <ProgressBar completed={progress.completed} total={progress.total || Math.max(estimateBars(settings), 1)} label={progress.phase} /> : null}
          {localJob ? <p className="muted small">분석 대상 {localJob.universeCount.toLocaleString()}종목{skipsSingleSlippage(localJob) ? ' · 슬리피지 검사 안 함' : ` · 슬리피지 제외 ${localJob.excludedCount.toLocaleString()}종목`}{localJob.failedSymbols.length ? ` · 캔들 누락 제외 ${localJob.failedSymbols.length}종목` : ''}{localJob.status === 'COMPLETED' ? ' · 완료' : localJob.status === 'PAUSED' ? ' · 일시정지' : ''}</p> : null}
        </section>
        {result ? <ResultCard result={result} leverage={settings.leverage} trades={resultTrades} onOpenTrade={trade => void openTrade(trade)} /> : null}
      </div>
      {chartLoading ? <div className="modal-backdrop"><div className="loading-card">체결 차트를 불러오는 중입니다…</div></div> : null}
      {chart ? <ChartModal chart={chart} onClose={closeChart} onLoadOlder={selectedTrade && hasOlder ? loadOlder : undefined} onFocusCandle={focusChartCandle} onIntervalChange={changeChartInterval} loadingOlder={loadingOlder} historyError={chartError} /> : null}
    </main>
  );
}

function HistoryList({ entries, emptyMessage, onOpen }: { entries: BacktestHistoryEntry[]; emptyMessage: string; onOpen: (entry: BacktestHistoryEntry) => void }) {
  if (entries.length === 0) return <p className="muted history-empty">{emptyMessage}</p>;
  return <div className="history-list">{entries.map(entry => <button className="history-card" type="button" key={entry.id} onClick={() => onOpen(entry)}>
    <span className="history-card-heading"><strong>{entry.symbol === 'ALL' ? '전체종목' : `${entry.symbol}USDT`}</strong><em className={entry.result.returnPercent >= 0 ? 'positive' : 'negative'}>{percent(entry.result.returnPercent)}</em></span>
    <span className="history-card-settings">{formatBacktestHistorySettings(entry.settings, entry.strategy).map(value => <span className="history-card-setting" key={value}>{value}</span>)}</span>
    <small>저장 {new Date(entry.savedAt).toLocaleDateString('ko-KR')}</small>
  </button>)}</div>;
}

function ResultCard({ result, leverage, trades, onOpenTrade }: { result: BacktestResult; leverage?: string; trades: BacktestTrade[]; onOpenTrade: (trade: BacktestTrade) => void }) {
  const reasonLabel = (trade: BacktestTrade): string => reasonLabels[trade.reason] ?? trade.reason;
  return <section className="surface-card result-card">
    <div className="result-heading"><div><p className="eyebrow">BACKTEST RESULT</p><h2>확보한 구간까지의 성적</h2></div><strong className={result.returnPercent >= 0 ? 'positive big-number' : 'negative big-number'}>{percent(result.returnPercent)}</strong></div>
    <div className="metric-grid"><div><span>최종 평가금액</span><strong>{money(result.finalEquityUsdt)} USDT</strong></div><div><span>실현손익</span><strong>{money(result.realizedProfitUsdt)} USDT</strong></div><div><span>승률</span><strong>{percent(result.winRatePercent)}</strong></div><div><span>진입 · 청산</span><strong>{result.entryCount} · {result.closedTradeCount}</strong></div><div><span>수익 · 손실</span><strong>{result.winCount} · {result.lossCount}</strong></div><div><span>최대 낙폭</span><strong>{percent(result.maxDrawdownPercent)}</strong></div><div><span>레버리지</span><strong>{leverage ? `${leverage}배` : '—'}</strong></div></div>
    <p className="muted small">관찰 캔들 {result.observedBars.toLocaleString()}개 · 수수료 {money(result.feesUsdt)} USDT · 2차 체결 {result.secondFillCount}회</p>
    {result.failedSymbols?.length ? <p className="notice small">캔들 누락으로 제외된 종목 {result.failedSymbols.length}개: {result.failedSymbols.slice(0, 8).join(', ')}{result.failedSymbols.length > 8 ? ' 외' : ''}</p> : null}
    {Object.keys(result.exitReasons).length > 0 ? <div className="reason-list">{Object.entries(result.exitReasons).map(([reason, count]) => <span key={reason}>{reasonLabels[reason] ?? reason} {count}</span>)}</div> : null}
    {trades.length > 0 ? <div className="trade-list"><h3>최근 청산 내역 (최대 100건)</h3>{trades.slice(0, 100).map(trade => <button className="trade-row" type="button" key={trade.tradeId} onClick={() => onOpenTrade(trade)}><strong>{trade.symbol} · {trade.side === 'LONG' ? '롱' : '숏'} · {reasonLabel(trade)}</strong><span>{new Date(trade.entryAt * 1000).toLocaleString('ko-KR')} 진입</span><span>{new Date(trade.exitAt * 1000).toLocaleString('ko-KR')} 청산</span><span>베팅 금액 {money(trade.betAmountUsdt ?? result.betAmountUsdt)} USDT</span><em className={trade.netProfitUsdt >= 0 ? 'positive' : 'negative'}>청산 손익 {money(trade.netProfitUsdt)} USDT · 체결 차트 보기 ›</em></button>)}</div> : <p className="muted">아직 청산된 거래가 없습니다.</p>}
  </section>;
}
