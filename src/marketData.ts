/** Public Bybit data only: bounded requests, retries, and incremental closed-candle caching. */
import { intervalSeconds } from './api';
import { cacheCandles, readCandlePages, readValue, writeValue } from './database';
import type { CandleInterval, BacktestSettings, Candle } from './types';

export interface Instrument { symbol: string; launchAt: number }
export interface EligibleInstrument extends Instrument { LONG: boolean; SHORT: boolean }
interface PublicSnapshot<T> { expiresAt: number; data: T }
interface ListingPrefix { emptyUntil: number; firstAt?: number }
interface BybitEnvelope<T> { retCode: number; result: T }
const intervals = { '1m': '1', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
let nextRequestAt = 0;

export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

async function publicRequest<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    signal?.throwIfAborted();
    const slot = Math.max(Date.now(), nextRequestAt);
    nextRequestAt = slot + 150;
    await delay(Math.max(0, slot - Date.now()), signal);
    const url = new URL(`https://api.bybit.com/v5/market/${path}`);
    url.search = new URLSearchParams({ category: 'linear', ...params }).toString();
    const timeout = new AbortController();
    const cancel = () => timeout.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => timeout.abort(), 15_000);
    try {
      const response = await fetch(url, { signal: timeout.signal, credentials: 'omit' });
      if (response.status === 429 || response.status >= 500 || response.status === 408) {
        if (attempt === 3) throw new Error('공개 시세 서버가 혼잡합니다. 잠시 후 분석을 이어가 주세요.');
        await delay(1000 * 2 ** attempt, signal);
        continue;
      }
      if (!response.ok) throw new Error(`공개 시세 조회 오류 (${response.status}). 네트워크를 확인해 주세요.`);
      const body = await response.json() as BybitEnvelope<T>;
      if (body.retCode === 10006 || body.retCode === 10016) {
        if (attempt === 3) throw new Error('공개 시세 요청 한도를 초과했습니다. 잠시 후 분석을 이어가 주세요.');
        await delay(1000 * 2 ** attempt, signal);
        continue;
      }
      if (body.retCode !== 0 || !body.result) throw new Error('공개 시세 응답을 확인하지 못했습니다.');
      return body.result;
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt === 3 && error instanceof Error && ['TypeError', 'AbortError'].includes(error.name)) throw new Error('공개 시세에 직접 연결하지 못했습니다. 네트워크를 확인하거나 서버에서 분석을 선택해 주세요.');
      if (attempt === 3 || error instanceof Error && !['TypeError', 'AbortError'].includes(error.name)) throw error;
      await delay(1000 * 2 ** attempt, signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
  throw new Error('공개 시세에 연결하지 못했습니다.');
}

async function snapshot<T>(key: string, loader: () => Promise<T>, maxAge = 300_000): Promise<T> {
  const previous = await readValue<PublicSnapshot<T>>('publicData', key);
  if (previous && previous.expiresAt > Date.now()) return previous.data;
  const data = await loader();
  await writeValue('publicData', key, { expiresAt: Date.now() + maxAge, data });
  return data;
}

export async function listInstruments(symbol?: string, signal?: AbortSignal): Promise<Instrument[]> {
  return snapshot(`instruments:${symbol ?? 'ALL'}`, async () => {
    const output = new Map<string, Instrument>();
    let cursor = '';
    for (let page = 0; page < 20; page += 1) {
      const result = await publicRequest<{ list: Record<string, unknown>[]; nextPageCursor?: string }>('instruments-info', {
        status: 'Trading', limit: '1000', ...(symbol ? { symbol } : {}), ...(cursor ? { cursor } : {}),
      }, signal);
      if (!Array.isArray(result.list)) throw new Error('종목 목록을 확인하지 못했습니다.');
      for (const item of result.list) {
        if (item.quoteCoin !== 'USDT' || item.settleCoin !== 'USDT' || item.status !== 'Trading' || item.isPreListing === true) continue;
        const name = String(item.symbol);
        if (!/^[A-Z0-9]{1,36}USDT$/.test(name)) continue;
        const launched = Number(item.launchTime) / 1000;
        output.set(name, { symbol: name, launchAt: Number.isFinite(launched) ? Math.floor(launched) : 0 });
      }
      if (!result.nextPageCursor) return [...output.values()].sort((a, b) => a.symbol.localeCompare(b.symbol, 'en'));
      if (result.nextPageCursor === cursor) throw new Error('종목 목록 조회가 진행되지 않았습니다.');
      cursor = result.nextPageCursor;
    }
    throw new Error('종목 목록이 조회 한도를 초과했습니다.');
  });
}

/** Average execution price of a 10,000 USDT market order, measured from the midpoint. */
export function orderBookSlippage(bids: number[][], asks: number[][], side: 'LONG' | 'SHORT'): number | null {
  const bid = bids[0]?.[0];
  const ask = asks[0]?.[0];
  if (!bid || !ask || bid <= 0 || ask < bid) return null;
  const midpoint = (bid + ask) / 2;
  let remaining = 10_000;
  let quantity = 0;
  for (const [price, size] of side === 'LONG' ? asks : bids) {
    if (price === undefined || size === undefined || !Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) continue;
    const spent = Math.min(remaining, price * size);
    quantity += spent / price;
    remaining -= spent;
    if (remaining <= 1e-8) return (10_000 / quantity - midpoint) / midpoint * (side === 'LONG' ? 1 : -1);
  }
  return null;
}

