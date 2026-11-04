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
import { loadLocalResult, engineVersionFor, canResumeLocalJob, type LocalJobView } from '../localJobs';
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
import { serverSettingsSnapshot } from '../backtestSettings';
import { ProgressBar } from './ProgressBar';
import { currentEnvelopeSettings, currentPullbackSettings, envelopeParameters, envelopePeriods, pullbackEnvelopeParameters } from '../envelope';
import { EnvelopeTrendControl } from './EnvelopeTrendControl';
import { isEnvelopeStatisticsRunning } from '../envelopeStatisticsClient';
import { isEnvelopeBatchRunning } from '../envelopeBatchClient';
import { useAnalysisBusy } from '../analysisActivity';
import { currentNewHighSettings, newHighPeriod, newHighRules, newHighSlMultiplier } from '../newHigh';

const strategySettings = (strategy: Strategy, value: BacktestSettings): BacktestSettings => strategy === 'NEW_HIGH'
  ? currentNewHighSettings(value) : strategy === 'ENVELOPE' ? currentEnvelopeSettings(value) : strategy === 'PULLBACK' ? currentPullbackSettings(value) : value;

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
    envelopeMoveSlOnCenter: false,
    envelopeEntryMode: 'RECLAIM',
    newHighLookback: '20',
    newHighSlMultiplier: '2',
    newHighMa60Enabled: false,
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
  VOLATILITY_MA5_EXIT: '수익구간 MA5 기준 청산',
  NEXT_CANDLE_CLOSE: '매수 다음 캔들 종가 청산',
  PULLBACK_ENVELOPE: '눌림목 엔벨로프 청산',
  PULLBACK_MA60: '눌림목 MA60 터치 청산',
  PULLBACK_MA_EXIT: '눌림목 정배열 이탈 청산',
  ENVELOPE_CENTER: '엔벨로프 중심선 청산',
  ENVELOPE_OPPOSITE: '엔벨로프 반대 밴드 청산',
  NEW_HIGH_CONDITIONAL_EXIT: '2ATR 도달·MA5/MA20 조건 청산',
  NEW_HIGH_PROFIT_RETRACE: '1ATR 돌파 후 재이탈 청산',
};

