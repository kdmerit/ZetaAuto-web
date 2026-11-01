import { useEffect, useMemo, useRef, useState } from 'react';

import {
  cancelServerBacktest,
  fetchServerChart,
  fetchServerEntryChart,
  getServerBacktest,
  startServerBacktest,
  type ApiContext,
  type BacktestRequestBody,
} from '../api';
import { chartForLocalTrade, isLocalBacktestRunning, pauseLocalBacktest, restoreLocalBacktest, startLocalBacktest, subscribeLocalBacktest } from '../localBacktest';
import { loadLocalResult, engineVersionFor, type LocalJobView } from '../localJobs';
import { estimateBars } from '../engine';
import {
  loadBacktestHistory,
  loadCachedResult,
  loadSettings,
  saveBacktestHistory,
  saveCachedResult,
  saveSettings,
  type BacktestHistoryEntry,
} from '../storage';
import type {
  BacktestResult,
  BacktestSettings,
  BacktestTrade,
  BacktestInterval,
  ChartData,
  ServerJob,
  Strategy,
} from '../types';
import { ChartModal } from './ChartModal';
import { chartTimestamp, mergeChartPages } from '../chartData';
import { chartAtInterval, withChartExecutionTimes } from '../chartIntervals';
import { serverSettingsSnapshot, volatilityParameters } from '../backtestSettings';
import { ProgressBar } from './ProgressBar';
import { envelopeExitLabels, envelopeExitModes, envelopeParameters, envelopePeriods } from '../envelope';
import { isEnvelopeStatisticsRunning } from '../envelopeStatisticsClient';
import { isEnvelopeBatchRunning } from '../envelopeBatchClient';
import { useAnalysisBusy } from '../analysisActivity';

interface StrategyBacktestProps {
  strategy: Strategy;
  context: ApiContext;
  embedded?: boolean;
  forcedMode?: 'SINGLE' | 'ALL';
  preferredSettings?: BacktestSettings;
}

