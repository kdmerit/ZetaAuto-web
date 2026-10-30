/** IndexedDB shared by pages and workers. Only public candles and simulation data are stored. */
import type { BacktestInterval, Candle } from './types';

const databaseName = 'zetaauto-web-cache';
const databaseVersion = 2;
export const retentionMs = 30 * 86_400_000;
const maxCacheBytes = 2 * 1024 ** 3;
const pageSize = 1000;
let database: Promise<IDBDatabase> | null = null;
let maintenanceAt = 0;

export type StoreName = 'jobs' | 'prepared' | 'results' | 'publicData' | 'leases';
interface ValueRecord<T> { key: string; value: T; updatedAt: number }
interface CandlePage { key: [string, string, number]; candles: Candle[] }
interface PageMetadata { key: [string, string, number]; bytes: number; usedAt: number }

export function openCacheDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('이 브라우저에서는 저장소를 사용할 수 없습니다.')); return; }
    const request = indexedDB.open(databaseName, databaseVersion);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      // The v1 store is retained and migrated one record at a time after upgrade.
      for (const name of ['pages', 'pageMetadata', 'jobs', 'prepared', 'results', 'publicData', 'leases']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); database = null; };
      resolve(db);
    };
    request.onerror = () => { database = null; reject(request.error ?? new Error('저장소를 열지 못했습니다.')); };
    request.onblocked = () => { blocked = true; database = null; reject(new Error('다른 백테스트 탭을 닫은 뒤 다시 열어 주세요.')); };
  });
  return database;
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('저장소 용량 또는 접근 권한을 확인해 주세요.'));
  });
}

function valueOf<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readValue<T>(store: StoreName, key: string): Promise<T | null> {
  const db = await openCacheDatabase();
  const row = await valueOf(db.transaction(store).objectStore(store).get(key)) as ValueRecord<T> | undefined;
  return row?.value ?? null;
}

export async function writeValue<T>(store: StoreName, key: string, value: T): Promise<void> {
  const db = await openCacheDatabase();
  const transaction = db.transaction(store, 'readwrite');
  const done = completed(transaction);
  transaction.objectStore(store).put({ key, value, updatedAt: Date.now() } satisfies ValueRecord<T>);
  await done;
}

export async function deleteValue(store: StoreName, key: string): Promise<void> {
  const db = await openCacheDatabase();
  const transaction = db.transaction(store, 'readwrite');
  const done = completed(transaction);
  transaction.objectStore(store).delete(key);
  await done;
}

export async function deletePrefix(store: StoreName, prefix: string): Promise<void> {
  const db = await openCacheDatabase();
  const transaction = db.transaction(store, 'readwrite');
  const done = completed(transaction);
  const cursor = transaction.objectStore(store).openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
  cursor.onsuccess = () => { if (cursor.result) { cursor.result.delete(); cursor.result.continue(); } };
  await done;
}

/** Atomic lease also covers browsers without the Web Locks API. A dead tab expires automatically. */
export async function lease(owner: string, release = false): Promise<boolean> {
  const db = await openCacheDatabase();
  const transaction = db.transaction('leases', 'readwrite');
  const done = completed(transaction);
  const store = transaction.objectStore('leases');
  let acquired = false;
  const request = store.get('analysis');
  request.onsuccess = () => {
    const row = request.result as { owner: string; expiresAt: number } | undefined;
    if (row && row.owner !== owner && row.expiresAt > Date.now()) return;
    acquired = true;
    if (release) store.delete('analysis');
    else store.put({ key: 'analysis', owner, expiresAt: Date.now() + 45_000 });
  };
  await done;
  return acquired;
}

function seconds(interval: string): number {
  return interval === '15m' ? 900 : interval === '1h' ? 3600 : interval === '4h' ? 14_400 : 86_400;
}

export async function readCandlePages(symbol: string, interval: string, start: number, end: number): Promise<Candle[]> {
  if (end <= start) return [];
  const db = await openCacheDatabase();
  const span = seconds(interval) * pageSize;
  const range = IDBKeyRange.bound([symbol, interval, Math.floor(start / span)], [symbol, interval, Math.floor((end - 1) / span)]);
  const pages = await valueOf(db.transaction('pages').objectStore('pages').getAll(range)) as CandlePage[];
  const transaction = db.transaction('pageMetadata', 'readwrite');
  const done = completed(transaction);
  for (const page of pages) transaction.objectStore('pageMetadata').put({ key: page.key, bytes: page.candles.length * 128 + 256, usedAt: Date.now() } satisfies PageMetadata);
  await done;
  return pages.flatMap(page => page.candles).filter(candle => candle.openTime >= start && candle.openTime < end && candle.closeTime <= Date.now() / 1000);
}

