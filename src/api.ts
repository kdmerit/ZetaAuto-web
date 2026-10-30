import { chartTimestamp, firstEntryTime } from './chartData';
import type {
  ApiEnvelope,
  BacktestInterval,
  BacktestSettings,
  BacktestTrade,
  Candle,
  ChartData,
  EnrichedCandle,
  ServerJob,
  Strategy,
} from './types';

export interface ApiContext {
  apiBaseUrl: string;
  accessToken: string;
  refreshAccessToken?: () => Promise<string | null>;
}

export interface BacktestRequestBody {
  strategy: Strategy;
  mode: BacktestSettings['mode'];
  symbol: string | null;
  interval: BacktestSettings['interval'];
  startAt: string;
  endAt?: string;
  initialCapitalUsdt: string;
  betAmountUsdt: string;
  side: BacktestSettings['side'];
  leverage: string;
  entryMode: 'SPLIT' | 'ALL_IN';
  ma10CloseEnabled: false;
  partialTpEnabled: boolean;
  fullTpWavePercent?: number;
  minDisparityPercent?: string;
  ma20HalfCloseEnabled?: boolean;
  roiClosePercent?: string;
}

function apiUrl(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('API URL 설정이 올바르지 않습니다.');
  }
  const queryIndex = suffix.indexOf('?');
  const path = queryIndex >= 0 ? suffix.slice(0, queryIndex) : suffix;
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  url.search = queryIndex >= 0 ? suffix.slice(queryIndex) : '';
  return url.toString();
}

