/** Change chart resolution using cached public candles and frozen trade metadata. */
import { enrichCandles, intervalSeconds } from './api';
import { chartTimestamp, tradeChartFills } from './chartData';
import { ensureCandles, listInstruments } from './marketData';
import type { BacktestInterval, BacktestTrade, ChartData, ChartMarker, Wave } from './types';

export const chartIntervals: BacktestInterval[] = ['15m', '1h', '4h', '1d'];

function chartEvents(chart: ChartData): ChartMarker[] {
  const events = new Map((chart.executions ?? []).map(event => [event.id, event]));
  for (const event of chart.markers) if (!events.has(event.id)) events.set(event.id, event);
  return [...events.values()];
}

/** Attach known fill times once; old server events may only identify their original candle. */
export function withChartExecutionTimes(chart: ChartData, trade: BacktestTrade): ChartData {
  const sourceInterval = chart.sourceInterval ?? chart.interval;
  const seconds = intervalSeconds(sourceInterval);
  const executions = chartEvents(chart).map(event => {
    const sourceOpenTime = event.sourceOpenTime ?? event.openTime;
    const fill = trade.executions.find(value => value.kind === event.kind && value.candleOpenAt === sourceOpenTime);
    const candidate = fill?.at ?? (event.kind === 'ENTRY' ? trade.entryAt
      : event.kind === 'CLOSE' && trade.reason !== 'PARTIAL_TP' ? trade.exitAt : undefined);
    const executedAt = event.executedAt ?? (candidate !== undefined && Number.isFinite(candidate)
      && candidate >= sourceOpenTime && candidate <= sourceOpenTime + seconds ? candidate : undefined);
    return { ...event, sourceOpenTime, ...(executedAt === undefined ? {} : {
      executedAt,
      timing: event.timing ?? fill?.timing ?? (executedAt === sourceOpenTime + seconds ? 'BAR_CLOSE' as const : 'INTRABAR' as const),
    }) };
  });
  const byId = new Map(executions.map(event => [event.id, event]));
  return { ...chart, sourceInterval, sourceWaves: chart.sourceWaves ?? trade.signal.waves ?? chart.waves,
    executions, markers: chart.markers.map(event => byId.get(event.id) ?? event) };
}

/** A close at the boundary belongs to the candle that just finished. */
export function markerAtInterval(event: ChartMarker, interval: BacktestInterval, sourceInterval: BacktestInterval): number {
  const original = event.sourceOpenTime ?? event.openTime;
  if (interval === sourceInterval) return original;
  const at = event.executedAt ?? original;
  const effective = event.timing === 'BAR_CLOSE' ? at - 1 : at;
  const seconds = intervalSeconds(interval);
  return Math.floor(effective / seconds) * seconds;
}

function visibleWaves(waves: Wave[], candles: ChartData['candles']): Wave[] {
  return waves.flatMap(wave => {
    const startIndex = candles.findIndex(candle => candle.closeTime > wave.startTime && candle.openTime <= wave.endTime);
    if (startIndex < 0) return [];
    let endIndex = startIndex;
    while (endIndex + 1 < candles.length && candles[endIndex + 1]!.openTime <= wave.endTime) endIndex += 1;
    return [{ ...wave, startIndex, endIndex }];
  });
}

export async function chartAtInterval(
  source: ChartData,
  interval: BacktestInterval,
  options: { focusAt?: number; beforeAt?: number } = {},
): Promise<ChartData> {
  const seconds = intervalSeconds(interval);
  const sourceInterval = source.sourceInterval ?? source.interval;
  const events = chartEvents(source).map(event => ({ ...event,
    sourceOpenTime: event.sourceOpenTime ?? event.openTime,
    openTime: markerAtInterval(event, interval, sourceInterval),
  }));
  const entry = tradeChartFills({ ...source, markers: [], executions: events }).entry;
  const latestEnd = Math.floor(Date.now() / 1000 / seconds) * seconds;
  const requested = options.focusAt ?? entry?.openTime ?? chartTimestamp(source.referenceAt) ?? latestEnd - seconds;
  const focusAt = Math.min(Math.floor(requested / seconds) * seconds, latestEnd - seconds);
  const end = options.beforeAt ?? Math.min(latestEnd, focusAt + 160 * seconds);
  const start = end - 300 * seconds;
  const instrument = (await listInstruments(source.symbol))[0] ?? { symbol: source.symbol, launchAt: 0 };
  const rows = await ensureCandles(instrument, interval, start - 200 * seconds, end);
  const candles = enrichCandles(rows).filter(candle => candle.openTime >= start);
  if (!candles.length) throw new Error('선택한 주기의 차트에 표시할 완성봉이 없습니다.');
  const indices = new Map(candles.map((candle, index) => [candle.openTime, index]));
  const executions = events.map(event => ({ ...event, candleIndex: indices.get(event.openTime) ?? -1 }));
  const sourceWaves = source.sourceWaves ?? source.waves;
  const referenceIndex = indices.get(focusAt) ?? 0;
  return { ...source, interval, sourceInterval, sourceWaves, candles,
    executions, markers: executions.filter(event => event.candleIndex >= 0),
    waves: visibleWaves(sourceWaves, candles),
    referenceAt: new Date(candles[referenceIndex]!.openTime * 1000).toISOString(), referenceIndex };
}
