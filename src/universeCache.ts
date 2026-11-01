/** One direction-neutral, weekly slippage snapshot shared by all local backtests. */
import { readValue, writeValue } from './database';
import type { EligibleInstrument } from './marketData';

export const weeklyUniverseStorageKey = 'zetaauto.web.backtest.weeklyUniverse.v1';
export const weeklyUniverseDatabaseKey = 'weekly-universe:v1';
export const universeRetentionMs = 7 * 86_400_000;

export interface WeeklyUniverseSnapshot {
  version: 1;
  checkedAt: number;
  expiresAt: number;
  notionalUsdt: 10000;
  maxSlippagePercent: 0.5;
  instruments: EligibleInstrument[];
}

export function isWeeklyUniverse(value: unknown, now = Date.now()): value is WeeklyUniverseSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<WeeklyUniverseSnapshot>;
  if (snapshot.version !== 1 || snapshot.notionalUsdt !== 10000 || snapshot.maxSlippagePercent !== 0.5
    || typeof snapshot.checkedAt !== 'number' || !Number.isFinite(snapshot.checkedAt) || snapshot.checkedAt > now
    || snapshot.expiresAt !== snapshot.checkedAt + universeRetentionMs || now >= snapshot.expiresAt
    || !Array.isArray(snapshot.instruments) || snapshot.instruments.length < 1 || snapshot.instruments.length > 3000) return false;
  const symbols = new Set<string>();
  return snapshot.instruments.every(instrument => {
    if (!instrument || typeof instrument !== 'object' || typeof instrument.symbol !== 'string'
      || !/^[A-Z0-9]{1,36}USDT$/.test(instrument.symbol) || symbols.has(instrument.symbol)
      || !Number.isFinite(instrument.launchAt) || instrument.launchAt < 0
      || typeof instrument.LONG !== 'boolean' || typeof instrument.SHORT !== 'boolean') return false;
    symbols.add(instrument.symbol); return true;
  });
}

export function loadLocalWeeklyUniverse(): WeeklyUniverseSnapshot | null {
  try {
    const raw = localStorage.getItem(weeklyUniverseStorageKey);
    const value: unknown = raw ? JSON.parse(raw) : null;
    return isWeeklyUniverse(value) ? value : null;
  } catch { return null; }
}

export function saveLocalWeeklyUniverse(snapshot: WeeklyUniverseSnapshot): void {
  if (!isWeeklyUniverse(snapshot)) return;
  try { localStorage.setItem(weeklyUniverseStorageKey, JSON.stringify(snapshot)); }
  catch { /* Quota/private-mode failures leave the worker's IndexedDB copy available. */ }
}

export async function loadWeeklyUniverse(supplied?: WeeklyUniverseSnapshot | null): Promise<WeeklyUniverseSnapshot | null> {
  const stored = await readValue<unknown>('publicData', weeklyUniverseDatabaseKey);
  const previous = isWeeklyUniverse(stored) ? stored : null;
  if (isWeeklyUniverse(supplied) && (!previous || supplied.checkedAt > previous.checkedAt)) {
    await writeValue('publicData', weeklyUniverseDatabaseKey, supplied);
    return supplied;
  }
  return previous;
}

/** Called only after every candidate has been checked; partial refreshes never replace this record. */
export async function saveWeeklyUniverse(instruments: EligibleInstrument[]): Promise<WeeklyUniverseSnapshot> {
  const checkedAt = Date.now();
  const snapshot: WeeklyUniverseSnapshot = { version: 1, checkedAt, expiresAt: checkedAt + universeRetentionMs,
    notionalUsdt: 10000, maxSlippagePercent: 0.5, instruments };
  if (!isWeeklyUniverse(snapshot)) throw new Error('전체종목 필터 결과를 확인하지 못했습니다. 다시 이어가 주세요.');
  await writeValue('publicData', weeklyUniverseDatabaseKey, snapshot);
  return snapshot;
}
