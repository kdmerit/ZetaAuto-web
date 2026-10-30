import { describe, expect, it } from 'vitest';

import { serverSettingsSnapshot } from './backtestSettings';
import type { BacktestSettings } from './types';

const fallback: BacktestSettings = {
  mode: 'SINGLE', symbol: 'BTC', interval: '15m', side: 'BOTH',
  startDate: '2026-10-01', startTime: '00:00', endDate: '', endTime: '00:00',
  initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '1',
  fullTpWavePercent: '100', minDisparityPercent: '1', roiClosePercent: '100',
  partialTpEnabled: true, ma20HalfCloseEnabled: true,
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

  it('does not replace usable defaults with malformed request fields', () => {
    expect(serverSettingsSnapshot({
      mode: 'bad', interval: '5m', side: 'SELL', leverage: 'NaN',
      startAt: 'invalid', partialTpEnabled: 'false', fullTpWavePercent: '',
    }, fallback)).toEqual(fallback);
  });
});
