import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchServerChart, fetchServerEntryChart } from './api';
import { chartTimestamp, entryCandleIndex, mergeChartPages } from './chartData';
import type { ChartData, ChartMarker } from './types';

const opened = Date.parse('2026-10-28T14:00:00Z') / 1000;
const context = { apiBaseUrl: 'https://example.com/dev', accessToken: 'test' };

function chartAt(times: number[]): ChartData {
  return {
    symbol: 'BTCUSDT', interval: '1h', side: 'SHORT',
    referenceAt: new Date(opened * 1000).toISOString(), referenceIndex: null,
    candles: times.map((openTime) => ({
      openTime, closeTime: openTime + 3600,
      open: 101, high: 102, low: 99, close: 100, volume: 15,
      ma5: 101, ma10: 101, ma20: 101, ma60: 100, ma120: null,
    })),
    markers: [], executions: [], waves: [], priceLines: [{ kind: 'ENTRY', price: 100 }],
  };
}

function entry(): ChartMarker {
  return { id: 'entry', orderId: 'entry', kind: 'ENTRY', label: 'S', openTime: opened, candleIndex: -1, price: 100, quantity: 1 };
}

function wireChart(chart: ChartData): unknown {
  return {
    ...chart,
    candles: chart.candles.map((candle) => ({
      ...candle,
      openTime: new Date(candle.openTime * 1000).toISOString(),
      closeTime: new Date(candle.closeTime * 1000).toISOString(),
      open: String(candle.open), high: String(candle.high), low: String(candle.low), close: String(candle.close), volume: String(candle.volume),
    })),
    markers: chart.markers.map((marker) => ({ ...marker, openTime: new Date(marker.openTime * 1000).toISOString() })),
    executions: chart.executions?.map((marker) => ({ ...marker, openTime: new Date(marker.openTime * 1000).toISOString() })),
    waves: chart.waves.map((wave) => ({ ...wave, startTime: new Date(wave.startTime * 1000).toISOString(), endTime: new Date(wave.endTime * 1000).toISOString() })),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('server chart dates and entry focus', () => {
  it('normalizes seconds, milliseconds and ISO timestamps without creating invalid dates', () => {
    expect(chartTimestamp(opened)).toBe(opened);
    expect(chartTimestamp(opened * 1000)).toBe(opened);
    expect(chartTimestamp(String(opened))).toBe(opened);
    expect(chartTimestamp('2026-10-28T14:00:00Z')).toBe(opened);
    expect(chartTimestamp(null)).toBeNull();
    expect(chartTimestamp('not a date')).toBeNull();
  });

  it('keeps server candle dates usable when a candle is selected', async () => {
    const fixture = chartAt([opened]);
    fixture.markers = [{ ...entry(), candleIndex: 0 }];
    fixture.executions = [entry()];
    fixture.waves = [{ label: 'CURRENT', direction: 'DOWN', startTime: opened, endTime: opened, startIndex: 0, endIndex: 0, low: 99, high: 102, complete: false }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ chart: wireChart(fixture) }))));
    const chart = await fetchServerChart(context, 'BTCUSDT', 'SHORT', fixture.referenceAt, 'a'.repeat(32), 'b'.repeat(32));
    expect(chart.candles[0]?.openTime).toBe(opened);
    expect(chart.candles[0]?.closeTime).toBe(opened + 3600);
    expect(chart.markers[0]?.openTime).toBe(opened);
    expect(chart.executions?.[0]?.openTime).toBe(opened);
    expect(chart.waves[0]?.startTime).toBe(opened);
    expect(() => new Intl.DateTimeFormat('ko-KR').format(new Date(chart.candles[0]!.openTime * 1000))).not.toThrow();
  });

  it('loads the first entry page when a long-held trade initially shows only its exit', async () => {
    const exitPage = chartAt([opened + 1000 * 3600]);
    exitPage.executions = [entry()];
    const entryPage = chartAt([opened - 3600, opened, opened + 3600]);
    entryPage.executions = [entry()];
    entryPage.markers = [{ ...entry(), candleIndex: 1 }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ chart: wireChart(exitPage) })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ chart: wireChart(entryPage) })));
    vi.stubGlobal('fetch', fetchMock);
    const chart = await fetchServerEntryChart(context, 'BTCUSDT', 'SHORT', exitPage.referenceAt, 'a'.repeat(32), 'b'.repeat(32));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('focusAt')).toBe(new Date(opened * 1000).toISOString());
    expect(entryCandleIndex(chart)).toBe(1);
  });

  it('reports invalid server timestamps before opening a broken chart', async () => {
    const fixture = wireChart(chartAt([opened])) as { candles: Array<{ openTime: string }> };
    fixture.candles[0]!.openTime = 'invalid';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ chart: fixture }))));
    await expect(fetchServerChart(context, 'BTCUSDT', 'SHORT', '2026-10-28T14:00:00Z', 'a'.repeat(32), 'b'.repeat(32))).rejects.toThrow('캔들 시각');
  });

  it('preserves entry and wave dates while reindexing prepended and overlapping pages', () => {
    const current = chartAt([opened, opened + 3600]);
    current.referenceIndex = 0;
    current.markers = [{ ...entry(), candleIndex: 0 }];
    current.executions = [entry()];
    current.waves = [{ label: 'PREVIOUS', direction: 'DOWN', startTime: opened - 3600, endTime: opened, startIndex: 0, endIndex: 0, low: 99, high: 102, complete: true }];
    const older = chartAt([opened - 7200, opened - 3600, opened]);
    const merged = mergeChartPages(older, current);
    expect(merged.candles).toHaveLength(4);
    expect(merged.referenceIndex).toBe(2);
    expect(merged.markers[0]?.candleIndex).toBe(2);
    expect(merged.waves[0]).toMatchObject({ startIndex: 1, endIndex: 2 });
    expect(entryCandleIndex(merged)).toBe(2);
  });
});