async function request<T>(
  context: ApiContext,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const fetchWithToken = async (accessToken: string): Promise<Response> => {
    try {
      return await fetch(apiUrl(context.apiBaseUrl, path), {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new Error('분석 서버에 연결하지 못했습니다. 네트워크 또는 접속 권한을 확인해 주세요.');
    }
  };

  let response = await fetchWithToken(context.accessToken);
  if (response.status === 401 && context.refreshAccessToken) {
    const nextToken = await context.refreshAccessToken();
    if (nextToken) response = await fetchWithToken(nextToken);
  }
  if (!response.ok) {
    if (response.status === 401) throw new Error('로그인이 만료되었습니다.');
    let serverMessage: string | null = null;
    try {
      const payload = (await response.clone().json()) as {
        error?: { message?: unknown };
      };
      if (typeof payload.error?.message === 'string' && payload.error.message.trim()) {
        serverMessage = payload.error.message;
      }
    } catch {
      // Some gateway failures have an empty or non-JSON body.
    }
    if (serverMessage) throw new Error(serverMessage);
    throw new Error(`분석 서버 응답 오류 (${response.status})`);
  }
  return (await response.json()) as T;
}

function normalizeServerTrade(value: Record<string, unknown>): BacktestTrade {
  return {
    tradeId: String(value.tradeId ?? `${value.symbol}-${value.exitAt}`),
    symbol: String(value.symbol),
    side: value.side === 'SHORT' ? 'SHORT' : 'LONG',
    entryAt: Number(value.entryAt),
    exitAt: Number(value.exitAt),
    reason: String(value.reason),
    quantity: Number(value.quantity),
    entryPrice: Number(value.entryPrice),
    exitPrice: Number(value.exitPrice),
    netProfitUsdt: Number(value.netProfitUsdt),
    signalIndex: -1,
    entryIndex: -1,
    exitIndex: -1,
    signal: {
      strategy: 'PULLBACK',
      side: value.side === 'SHORT' ? 'SHORT' : 'LONG',
      index: -1,
      entry: Number(value.entryPrice),
      stop: Number(value.entryPrice),
      target: Number(value.exitPrice),
      initialTarget: Number(value.exitPrice),
    },
    executions: [],
  };
}

function normalizeServerJob(value: unknown): ServerJob {
  const envelope = value as ApiEnvelope<Record<string, unknown>>;
  const raw = envelope.job;
  if (!raw || typeof raw !== 'object') throw new Error('분석 응답이 비어 있습니다.');
  const resultValue = raw.result;
  const result =
    resultValue && typeof resultValue === 'object'
      ? (() => {
          const source = resultValue as Record<string, unknown>;
          const trades = Array.isArray(source.recentTrades)
            ? source.recentTrades
                .filter((trade): trade is Record<string, unknown> => Boolean(trade && typeof trade === 'object'))
                .map(normalizeServerTrade)
            : [];
          return {
            initialCapitalUsdt: Number(source.initialCapitalUsdt),
            finalEquityUsdt: Number(source.finalEquityUsdt),
            returnPercent: Number(source.returnPercent),
            realizedProfitUsdt: Number(source.realizedProfitUsdt),
            unrealizedProfitUsdt: Number(source.unrealizedProfitUsdt),
            feesUsdt: Number(source.feesUsdt),
            maxDrawdownPercent: Number(source.maxDrawdownPercent),
            entryCount: Number(source.entryCount),
            closedTradeCount: Number(source.closedTradeCount),
            winCount: Number(source.winCount),
            lossCount: Number(source.lossCount),
            breakevenCount: Number(source.breakevenCount),
            winRatePercent:
              source.winRatePercent == null ? null : Number(source.winRatePercent),
            openPositionCount: Number(source.openPositionCount),
            insufficientFundsCount: Number(source.insufficientFundsCount),
            betAmountUsdt: Number(source.betAmountUsdt),
            secondFillCount: Number(source.secondFillCount),
            signalCount: Number(source.signalCount),
            observedBars: Number(source.observedBars),
            dataStartAt: source.dataStartAt == null ? null : Number(source.dataStartAt),
            dataEndAt: source.dataEndAt == null ? null : Number(source.dataEndAt),
            exitReasons: (source.exitReasons ?? {}) as Record<string, number>,
            recentTrades: trades,
            equityCurve: Array.isArray(source.equityCurve)
              ? source.equityCurve.map((point) => {
                  const item = point as Record<string, unknown>;
                  return { at: Number(item.at), equityUsdt: Number(item.equityUsdt) };
                })
              : [],
            candles: [],
          };
        })()
      : null;
  return {
    jobId: String(raw.jobId),
    status: String(raw.status) as ServerJob['status'],
    createdAt: String(raw.createdAt),
    updatedAt: String(raw.updatedAt),
    request: (raw.request ?? {}) as Record<string, unknown>,
    strategyVersion: String(raw.strategyVersion ?? ''),
    phase: String(raw.phase) as ServerJob['phase'],
    processedSymbols: Number(raw.processedSymbols ?? 0),
    universeCount: Number(raw.universeCount ?? 0),
    excludedCount: Number(raw.excludedCount ?? 0),
    failedCount: Number(raw.failedCount ?? 0),
    completedBars: Number(raw.completedBars ?? 0),
    totalBars: Number(raw.totalBars ?? 0),
    message: raw.message == null ? null : String(raw.message),
    assumptions: Array.isArray(raw.assumptions) ? raw.assumptions.map(String) : [],
    result,
  };
}

export async function startServerBacktest(
  context: ApiContext,
  body: BacktestRequestBody,
): Promise<ServerJob> {
  return normalizeServerJob(
    await request<ApiEnvelope<Record<string, unknown>>>(
      context,
      '/reference-candle-backtests',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  );
}

export async function getServerBacktest(
  context: ApiContext,
  strategy: Strategy,
  jobId = 'latest',
): Promise<ServerJob | null> {
  const suffix = jobId === 'latest'
    ? `/reference-candle-backtests/latest?strategy=${strategy}`
    : `/reference-candle-backtests/${jobId}`;
  const response = await request<ApiEnvelope<Record<string, unknown>>>(context, suffix);
  if (!response.job) return null;
  return normalizeServerJob(response);
}

export async function cancelServerBacktest(
  context: ApiContext,
  jobId: string,
): Promise<ServerJob> {
  return normalizeServerJob(
    await request<ApiEnvelope<Record<string, unknown>>>(
      context,
      `/reference-candle-backtests/${jobId}`,
      { method: 'POST' },
    ),
  );
}

export async function fetchServerChart(
  context: ApiContext,
  symbol: string,
  side: 'LONG' | 'SHORT',
  referenceAt: string,
  jobId: string,
  tradeId: string,
  beforeAt?: string,
  focusAt?: string,
): Promise<ChartData> {
  const query = new URLSearchParams({
    side,
    referenceAt,
    backtestJobId: jobId,
    backtestTradeId: tradeId,
    ...(beforeAt ? { beforeAt } : {}),
    ...(focusAt ? { focusAt } : {}),
  });
  const response = await request<{ chart: ChartData }>(
    context,
    `/market/charts/${encodeURIComponent(symbol)}?${query.toString()}`,
  );
  return normalizeChart(response.chart);
}

export async function fetchServerEntryChart(
  context: ApiContext,
  symbol: string,
  side: 'LONG' | 'SHORT',
  referenceAt: string,
  jobId: string,
  tradeId: string,
): Promise<ChartData> {
  const chart = await fetchServerChart(context, symbol, side, referenceAt, jobId, tradeId);
  const opened = firstEntryTime(chart);
  if (opened === null || chart.candles.some((candle) => candle.openTime === opened)) return chart;
  return fetchServerChart(context, symbol, side, referenceAt, jobId, tradeId, undefined, new Date(opened * 1000).toISOString());
}

function requiredChartTime(value: unknown): number {
  const seconds = chartTimestamp(value);
  if (seconds === null) throw new Error('차트의 캔들 시각을 확인하지 못했습니다. 다시 열어 주세요.');
  return seconds;
}

function normalizeChart(value: ChartData): ChartData {
  return {
    ...value,
    candles: value.candles.map((candle) => ({
      ...candle,
      openTime: requiredChartTime(candle.openTime),
      closeTime: requiredChartTime(candle.closeTime),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume),
      ma5: candle.ma5 == null ? null : Number(candle.ma5),
      ma10: candle.ma10 == null ? null : Number(candle.ma10),
      ma20: candle.ma20 == null ? null : Number(candle.ma20),
      ma60: candle.ma60 == null ? null : Number(candle.ma60),
      ma120: candle.ma120 == null ? null : Number(candle.ma120),
    })),
    markers: value.markers.map((marker) => ({
      ...marker,
      openTime: requiredChartTime(marker.openTime),
      price: Number(marker.price),
      quantity: Number(marker.quantity),
    })),
    executions: value.executions?.map((marker) => ({
      ...marker,
      openTime: requiredChartTime(marker.openTime),
      price: Number(marker.price),
      quantity: Number(marker.quantity),
      candleIndex: marker.candleIndex ?? -1,
    })),
    waves: value.waves.map((wave) => ({
      ...wave,
      startTime: requiredChartTime(wave.startTime),
      endTime: requiredChartTime(wave.endTime),
      low: Number(wave.low),
      high: Number(wave.high),
    })),
    priceLines: value.priceLines.map((line) => ({ ...line, price: Number(line.price) })),
    referenceAt: String(value.referenceAt),
  };
}

const bybitInterval: Record<BacktestSettings['interval'], string> = {
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1d': 'D',
};

function normalizeBybitRows(rows: unknown, intervalSeconds: number): Candle[] {
  if (!Array.isArray(rows)) throw new Error('Bybit 캔들 응답이 올바르지 않습니다.');
  return rows
    .filter((row): row is unknown[] => Array.isArray(row) && row.length >= 6)
    .map((row) => ({
      openTime: Math.floor(Number(row[0]) / 1000),
      closeTime: Math.floor(Number(row[0]) / 1000) + intervalSeconds,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }))
    .filter((candle) =>
      Object.values(candle).every((value) => Number.isFinite(value)),
    );
}

export async function fetchBybitCandles(
  settings: BacktestSettings,
  onProgress?: (completed: number, total: number) => void,
): Promise<Candle[]> {
  if (settings.mode !== 'SINGLE') throw new Error('브라우저 분석은 개별 종목만 지원합니다.');
  const { symbol, start, end } = candleWindow(settings);
  const candles = await fetchBybitCandlesRange(
    symbol,
    settings.interval,
    start,
    end,
    onProgress,
  );
  if (candles.length < 20) throw new Error('분석 기간의 캔들이 부족합니다.');
  return candles;
}

export async function fetchBybitCandlesRange(
  symbol: string,
  interval: BacktestInterval,
  start: number,
  end: number,
  onProgress?: (completed: number, total: number) => void,
): Promise<Candle[]> {
  const seconds = intervalSeconds(interval);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error('분석 기간을 확인해 주세요.');
  }
  const total = Math.ceil((end - start) / seconds);
  if (total > 30_000) {
    throw new Error('브라우저 분석 범위가 너무 깁니다. 전체 종목·장기간 분석은 AWS 분석을 사용해 주세요.');
  }
  const output = new Map<number, Candle>();
  let cursor = end * 1000;
  let pages = 0;
  while (cursor > start * 1000 && pages < 40) {
    const url = new URL('https://api.bybit.com/v5/market/kline');
    url.search = new URLSearchParams({
      category: 'linear',
      symbol,
      interval: bybitInterval[interval],
      limit: '1000',
      end: String(cursor),
    }).toString();
    const response = await fetch(url);
    if (!response.ok) throw new Error('Bybit 캔들 조회에 실패했습니다. CSV 가져오기를 사용해 주세요.');
    const body = (await response.json()) as {
      retCode?: number;
      result?: { list?: unknown };
    };
    if (body.retCode !== 0 || !body.result?.list) throw new Error('Bybit 캔들 응답을 확인하지 못했습니다.');
    const page = normalizeBybitRows(body.result.list, seconds);
    if (page.length === 0) break;
    for (const candle of page) {
      if (candle.openTime >= start && candle.openTime < end) output.set(candle.openTime, candle);
    }
    const oldest = Math.min(...page.map((candle) => candle.openTime));
    if (!Number.isFinite(oldest) || oldest * 1000 >= cursor) break;
    cursor = oldest * 1000 - 1;
    pages += 1;
    onProgress?.(Math.min(output.size, total), total);
    if (page.length < 1000) break;
  }
  const candles = [...output.values()].sort((a, b) => a.openTime - b.openTime);
  if (candles.length === 0) throw new Error('분석 기간의 캔들이 없습니다.');
  return candles;
}

export function intervalSeconds(interval: BacktestSettings['interval']): number {
  return interval === '15m'
    ? 900
    : interval === '1h'
      ? 3600
      : interval === '4h'
        ? 14400
        : 86400;
}

export function candleWindow(settings: BacktestSettings): {
  symbol: string;
  start: number;
  end: number;
} {
  const symbol = `${settings.symbol.trim().toUpperCase().replace(/USDT$/, '')}USDT`;
  const seconds = intervalSeconds(settings.interval);
  const start = Date.parse(`${settings.startDate}T${settings.startTime}:00+09:00`) / 1000;
  const end = settings.endDate
    ? Date.parse(`${settings.endDate}T${settings.endTime}:00+09:00`) / 1000
    : Math.floor(Date.now() / 1000 / seconds) * seconds;
  return { symbol, start, end };
}

function csvNumber(value: string | undefined): number {
  const result = Number(value?.trim());
  return Number.isFinite(result) ? result : Number.NaN;
}

export function parseCsv(text: string, interval: BacktestSettings['interval']): Candle[] {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(',').map((cell) => cell.replace(/^"|"$/g, '').trim()));
  if (rows.length < 2) throw new Error('CSV 캔들이 없습니다.');
  const header = rows[0]?.map((cell) => cell.toLowerCase()) ?? [];
  const hasHeader = header.some((cell) => /time|open|close/.test(cell));
  const data = hasHeader ? rows.slice(1) : rows;
  const indexOf = (names: string[], fallback: number): number => {
    const index = header.findIndex((cell) => names.some((name) => cell === name || cell.includes(name)));
    return index >= 0 && hasHeader ? index : fallback;
  };
  const timeIndex = indexOf(['time', 'timestamp', 'open_time', 'date'], 0);
  const openIndex = indexOf(['open'], 1);
  const highIndex = indexOf(['high'], 2);
  const lowIndex = indexOf(['low'], 3);
  const closeIndex = indexOf(['close'], 4);
  const volumeIndex = indexOf(['volume', 'vol'], 5);
  const seconds = intervalSeconds(interval);
  const candles = data.map((row) => {
    const rawTime = row[timeIndex] ?? '';
    const parsedTime = Number(rawTime);
    const openTime = Number.isFinite(parsedTime)
      ? (parsedTime > 2_000_000_000_000 ? parsedTime / 1000 : parsedTime)
      : Date.parse(rawTime) / 1000;
    return {
      openTime: Math.floor(openTime),
      closeTime: Math.floor(openTime) + seconds,
      open: csvNumber(row[openIndex]),
      high: csvNumber(row[highIndex]),
      low: csvNumber(row[lowIndex]),
      close: csvNumber(row[closeIndex]),
      volume: csvNumber(row[volumeIndex]),
    };
  }).filter((candle) =>
    candle.openTime > 0 && Object.values(candle).every((value) => Number.isFinite(value)),
  );
  const unique = new Map(candles.map((candle) => [candle.openTime, candle]));
  const result = [...unique.values()].sort((a, b) => a.openTime - b.openTime);
  if (result.length < 20) throw new Error('CSV에서 유효한 캔들을 충분히 찾지 못했습니다.');
  return result;
}

export function enrichCandles(candles: Candle[]): EnrichedCandle[] {
  const ma = (index: number, period: number): number | null => {
    if (index + 1 < period) return null;
    let total = 0;
    for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
      total += candles[cursor]?.close ?? 0;
    }
    return total / period;
  };
  return candles.map((candle, index) => ({
    ...candle,
    ma5: ma(index, 5),
    ma10: ma(index, 10),
    ma20: ma(index, 20),
    ma60: ma(index, 60),
    ma120: ma(index, 120),
  }));
}
