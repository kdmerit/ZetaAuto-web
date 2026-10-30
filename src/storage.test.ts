import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chartMaStorageKey, loadChartMas, saveChartMas } from './storage';

let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('chart moving-average preferences', () => {
  it('uses defaults only when no stored choices exist', () => {
    expect(loadChartMas()).toEqual({ ma5: true, ma10: false, ma20: true, ma60: false, ma120: false });
  });

  it('restores the last choice including an explicitly disabled MA and all unchecked', () => {
    const choice = { ma5: false, ma10: true, ma20: false, ma60: true, ma120: true };
    saveChartMas(choice);
    expect(loadChartMas()).toEqual(choice);
    const unchecked = { ma5: false, ma10: false, ma20: false, ma60: false, ma120: false };
    saveChartMas(unchecked);
    expect(loadChartMas()).toEqual(unchecked);
  });

  it('fills only missing or invalid fields with defaults and ignores unknown fields', () => {
    values.set(chartMaStorageKey, JSON.stringify({ ma5: false, ma20: 'false', ma60: true, other: true }));
    expect(loadChartMas()).toEqual({ ma5: false, ma10: false, ma20: true, ma60: true, ma120: false });
  });

  it('survives malformed or unavailable local storage', () => {
    for (const raw of ['{', 'null', '[]', 'true']) {
      values.set(chartMaStorageKey, raw);
      expect(loadChartMas().ma5).toBe(true);
    }
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('quota'); },
    });
    expect(loadChartMas().ma20).toBe(true);
    expect(() => saveChartMas(loadChartMas())).not.toThrow();
  });
});
