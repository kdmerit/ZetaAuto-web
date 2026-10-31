import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chartMaStorageKey, loadChartMas, loadSettings, saveChartMas, saveSettings } from './storage';
import type { BacktestSettings } from './types';

let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

describe('volatility settings migration and persistence', () => {
  const defaults: BacktestSettings = {
    mode: 'SINGLE', symbol: 'BTC', interval: '1h', side: 'BOTH',
    startDate: '2026-01-01', startTime: '09:00', endDate: '', endTime: '00:00',
    initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1',
    partialTpEnabled: false, fullTpWavePercent: '100', minDisparityPercent: '1.0',
    ma20HalfCloseEnabled: false, roiClosePercent: '100',
    minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1.0',
  };
  it('fills the three new fields without reusing the obsolete single K or losing other preferences', () => {
    values.set('zetaauto.web.backtest.settings.VOLATILITY', JSON.stringify({ symbol: 'ETH', leverage: '7', volatilityK: '1.5' }));
    expect(loadSettings('VOLATILITY', defaults)).toMatchObject({ ...defaults, symbol: 'ETH', leverage: '7' });
  });
  it('retains minimum range, K1 and K2 across a settings reload', () => {
    const saved = { ...defaults, minVolatilityPercent: '1.7', volatilityK1: '0.2', volatilityK2: '0.8' };
    saveSettings('VOLATILITY', saved);
    expect(loadSettings('VOLATILITY', defaults)).toEqual(saved);
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
