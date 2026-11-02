import { enrichCandles, intervalSeconds } from './api';
import type { BacktestInterval, Candle, ChartData, EnrichedCandle } from './types';

export interface MarketIndicatorSettings {
  smaPeriod: string;
  deviationPercent: string;
  emaPeriod: string;
  atrPeriod: string;
  atrMultiplier: string;
}
export const marketIndicatorStorageKey = 'zetaauto.web.marketChart.indicators.v1';
export const defaultMarketIndicators: MarketIndicatorSettings = { smaPeriod: '20', deviationPercent: '0.0', emaPeriod: '20', atrPeriod: '14', atrMultiplier: '2.0' };
export const volumeWindowSeconds = 120 * 86400;

function period(value: string, label: string): number {
  if (!/^\d+$/.test(value) || Number(value) > 120) throw new Error(`${label}은 0~120 정수로 입력해 주세요.`);
  return Number(value);
}
function decimal(value: string, label: string): number {
  if (!/^\d+(\.\d)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) > 20) throw new Error(`${label}은 0.0~20.0으로 입력해 주세요. (소수 한 자리)`);
  return Number(value);
}
export function marketIndicatorParameters(settings: MarketIndicatorSettings) {
  return { sma: period(settings.smaPeriod, 'SMA'), deviation: decimal(settings.deviationPercent, '엔벨로프 이격'),
    ema: period(settings.emaPeriod, 'EMA'), atr: period(settings.atrPeriod, 'ATR 기간'), multiplier: decimal(settings.atrMultiplier, 'ATR 승수') };
}
export function loadMarketIndicators(): MarketIndicatorSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(marketIndicatorStorageKey) ?? '{}') as Partial<MarketIndicatorSettings>;
    const settings = Object.fromEntries(Object.entries(defaultMarketIndicators).map(([key, fallback]) => [key, typeof saved?.[key as keyof MarketIndicatorSettings] === 'string' ? saved[key as keyof MarketIndicatorSettings] : fallback])) as unknown as MarketIndicatorSettings;
    marketIndicatorParameters(settings); return settings;
  } catch { return { ...defaultMarketIndicators }; }
}
export function saveMarketIndicators(settings: MarketIndicatorSettings): void {
  marketIndicatorParameters(settings);
  try { localStorage.setItem(marketIndicatorStorageKey, JSON.stringify(settings)); } catch { /* Indicators still work without persistence. */ }
}

export function trueRange(candle: Candle, previousClose?: number): number {
  const range = candle.high - candle.low;
  return previousClose === undefined ? range : Math.max(range, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
}

/** Average same-resolution volumes in [t - 120 days, t); never include the selected candle. */
export function enrichMarketCandles(rows: Candle[], interval: BacktestInterval): EnrichedCandle[] {
  let left = 0; let volume = 0;
  const expectedVolumeSamples = volumeWindowSeconds / intervalSeconds(interval);
  return enrichCandles(rows).map((candle, index) => {
    while (left < index && rows[left]!.openTime < candle.openTime - volumeWindowSeconds) volume -= rows[left++]!.volume;
    const samples = index - left;
    const average = samples ? Math.max(0, volume) / samples : null;
    const tr = trueRange(candle, rows[index - 1]?.close);
    const enriched = { ...candle, marketMetrics: { trueRange: tr, trueRangePercent: candle.close > 0 ? tr / candle.close * 100 : null,
      averageVolume120d: average, volumePercent: average !== null && average > 0 ? candle.volume / average * 100 : null,
      volumeSamples: samples, expectedVolumeSamples } };
    volume += candle.volume;
    return enriched;
  });
}

/** Standard chart indicators include the current completed candle, unlike frozen backtest orders. */
export function withMarketIndicators(chart: ChartData, settings: MarketIndicatorSettings): ChartData {
  if (!chart.market) return chart;
  const p = marketIndicatorParameters(settings);
  const envelope: NonNullable<ChartData['envelope']> = { interval: chart.interval, period: p.sma, deviationPercent: p.deviation, bands: [] };
  const atrEnvelope: NonNullable<ChartData['atrEnvelope']> = { emaPeriod: p.ema, atrPeriod: p.atr, multiplier: p.multiplier, bands: [] };
  const rows = chart.market.sourceCandles;
  const first = chart.candles[0]?.openTime ?? Infinity; const last = chart.candles.at(-1)?.openTime ?? -Infinity;
  const smaEnabled = p.sma > 0 && p.deviation > 0;
  const atrEnabled = p.ema > 0 && p.atr > 0 && p.multiplier > 0;
  let sum = 0; let ema: number | null = null; let atr: number | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const candle = rows[index]!;
    if (smaEnabled) { sum += candle.close; if (index >= p.sma) sum -= rows[index - p.sma]!.close; }
    if (atrEnabled) {
      const tr = trueRange(candle, rows[index - 1]?.close);
      ema = ema === null ? candle.close : ema + 2 / (p.ema + 1) * (candle.close - ema);
      // Exactly TR.ewm(alpha=1/M, adjust=False).mean(): seed with the first TR, not an SMA.
      atr = atr === null ? tr : atr + (tr - atr) / p.atr;
    }
    if (candle.openTime < first || candle.openTime > last) continue;
    if (smaEnabled && index + 1 >= p.sma) {
      const center = sum / p.sma;
      envelope.bands.push({ openTime: candle.openTime, center, upper: center * (1 + p.deviation / 100), lower: center * (1 - p.deviation / 100) });
    }
    if (atrEnabled && ema !== null && atr !== null) atrEnvelope.bands.push({ openTime: candle.openTime, center: ema, upper: ema + p.multiplier * atr, lower: ema - p.multiplier * atr });
  }
  return { ...chart, side: null, markers: [], executions: [], waves: [], priceLines: [], envelope: smaEnabled ? envelope : undefined, atrEnvelope: atrEnabled ? atrEnvelope : undefined };
}