export async function instrumentEligibility(instrument: Instrument, signal?: AbortSignal): Promise<EligibleInstrument> {
  const result = await snapshot(`orderbook:${instrument.symbol}`, () => publicRequest<{ b: string[][]; a: string[][] }>('orderbook', { symbol: instrument.symbol, limit: '50' }, signal));
  if (!Array.isArray(result.b) || !Array.isArray(result.a)) throw new Error('호가 정보를 확인하지 못했습니다.');
  const bids = result.b.map(row => row.map(Number));
  const asks = result.a.map(row => row.map(Number));
  const long = orderBookSlippage(bids, asks, 'LONG');
  const short = orderBookSlippage(bids, asks, 'SHORT');
  return { ...instrument, LONG: long !== null && long <= 0.005, SHORT: short !== null && short <= 0.005 };
}

export function analysisWindow(settings: BacktestSettings): { start: number; end: number } {
  const seconds = intervalSeconds(settings.interval);
  const requestedStart = Date.parse(`${settings.startDate}T${settings.startTime}:00+09:00`) / 1000;
  const requestedEnd = settings.endDate ? Date.parse(`${settings.endDate}T${settings.endTime}:00+09:00`) / 1000 : Date.now() / 1000;
  const start = Math.ceil(requestedStart / seconds) * seconds;
  const end = Math.floor(Math.min(requestedEnd, Date.now() / 1000) / seconds) * seconds;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 10 * seconds || start < Date.now() / 1000 - 1825 * 86_400) {
    throw new Error('최근 5년 이내의 완성봉 10개 이상인 기간을 선택해 주세요.');
  }
  return { start, end };
}

async function download(symbol: string, interval: CandleInterval, start: number, end: number, signal?: AbortSignal): Promise<Candle[]> {
  const seconds = intervalSeconds(interval);
  const result = await publicRequest<{ list: string[][] }>('kline', {
    symbol, interval: intervals[interval], limit: '1000', start: String(start * 1000), end: String(end * 1000 - 1),
  }, signal);
  if (!Array.isArray(result.list)) throw new Error('캔들 응답을 확인하지 못했습니다.');
  if (result.list.some(row => !Array.isArray(row) || row.length < 6 || !Number.isFinite(Number(row[0])))) throw new Error('캔들 응답의 시각을 확인하지 못했습니다.');
  const rows = result.list.map(row => ({
    openTime: Number(row[0]) / 1000, closeTime: Number(row[0]) / 1000 + seconds,
    open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]),
  })).filter(candle => candle.openTime >= start && candle.openTime < end && candle.closeTime <= Date.now() / 1000);
  if (rows.some(candle => !Object.values(candle).every(Number.isFinite) || candle.openTime % seconds !== 0
    || Math.min(candle.open, candle.high, candle.low, candle.close) <= 0 || candle.high < Math.max(candle.open, candle.close, candle.low)
    || candle.low > Math.min(candle.open, candle.close) || candle.volume < 0)) {
    throw new Error(`${symbol}의 캔들 가격 또는 시각이 올바르지 않습니다. 다시 이어가 주세요.`);
  }
  return rows.sort((a, b) => a.openTime - b.openTime);
}

/** Read only the needed series pages. Each missing request fills up to 1,000 bars for later blocks. */
export async function ensureCandles(instrument: Instrument, interval: CandleInterval, from: number, end: number, prefetchEnd = end, signal?: AbortSignal): Promise<Candle[]> {
  const seconds = intervalSeconds(interval);
  const listingBucket = Math.floor(instrument.launchAt / seconds) * seconds;
  const prefixKey = `listing-prefix:v1:${instrument.symbol}:${interval}:${instrument.launchAt}`;
  const previousPrefix = instrument.launchAt > 0 ? await readValue<ListingPrefix>('publicData', prefixKey) : null;
  let prefix = previousPrefix ?? { emptyUntil: listingBucket };
  const start = Math.max(Math.floor(from / seconds) * seconds, listingBucket, prefix.emptyUntil);
  if (end <= start) return [];
  const byTime = new Map((await readCandlePages(instrument.symbol, interval, start, end)).map(candle => [candle.openTime, candle]));
  for (let cursor = start; cursor < end; cursor += seconds) {
    signal?.throwIfAborted();
    if (byTime.has(cursor)) continue;
    let nextKnown = cursor + seconds;
    while (nextKnown < Math.min(prefetchEnd, cursor + 1000 * seconds) && !byTime.has(nextKnown)) nextKnown += seconds;
    const fetched = await download(instrument.symbol, interval, cursor, nextKnown, signal);
    await cacheCandles(instrument.symbol, interval, fetched);
    fetched.forEach(candle => byTime.set(candle.openTime, candle));
    if (byTime.has(cursor)) continue;
    // Instrument registration can precede the first trade. Only an API-confirmed empty
    // prefix anchored at listing is skipped; an internal gap must never be bridged.
    if (instrument.launchAt > 0 && prefix.firstAt === undefined && cursor === prefix.emptyUntil) {
      const first = [...byTime.keys()].filter(at => at >= cursor).sort((a, b) => a - b)[0];
      const emptyUntil = Math.min(first ?? nextKnown, nextKnown);
      prefix = { emptyUntil, ...(first !== undefined && first <= nextKnown ? { firstAt: first } : {}) };
      await writeValue('publicData', prefixKey, prefix);
      cursor = emptyUntil - seconds;
      continue;
    }
    // Retry the precise absent bar once in case a broad response was temporarily incomplete.
    const retried = await download(instrument.symbol, interval, cursor, cursor + seconds, signal);
    await cacheCandles(instrument.symbol, interval, retried);
    retried.forEach(candle => byTime.set(candle.openTime, candle));
    if (!byTime.has(cursor)) throw new Error(`${instrument.symbol}의 ${new Date(cursor * 1000).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} 캔들이 누락되었습니다. 다시 이어가 주세요.`);
  }
  return [...byTime.values()].filter(candle => candle.openTime >= start && candle.openTime < end).sort((a, b) => a.openTime - b.openTime);
}