export async function writeCandlePages(symbol: string, interval: string, candles: Candle[]): Promise<void> {
  const db = await openCacheDatabase();
  const span = seconds(interval) * pageSize;
  const groups = new Map<number, Candle[]>();
  for (const candle of candles) {
    if (!Object.values(candle).every(Number.isFinite) || candle.closeTime > Date.now() / 1000 || candle.openTime % seconds(interval) !== 0) continue;
    const bucket = Math.floor(candle.openTime / span);
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket)!.push(candle);
  }
  if (!groups.size) return;
  const transaction = db.transaction(['pages', 'pageMetadata'], 'readwrite');
  const done = completed(transaction);
  const store = transaction.objectStore('pages');
  for (const [bucket, rows] of groups) {
    const key: CandlePage['key'] = [symbol, interval, bucket];
    const request = store.get(key);
    request.onsuccess = () => {
      const previous = request.result as CandlePage | undefined;
      const merged = new Map((previous?.candles ?? []).map(candle => [candle.openTime, candle]));
      rows.forEach(candle => merged.set(candle.openTime, candle));
      const combined = [...merged.values()].sort((a, b) => a.openTime - b.openTime);
      store.put({ key, candles: combined } satisfies CandlePage);
      transaction.objectStore('pageMetadata').put({ key, bytes: combined.length * 128 + 256, usedAt: Date.now() } satisfies PageMetadata);
    };
  }
  await done;
}

async function migrateLegacy(db: IDBDatabase): Promise<void> {
  if (!db.objectStoreNames.contains('candles')) return;
  // Read at most one old range in memory; delete only after its new pages commit.
  for (;;) {
    const row = await valueOf(db.transaction('candles').objectStore('candles').openCursor());
    if (!row) return;
    const old = row.value as { cacheKey: string; candles: Candle[]; savedAt: number };
    const [symbol, interval] = old.cacheKey.split(':');
    if (symbol && interval && old.savedAt >= Date.now() - retentionMs) await writeCandlePages(symbol, interval, old.candles);
    const transaction = db.transaction('candles', 'readwrite');
    const done = completed(transaction);
    transaction.objectStore('candles').delete(row.primaryKey);
    await done;
  }
}

/** Metadata-only eviction avoids copying the complete candle database into RAM. */
export async function maintainCache(force = false): Promise<void> {
  if (!force && Date.now() - maintenanceAt < 60_000) return;
  maintenanceAt = Date.now();
  const db = await openCacheDatabase();
  await migrateLegacy(db);
  const metadata = await valueOf(db.transaction('pageMetadata').objectStore('pageMetadata').getAll()) as PageMetadata[];
  let budget = maxCacheBytes;
  try {
    const estimate = await navigator.storage?.estimate();
    if (estimate?.quota) budget = Math.min(budget, Math.floor(estimate.quota * 0.6));
  } catch { /* Browser quota estimates are optional. */ }
  let kept = 0;
  const transaction = db.transaction(['pages', 'pageMetadata', 'jobs', 'prepared', 'results', 'publicData'], 'readwrite');
  const done = completed(transaction);
  for (const row of metadata.sort((a, b) => b.usedAt - a.usedAt)) {
    if (row.usedAt < Date.now() - retentionMs || kept + row.bytes > budget) {
      transaction.objectStore('pages').delete(row.key);
      transaction.objectStore('pageMetadata').delete(row.key);
    } else kept += row.bytes;
  }
  for (const name of ['jobs', 'prepared', 'results', 'publicData'] as const) {
    const recent: { key: string; updatedAt: number }[] = [];
    const request = transaction.objectStore(name).openCursor();
    request.onsuccess = () => {
      if (!request.result) {
        if (name === 'results') recent.sort((a, b) => b.updatedAt - a.updatedAt).slice(300).forEach(row => transaction.objectStore(name).delete(row.key));
        return;
      }
      const row = request.result.value as ValueRecord<unknown>;
      if (row.updatedAt < Date.now() - retentionMs) request.result.delete();
      else if (name === 'results' && !row.key.startsWith('checkpoint:')) recent.push({ key: row.key, updatedAt: row.updatedAt });
      request.result.continue();
    };
  }
  await done;
}

export async function cacheCandles(symbol: string, interval: BacktestInterval, candles: Candle[]): Promise<void> {
  try {
    await writeCandlePages(symbol, interval, candles);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error;
    // Retry once after evicting the oldest quarter when a real browser quota is lower than its estimate.
    const db = await openCacheDatabase();
    const rows = await valueOf(db.transaction('pageMetadata').objectStore('pageMetadata').getAll()) as PageMetadata[];
    const transaction = db.transaction(['pages', 'pageMetadata'], 'readwrite');
    const done = completed(transaction);
    rows.sort((a, b) => a.usedAt - b.usedAt).slice(0, Math.max(1, Math.ceil(rows.length / 4))).forEach(row => {
      transaction.objectStore('pages').delete(row.key);
      transaction.objectStore('pageMetadata').delete(row.key);
    });
    await done;
    await writeCandlePages(symbol, interval, candles);
  }
}