function dateText(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function defaultSettings(): BacktestSettings {
  const start = new Date(Date.now() - 90 * 86_400_000);
  return {
    mode: 'SINGLE',
    symbol: 'BTC',
    interval: '15m',
    startDate: dateText(start),
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
    envelopeDeviationPercent: '0.5',
    envelopeMaPeriod: '20',
    envelopeExitMode: 'CENTER',
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

function toIso(date: string, time: string): string {
  const parsed = new Date(`${date}T${time}:00+09:00`);
  if (!Number.isFinite(parsed.getTime())) throw new Error('날짜·시간을 확인해 주세요.');
  return parsed.toISOString();
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
  PARTIAL_TP: '부분 TP 50%',
  FULL_TP: '전체 TP',
  SL: 'SL',
  LIQ: '격리 LIQ 추정 청산',
  MA60_TOUCH: 'MA60 접촉 청산',
  MA20_HALF_BREAK: '캔들 절반 MA20 청산',
  ROI_LOSS: 'ROI 손실 청산',
  SESSION_CLOSE: '신호 캔들 마감 청산',
  VOLATILITY_CLOSE: '변동폭 K1 종가 청산',
  NEXT_CANDLE_CLOSE: '매수 다음 캔들 종가 청산',
  ENVELOPE_CENTER: '엔벨로프 중심선 청산',
  ENVELOPE_OPPOSITE: '엔벨로프 반대 밴드 청산',
};

function defaultRequest(settings: BacktestSettings, strategy: Strategy): BacktestRequestBody {
  // The optional AWS fallback still runs VOLATILITY v1. Do not silently send a
  // v2 request to that incompatible calculation. Old server histories stay readable.
  if (strategy === 'VOLATILITY' || strategy === 'ENVELOPE') throw new Error('이 전략은 이 기기에서 분석합니다.');
  const body: BacktestRequestBody = {
    strategy,
    mode: settings.mode,
    symbol: settings.mode === 'SINGLE' ? `${baseSymbol(settings.symbol)}USDT` : null,
    interval: settings.interval,
    startAt: toIso(settings.startDate, settings.startTime),
    initialCapitalUsdt: settings.initialCapitalUsdt,
    betAmountUsdt: settings.betAmountUsdt,
    side: settings.side,
    leverage: settings.leverage,
    entryMode: strategy === 'PULLBACK' ? 'SPLIT' : 'ALL_IN',
    ma10CloseEnabled: false,
    partialTpEnabled: settings.partialTpEnabled,
  };
  if (settings.endDate) body.endAt = toIso(settings.endDate, settings.endTime);
  if (strategy === 'PULLBACK') body.fullTpWavePercent = Number(settings.fullTpWavePercent);
  else if (strategy === 'DISPARITY') {
    body.minDisparityPercent = settings.minDisparityPercent;
    body.ma20HalfCloseEnabled = settings.ma20HalfCloseEnabled;
    body.roiClosePercent = settings.roiClosePercent;
  }
  return body;
}

function historyScopeSymbol(settings: BacktestSettings): string {
  return settings.mode === 'ALL' ? 'ALL' : baseSymbol(settings.symbol);
}

function historyPeriod(settings: BacktestSettings): string {
  const start = `${settings.startDate} ${settings.startTime}`;
  const end = settings.endDate ? `${settings.endDate} ${settings.endTime}` : '현재';
  return `${start} ~ ${end}`;
}

function restoredServerJob(entry: BacktestHistoryEntry): ServerJob {
  return {
    jobId: entry.serverJobId ?? `history-${entry.id}`,
    status: 'COMPLETED',
    createdAt: new Date(entry.savedAt).toISOString(),
    updatedAt: new Date(entry.savedAt).toISOString(),
    request: {},
    strategyVersion: 'history',
    phase: 'DONE',
    processedSymbols: 0,
    universeCount: 0,
    excludedCount: 0,
    failedCount: 0,
    completedBars: entry.result.observedBars,
    totalBars: entry.result.observedBars,
    message: null,
    assumptions: [],
    result: entry.result,
  };
}

export function StrategyBacktest({ strategy, context, embedded = false, forcedMode, preferredSettings }: StrategyBacktestProps) {
  const defaults = useMemo(defaultSettings, []);
  const [settings, setSettings] = useState<BacktestSettings>(() => ({ ...(preferredSettings ?? loadSettings(strategy, defaults)), ...(forcedMode ? { mode: forcedMode } : {}), ...(forcedMode === 'ALL' ? { envelopeRisk: undefined } : {}) }));
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(() => forcedMode ? null : loadCachedResult(strategy));
  const [serverJob, setServerJob] = useState<ServerJob | null>(null);
  const [progress, setProgress] = useState({ phase: '대기 중', completed: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const statisticsRunning = strategy === 'ENVELOPE' && isEnvelopeStatisticsRunning();
  const [localJob, setLocalJob] = useState<LocalJobView | null>(null);
  const [chart, setChart] = useState<ChartData | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [selectedTrade, setSelectedTrade] = useState<BacktestTrade | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);
  const [chartError, setChartError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<BacktestHistoryEntry[]>([]);
  const resultRequestRef = useRef(0);
  const chartHistoryPushed = useRef(false);
  const chartRequestRef = useRef(0);
  const olderRequestRef = useRef(false);
  const contextRef = useRef(context);
  const analysisSettingsRef = useRef(settings);
  const restoringHistoryRef = useRef(false);
  const anyAnalysisBusy = useAnalysisBusy();
  const leverageMaximum = strategy === 'ENVELOPE' ? settings.envelopeRisk?.maxLeverage ?? 100 : 100;

  useEffect(() => {
    contextRef.current = context;
  }, [context]);

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      // WebViews may repeat a history notification for the current chart entry.
      // Only leaving that entry is a request to close the chart.
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

  useEffect(() => {
    const requestId = ++resultRequestRef.current;
    const fallback = { ...(preferredSettings ?? loadSettings(strategy, defaults)), ...(forcedMode ? { mode: forcedMode } : {}), ...(forcedMode === 'ALL' ? { envelopeRisk: undefined } : {}) };
    analysisSettingsRef.current = fallback;
    setSettings(fallback);
    setResult(forcedMode ? null : loadCachedResult(strategy));
    setServerJob(null);
    setChart(null);
    setHistoryOpen(false);
    setHistoryEntries([]);
    restoringHistoryRef.current = false;
    setLocalJob(null);
    setRunning(isLocalBacktestRunning(strategy));
    const receive = (view: LocalJobView): void => {
      if (forcedMode && view.settings.mode !== forcedMode) return;
      setLocalJob(view);
      const snapshot = { ...defaults, ...view.settings };
      if (view.status !== 'COMPLETED') setSettings(snapshot);
      setRunning(view.status === 'RUNNING' && isLocalBacktestRunning(strategy));
      analysisSettingsRef.current = snapshot;
      if (view.result) setResult(view.result);
      setNotice(strategy === 'VOLATILITY' && view.version !== engineVersionFor(strategy) && view.status === 'COMPLETED'
        ? '이전 변동성 돌파 조건의 결과입니다. 새 분석을 시작하면 변경된 조건으로 계산합니다.' : view.message);
      setProgress({ phase: view.progressLabel, completed: view.completed, total: view.total });
      if (view.status === 'PAUSED' && view.message && !view.message.startsWith('분석을 일시정지')) setError(view.message);
    };
    const unsubscribe = subscribeLocalBacktest(strategy, event => {
      if (event.type === 'UPDATE') receive(event.view);
      else if (event.type === 'ERROR') { setError(event.message); setRunning(false); }
      else setRunning(false);
    });
    void restoreLocalBacktest(strategy).then(async local => {
      if (requestId !== resultRequestRef.current) return;
      if (preferredSettings) {
        if (local && (!forcedMode || local.settings.mode === forcedMode)) setLocalJob(local);
        setNotice('선택한 통계 세팅을 불러왔습니다. 분석 시작을 누르면 이 조건의 체결 결과와 차트를 확인합니다. 기존 일시정지 작업은 이어하기로 재개할 수 있습니다.');
        return;
      }
      if (local && (!forcedMode || local.settings.mode === forcedMode)) { receive(local); return; }
      if (forcedMode) {
        const entry = loadBacktestHistory(strategy, forcedMode, historyScopeSymbol(fallback))[0];
        const saved = entry?.localRunId ? await loadLocalResult(entry.localRunId) : null;
        if (saved && requestId === resultRequestRef.current) { setResult(saved.result); analysisSettingsRef.current = { ...defaults, ...saved.settings }; }
        return;
      }
      if (strategy === 'ENVELOPE') return;
      const job = await getServerBacktest(contextRef.current, strategy);
      if (job && requestId === resultRequestRef.current) {
        setServerJob(job);
        if (strategy === 'VOLATILITY') setNotice('이전 변동성 돌파 조건의 서버 결과입니다. 새 분석은 변경된 조건으로 이 기기에서 계산합니다.');
      }
    }).catch(() => undefined);
    return () => { unsubscribe(); resultRequestRef.current += 1; };
  }, [defaults, strategy, forcedMode, preferredSettings]);

  useEffect(() => {
    if (!serverJob || !['QUEUED', 'RUNNING'].includes(serverJob.status)) return undefined;
    const requestId = resultRequestRef.current;
    let active = true;
    const timer = window.setInterval(() => {
      void getServerBacktest(context, strategy, serverJob.jobId)
        .then((job) => {
          if (job && active && requestId === resultRequestRef.current) setServerJob(job);
        })
        .catch((failure: unknown) => {
          if (active && requestId === resultRequestRef.current) setError(failure instanceof Error ? failure.message : '분석 상태를 확인하지 못했습니다.');
        });
    }, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [context, serverJob, strategy]);

  useEffect(() => {
    if (!serverJob?.result) return;
    setResult(serverJob.result);
    if (restoringHistoryRef.current) {
      restoringHistoryRef.current = false;
      return;
    }
    if (serverJob.status === 'COMPLETED' || serverJob.status === 'PARTIAL') {
      const snapshot = serverSettingsSnapshot(serverJob.request, analysisSettingsRef.current);
      analysisSettingsRef.current = snapshot;
      saveBacktestHistory({
        id: `${strategy}:${serverJob.jobId}`,
        strategy,
        savedAt: Date.now(),
        mode: snapshot.mode,
        symbol: historyScopeSymbol(snapshot),
        interval: snapshot.interval,
        settings: snapshot,
        result: serverJob.result,
        serverJobId: serverJob.jobId,
      });
    }
  }, [serverJob, strategy]);

  useEffect(() => {
    if (!historyOpen) return;
    setHistoryEntries(
      loadBacktestHistory(strategy, settings.mode, historyScopeSymbol(settings)),
    );
  }, [historyOpen, settings.mode, settings.symbol, strategy]);

  const update = <K extends keyof BacktestSettings>(key: K, value: BacktestSettings[K]) => {
    const next = { ...settings, [key]: value, ...(key === 'symbol' ? { envelopeRisk: undefined } : {}) };
    setSettings(next);
    saveSettings(strategy, next);
  };

  useEffect(() => {
    const refreshSharedStorage = (): void => {
      if (document.visibilityState === 'hidden' || running || (serverJob && ['QUEUED', 'RUNNING'].includes(serverJob.status))) return;
      const shared = { ...loadSettings(strategy, defaults), ...(forcedMode ? { mode: forcedMode } : {}), ...(forcedMode === 'ALL' ? { envelopeRisk: undefined } : {}) };
      setSettings(current => JSON.stringify(current) === JSON.stringify(shared) ? current : shared);
      if (historyOpen) setHistoryEntries(loadBacktestHistory(strategy, shared.mode, historyScopeSymbol(shared)));
    };
    window.addEventListener('storage', refreshSharedStorage);
    window.addEventListener('focus', refreshSharedStorage);
    document.addEventListener('visibilitychange', refreshSharedStorage);
    return () => {
      window.removeEventListener('storage', refreshSharedStorage);
      window.removeEventListener('focus', refreshSharedStorage);
      document.removeEventListener('visibilitychange', refreshSharedStorage);
    };
  }, [defaults, historyOpen, running, serverJob, strategy, forcedMode]);

  const validate = (): void => {
    if (settings.mode === 'SINGLE' && !baseSymbol(settings.symbol)) throw new Error('종목명을 입력해 주세요.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(settings.startDate) || !/^\d{2}:\d{2}$/.test(settings.startTime)) throw new Error('시작일·시간을 확인해 주세요.');
    if (settings.endDate && (!/^\d{4}-\d{2}-\d{2}$/.test(settings.endDate) || !/^\d{2}:\d{2}$/.test(settings.endTime))) throw new Error('종료일·시간을 확인해 주세요.');
    if (!/^\d+(\.\d{1,2})?$/.test(settings.initialCapitalUsdt) || Number(settings.initialCapitalUsdt) < 10) throw new Error('초기자금을 확인해 주세요.');
    if (!/^\d+(\.\d{1,2})?$/.test(settings.betAmountUsdt) || Number(settings.betAmountUsdt) < 1 || Number(settings.betAmountUsdt) > Number(settings.initialCapitalUsdt)) throw new Error('고정 베팅액을 확인해 주세요.');
    if (!/^\d{1,4}(\.\d{1,2})?$/.test(settings.leverage) || Number(settings.leverage) < 1 || Number(settings.leverage) > leverageMaximum) throw new Error(`레버리지는 1~${leverageMaximum}배로 입력해 주세요.`);
    if (strategy === 'PULLBACK' && (!/^\d+$/.test(settings.fullTpWavePercent) || Number(settings.fullTpWavePercent) < 1 || Number(settings.fullTpWavePercent) > 100)) throw new Error('전체 TP 파동폭은 1~100 정수로 입력해 주세요.');
    if (strategy === 'DISPARITY' && (!/^(0\.[1-9]|[1-9](\.\d)?|10(\.0)?)$/.test(settings.minDisparityPercent))) throw new Error('MA60 이격률은 0.1~10.0%로 입력해 주세요.');
    if (strategy === 'DISPARITY' && (!/^([1-9]|[1-9]\d|100)$/.test(settings.roiClosePercent))) throw new Error('ROI 손실 청산은 1~100 정수로 입력해 주세요.');
    if (strategy === 'VOLATILITY') volatilityParameters(settings);
    if (strategy === 'ENVELOPE') envelopeParameters(settings);
    const start = Date.parse(`${settings.startDate}T${settings.startTime}:00+09:00`);
    const end = settings.endDate ? Date.parse(`${settings.endDate}T${settings.endTime}:00+09:00`) : Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start > Date.now()) throw new Error('분석 기간을 확인해 주세요.');
  };

  const runServer = async (reason?: string): Promise<void> => {
    validate();
    resultRequestRef.current += 1;
    const snapshot = { ...(localJob?.status === 'PAUSED' ? localJob.settings : settings) };
    analysisSettingsRef.current = snapshot;
    saveSettings(strategy, snapshot);
    setRunning(true);
    setError(null);
    setNotice(reason ?? 'AWS 분석 서버에 작업을 등록했습니다.');
    restoringHistoryRef.current = false;
    setServerJob(null);
    setResult(null);
    setHistoryOpen(false);
    setHistoryEntries([]);
    try {
      const body = defaultRequest(snapshot, strategy);
      if (localJob?.status === 'PAUSED') body.endAt = new Date(localJob.end * 1000).toISOString();
      const job = await startServerBacktest(context, body);
      setLocalJob(null);
      setServerJob(job);
      if (job.result) setResult(job.result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '분석 요청에 실패했습니다.');
    } finally {
      setRunning(false);
    }
  };

  const runLocal = (resume = false): void => {
    if (isEnvelopeStatisticsRunning()) throw new Error('통계분석을 먼저 일시정지해 주세요.');
    if (isEnvelopeBatchRunning()) throw new Error('전체통계·가상매매를 먼저 일시정지해 주세요.');
    if (!resume) validate();
    resultRequestRef.current += 1;
    const snapshot = { ...(resume && localJob ? localJob.settings : settings) };
    analysisSettingsRef.current = snapshot;
    saveSettings(strategy, snapshot);
    setError(null);
    setNotice('저장된 캔들을 확인하며 이 기기에서 분석합니다.');
    restoringHistoryRef.current = false;
    setServerJob(null);
    setResult(null);
    setHistoryOpen(false);
    setHistoryEntries([]);
    startLocalBacktest(strategy, snapshot, resume ? localJob?.id : undefined);
    if (!resume) setLocalJob(null);
    setSettings(snapshot);
    setRunning(true);
    setProgress({ phase: '분석 준비', completed: 0, total: 1 });
  };

  const run = (resume = false): void => {
    try {
      runLocal(resume);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '입력값을 확인해 주세요.');
    }
  };

  const cancel = async (): Promise<void> => {
    if (isLocalBacktestRunning(strategy)) {
      setNotice('현재까지의 진행 상태를 저장하고 있습니다.');
      pauseLocalBacktest(strategy);
      return;
    }
    if (!serverJob || !['QUEUED', 'RUNNING'].includes(serverJob.status)) return;
    try {
      setNotice('분석 중지 요청 중입니다.');
      setServerJob(await cancelServerBacktest(context, serverJob.jobId));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '분석 중지에 실패했습니다.');
    }
  };

  const toggleHistory = (): void => {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setHistoryEntries(
      loadBacktestHistory(strategy, settings.mode, historyScopeSymbol(settings)),
    );
    setHistoryOpen(true);
  };

  const openHistory = async (entry: BacktestHistoryEntry): Promise<void> => {
    const requestId = ++resultRequestRef.current;
    let restored = entry.result;
    if (entry.localRunId) {
      try {
        const saved = await loadLocalResult(entry.localRunId);
        if (!saved) throw new Error('저장된 분석 결과를 찾지 못했습니다. 다시 분석해 주세요.');
        restored = saved.result;
      } catch (failure) { setError(failure instanceof Error ? failure.message : '이력을 불러오지 못했습니다.'); return; }
    }
    if (requestId !== resultRequestRef.current) return;
    const snapshot = { ...defaults, ...entry.settings };
    analysisSettingsRef.current = snapshot;
    restoringHistoryRef.current = true;
    setSettings(snapshot);
    saveSettings(strategy, snapshot);
    saveCachedResult(strategy, restored);
    setResult(restored);
    setServerJob(entry.serverJobId ? restoredServerJob(entry) : null);
    setHistoryOpen(false);
    setHistoryEntries([]);
    setChart(null);
    setSelectedTrade(null);
    setError(null);
    setNotice(strategy === 'VOLATILITY' && (entry.serverJobId || typeof entry.settings.volatilityTpEnabled !== 'boolean')
      ? '이전 변동성 돌파 조건의 이력입니다. 새 분석을 시작하면 변경된 조건으로 계산합니다.'
      : '저장된 분석 이력을 불러왔습니다.');
  };

  const openTrade = async (trade: BacktestTrade): Promise<void> => {
    const requestId = ++chartRequestRef.current;
    setSelectedTrade(trade);
    setChartLoading(true);
    setChartError(null);
    setHasOlder(true);
    setError(null);
    try {
      if (serverJob?.result && serverJob.jobId && trade.tradeId && trade.symbol !== 'LOCAL') {
        const next = await fetchServerEntryChart(context, trade.symbol, trade.side, new Date(trade.exitAt * 1000).toISOString(), serverJob.jobId, trade.tradeId);
        if (requestId === chartRequestRef.current) setChart(withChartExecutionTimes(next, trade));
      } else if (result) {
        const next = await chartForLocalTrade(result, trade, analysisSettingsRef.current);
        if (requestId === chartRequestRef.current) setChart(withChartExecutionTimes(next, trade));
      }
    } catch (failure) {
      if (requestId === chartRequestRef.current) setError(failure instanceof Error ? failure.message : '차트 조회에 실패했습니다.');
    } finally {
      if (requestId === chartRequestRef.current) setChartLoading(false);
    }
  };

  const loadOlder = async (): Promise<boolean> => {
    if (!chart || !selectedTrade || olderRequestRef.current || !hasOlder) return false;
    const oldest = chart.candles[0]?.openTime;
    if (!oldest || !Number.isFinite(oldest)) return false;
    const requestId = chartRequestRef.current;
    olderRequestRef.current = true;
    setLoadingOlder(true);
    setChartError(null);
    try {
      const older = chart.interval !== analysisSettingsRef.current.interval
        ? await chartAtInterval(chart, chart.interval, { beforeAt: oldest })
        : serverJob
        ? await fetchServerChart(context, selectedTrade.symbol, selectedTrade.side, new Date(selectedTrade.exitAt * 1000).toISOString(), serverJob.jobId, selectedTrade.tradeId, new Date(oldest * 1000).toISOString())
        : result ? await chartForLocalTrade(result, selectedTrade, analysisSettingsRef.current, oldest) : null;
      if (!older) return false;
      if (requestId !== chartRequestRef.current) return false;
      const merged = mergeChartPages(withChartExecutionTimes(older, selectedTrade), chart);
      if (merged.candles.length <= chart.candles.length) {
        setHasOlder(false);
        return false;
      }
      setChart(merged);
      return true;
    } catch (failure) {
      if (requestId === chartRequestRef.current) {
        setChartError(failure instanceof Error ? failure.message : '과거 캔들을 불러오지 못했습니다.');
      }
      return false;
    } finally {
      olderRequestRef.current = false;
      setLoadingOlder(false);
    }
  };

  const focusChartCandle = async (openTime: number): Promise<boolean> => {
    if (!chart || !selectedTrade || olderRequestRef.current) return false;
    if (chart.candles.some(candle => candle.openTime === openTime)) return true;
    if (![...chart.markers, ...(chart.executions ?? [])].some(fill =>
      (fill.kind === 'ENTRY' || fill.kind === 'CLOSE') && fill.openTime === openTime)) return false;
    const requestId = ++chartRequestRef.current;
    olderRequestRef.current = true;
    setLoadingOlder(true);
    setChartError(null);
    try {
      const next = chart.interval !== analysisSettingsRef.current.interval
        ? await chartAtInterval(chart, chart.interval, { focusAt: openTime })
        : serverJob
        ? await fetchServerChart(context, selectedTrade.symbol, selectedTrade.side, new Date(selectedTrade.exitAt * 1000).toISOString(), serverJob.jobId, selectedTrade.tradeId, undefined, new Date(openTime * 1000).toISOString())
        : result ? await chartForLocalTrade(result, selectedTrade, analysisSettingsRef.current, undefined, openTime) : null;
      if (requestId !== chartRequestRef.current) return false;
      if (!next?.candles.some(candle => candle.openTime === openTime)) throw new Error('해당 체결 시점의 캔들을 불러오지 못했습니다. 다시 눌러 주세요.');
      // Distant entry/exit pages are not adjacent candles: switch pages rather
      // than merging them into a chart with an unmarked gap in its time axis.
      setChart(withChartExecutionTimes(next, selectedTrade));
      setHasOlder(true);
      return true;
    } catch (failure) {
      if (requestId === chartRequestRef.current) setChartError(failure instanceof Error ? failure.message : '체결 캔들을 불러오지 못했습니다.');
      return false;
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

  const activeServer = serverJob && ['QUEUED', 'RUNNING'].includes(serverJob.status);
  const title = strategy === 'PULLBACK' ? '눌림목' : strategy === 'DISPARITY' ? '이격매매' : strategy === 'ENVELOPE' ? '엔벨로프' : '변동성 돌파';
  const resultTrades = result?.recentTrades ? [...result.recentTrades].reverse() : [];
  const currentHistorySymbol = historyScopeSymbol(settings);
  const historyLabel = settings.mode === 'ALL'
    ? '전체종목 이력보기'
    : `${currentHistorySymbol || '종목'} 이력보기`;
  const Root = embedded ? 'section' : 'main';

  return (
    <Root className={embedded ? 'embedded-backtest' : 'screen'}>
      <div className={`${embedded ? '' : 'content '}strategy-content`}>
        {!embedded ? <header className="page-header strategy-header">
          <div>
            <p className="eyebrow">{strategy} · BACKTEST</p>
            <h1>{title} 백테스트</h1>
          </div>
        </header> : null}
        <button className="outline-button detail-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? '상세설명접기' : '상세설명보기'}
        </button>
        {expanded ? (
          <section className="surface-card condition-card">
            <h3>검색 조건</h3>
            {strategy === 'PULLBACK' ? (
              <div className="condition-copy">
                <strong>롱 포지션</strong>
                <p>1. 전파동 저점·고점 &gt; 전전파동 저점·고점</p>
                <p>2. MA10·MA20·(MA10−MA20)이 t−2 &lt; t−1 &lt; t</p>
                <p>3. 하락→상승 반전 첫 봉의 몸통 고점 &gt; 직전 몸통 고점</p>
                <p>4. 1차 종가·2차 (1차가+SL)÷2 · 최초 TP = 몸통 저점 + 전파동폭 × 비율</p>
                <strong>숏 포지션</strong>
                <p>위 조건을 반대로 적용합니다. SL은 전파동 꼬리 극값이며 2차 체결 후 TP는 평단가·1차가 중간값입니다.</p>
              </div>
            ) : strategy === 'DISPARITY' ? (
              <div className="condition-copy">
                <strong>롱 포지션</strong>
                <p>1. MA20 &lt; 종가 &lt; MA60, 캔들 절반 이상 MA20 위</p>
                <p>2. 몸통 상단 &gt; 이전 5봉 몸통 상단 최댓값, 양봉 몸통 ≥ 0.5%</p>
                <p>3. MA60 이격 ≥ 입력값, 이전 10봉 종가 ≤ 각 봉 MA20</p>
                <p>4. SL은 이전 10봉 최저가, MA60 접촉·선택 조건으로 청산</p>
                <strong>숏 포지션</strong>
                <p>위 조건을 반대로 적용합니다. ROI 손실은 레버리지가 반영된 가격 기준입니다.</p>
              </div>
            ) : strategy === 'ENVELOPE' ? (
              <div className="condition-copy">
                <p>중심선은 선택 주기의 SMA5·10·20·40·60·80·100·120입니다. 봉 시작 전 확정된 N개 종가 평균을 사용하며 봉 안에서는 밴드를 고정합니다.</p>
                <p>상단 = 중심선 × (1 + 이격%/100), 하단 = 중심선 × (1 − 이격%/100)</p>
                <strong>롱 포지션</strong>
                <p>하단 접촉 시 진입 · SL = 실제 매수가 × (1 − 이격%/100)</p>
                <p>① 중심선 전량 ② 상단 전량 ③ 중심선 50% + 상단 나머지 전량 중 선택합니다.</p>
                <strong>숏 포지션</strong>
                <p>상단 접촉 시 진입 · SL = 실제 매수가 × (1 + 이격%/100)</p>
                <p>① 중심선 전량 ② 하단 전량 ③ 중심선 50% + 하단 나머지 전량 중 선택합니다.</p>
                <p>보유 중 중심선·밴드는 매 봉 시작에 갱신하고 SL은 실제 진입가 기준으로 고정합니다. 절반 청산 후에도 SL은 그대로입니다. SL 갭은 시가에 손절하며 진입·손절 시장가에 0.02% 슬리피지, 편도 0.055% 수수료를 반영합니다.</p>
                <p>선택 봉의 시가→고가→저가→종가와 시가→저가→고가→종가 두 경로 중 보수적인 결과를 사용합니다. 양쪽 밴드가 모두 닿는 봉은 진입 방향도 경로에 따라 비교합니다. 봉 중간 체결 시각은 봉 시작 시각의 추정치이며 정확한 틱 재현은 아닙니다.</p>
                <p>한 종목은 봉당 한 번만 진입하고 봉 시작에 보유했다면 같은 봉에 재진입하지 않습니다. 전체종목은 종목명 순서·봉 시작 가용자금 한도로 배분하며 미래 청산 자금을 재사용하지 않습니다. 기간 말 미청산분은 평가액에 포함합니다.</p>
                <p>개별통계는 4개 주기·8개 SMA·이격 0.1~20.0%(0.1 단위)·3개 청산 방식과 정수 레버리지를 같은 자금·방향·기간으로 비교합니다. LIQ는 롱 SL×0.997 이하, 숏 SL×1.003 이상인 안전 범위까지만 올립니다. 밴드 접촉이 없는 이격부터 더 넓은 이격은 건너뜁니다.</p>
                <p>전체통계는 슬리피지 필터 없이 모든 활성 USDT 종목의 최적 세팅을 하나씩 저장합니다. 가상매매는 완료된 전체통계 결과를 선택해 15분봉·한 계좌의 공유 자금으로 같은 기간을 재검증합니다. 과거 최적값의 사후 분석이며 미래 성과를 보장하지 않습니다.</p>
                {settings.envelopeRisk ? <p className="notice">통계에서 불러온 세팅은 현재 공개 위험한도에 따른 격리 LIQ 예상치를 사용합니다. 시가 갭이 SL과 LIQ를 모두 넘으면 남은 포지션 증거금을 소진하는 추정 청산으로 처리합니다. 실제 계좌·과거 거래소 청산가와 다를 수 있습니다.</p> : null}
              </div>
            ) : (
              <div className="condition-copy">
                <p>R = |직전 종가 − 직전 시가| (몸통 크기) · 변동폭(%) = R ÷ 직전 종가 × 100</p>
                <p>변동폭 ≥ {settings.minVolatilityPercent}% · 0.1 ≤ K1 ≤ K2 ≤ 10.0</p>
                <strong>롱 포지션</strong>
                <p>1. 전전봉 종가 &lt; 시가 (음봉)</p>
                <p>2. 직전봉 양봉 · 돌파 순간의 현재가 &gt; 현재 시가</p>
                <p>3. 직전 저가 &lt; 진입 시점까지의 현재봉 저가</p>
                <p>4. 현재가가 현재 시가 + R×K1에 처음 닿으면 롱 진입 · 진입 허용 상한은 현재 시가 + R×K2</p>
                <p>5. TP 켜짐: 매수가 + R×K1 접촉 시 전량 청산 · 종가 확정 대기 없음</p>
                <p>6. SL = 진입 시점까지의 현재봉 저가로 고정 · 진입 직후부터 접촉 시 전량 손절</p>
                <p>7. 다음 캔들 종가 청산 켜짐: 진입봉의 바로 다음 봉이 마감되면 전량 시장가 청산</p>
                <strong>숏 포지션</strong>
                <p>1. 전전봉 종가 &gt; 시가 (양봉)</p>
                <p>2. 직전봉 음봉 · 돌파 순간의 현재가 &lt; 현재 시가</p>
                <p>3. 직전 고가 &gt; 진입 시점까지의 현재봉 고가</p>
                <p>4. 현재가가 현재 시가 − R×K1에 처음 닿으면 숏 진입 · 진입 허용 하한은 현재 시가 − R×K2</p>
                <p>5. TP 켜짐: 매수가 − R×K1 접촉 시 전량 청산 · 종가 확정 대기 없음</p>
                <p>6. SL = 진입 시점까지의 현재봉 고가로 고정 · 진입 직후부터 접촉 시 전량 손절</p>
                <p>7. 다음 캔들 종가 청산 켜짐: 진입봉의 바로 다음 봉이 마감되면 전량 시장가 청산</p>
                <strong>공통 체결 기준</strong>
                <p>최소 변동폭 조건을 포함해 모두 충족해야 진입합니다. R·진입 시점 SL은 고정하며 실제 매수가는 시장가 슬리피지 0.02%를 반영합니다. 연속 가격에서는 K1 가격에 진입하며, 1분봉 시가 갭이 나면 관측된 시가가 K2 범위 안일 때만 진입합니다.</p>
                <p>TP와 다음 봉 종가 청산은 독립 옵션이며 먼저 충족한 조건으로 청산합니다. SL은 항상 적용합니다. 둘 다 끄면 SL로만 청산하며 기간 말 미청산분은 평가액에 포함합니다. 진입봉 안의 TP·SL도 적용하되, 진입 이전 움직임으로 소급 청산하지 않습니다.</p>
                <p>신호봉의 1분봉을 시간순으로 사용해 진입 시점 SL을 계산하며, 분봉 안에서는 두 OHLC 경로 중 불리한 결과를 사용합니다. 진입·신호봉 내 청산 시각은 1분봉 시작의 추정치이고, 이후 보유 봉 TP/SL은 선택 주기 봉 시작의 추정치입니다. 다음 봉 종가 청산은 실제 마감 시각이며 정확한 틱 재현은 아닙니다.</p>
                <p>한 종목은 봉당 최대 한 번 진입하며 봉 시작에 보유했다면 그 봉 재진입은 제외합니다. 전체종목은 종목명 순서·봉 시작의 가용자금만 진입에 사용해 같은 봉의 미래 청산 자금을 재사용하지 않습니다. SL 갭은 시가에 손절합니다.</p>
              </div>
            )}
          </section>
        ) : null}

        <section className="surface-card form-card">
          <fieldset className="analysis-fields" disabled={running || statisticsRunning || anyAnalysisBusy || Boolean(activeServer)}>
          {!forcedMode ? <><h2>분석 대상</h2>
          <div className="segmented">
            {(['SINGLE', 'ALL'] as const).map((mode) => (
              <button key={mode} type="button" className={settings.mode === mode ? 'selected' : ''} onClick={() => update('mode', mode)}>
                {mode === 'SINGLE' ? '개별 종목' : '전체 종목'}
              </button>
            ))}
          </div></> : null}
          <p className="muted small">저장된 캔들을 우선 사용하고 없는 구간만 조회합니다. 전체 종목은 현재 슬리피지 조건을 통과한 종목을 하나의 가상 계좌에서 분석합니다.</p>
          {settings.mode === 'SINGLE' ? (
            <label className="field-label">종목명
              <span className="suffix-field"><input value={baseSymbol(settings.symbol)} onChange={(event) => update('symbol', baseSymbol(event.target.value))} placeholder="BTC" /><b>USDT</b></span>
            </label>
          ) : null}

          <h2>분석 방향</h2>
          <div className="segmented three">
            {(['BOTH', 'LONG', 'SHORT'] as const).map((side) => <button key={side} type="button" className={settings.side === side ? 'selected' : ''} onClick={() => update('side', side)}>{side === 'BOTH' ? '롱 + 숏' : side === 'LONG' ? '롱' : '숏'}</button>)}
          </div>

          <h2>{strategy === 'ENVELOPE' ? '엔벨로프 중심선 주기' : '캔들 주기'}</h2>
          <div className="segmented four">
            {(['15m', '1h', '4h', '1d'] as const).map((interval) => <button key={interval} type="button" className={settings.interval === interval ? 'selected' : ''} onClick={() => update('interval', interval)}>{interval.toUpperCase()}</button>)}
          </div>

          <h2>분석 기간 (한국시간)</h2>
          <div className="field-grid two">
            <label className="field-label">시작일<input inputMode="numeric" value={settings.startDate} onChange={(event) => update('startDate', formatDateInput(event.target.value))} placeholder="2026-01-01" /></label>
            <label className="field-label">시작시간<input inputMode="numeric" value={settings.startTime} onChange={(event) => update('startTime', formatTimeInput(event.target.value))} placeholder="00:00" /></label>
            <label className="field-label">종료일 (선택)<input inputMode="numeric" value={settings.endDate} onChange={(event) => update('endDate', formatDateInput(event.target.value))} placeholder="현재까지" /></label>
            <label className="field-label">종료시간<input inputMode="numeric" value={settings.endTime} onChange={(event) => update('endTime', formatTimeInput(event.target.value))} placeholder="00:00" /></label>
          </div>

          <div className="field-grid three">
            <label className="field-label">가상 초기자금<input inputMode="decimal" value={settings.initialCapitalUsdt} onChange={(event) => update('initialCapitalUsdt', event.target.value)} /></label>
            <label className="field-label">고정 베팅액<input inputMode="decimal" value={settings.betAmountUsdt} onChange={(event) => update('betAmountUsdt', event.target.value)} /></label>
            <label className="field-label">레버리지<input inputMode="decimal" value={settings.leverage} onChange={(event) => update('leverage', event.target.value)} /><small>1~{leverageMaximum}배</small></label>
          </div>

          {strategy === 'PULLBACK' ? (
            <label className="field-label">전체 TP 직전 파동폭 (%)<input inputMode="numeric" value={settings.fullTpWavePercent} onChange={(event) => update('fullTpWavePercent', event.target.value.replace(/\D/g, '').slice(0, 3))} /><small>1~100 · 기본 100</small></label>
          ) : strategy === 'DISPARITY' ? (
            <>
              <label className="field-label">MA60 최소 이격률 (%)<input inputMode="decimal" value={settings.minDisparityPercent} onChange={(event) => update('minDisparityPercent', event.target.value)} /><small>0.1~10.0</small></label>
              <label className="checkbox-row"><input type="checkbox" checked={settings.ma20HalfCloseEnabled} onChange={(event) => update('ma20HalfCloseEnabled', event.target.checked)} /><span>캔들 절반 MA20 청산</span></label>
              <label className="field-label">ROI 손실 청산 (%)<input inputMode="numeric" value={settings.roiClosePercent} onChange={(event) => update('roiClosePercent', event.target.value.replace(/\D/g, '').slice(0, 3))} /><small>레버리지 적용 ROI · 1~100</small></label>
            </>
          ) : strategy === 'ENVELOPE' ? (
            <>
              <h2>엔벨로프 중심선 봉수</h2>
              <div className="segmented four envelope-periods">{envelopePeriods.map(period => <button key={period} type="button" className={Number(settings.envelopeMaPeriod ?? '20') === period ? 'selected' : ''} onClick={() => update('envelopeMaPeriod', String(period))}>MA{period}</button>)}</div>
              <label className="field-label">엔벨로프 이격 (%)<span className="suffix-field"><input type="number" min="0.1" max="20" step="0.1" inputMode="decimal" value={settings.envelopeDeviationPercent ?? '0.5'} onChange={event => update('envelopeDeviationPercent', event.target.value)} /><b>%</b></span><small>0.1~20.0 · 상단·하단 각각 적용 · SL도 같은 비율</small></label>
              <label className="field-label">청산 방식<select value={settings.envelopeExitMode ?? 'CENTER'} onChange={event => update('envelopeExitMode', event.target.value as BacktestSettings['envelopeExitMode'])}>{envelopeExitModes.map(mode => <option value={mode} key={mode}>{envelopeExitLabels[mode]}</option>)}</select></label>
            </>
          ) : (
            <>
              <label className="field-label">변동폭 최소 (%)<span className="suffix-field"><input inputMode="decimal" value={settings.minVolatilityPercent} onChange={(event) => update('minVolatilityPercent', event.target.value.replace(/[^0-9.]/g, '').slice(0, 5))} /><b>%</b></span><small>0.1~10.0 · 기본 0.5 · 직전 몸통 크기 ÷ 직전 종가 × 100</small></label>
              <div className="field-grid two">
                <label className="field-label">K1<input inputMode="decimal" value={settings.volatilityK1} onChange={(event) => update('volatilityK1', event.target.value.replace(/[^0-9.]/g, '').slice(0, 4))} /><small>0.1~10.0 · 기본 0.5</small></label>
                <label className="field-label">K2<input inputMode="decimal" value={settings.volatilityK2} onChange={(event) => update('volatilityK2', event.target.value.replace(/[^0-9.]/g, '').slice(0, 4))} /><small>0.1~10.0 · 기본 1.0 · K1 이상</small></label>
              </div>
            </>
          )}
          {strategy === 'VOLATILITY' ? (
            <>
              <label className="checkbox-row"><input type="checkbox" checked={settings.volatilityTpEnabled} onChange={(event) => update('volatilityTpEnabled', event.target.checked)} /><span>TP (변동폭 × K1)</span></label>
              <label className="checkbox-row"><input type="checkbox" checked={settings.volatilityNextCloseEnabled} onChange={(event) => update('volatilityNextCloseEnabled', event.target.checked)} /><span>매수 다음 캔들 종가 청산</span></label>
              <p className="muted small">봉 중간 K1 돌파에 진입하며 SL은 진입 시점까지의 저가(롱)·고가(숏)로 고정합니다. 두 옵션은 먼저 충족한 조건으로 청산하며, 모두 끄면 SL만 적용합니다. 신호봉의 1분봉은 필요한 구간만 조회·캐시하며 1분봉 내부 경로는 보수적으로 추정합니다.</p>
            </>
          ) : strategy !== 'ENVELOPE' ? (
            <>
              <label className="checkbox-row"><input type="checkbox" checked={settings.partialTpEnabled} onChange={(event) => update('partialTpEnabled', event.target.checked)} /><span>부분 TP 50%</span></label>
              <p className="muted small">{strategy === 'PULLBACK' ? '1차 매수가와 최초 TP의 중간에서 50% 청산합니다. 2차 체결 시 미체결 부분 TP는 취소됩니다.' : '매수가와 신호 시점 MA60의 중간에서 50% 청산하고 SL을 최초 매수가로 옮깁니다.'}</p>
            </>
          ) : null}

          </fieldset>
          <div className="action-row">
            <button className="primary-button" type="button" disabled={running || statisticsRunning || anyAnalysisBusy || Boolean(activeServer)} onClick={() => run()}>{running || activeServer ? '분석 진행 중' : localJob?.status === 'PAUSED' ? '새 분석 시작' : '분석 시작'}</button>
            {running || activeServer ? <button className="danger-button" type="button" onClick={() => void cancel()}>{running ? '분석 일시정지' : '분석 중지'}</button> : null}
          </div>
          {!running && !statisticsRunning && !activeServer && localJob?.status === 'PAUSED' && localJob.version === engineVersionFor(strategy) ? <button className="outline-button" type="button" onClick={() => run(true)}>분석 이어하기</button> : null}
          {localJob && localJob.status !== 'COMPLETED' ? <p className="muted small">화면을 끄거나 탭을 닫으면 분석이 정지될 수 있습니다. 다시 열어 ‘분석 이어하기’를 누르면 저장된 지점부터 계속합니다.</p> : null}
          {error && strategy !== 'VOLATILITY' && strategy !== 'ENVELOPE' && !running && !activeServer ? <button className="outline-button" type="button" onClick={() => void runServer('AWS 분석 서버에서 분석합니다.').catch(failure => setError(failure instanceof Error ? failure.message : '분석 요청에 실패했습니다.'))}>서버에서 분석</button> : null}
          <button
            className="outline-button history-toggle"
            type="button"
            disabled={running || statisticsRunning || Boolean(activeServer)}
            aria-expanded={historyOpen}
            onClick={toggleHistory}
          >
            {historyOpen ? '이력 닫기' : historyLabel}
          </button>
          {historyOpen ? (
            <HistoryList
              entries={historyEntries}
              emptyMessage={settings.mode === 'ALL'
                ? '전체종목 분석 이력이 없습니다.'
                : `${currentHistorySymbol || '해당 종목'} 분석 이력이 없습니다.`}
              onOpen={openHistory}
            />
          ) : null}
          {notice && notice !== error ? <p className="notice">{notice}</p> : null}
          {error ? <p className="error" role="alert">{error}</p> : null}
          {running || localJob?.status === 'PAUSED' ? <ProgressBar completed={progress.completed} total={progress.total || Math.max(estimateBars(settings), 1)} label={progress.phase} /> : null}
          {localJob ? <p className="muted small">분석 대상 {localJob.universeCount.toLocaleString()}종목 · 슬리피지 제외 {localJob.excludedCount.toLocaleString()}종목{localJob.status === 'COMPLETED' ? ' · 완료' : localJob.status === 'PAUSED' ? ' · 일시정지' : ''}</p> : null}
          {localJob?.settings.mode === 'ALL' && localJob.universeCheckedAt ? <p className="muted small">전체종목 필터: {new Date(localJob.universeCheckedAt).toLocaleString('ko-KR')} 검사 · 7일 공통 재사용</p> : null}
          {activeServer ? <ProgressBar completed={serverJob.completedBars} total={Math.max(serverJob.totalBars, 1)} label={`${serverJob.phase === 'UNIVERSE' ? '종목 확인' : serverJob.phase === 'DATA' ? '캔들 조회' : '전략 계산'} · ${serverJob.status === 'QUEUED' ? '대기 중' : '분석 중'}`} /> : null}
        </section>

        {result ? <ResultCard result={result} onOpenTrade={(trade) => void openTrade(trade)} /> : null}
      </div>
      {chartLoading ? <div className="modal-backdrop"><div className="loading-card">체결 차트를 불러오는 중입니다…</div></div> : null}
      {chart ? <ChartModal chart={chart} onClose={closeChart} onLoadOlder={selectedTrade && hasOlder ? loadOlder : undefined} onFocusCandle={focusChartCandle} onIntervalChange={changeChartInterval} loadingOlder={loadingOlder} historyError={chartError} /> : null}
    </Root>
  );
}

function HistoryList({
  entries,
  emptyMessage,
  onOpen,
}: {
  entries: BacktestHistoryEntry[];
  emptyMessage: string;
  onOpen: (entry: BacktestHistoryEntry) => void;
}) {
  if (entries.length === 0) {
    return <p className="muted history-empty">{emptyMessage}</p>;
  }
  return (
    <div className="history-list">
      {entries.map((entry) => (
        <button className="history-card" type="button" key={entry.id} onClick={() => onOpen(entry)}>
          <span className="history-card-heading">
            <strong>{entry.symbol === 'ALL' ? '전체종목' : `${entry.symbol}USDT`}</strong>
            <em className={entry.result.returnPercent >= 0 ? 'positive' : 'negative'}>{percent(entry.result.returnPercent)}</em>
          </span>
          <span>{entry.interval.toUpperCase()} · {historyPeriod(entry.settings)}</span>
          <small>저장 {new Date(entry.savedAt).toLocaleDateString('ko-KR')}</small>
        </button>
      ))}
    </div>
  );
}

function ResultCard({ result, onOpenTrade }: { result: BacktestResult; onOpenTrade: (trade: BacktestTrade) => void }) {
  return (
    <section className="surface-card result-card">
      <div className="result-heading">
        <div><p className="eyebrow">BACKTEST RESULT</p><h2>확보한 구간까지의 성적</h2></div>
        <strong className={result.returnPercent >= 0 ? 'positive big-number' : 'negative big-number'}>{percent(result.returnPercent)}</strong>
      </div>
      <div className="metric-grid">
        <div><span>최종 평가금액</span><strong>{money(result.finalEquityUsdt)} USDT</strong></div>
        <div><span>실현손익</span><strong>{money(result.realizedProfitUsdt)} USDT</strong></div>
        <div><span>승률</span><strong>{percent(result.winRatePercent)}</strong></div>
        <div><span>진입 · 청산</span><strong>{result.entryCount} · {result.closedTradeCount}</strong></div>
        <div><span>수익 · 손실</span><strong>{result.winCount} · {result.lossCount}</strong></div>
        <div><span>최대 낙폭</span><strong>{percent(result.maxDrawdownPercent)}</strong></div>
      </div>
      <p className="muted small">관찰 캔들 {result.observedBars.toLocaleString()}개 · 수수료 {money(result.feesUsdt)} USDT · 2차 체결 {result.secondFillCount}회</p>
      {Object.keys(result.exitReasons).length > 0 ? <div className="reason-list">{Object.entries(result.exitReasons).map(([reason, count]) => <span key={reason}>{reasonLabels[reason] ?? reason} {count}</span>)}</div> : null}
      {result.recentTrades.length > 0 ? (
        <div className="trade-list">
          <h3>최근 청산 내역 (최대 100건)</h3>
          {[...result.recentTrades].reverse().slice(0, 100).map((trade) => (
            <button className="trade-row" type="button" key={trade.tradeId} onClick={() => onOpenTrade(trade)}>
              <strong>{trade.symbol} · {trade.side === 'LONG' ? '롱' : '숏'} · {reasonLabels[trade.reason] ?? trade.reason}</strong>
              <span>{new Date(trade.entryAt * 1000).toLocaleString('ko-KR')} {trade.executions.find(fill => fill.kind === 'ENTRY')?.timing === 'INTRABAR' ? '진입봉 (봉 중간 체결 추정)' : '진입'}</span>
              <span>{new Date(trade.exitAt * 1000).toLocaleString('ko-KR')} {trade.executions.at(-1)?.timing === 'INTRABAR' ? '청산봉 (봉 중간 체결 추정)' : '청산'}</span>
              <em className={trade.netProfitUsdt >= 0 ? 'positive' : 'negative'}>청산 손익 {money(trade.netProfitUsdt)} USDT · 체결 차트 보기 ›</em>
            </button>
          ))}
        </div>
      ) : <p className="muted">아직 청산된 거래가 없습니다.</p>}
    </section>
  );
}
