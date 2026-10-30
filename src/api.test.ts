import { describe, expect, it } from 'vitest';

import { candleWindow, enrichCandles, intervalSeconds, parseCsv } from './api';

describe('web backtest candle utilities', () => {
  it('maps supported intervals to Bybit seconds', () => {
    expect(intervalSeconds('15m')).toBe(900);
    expect(intervalSeconds('1h')).toBe(3600);
    expect(intervalSeconds('4h')).toBe(14_400);
    expect(intervalSeconds('1d')).toBe(86_400);
  });

  it('parses a CSV and calculates moving averages', () => {
    const rows = ['time,open,high,low,close,volume'];
    for (let index = 0; index < 20; index += 1) {
      const time = Date.UTC(2026, 0, 1, 0, index) / 1000;
      rows.push(`${time},${100 + index},${102 + index},${99 + index},${101 + index},${index + 1}`);
    }
    const candles = parseCsv(rows.join('\n'), '1h');
    const enriched = enrichCandles(candles);
    expect(candles).toHaveLength(20);
    expect(enriched[18]?.ma20).toBeNull();
    expect(enriched[19]?.ma20).toBe(110.5);
  });

  it('normalizes the cache window to a USDT symbol', () => {
    const window = candleWindow({
      mode: 'SINGLE',
      symbol: 'BTCUSDT',
      interval: '1h',
      startDate: '2026-01-01',
      startTime: '00:00',
      endDate: '2026-01-02',
      endTime: '00:00',
      initialCapitalUsdt: '1000',
      betAmountUsdt: '100',
      leverage: '1',
      side: 'BOTH',
      partialTpEnabled: false,
      fullTpWavePercent: '100',
      minDisparityPercent: '1.0',
      ma20HalfCloseEnabled: false,
      roiClosePercent: '100',
    });
    expect(window.symbol).toBe('BTCUSDT');
    expect(window.end - window.start).toBe(86_400);
  });
});
