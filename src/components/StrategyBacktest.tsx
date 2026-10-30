import { useEffect, useMemo, useRef, useState } from 'react';

import {
  cancelServerBacktest,
  fetchServerChart,
  getServerBacktest,
  startServerBacktest,
  type ApiContext,
  type BacktestRequestBody,
} from '../api';
import { chartForLocalTrade, runLocalBacktest } from '../localBacktest';
import { estimateBars } from '../engine';
import {
  loadCachedResult,
  loadSettings,
  saveCachedResult,
  saveSettings,
} from '../storage';
import type {
  BacktestResult,
  BacktestSettings,
  BacktestTrade,
  ChartData,
  ServerJob,
  Strategy,
} from '../types';
import { ChartModal } from './ChartModal';
import { ProgressBar } from './ProgressBar';

interface StrategyBacktestProps {
  strategy: Strategy;
  context: ApiContext;
}

function dateText(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function defaultSettings(): BacktestSettings {
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
  };
}

function formatDateInput(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  return digits.length <= 4
    ? digits
    : digits.length <= 6
      ? `${digits.slice(0, 4)}-${digits.slice(4)}`
      : `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
}

function formatTimeInput(value: string): string {
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
  MA60_TOUCH: 'MA60 접촉 청산',
  MA20_HALF_BREAK: '캔들 절반 MA20 청산',
  ROI_LOSS: 'ROI 손실 청산',
};

function defaultRequest(settings: BacktestSettings, strategy: Strategy): BacktestRequestBody {
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
  else {
    body.minDisparityPercent = settings.minDisparityPercent;
    body.ma20HalfCloseEnabled = settings.ma20HalfCloseEnabled;
    body.roiClosePercent = settings.roiClosePercent;
  }
  return body;
}

export function StrategyBacktest({ strategy, context }: StrategyBacktestProps) {
  const defaults = useMemo(defaultSettings, []);
  const [settings, setSettings] = useState<BacktestSettings>(() => loadSettings(strategy, defaults));
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(() => loadCachedResult(strategy));
  const [serverJob, setServerJob] = useState<ServerJob | null>(null);
  const [progress, setProgress] = useState({ phase: '대기 중', completed: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [chart, setChart] = useState<ChartData | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [selectedTrade, setSelectedTrade] = useState<BacktestTrade | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const chartHistoryPushed = useRef(false);

  useEffect(() => {
    const handlePopState = () => {
      if (!chartHistoryPushed.current) return;
      chartHistoryPushed.current = false;
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
    const fallback = loadSettings(strategy, defaults);
    setSettings(fallback);
    setResult(loadCachedResult(strategy));
    setServerJob(null);
    setChart(null);
    void getServerBacktest(context, strategy)
      .then((job) => {
        if (job) setServerJob(job);
      })
      .catch(() => undefined);
  }, [context, defaults, strategy]);

  useEffect(() => {
    if (!serverJob || !['QUEUED', 'RUNNING'].includes(serverJob.status)) return undefined;
    const timer = window.setInterval(() => {
      void getServerBacktest(context, strategy, serverJob.jobId)
        .then((job) => {
          if (job) setServerJob(job);
        })
        .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : '분석 상태를 확인하지 못했습니다.'));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [context, serverJob, strategy]);

  useEffect(() => {
    if (serverJob?.result) setResult(serverJob.result);
  }, [serverJob]);

  const update = <K extends keyof BacktestSettings>(key: K, value: BacktestSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const validate = (): void => {
    if (settings.mode === 'SINGLE' && !baseSymbol(settings.symbol)) throw new Error('종목명을 입력해 주세요.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(settings.startDate) || !/^\d{2}:\d{2}$/.test(settings.startTime)) throw new Error('시작일·시간을 확인해 주세요.');
    if (settings.endDate && (!/^\d{4}-\d{2}-\d{2}$/.test(settings.endDate) || !/^\d{2}:\d{2}$/.test(settings.endTime))) throw new Error('종료일·시간을 확인해 주세요.');
    if (!/^\d+(\.\d{1,2})?$/.test(settings.initialCapitalUsdt) || Number(settings.initialCapitalUsdt) < 10) throw new Error('초기자금을 확인해 주세요.');
    if (!/^\d+(\.\d{1,2})?$/.test(settings.betAmountUsdt) || Number(settings.betAmountUsdt) < 1 || Number(settings.betAmountUsdt) > Number(settings.initialCapitalUsdt)) throw new Error('고정 베팅액을 확인해 주세요.');
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(settings.leverage) || Number(settings.leverage) < 1 || Number(settings.leverage) > 100) throw new Error('레버리지는 1~100배로 입력해 주세요.');
    if (strategy === 'PULLBACK' && (!/^\d+$/.test(settings.fullTpWavePercent) || Number(settings.fullTpWavePercent) < 1 || Number(settings.fullTpWavePercent) > 100)) throw new Error('전체 TP 파동폭은 1~100 정수로 입력해 주세요.');
    if (strategy === 'DISPARITY' && (!/^(0\.[1-9]|[1-9](\.\d)?|10(\.0)?)$/.test(settings.minDisparityPercent))) throw new Error('MA60 이격률은 0.1~10.0%로 입력해 주세요.');
    if (strategy === 'DISPARITY' && (!/^([1-9]|[1-9]\d|100)$/.test(settings.roiClosePercent))) throw new Error('ROI 손실 청산은 1~100 정수로 입력해 주세요.');
    const start = Date.parse(`${settings.startDate}T${settings.startTime}:00+09:00`);
    const end = settings.endDate ? Date.parse(`${settings.endDate}T${settings.endTime}:00+09:00`) : Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start > Date.now()) throw new Error('분석 기간을 확인해 주세요.');
  };

  const runServer = async (reason?: string): Promise<void> => {
    validate();
    saveSettings(strategy, settings);
    setRunning(true);
    setError(null);
    setNotice(reason ?? 'AWS 분석 서버에 작업을 등록했습니다.');
    try {
      const job = await startServerBacktest(context, defaultRequest(settings, strategy));
      setServerJob(job);
      if (job.result) setResult(job.result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '분석 요청에 실패했습니다.');
    } finally {
      setRunning(false);
    }
  };

  const runLocal = async (sourceFile?: File): Promise<void> => {
    validate();
    if (settings.mode !== 'SINGLE') {
      await runServer('전체 종목 분석은 AWS 분석 서버를 사용합니다.');
      return;
    }
    saveSettings(strategy, settings);
    setRunning(true);
    setError(null);
    setNotice(sourceFile ? 'CSV 캔들로 브라우저 분석 중입니다.' : 'Bybit 공개 캔들을 받아 브라우저에서 분석 중입니다.');
    try {
      const next = await runLocalBacktest(settings, strategy, (nextProgress) => {
        setProgress({ phase: nextProgress.phase === 'DATA' ? '캔들 조회 중' : '전략 계산 중', completed: nextProgress.completed, total: nextProgress.total });
      }, sourceFile);
      saveCachedResult(strategy, next);
      setResult(next);
      setNotice('브라우저 분석이 완료되었습니다.');
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : '브라우저 분석에 실패했습니다.';
      if (!sourceFile && /Bybit|CORS|너무 깁니다/.test(message)) {
        await runServer('브라우저 캔들 조회가 불가능해 AWS 분석 서버로 전환합니다.');
      } else setError(message);
    } finally {
      setRunning(false);
    }
  };

  const run = async (): Promise<void> => {
    try {
      if (settings.mode === 'ALL' || estimateBars(settings) > 30_000) await runServer('분석 범위가 길거나 전체 종목이므로 AWS 분석 서버를 사용합니다.');
      else await runLocal();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '입력값을 확인해 주세요.');
    }
  };

  const cancel = async (): Promise<void> => {
    if (!serverJob || !['QUEUED', 'RUNNING'].includes(serverJob.status)) return;
    try {
      setNotice('분석 중지 요청 중입니다.');
      setServerJob(await cancelServerBacktest(context, serverJob.jobId));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '분석 중지에 실패했습니다.');
    }
  };

  const openTrade = async (trade: BacktestTrade): Promise<void> => {
    setSelectedTrade(trade);
    setChartLoading(true);
    setError(null);
    try {
      if (serverJob?.result && serverJob.jobId && trade.tradeId && trade.symbol !== 'LOCAL') {
        setChart(await fetchServerChart(context, trade.symbol, trade.side, new Date(trade.exitAt * 1000).toISOString(), serverJob.jobId, trade.tradeId));
      } else if (result) {
        setChart(chartForLocalTrade(result, trade, settings));
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '차트 조회에 실패했습니다.');
    } finally {
      setChartLoading(false);
    }
  };

  const loadOlder = async (): Promise<void> => {
    if (!chart || !selectedTrade || !serverJob || selectedTrade.symbol === 'LOCAL') return;
    const oldest = chart.candles[0]?.openTime;
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const older = await fetchServerChart(context, selectedTrade.symbol, selectedTrade.side, new Date(selectedTrade.exitAt * 1000).toISOString(), serverJob.jobId, selectedTrade.tradeId, new Date(oldest * 1000).toISOString());
      const seen = new Set(chart.candles.map((candle) => candle.openTime));
      setChart({ ...chart, candles: [...older.candles.filter((candle) => !seen.has(candle.openTime)), ...chart.candles] });
    } finally {
      setLoadingOlder(false);
    }
  };

  const closeChart = (): void => {
    const hadHistoryEntry = chartHistoryPushed.current;
    chartHistoryPushed.current = false;
    setChart(null);
    setSelectedTrade(null);
    if (hadHistoryEntry) window.history.back();
  };

  const activeServer = serverJob && ['QUEUED', 'RUNNING'].includes(serverJob.status);
  const title = strategy === 'PULLBACK' ? '눌림목' : '이격매매';
  const resultTrades = result?.recentTrades ? [...result.recentTrades].reverse() : [];

  return (
    <main className="screen">
      <div className="content strategy-content">
        <header className="page-header strategy-header">
          <div>
            <p className="eyebrow">{strategy} · BACKTEST</p>
            <h1>{title} 백테스트</h1>
          </div>
        </header>
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
            ) : (
              <div className="condition-copy">
                <strong>롱 포지션</strong>
                <p>1. MA20 &lt; 종가 &lt; MA60, 캔들 절반 이상 MA20 위</p>
                <p>2. 몸통 상단 &gt; 이전 5봉 몸통 상단 최댓값, 양봉 몸통 ≥ 0.5%</p>
                <p>3. MA60 이격 ≥ 입력값, 이전 10봉 종가 ≤ 각 봉 MA20</p>
                <p>4. SL은 이전 10봉 최저가, MA60 접촉·선택 조건으로 청산</p>
                <strong>숏 포지션</strong>
                <p>위 조건을 반대로 적용합니다. ROI 손실은 레버리지가 반영된 가격 기준입니다.</p>
              </div>
            )}
          </section>
        ) : null}

        <section className="surface-card form-card">
          <h2>분석 대상</h2>
          <div className="segmented">
            {(['SINGLE', 'ALL'] as const).map((mode) => (
              <button key={mode} type="button" className={settings.mode === mode ? 'selected' : ''} onClick={() => update('mode', mode)}>
                {mode === 'SINGLE' ? '개별 종목' : '전체 종목'}
              </button>
            ))}
          </div>
          <p className="muted">전체 종목은 현재 슬리피지 조건을 통과한 종목만 AWS에서 분석합니다.</p>
          {settings.mode === 'SINGLE' ? (
            <label className="field-label">종목명
              <span className="suffix-field"><input value={baseSymbol(settings.symbol)} onChange={(event) => update('symbol', baseSymbol(event.target.value))} placeholder="BTC" /><b>USDT</b></span>
            </label>
          ) : null}

          <h2>분석 방향</h2>
          <div className="segmented three">
            {(['BOTH', 'LONG', 'SHORT'] as const).map((side) => <button key={side} type="button" className={settings.side === side ? 'selected' : ''} onClick={() => update('side', side)}>{side === 'BOTH' ? '롱 + 숏' : side === 'LONG' ? '롱' : '숏'}</button>)}
          </div>

          <h2>캔들 주기</h2>
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
            <label className="field-label">레버리지<input inputMode="decimal" value={settings.leverage} onChange={(event) => update('leverage', event.target.value)} /><small>1~100배</small></label>
          </div>

          {strategy === 'PULLBACK' ? (
            <label className="field-label">전체 TP 직전 파동폭 (%)<input inputMode="numeric" value={settings.fullTpWavePercent} onChange={(event) => update('fullTpWavePercent', event.target.value.replace(/\D/g, '').slice(0, 3))} /><small>1~100 · 기본 100</small></label>
          ) : (
            <>
              <label className="field-label">MA60 최소 이격률 (%)<input inputMode="decimal" value={settings.minDisparityPercent} onChange={(event) => update('minDisparityPercent', event.target.value)} /><small>0.1~10.0</small></label>
              <label className="checkbox-row"><input type="checkbox" checked={settings.ma20HalfCloseEnabled} onChange={(event) => update('ma20HalfCloseEnabled', event.target.checked)} /><span>캔들 절반 MA20 청산</span></label>
              <label className="field-label">ROI 손실 청산 (%)<input inputMode="numeric" value={settings.roiClosePercent} onChange={(event) => update('roiClosePercent', event.target.value.replace(/\D/g, '').slice(0, 3))} /><small>레버리지 적용 ROI · 1~100</small></label>
            </>
          )}
          <label className="checkbox-row"><input type="checkbox" checked={settings.partialTpEnabled} onChange={(event) => update('partialTpEnabled', event.target.checked)} /><span>부분 TP 50%</span></label>
          <p className="muted small">{strategy === 'PULLBACK' ? '1차 매수가와 최초 TP의 중간에서 50% 청산합니다. 2차 체결 시 미체결 부분 TP는 취소됩니다.' : '매수가와 신호 시점 MA60의 중간에서 50% 청산하고 SL을 최초 매수가로 옮깁니다.'}</p>

          <div className="action-row">
            <button className="primary-button" type="button" disabled={running || Boolean(activeServer)} onClick={() => void run()}>{running ? '분석 진행 중' : activeServer ? '분석 진행 중' : '분석 시작'}</button>
            {activeServer ? <button className="danger-button" type="button" onClick={() => void cancel()}>분석 중지</button> : null}
          </div>
          {settings.mode === 'SINGLE' ? (
            <>
              <input ref={fileInput} type="file" accept=".csv,text/csv" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void runLocal(file); event.currentTarget.value = ''; }} />
              <button className="outline-button" type="button" disabled={running || Boolean(activeServer)} onClick={() => fileInput.current?.click()}>CSV 캔들로 분석</button>
            </>
          ) : null}
          {notice ? <p className="notice">{notice}</p> : null}
          {error ? <p className="error" role="alert">{error}</p> : null}
          {running ? <ProgressBar completed={progress.completed} total={progress.total || Math.max(estimateBars(settings), 1)} label={progress.phase} /> : null}
          {activeServer ? <ProgressBar completed={serverJob.completedBars} total={Math.max(serverJob.totalBars, 1)} label={`${serverJob.phase === 'UNIVERSE' ? '종목 확인' : serverJob.phase === 'DATA' ? '캔들 조회' : '전략 계산'} · ${serverJob.status === 'QUEUED' ? '대기 중' : '분석 중'}`} /> : null}
        </section>

        {result ? <ResultCard result={result} onOpenTrade={(trade) => void openTrade(trade)} /> : null}
      </div>
      {chartLoading ? <div className="modal-backdrop"><div className="loading-card">체결 차트를 불러오는 중입니다…</div></div> : null}
      {chart ? <ChartModal chart={chart} onClose={closeChart} onLoadOlder={selectedTrade?.symbol !== 'LOCAL' ? loadOlder : undefined} loadingOlder={loadingOlder} /> : null}
    </main>
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
              <span>{new Date(trade.entryAt * 1000).toLocaleString('ko-KR')} 진입</span>
              <span>{new Date(trade.exitAt * 1000).toLocaleString('ko-KR')} 청산</span>
              <em className={trade.netProfitUsdt >= 0 ? 'positive' : 'negative'}>청산 손익 {money(trade.netProfitUsdt)} USDT · 체결 차트 보기 ›</em>
            </button>
          ))}
        </div>
      ) : <p className="muted">아직 청산된 거래가 없습니다.</p>}
    </section>
  );
}
