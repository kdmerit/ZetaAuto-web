import type { ChartData, ChartMarker } from './types';

export function chartTimestamp(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const numeric = Number(value);
  const seconds = Number.isFinite(numeric)
    ? Math.abs(numeric) >= 100_000_000_000 ? numeric / 1000 : numeric
    : typeof value === 'string' ? Date.parse(value) / 1000 : Number.NaN;
  return Number.isFinite(seconds) && Number.isFinite(new Date(seconds * 1000).getTime())
    ? seconds
    : null;
}

export function firstEntryTime(chart: ChartData): number | null {
  const times = [...(chart.executions ?? []), ...chart.markers]
    .filter((marker) => marker.kind === 'ENTRY')
    .map((marker) => marker.openTime)
    .filter(Number.isFinite);
  return times.length > 0 ? Math.min(...times) : null;
}

export function entryCandleIndex(chart: ChartData): number | null {
  const opened = firstEntryTime(chart);
  const entryIndex = opened === null ? -1 : chart.candles.findIndex((candle) => candle.openTime === opened);
  if (entryIndex >= 0) return entryIndex;
  if (chart.referenceIndex !== null && chart.candles[chart.referenceIndex]) return chart.referenceIndex;
  return chart.candles.length > 0 ? 0 : null;
}

export function mergeChartPages(older: ChartData, current: ChartData): ChartData {
  const byTime = new Map([...older.candles, ...current.candles].map((candle) => [candle.openTime, candle]));
  const candles = [...byTime.values()].sort((left, right) => left.openTime - right.openTime);
  const indices = new Map(candles.map((candle, index) => [candle.openTime, index]));
  const events = new Map<string, ChartMarker>();
  for (const event of [
    ...older.markers, ...(older.executions ?? []),
    ...current.markers, ...(current.executions ?? []),
  ]) events.set(event.id, event);
  const executions = [...events.values()].map((event) => ({
    ...event,
    candleIndex: indices.get(event.openTime) ?? -1,
  }));
  const waveRanges = new Map([...older.waves, ...current.waves].map((wave) => [wave.label, wave]));
  const waves = [...waveRanges.values()].flatMap((wave) => {
    const startIndex = candles.findIndex((candle) => candle.openTime >= wave.startTime && candle.openTime <= wave.endTime);
    if (startIndex < 0) return [];
    let endIndex = startIndex;
    while (endIndex + 1 < candles.length && candles[endIndex + 1]!.openTime <= wave.endTime) endIndex += 1;
    return [{ ...wave, startIndex, endIndex }];
  });
  const referenceTime = chartTimestamp(current.referenceAt);
  return {
    ...current,
    candles,
    markers: executions.filter((event) => event.candleIndex >= 0),
    executions,
    waves,
    referenceIndex: referenceTime === null ? null : indices.get(referenceTime) ?? null,
  };
}