function defaultRequest(settings: BacktestSettings, strategy: Strategy): BacktestRequestBody {
  // The optional AWS fallback still runs VOLATILITY v1. Do not silently send a
  // v2 request to that incompatible calculation. Old server histories stay readable.
  if (strategy === 'VOLATILITY' || strategy === 'ENVELOPE' || strategy === 'NEW_HIGH' || strategy === 'PULLBACK') throw new Error('이 전략은 이 기기에서 분석합니다.');
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
    entryMode: 'ALL_IN',
    ma10CloseEnabled: false,
    partialTpEnabled: settings.partialTpEnabled,
  };
  if (settings.endDate) body.endAt = toIso(settings.endDate, settings.endTime);
  if (strategy === 'DISPARITY') {
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
  const defaults = useMemo(() => strategySettings(strategy, strategy === 'PULLBACK' ? { ...defaultSettings(), envelopeDeviationPercent: undefined } : defaultSettings()), [strategy]);
  const [settings, setSettings] = useState<BacktestSettings>(() => {
    const value = { ...(preferredSettings ?? loadSettings(strategy, defaults)), ...(forcedMode ? { mode: forcedMode } : {}), ...(forcedMode === 'ALL' ? { envelopeRisk: undefined } : {}) };
    return strategySettings(strategy, value);
  });
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
    const stored = { ...(preferredSettings ?? loadSettings(strategy, defaults)), ...(forcedMode ? { mode: forcedMode } : {}), ...(forcedMode === 'ALL' ? { envelopeRisk: undefined } : {}) };
    const fallback = strategySettings(strategy, stored);
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
      if (view.status !== 'COMPLETED') setSettings(strategySettings(strategy, snapshot));
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
      if (strategy === 'ENVELOPE' || strategy === 'NEW_HIGH') return;
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
    const changed = { ...settings, [key]: value, ...(key === 'symbol' ? { envelopeRisk: undefined } : {}) };
    const next = strategySettings(strategy, changed);
    setSettings(next);
    saveSettings(strategy, next);
  };

  useEffect(() => {
    const refreshSharedStorage = (): void => {
      if (document.visibilityState === 'hidden' || running || (serverJob && ['QUEUED', 'RUNNING'].includes(serverJob.status))) return;
      const stored = { ...loadSettings(strategy, defaults), ...(forcedMode ? { mode: forcedMode } : {}), ...(forcedMode === 'ALL' ? { envelopeRisk: undefined } : {}) };
      const shared = strategySettings(strategy, stored);
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
    if (strategy === 'DISPARITY' && (!/^(0\.[1-9]|[1-9](\.\d)?|10(\.0)?)$/.test(settings.minDisparityPercent))) throw new Error('MA60 이격률은 0.1~10.0%로 입력해 주세요.');
    if (strategy === 'DISPARITY' && (!/^([1-9]|[1-9]\d|100)$/.test(settings.roiClosePercent))) throw new Error('ROI 손실 청산은 1~100 정수로 입력해 주세요.');
    if (strategy === 'ENVELOPE') envelopeParameters(settings);
    if (strategy === 'PULLBACK') pullbackEnvelopeParameters(settings);
    if (strategy === 'NEW_HIGH') { newHighPeriod(settings); newHighSlMultiplier(settings); }
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
    const displaySettings = strategySettings(strategy, snapshot);
    setSettings(displaySettings);
    saveSettings(strategy, displaySettings);
    saveCachedResult(strategy, restored);
    setResult(restored);
    setServerJob(entry.serverJobId ? restoredServerJob(entry) : null);
    setHistoryOpen(false);
    setHistoryEntries([]);
    setChart(null);
    setSelectedTrade(null);
    setError(null);
    setNotice(strategy === 'ENVELOPE' && (entry.settings.interval !== '1h' || typeof entry.settings.envelopeDailyTrend !== 'boolean')
      ? '이전 엔벨로프 조건의 저장 결과입니다. 차트는 당시 설정으로 표시하며 새 분석은 1h·현재 추세 체크 상태로 계산합니다.'
      : strategy === 'VOLATILITY' && (entry.serverJobId || typeof entry.settings.volatilityTpEnabled !== 'boolean')
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
  const title = strategy === 'NEW_HIGH' ? '신고가' : strategy === 'PULLBACK' ? '눌림목' : strategy === 'DISPARITY' ? '이격매매' : strategy === 'ENVELOPE' ? '엔벨로프' : '변동성 돌파';
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
            {strategy === 'NEW_HIGH' ? (
              <div className="condition-copy"><strong>롱 포지션</strong>{newHighRules.long.map((text, index) => <p key={text}>{index + 1}. {text}</p>)}
                <strong>숏 포지션</strong>{newHighRules.short.map((text, index) => <p key={text}>{index + 1}. {text}</p>)}
                <strong>공통 체결·자금 기준</strong><p>{newHighRules.common}</p>
              </div>
            ) : strategy === 'PULLBACK' ? (
              <div className="condition-copy">
                <strong>롱 포지션</strong>
                <p>1. MA20 &gt; MA60 &gt; MA120 정배열이 최근 5개 캔들에서 계속 유지됩니다.</p>
                <p>2. MA60과 MA120이 각각 5개 캔들 연속 상승하고, MA60−MA120 값도 5개 캔들 연속 증가합니다.</p>
                <p>3. 직전 10개 캔들 중 고가가 당시 엔벨로프 상단 이상이었던 캔들이 하나 이상 있어야 합니다.</p>
                <p>4. 현재 종가가 MA20 이하일 때 종가로 롱 진입합니다.</p>
                <p>5. MA60 터치 시 전량 청산하고, 엔벨로프 상단 터치 시에도 전량 청산합니다.</p>
                <p>6. MA20·MA60·MA120 정배열이 깨지면 해당 캔들 종가로 전량 청산합니다.</p>
                <strong>숏 포지션</strong>
                <p>위 조건을 반대로 적용합니다. 직전 10개 캔들 중 저가가 당시 엔벨로프 하단 이하였던 캔들이 하나 이상 있어야 하며, MA20 &lt; MA60 &lt; MA120, MA60·MA120 하락, MA60−MA120 감소, 현재 종가가 MA20 이상일 때 진입합니다. MA60 터치·엔벨로프 하단·정배열 이탈 시 청산합니다.</p>
                <p>엔벨로프 중심선은 입력한 SMA, 상·하단은 중심선에서 입력한 이격률만큼 떨어진 가격입니다. 별도 SL·분할매수·부분 TP는 사용하지 않습니다.</p>
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
                <p>모든 탭의 중심선·매매·통계는 1h로 고정합니다. 중심선은 1h SMA5·10·20·40·60·80·100·120입니다. 봉 시작 전 확정된 N개 종가 평균을 사용하며 봉 안에서는 밴드를 고정합니다.</p>
                <p>‘일봉 MA20 5봉 추세 필터’를 켜면 진입 전 일봉 MA20의 5봉 변화율 = (최근 확정 일봉 MA20 ÷ 5일봉 전 MA20 − 1) × 100을 확인합니다. 롱은 +0.5% 이상 상승, 숏은 −0.5% 이하 하락일 때만 진입합니다. 진행 중인 일봉은 사용하지 않으며 확정 일봉 25개가 없으면 신규 진입하지 않습니다. 체크를 끄면 이 조건과 분석용 일봉 조회를 생략합니다.</p>
                <p>상단 = 중심선 × (1 + 이격%/100), 하단 = 중심선 × (1 − 이격%/100)</p>
                <strong>롱 포지션</strong>
                <p>하단 아래로 이탈한 봉 다음의 다른 봉에서 하단을 위로 재돌파할 때 하단 라인에 진입합니다. 같은 봉 안에서 이탈·복귀한 경우는 진입하지 않습니다.</p>
                <p>이미 복귀한 시가라면 하단 ≤ 현재가 ≤ (하단 + 중앙선) ÷ 2일 때만 그 시가에 진입합니다. 허용 범위를 넘은 갭은 추격하지 않습니다. 초기 SL = 실제 매수가 × (1 − 이격%/100). 중심선 접촉에 전량 청산합니다.</p>
                <strong>숏 포지션</strong>
                <p>상단 위로 이탈한 봉 다음의 다른 봉에서 상단을 아래로 재돌파할 때 상단 라인에 진입합니다. 이미 복귀한 시가라면 (상단 + 중앙선) ÷ 2 ≤ 현재가 ≤ 상단일 때만 진입합니다. 초기 SL = 실제 매수가 × (1 + 이격%/100). 중심선 접촉에 전량 청산합니다.</p>
                <p>중심선에 닿으면 봉 마감을 기다리지 않고 전량 청산합니다. 반대 밴드까지 기다리거나 중심선 접촉 후 SL을 옮기지 않습니다. 초기 SL은 청산까지 유지하며 추가 매수는 없습니다. 중심선·밴드는 매 봉 시작에 확정된 과거 종가로 갱신합니다. SL 갭은 시가에 손절하며 진입·손절 시장가에 0.02% 슬리피지, 편도 0.055% 수수료를 반영합니다.</p>
                <p>선택 봉의 시가→고가→저가→종가와 시가→저가→고가→종가 두 경로 중 보수적인 결과를 사용합니다. 양쪽 밴드가 모두 닿는 봉은 진입 방향도 경로에 따라 비교합니다. 봉 중간 체결 시각은 봉 시작 시각의 추정치이며 정확한 틱 재현은 아닙니다.</p>
                <p>한 종목은 봉당 한 번만 진입하고 봉 시작에 보유했다면 같은 봉에 재진입하지 않습니다. 전체종목은 종목명 순서·봉 시작 가용자금 한도로 배분하며 미래 청산 자금을 재사용하지 않습니다. 기간 말 미청산분은 평가액에 포함합니다.</p>
                <p>개별통계·전체통계는 1h에서 방향당 최대 1,600조합, 롱+숏 최대 3,200조합을 비교합니다. 입력 배율을 고정해 8개 SMA·이격 0.1~20.0%(0.1 단위)만 비교합니다. 매매횟수·수익률·최소수익비 필터를 모두 통과한 결과만 표시하며 수익률 또는 승률 내림차순의 최상위 세팅을 방향별로 선정합니다. 이전 승률 60% 고정 조건은 사용하지 않습니다. 수익비 = 수익금 ÷ (수익금 + 손실금의 절댓값) × 100이며 수수료를 뺀 완료 매매 기준입니다. 실제 접촉 없는 더 넓은 이격은 건너뛰며 자동 배율 탐색은 하지 않습니다.</p>
                <p>전체통계는 슬리피지 필터 없이 모든 활성 USDT 종목에서 조건을 충족한 방향별 세팅을 저장합니다. 가상매매는 선정한 중심선·이격을 고정하고 별도로 입력한 기간·초기자금·베팅액·레버리지로 검증합니다. 검증 기간으로 다시 최적화하지 않습니다. 선정 기간과 겹치거나 그 이전을 검증하면 화면에 표시하며 실제 미래 성과를 보장하지 않습니다.</p>
                {settings.envelopeRisk ? <p className="notice">통계에서 불러온 세팅은 현재 공개 위험한도에 따른 격리 LIQ 예상치를 사용합니다. 시가 갭이 SL과 LIQ를 모두 넘으면 남은 포지션 증거금을 소진하는 추정 청산으로 처리합니다. 실제 계좌·과거 거래소 청산가와 다를 수 있습니다.</p> : null}
              </div>
            ) : (
              <div className="condition-copy">
                <p>신호는 선택한 주기의 완성 캔들에서 조건을 확인하지만, 체결은 종가까지 기다리지 않고 해당 캔들 안의 조건 충족 가격으로 추정합니다.</p>
                <strong>롱 포지션</strong>
                <p>1. 직전 5개 캔들의 몸통 전체가 각 캔들의 MA5 아래에 있습니다.</p>
                <p>2. 현재 캔들의 고가·저가 중간값이 MA5 이상입니다. 즉, 캔들 전체 길이 기준 MA5 위·아래 길이가 같거나 위쪽이 더 깁니다.</p>
                <p>3. 현재 캔들 몸통 크기가 직전 캔들 몸통의 2배 이상입니다.</p>
                <p>4. SL은 실제 매수가에서 ATR×2만큼 아래 가격입니다. ATR은 선택 주기의 직전 20일 TR 단순평균입니다.</p>
                <p>5. 수익구간에서만, 보유 후 완성된 캔들의 고가·저가 중간값이 MA5 이하가 되는 시점에 종가로 전량 청산합니다. 매수가 이하에서는 MA5를 하락 이탈해도 청산하지 않습니다.</p>
                <strong>숏 포지션</strong>
                <p>1. 직전 5개 캔들의 몸통 전체가 각 캔들의 MA5 위에 있습니다.</p>
                <p>2. 현재 캔들의 고가·저가 중간값이 MA5 이하입니다. 즉, 캔들 전체 길이 기준 MA5 아래·위 길이가 같거나 아래쪽이 더 깁니다.</p>
                <p>3. 현재 캔들 몸통 크기가 직전 캔들 몸통의 2배 이상입니다.</p>
                <p>4. SL은 실제 매수가에서 ATR×2만큼 위 가격입니다. ATR은 선택 주기의 직전 20일 TR 단순평균입니다.</p>
                <p>5. 수익구간에서만, 보유 후 완성된 캔들의 고가·저가 중간값이 MA5 이상이 되는 시점에 종가로 전량 청산합니다. 매수가 이상에서는 MA5를 상승 이탈해도 청산하지 않습니다.</p>
                <strong>공통 체결 기준</strong>
                <p>거래량 증가 조건과 변동폭 최소·K1·K2 입력값은 사용하지 않습니다. 1분봉을 조회하지 않고 선택 주기 캔들의 고가·저가 경계를 기준으로 MA5 위·아래 길이가 같아지는 가격과 몸통 2배 가격 중 조건이 충족되는 지점을 중간 체결가로 추정합니다. 롱 추정가는 `max(시가 + 직전 몸통×2, MA5×2 − 저가)`, 숏은 반대로 `min(시가 − 직전 몸통×2, MA5×2 − 고가)`입니다. 진입·SL에는 0.02% 슬리피지와 편도 0.055% 수수료를 반영합니다. MA5 이탈 청산은 실제 매수가보다 유리한 수익구간에서만 적용하며, 완성된 보유 캔들의 고가·저가 중간값으로 확인해 해당 캔들 종가에 청산합니다.</p>
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

          <h2>{strategy === 'ENVELOPE' ? '중심선 · 매매 기준 1h' : '캔들 주기'}</h2>
          {strategy === 'ENVELOPE' ? <p className="notice small">1시간봉 고정</p> : <div className={`segmented${strategy === 'NEW_HIGH' ? '' : ' four'}`}>
            {(strategy === 'NEW_HIGH' ? ['1h', '4h'] as const : ['15m', '1h', '4h', '1d'] as const).map((interval) => <button key={interval} type="button" className={settings.interval === interval ? 'selected' : ''} onClick={() => update('interval', interval)}>{interval.toUpperCase()}</button>)}
          </div>}

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

          {strategy === 'NEW_HIGH' ? <>
            <label className="field-label">신고가 기준 봉수<input type="number" inputMode="numeric" min="6" max="1000" step="1" value={settings.newHighLookback ?? '20'} onChange={event => update('newHighLookback', event.target.value)} /><small>6~1000 · 기본 20 · 현재 봉 제외 · 최근 5봉에 고가/저가가 있으면 제외</small></label>
            <label className="field-label">SL 배수 (ATR)<input type="number" inputMode="decimal" min="0.1" max="10" step="0.1" value={settings.newHighSlMultiplier ?? '2'} onChange={event => update('newHighSlMultiplier', event.target.value)} /><small>0.1~10.0 · 기본 2.0 · 롱 매수가−ATR×배수 / 숏 매수가+ATR×배수</small></label>
            <label className="checkbox-row"><input type="checkbox" checked={settings.newHighMa60Enabled === true} onChange={event => update('newHighMa60Enabled', event.target.checked)} /><span>현재가 &gt; MA60 (롱) / 현재가 &lt; MA60 (숏)일 때만 매수</span></label>
            <p className="notice small">돌파 즉시 1회 진입 · 돌파선 ± 1ATR 이내만 매수 · 입력한 SL 배수×ATR 적용</p>
            <p className="muted small">ATR은 직전 20일 TR의 단순평균입니다. 1h는 확정 480봉, 4h는 확정 120봉을 사용하며 종목당 고정 베팅액으로 한 번만 진입합니다. 1ATR 라인을 돌파한 뒤 다음 캔들에서 재이탈하면 청산하며, 2ATR 수익구간에서는 롱 MA5&lt;MA20·숏 MA5&gt;MA20 조건도 적용합니다.</p>
          </> : strategy === 'PULLBACK' ? (
            <>
              <label className="field-label">엔벨로프 SMA<input type="number" inputMode="numeric" min="1" max="120" step="1" value={settings.envelopeMaPeriod ?? '20'} onChange={event => update('envelopeMaPeriod', event.target.value.replace(/\D/g, '').slice(0, 3))} /><small>1~120 · 기본 20</small></label>
              <label className="field-label">엔벨로프 이격 (%)<span className="suffix-field"><input type="number" inputMode="decimal" min="0.1" max="20" step="0.1" value={settings.envelopeDeviationPercent ?? '5.0'} onChange={event => update('envelopeDeviationPercent', event.target.value)} /><b>%</b></span><small>0.1~20.0 · 기본 5.0</small></label>
              <p className="notice small">MA20·MA60·MA120 5봉 정배열·추세·간격 증가 후 MA20 눌림 진입 · 엔벨로프 반대 밴드 터치 또는 정배열 이탈 청산</p>
            </>
          ) : strategy === 'DISPARITY' ? (
            <>
              <label className="field-label">MA60 최소 이격률 (%)<input inputMode="decimal" value={settings.minDisparityPercent} onChange={(event) => update('minDisparityPercent', event.target.value)} /><small>0.1~10.0</small></label>
              <label className="checkbox-row"><input type="checkbox" checked={settings.ma20HalfCloseEnabled} onChange={(event) => update('ma20HalfCloseEnabled', event.target.checked)} /><span>캔들 절반 MA20 청산</span></label>
              <label className="field-label">ROI 손실 청산 (%)<input inputMode="numeric" value={settings.roiClosePercent} onChange={(event) => update('roiClosePercent', event.target.value.replace(/\D/g, '').slice(0, 3))} /><small>레버리지 적용 ROI · 1~100</small></label>
            </>
          ) : strategy === 'ENVELOPE' ? (
            <>
              <EnvelopeTrendControl enabled={settings.envelopeDailyTrend !== false} onChange={enabled => update('envelopeDailyTrend', enabled)} />
              <h2>엔벨로프 중심선 봉수</h2>
              <div className="segmented four envelope-periods">{envelopePeriods.map(period => <button key={period} type="button" className={Number(settings.envelopeMaPeriod ?? '20') === period ? 'selected' : ''} onClick={() => update('envelopeMaPeriod', String(period))}>MA{period}</button>)}</div>
              <label className="field-label">엔벨로프 이격 (%)<span className="suffix-field"><input type="number" min="0.1" max="20" step="0.1" inputMode="decimal" value={settings.envelopeDeviationPercent ?? '0.5'} onChange={event => update('envelopeDeviationPercent', event.target.value)} /><b>%</b></span><small>0.1~20.0 · 상단·하단 각각 적용 · SL도 같은 비율</small></label>
              <p className="notice small">고정 조건: 서로 다른 봉의 이탈 후 재돌파 진입 · 중심선 터치 시 전량 청산 · 초기 SL 유지</p>
            </>
          ) : strategy === 'VOLATILITY' ? (
            <p className="notice small">MA5 몸통 위치·몸통 크기 2배·직전 5개 캔들 조건으로 진입가를 캔들 중간에서 추정하고, 실제 매수가 기준 ±2ATR SL을 적용합니다. 1분봉·거래량·변동폭·K1·K2 조건은 사용하지 않습니다.</p>
          ) : (
            <></>
          )}
          {strategy === 'VOLATILITY' ? (
            <p className="muted small">매수 캔들의 고가·저가 경계 안에서 MA5 절반 돌파와 몸통 2배가 충족되는 가격을 추정해 진입하며, SL은 실제 매수가 ±2ATR로 고정합니다. ATR은 선택 주기의 직전 20일 TR 단순평균이며, 실제 매수가보다 유리한 구간에서만 완성 캔들의 고가·저가 중간값이 MA5를 이탈하면 종가에 청산합니다.</p>
          ) : strategy !== 'ENVELOPE' && strategy !== 'NEW_HIGH' && strategy !== 'PULLBACK' ? (
            <>
              <label className="checkbox-row"><input type="checkbox" checked={settings.partialTpEnabled} onChange={(event) => update('partialTpEnabled', event.target.checked)} /><span>부분 TP 50%</span></label>
              <p className="muted small">매수가와 신호 시점 MA60의 중간에서 50% 청산하고 SL을 최초 매수가로 옮깁니다.</p>
            </>
          ) : null}

          </fieldset>
          <div className="action-row">
            <button className="primary-button" type="button" disabled={running || statisticsRunning || anyAnalysisBusy || Boolean(activeServer)} onClick={() => run()}>{running || activeServer ? '분석 진행 중' : localJob?.status === 'PAUSED' ? '새 분석 시작' : '분석 시작'}</button>
            {running || activeServer ? <button className="danger-button" type="button" onClick={() => void cancel()}>{running ? '분석 일시정지' : '분석 중지'}</button> : null}
          </div>
          {!running && !statisticsRunning && !activeServer && localJob?.status === 'PAUSED' && canResumeLocalJob(localJob) ? <button className="outline-button" type="button" onClick={() => run(true)}>분석 이어하기</button> : null}
          {localJob && localJob.status !== 'COMPLETED' ? <p className="muted small">화면을 끄거나 탭을 닫으면 분석이 정지될 수 있습니다. 다시 열어 ‘분석 이어하기’를 누르면 저장된 지점부터 계속합니다.</p> : null}
          {error && strategy !== 'VOLATILITY' && strategy !== 'ENVELOPE' && strategy !== 'NEW_HIGH' && strategy !== 'PULLBACK' && !running && !activeServer ? <button className="outline-button" type="button" onClick={() => void runServer('AWS 분석 서버에서 분석합니다.').catch(failure => setError(failure instanceof Error ? failure.message : '분석 요청에 실패했습니다.'))}>서버에서 분석</button> : null}
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
