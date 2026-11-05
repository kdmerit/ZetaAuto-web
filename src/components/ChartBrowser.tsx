import { useEffect, useMemo, useRef, useState } from 'react';
import { chartIntervals } from '../chartIntervals';
import { listInstruments, type Instrument } from '../marketData';
import { loadMarketChart, matchingChartInstruments, mergeMarketChartPages, NoMarketCandlesError, normalizeChartQuery } from '../marketChart';
import type { BacktestInterval, ChartData } from '../types';
import { ChartModal } from './ChartModal';

const queryKey = 'zetaauto.web.marketChart.query';
const intervalKey = 'zetaauto.web.marketChart.interval';
function savedQuery(): string { try { return normalizeChartQuery(localStorage.getItem(queryKey) ?? ''); } catch { return ''; } }
function savedInterval(): BacktestInterval { try { const saved = localStorage.getItem(intervalKey); return chartIntervals.includes(saved as BacktestInterval) ? saved as BacktestInterval : '1h'; } catch { return '1h'; } }
function remember(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* Optional preference. */ } }
function isEditableElement(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
}

export function ChartBrowser() {
  const [query, setQuery] = useState(savedQuery); const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [loadingList, setLoadingList] = useState(true); const [listRevision, setListRevision] = useState(0);
  const [error, setError] = useState<string | null>(null); const [historyError, setHistoryError] = useState<string | null>(null);
  const [chart, setChart] = useState<ChartData | null>(null); const [loadingSymbol, setLoadingSymbol] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(false); const [hasOlder, setHasOlder] = useState(true);
  const chartRef = useRef<ChartData | null>(null); const selectedRef = useRef<Instrument | null>(null);
  const historyOpen = useRef(false); const request = useRef(0); const pageBusy = useRef(false); const controller = useRef<AbortController | null>(null);
  const commitChart = (value: ChartData | null): void => { chartRef.current = value; setChart(value); };
  const cancel = (): void => { request.current += 1; controller.current?.abort(); controller.current = null; pageBusy.current = false; };

  useEffect(() => {
    const abort = new AbortController(); setLoadingList(true); setError(null);
    void listInstruments(undefined, abort.signal).then(rows => { if (!abort.signal.aborted) setInstruments(rows); })
      .catch(failure => { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '종목 목록을 불러오지 못했습니다.'); })
      .finally(() => { if (!abort.signal.aborted) setLoadingList(false); });
    return () => abort.abort();
  }, [listRevision]);
  useEffect(() => {
    const back = (event: PopStateEvent): void => {
      if (event.state?.zetaautoChart || !historyOpen.current) return;
      const activeElement = document.activeElement;
      if (isEditableElement(activeElement)) {
        activeElement.blur();
        const state = event.state && typeof event.state === 'object' ? event.state : {};
        window.history.pushState({ ...state, zetaautoApp: true, screen: 'CHARTS', zetaautoChart: true }, '');
        return;
      }
      historyOpen.current = false; cancel(); commitChart(null); setLoadingPage(false); setLoadingSymbol(null);
    };
    window.addEventListener('popstate', back);
    return () => {
      window.removeEventListener('popstate', back); cancel();
      if (historyOpen.current && window.history.state?.zetaautoChart) { historyOpen.current = false; window.history.back(); }
    };
  }, []);
  const close = (): void => {
    cancel(); commitChart(null); setLoadingPage(false); setLoadingSymbol(null); setHistoryError(null);
    if (historyOpen.current) { historyOpen.current = false; window.history.back(); }
  };
  const open = async (instrument: Instrument): Promise<void> => {
    cancel(); const id = request.current; const abort = new AbortController(); controller.current = abort;
    selectedRef.current = instrument; setLoadingSymbol(instrument.symbol); setError(null); setHistoryError(null); setHasOlder(true);
    try {
      const loaded = await loadMarketChart(instrument, savedInterval(), { signal: abort.signal });
      if (id !== request.current || abort.signal.aborted) return;
      window.history.pushState({ ...window.history.state, zetaautoApp: true, screen: 'CHARTS', zetaautoChart: true }, '');
      historyOpen.current = true; commitChart(loaded);
    } catch (failure) { if (id === request.current && !abort.signal.aborted) setError(failure instanceof Error ? failure.message : '차트를 불러오지 못했습니다.'); }
    finally { if (id === request.current) setLoadingSymbol(null); }
  };
  const older = async (): Promise<boolean> => {
    const current = chartRef.current; const instrument = selectedRef.current;
    if (!current || !instrument || !hasOlder || pageBusy.current) return false;
    pageBusy.current = true; setLoadingPage(true); setHistoryError(null);
    const id = request.current; const abort = new AbortController(); controller.current = abort;
    try {
      const page = await loadMarketChart(instrument, current.interval, { beforeAt: current.candles[0]!.openTime, signal: abort.signal });
      if (id !== request.current || abort.signal.aborted) return false;
      const merged = mergeMarketChartPages(page, current); commitChart(merged); return merged.candles.length > current.candles.length;
    } catch (failure) {
      if (id === request.current && !abort.signal.aborted) {
        if (failure instanceof NoMarketCandlesError) setHasOlder(false);
        else setHistoryError(failure instanceof Error ? failure.message : '이전 캔들을 불러오지 못했습니다.');
      }
      return false;
    } finally { if (id === request.current) { pageBusy.current = false; setLoadingPage(false); } }
  };
  const changeInterval = async (interval: BacktestInterval, focusAt: number): Promise<number | null> => {
    if (!selectedRef.current || pageBusy.current) return null;
    pageBusy.current = true; setLoadingPage(true); setHistoryError(null);
    const id = request.current; const abort = new AbortController(); controller.current = abort;
    try {
      const next = await loadMarketChart(selectedRef.current, interval, { focusAt, signal: abort.signal });
      if (id !== request.current || abort.signal.aborted) return null;
      commitChart(next); setHasOlder(true); remember(intervalKey, interval); return next.candles[next.referenceIndex ?? 0]!.openTime;
    } catch (failure) { if (id === request.current && !abort.signal.aborted) setHistoryError(failure instanceof Error ? failure.message : '차트 주기를 변경하지 못했습니다.'); return null; }
    finally { if (id === request.current) { pageBusy.current = false; setLoadingPage(false); } }
  };
  const matches = useMemo(() => matchingChartInstruments(instruments, query), [instruments, query]);
  return <main className="screen"><div className="content strategy-content market-browser">
    <header className="page-header"><div><p className="eyebrow">BYBIT · CHART</p><h1>차트 보기</h1></div></header>
    <section className="surface-card form-card"><label className="field-label">종목명 검색<input aria-label="종목명 검색" value={query} inputMode="text" autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="BTC" onChange={event => {
      const value = normalizeChartQuery(event.target.value); setQuery(value); remember(queryKey, value);
      if (loadingSymbol) { cancel(); setLoadingSymbol(null); }
    }} /></label>
      <p className="muted small">영문 대문자 · 입력한 글자로 시작하는 USDT 종목</p>
      {loadingList ? <p className="muted" role="status">종목 목록을 불러오는 중…</p> : null}
      {error ? <><p className="error" role="alert">{error}</p>{!instruments.length ? <button className="outline-button" type="button" onClick={() => setListRevision(value => value + 1)}>종목 목록 다시 불러오기</button> : null}</> : null}
      {loadingSymbol ? <p className="notice small" role="status">{loadingSymbol} 차트·120일 거래량 자료를 불러오는 중…</p> : null}
      {!loadingList && query ? <><p className="muted small" aria-live="polite">{query}로 시작하는 종목 {matches.length}개</p><div className="market-symbol-list" aria-label="USDT 종목 검색 결과">{matches.map(instrument => <button className="market-symbol" type="button" key={instrument.symbol} onClick={() => { void open(instrument); }}>{instrument.symbol}<span aria-hidden="true">›</span></button>)}</div>{!matches.length ? <p className="muted">해당 글자로 시작하는 USDT 종목이 없습니다.</p> : null}</> : !loadingList ? <p className="muted">종목명의 첫 글자를 입력해 주세요.</p> : null}
    </section>
  </div>{chart ? <ChartModal chart={chart} onClose={close} onLoadOlder={hasOlder ? older : undefined} onIntervalChange={changeInterval} loadingOlder={loadingPage} historyError={historyError} /> : null}</main>;
}
