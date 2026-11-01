import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openCacheDatabase, readValue, writeValue } from './database';
import { isWeeklyUniverse, loadLocalWeeklyUniverse, loadWeeklyUniverse, saveLocalWeeklyUniverse, saveWeeklyUniverse, universeRetentionMs, weeklyUniverseDatabaseKey, weeklyUniverseStorageKey } from './universeCache';

const instruments = [
  { symbol: 'AAAUSDT', launchAt: 0, LONG: true, SHORT: false },
  { symbol: 'BBBUSDT', launchAt: 100, LONG: false, SHORT: true },
  { symbol: 'CCCUSDT', launchAt: 200, LONG: false, SHORT: false },
];
let values: Map<string, string>;
beforeEach(async () => {
  const db = await openCacheDatabase();
  await new Promise<void>(resolve => {
    const transaction = db.transaction([...db.objectStoreNames], 'readwrite');
    for (const name of db.objectStoreNames) transaction.objectStore(name).clear();
    transaction.oncomplete = () => resolve();
  });
  values = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('weekly shared universe cache', () => {
  it('retains both direction flags, persists to localStorage, and expires at exactly seven days', async () => {
    const snapshot = await saveWeeklyUniverse(instruments);
    saveLocalWeeklyUniverse(snapshot);
    expect(loadLocalWeeklyUniverse()).toEqual(snapshot);
    expect(snapshot.instruments).toEqual(instruments);
    expect(snapshot.expiresAt - snapshot.checkedAt).toBe(universeRetentionMs);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(snapshot.expiresAt - 1);
    expect(await loadWeeklyUniverse()).toEqual(snapshot);
    vi.setSystemTime(snapshot.expiresAt);
    expect(loadLocalWeeklyUniverse()).toBeNull(); expect(await loadWeeklyUniverse()).toBeNull();
  });
  it('restores an IndexedDB copy from a valid localStorage snapshot without a new scan', async () => {
    const snapshot = await saveWeeklyUniverse(instruments);
    saveLocalWeeklyUniverse(snapshot);
    await writeValue('publicData', weeklyUniverseDatabaseKey, null);
    expect(await loadWeeklyUniverse(loadLocalWeeklyUniverse())).toEqual(snapshot);
    expect(await readValue('publicData', weeklyUniverseDatabaseKey)).toEqual(snapshot);
  });
  it('does not replace a newer IndexedDB snapshot with an older page copy', async () => {
    const first = await saveWeeklyUniverse(instruments);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(first.checkedAt + 3600_000);
    const second = await saveWeeklyUniverse(instruments.slice(0, 1));
    expect(await loadWeeklyUniverse(first)).toEqual(second);
  });
  it('rejects corrupted data, changed filter criteria, duplicates, and future timestamps', async () => {
    const snapshot = await saveWeeklyUniverse(instruments);
    for (const patch of [{ version: 2 }, { notionalUsdt: 100 }, { maxSlippagePercent: 1 }, { expiresAt: snapshot.expiresAt + 1 },
      { instruments: [instruments[0], instruments[0]] }, { instruments: [{ ...instruments[0], SHORT: 'false' }] },
      { checkedAt: Date.now() + 86400_000, expiresAt: Date.now() + 86400_000 + universeRetentionMs }]) {
      expect(isWeeklyUniverse({ ...snapshot, ...patch })).toBe(false);
    }
    values.set(weeklyUniverseStorageKey, '{bad json'); expect(loadLocalWeeklyUniverse()).toBeNull();
  });
  it('keeps analysis usable through IndexedDB if localStorage is unavailable or full', async () => {
    const snapshot = await saveWeeklyUniverse(instruments);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } });
    expect(() => saveLocalWeeklyUniverse(snapshot)).not.toThrow(); expect(loadLocalWeeklyUniverse()).toBeNull();
    expect(await loadWeeklyUniverse()).toEqual(snapshot);
  });
});
