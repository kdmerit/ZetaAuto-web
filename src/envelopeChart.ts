import { intervalSeconds } from './api';
import { projectEnvelopeBands } from './envelope';
import { ensureCandles, listInstruments } from './marketData';
import { projectAtrEnvelopeBands } from './marketIndicators';
import type { ChartData } from './types';

/** Keep the strategy's original band timeframe even when the price chart is viewed at another resolution. */
export async function refreshEnvelopeOverlay(chart: ChartData): Promise<ChartData> {
  if (!chart.candles.length) return chart;
  const atr = chart.atrEnvelope;
  if (atr?.interval !== undefined && atr.seedFrom !== undefined) {
    const end = chart.candles.at(-1)!.openTime;
    const instrument = (await listInstruments(chart.symbol))[0] ?? { symbol: chart.symbol, launchAt: 0 };
    const rows = await ensureCandles(instrument, atr.interval, atr.seedFrom, end);
    return { ...chart, atrEnvelope: projectAtrEnvelopeBands(rows, chart.candles, { ...atr, interval: atr.interval, seedFrom: atr.seedFrom }) };
  }
  const definition = chart.envelope;
  if (!definition) return chart;
  const seconds = intervalSeconds(definition.interval);
  const start = Math.floor(chart.candles[0]!.openTime / seconds) * seconds - definition.period * seconds;
  const end = Math.floor(chart.candles.at(-1)!.openTime / seconds) * seconds;
  const instrument = (await listInstruments(chart.symbol))[0] ?? { symbol: chart.symbol, launchAt: 0 };
  const rows = await ensureCandles(instrument, definition.interval, start, end);
  return { ...chart, envelope: projectEnvelopeBands(rows, chart.candles, definition) };
}
