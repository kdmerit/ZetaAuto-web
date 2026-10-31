import { describe, expect, it } from 'vitest';

import { serverSettingsSnapshot, volatilityParameters } from './backtestSettings';
import type { BacktestSettings } from './types';

const fallback: BacktestSettings = {
  mode: 'SINGLE', symbol: 'BTC', interval: '15m', side: 'BOTH',
  startDate: '2026-10-01', startTime: '00:00', endDate: '', endTime: '00:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1',
  fullTpWavePercent: '100', minDisparityPercent: '1', roiClosePercent: '100', minVolatilityPercent: '0.5', volatilityK1: '0.5', volatilityK2: '1.0',
  partialTpEnabled: true, ma20HalfCloseEnabled: true,
  volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
};

describe('settings snapshots for server histories', () => {
  it('uses the job request instead of the currently edited settings', () => {
    const snapshot = serverSettingsSnapshot({
      mode: 'ALL', symbol: null, interval: '4h', side: 'SHORT',
      startAt: '2026-10-20T16:30:00Z', endAt: '2026-10-29T03:45:00Z',
      initialCapitalUsdt: '2500', betAmountUsdt: '250', leverage: '7',
      minDisparityPercent: '0.5', roiClosePercent: '20', fullTpWavePercent: 90,
      partialTpEnabled: false, ma20HalfCloseEnabled: false,
    }, fallback);
    expect(snapshot).toEqual({
      ...fallback, mode: 'ALL', interval: '4h', side: 'SHORT',
      startDate: '2026-10-21', startTime: '01:30', endDate: '2026-10-29', endTime: '12:45',
      initialCapitalUsdt: '2500', betAmountUsdt: '250', leverage: '7',
      minDisparityPercent: '0.5', roiClosePercent: '20', fullTpWavePercent: '90',
      partialTpEnabled: false, ma20HalfCloseEnabled: false,
    });
    expect(fallback.leverage).toBe('1');
  });

  it('keeps local snapshots for older records without a server request', () => {
    expect(serverSettingsSnapshot({}, fallback)).toEqual(fallback);
    expect(serverSettingsSnapshot({ symbol: 'ETHUSDT' }, fallback).symbol).toBe('ETH');
  });
  it('restores both independent volatility checkboxes, including explicitly disabled TP', () => {
    expect(serverSettingsSnapshot({ volatilityTpEnabled: false, volatilityNextCloseEnabled: true }, fallback))
      .toMatchObject({ volatilityTpEnabled: false, volatilityNextCloseEnabled: true });
  });

  it('does not replace usable defaults with malformed request fields', () => {
    expect(serverSettingsSnapshot({
      mode: 'bad', interval: '5m', side: 'SELL', leverage: 'NaN',
      startAt: 'invalid', partialTpEnabled: 'false', fullTpWavePercent: '',
    }, fallback)).toEqual(fallback);
  });
});

describe('volatility v2 parameter validation', () => {
  it.each(['0.1', '0.5', '10.0'])('accepts range percentage %s', minimum => {
    expect(volatilityParameters({ ...fallback, minVolatilityPercent: minimum }).minimum).toBe(Number(minimum));
  });
  it('accepts inclusive K limits and an equal lower/upper band', () => {
    expect(volatilityParameters({ ...fallback, volatilityK1: '0.1', volatilityK2: '1.0' })).toMatchObject({ k1: 0.1, k2: 1 });
    expect(volatilityParameters({ ...fallback, volatilityK1: '1.0', volatilityK2: '1.0' })).toMatchObject({ k1: 1, k2: 1 });
  });
  it.each(['', '0', '0.09', '10.1', 'bad', 'Infinity'])('rejects invalid minimum %s', minimum => {
    expect(() => volatilityParameters({ ...fallback, minVolatilityPercent: minimum })).toThrow('최소 변동폭');
  });
  it.each(['', '0', '0.09', '1.01', '2.0', 'NaN'])('rejects invalid K %s', value => {
    expect(() => volatilityParameters({ ...fallback, volatilityK1: value })).toThrow('K1·K2');
    expect(() => volatilityParameters({ ...fallback, volatilityK2: value })).toThrow('K1·K2');
  });
  it('rejects a reversed band instead of swapping user settings', () => {
    expect(() => volatilityParameters({ ...fallback, volatilityK1: '0.8', volatilityK2: '0.5' })).toThrow('K1은 K2');
  });
});
