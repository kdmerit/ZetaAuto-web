import { enrichCandles, intervalSeconds } from './api';
import { calendarAtr, trueRange } from './atr';
export { trueRange } from './atr';
import type { AtrEnvelopeInputs, AtrEnvelopeParameters, BacktestInterval, Candle, ChartData, EnrichedCandle, EnvelopeBand } from './types';

export interface MarketIndicatorSettings extends AtrEnvelopeInputs {
  smaPeriod: string;
  deviationPercent: string;
  bollingerPeriod: string;
  bollingerMultiplier: string;
}
export const marketIndicatorStorageKey = 'zetaauto.web.marketChart.indicators.v1';
export const defaultAtrEnvelopeInputs: AtrEnvelopeInputs = { emaPeriod: '20', atrPeriod: '14', atrMultiplier: '2.0' };
export const defaultMarketIndicators: MarketIndicatorSettings = { smaPeriod: '20', deviationPercent: '0.0', ...defaultAtrEnvelopeInputs, bollingerPeriod: '20', bollingerMultiplier: '2.0' };
export const volumeWindowSeconds = 120 * 86400;

const maximumPeriod = 120;
export const atrEnvelopeMultiplierInput = { max: 20, step: 0.1 } as const;
export const atrEnvelopeFields = [
  { key: 'emaPeriod', label: 'EMA', name: 'ATR 중심 EMA', max: maximumPeriod, step: 1 },
  { key: 'atrPeriod', label: 'ATR', name: 'ATR 기간', max: maximumPeriod, step: 1 },
  { key: 'atrMultiplier', label: '×', name: 'ATR 승수', ...atrEnvelopeMultiplierInput },
] as const;

function period(value: string, label: string): number {
  if (!/^\d+$/.test(value) || Number(value) > maximumPeriod) throw new Error(`${label}은 0~${maximumPeriod} 정수로 입력해 주세요.`);
  return Number(value);
}
function decimal(value: string, label: string, maximum = 20): number {
  if (!/^\d+(\.\d)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) > maximum) throw new Error(`${label}은 0.0~${maximum.toFixed(1)}으로 입력해 주세요. (소수 한 자리)`);
  return Number(value);
}
export function parseAtrEnvelopeMultiplier(value: string, label: string): number {
  return decimal(value, label, atrEnvelopeMultiplierInput.max);
}
export function atrEnvelopeParameters(settings: AtrEnvelopeInputs): AtrEnvelopeParameters {
  return {
    emaPeriod: period(settings.emaPeriod, 'EMA'),
    atrPeriod: period(settings.atrPeriod, 'ATR 기간'),
    multiplier: parseAtrEnvelopeMultiplier(settings.atrMultiplier, 'ATR 승수'),
  };
}

export function marketIndicatorParameters(settings: MarketIndicatorSettings) {
  return { sma: period(settings.smaPeriod, 'SMA'), deviation: decimal(settings.deviationPercent, '엔벨로프 이격'),
    atrEnvelope: atrEnvelopeParameters(settings),
    bollingerPeriod: period(settings.bollingerPeriod, '볼린저밴드 기간'), bollingerMultiplier: decimal(settings.bollingerMultiplier, '볼린저밴드 표준편차 배수', 10) };
}

export interface AtrEnvelopeState {
  closeTime: number;
  previousClose: number;
  ema: number;
  atr: number;
}

export function atrEnvelopeEnabled(parameters: AtrEnvelopeParameters): boolean {
  return parameters.emaPeriod > 0 && parameters.atrPeriod > 0 && parameters.multiplier > 0;
}

export function advanceAtrEnvelope(state: AtrEnvelopeState | undefined, candle: Candle, parameters: AtrEnvelopeParameters): AtrEnvelopeState {
  const tr = trueRange(candle, state?.previousClose);
  return {
    closeTime: candle.closeTime,
    previousClose: candle.close,
    ema: state ? state.ema + 2 / (parameters.emaPeriod + 1) * (candle.close - state.ema) : candle.close,
    // Wilder smoothing starts at the first TR, matching adjust=False in the chart.
    atr: state ? state.atr + (tr - state.atr) / parameters.atrPeriod : tr,
  };
}

export function atrEnvelopeBand(state: AtrEnvelopeState, parameters: AtrEnvelopeParameters): EnvelopeBand {
  const width = parameters.multiplier * state.atr;
  return { center: state.ema, upper: state.ema + width, lower: state.ema - width };
}

/** Project only the source candles already completed at each target candle's open. */
export function projectAtrEnvelopeBands(
  rows: readonly Candle[],
  targets: readonly Candle[],
  definition: AtrEnvelopeParameters & { interval: BacktestInterval; seedFrom: number },
): NonNullable<ChartData['atrEnvelope']> {
  const bands: NonNullable<ChartData['atrEnvelope']>['bands'] = [];
  if (!atrEnvelopeEnabled(definition)) return { ...definition, bands };
  let state: AtrEnvelopeState | undefined;
  let cursor = 0;
  for (const target of targets) {
    while (cursor < rows.length && rows[cursor]!.closeTime <= target.openTime) {
      const candle = rows[cursor++]!;
      if (candle.openTime >= definition.seedFrom) state = advanceAtrEnvelope(state, candle, definition);
    }
    if (state) bands.push({ openTime: target.openTime, ...atrEnvelopeBand(state, definition) });
  }
  return { ...definition, bands };
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

/** Average same-resolution volumes in [t - 120 days, t); never include the selected candle. */
export function enrichMarketCandles(rows: Candle[], interval: BacktestInterval): EnrichedCandle[] {
  let left = 0; let volume = 0;
  const expectedVolumeSamples = volumeWindowSeconds / intervalSeconds(interval);
  const atr = calendarAtr(rows, interval, true);
  return enrichCandles(rows).map((candle, index) => {
    while (left < index && rows[left]!.openTime < candle.openTime - volumeWindowSeconds) volume -= rows[left++]!.volume;
    const samples = index - left;
    const average = samples ? Math.max(0, volume) / samples : null;
    const tr = trueRange(candle, rows[index - 1]?.close);
    const enriched = { ...candle, marketMetrics: { trueRange: tr, trueRangePercent: candle.close > 0 ? tr / candle.close * 100 : null,
      averageTrueRange20d: atr[index]!.value, atrPercent: candle.close > 0 && atr[index]!.value !== null ? atr[index]!.value! / candle.close * 100 : null,
      atrSamples: atr[index]!.samples, expectedAtrSamples: atr[index]!.expected,
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
  const atrEnvelope: NonNullable<ChartData['atrEnvelope']> = { ...p.atrEnvelope, bands: [] };
  const bollinger: NonNullable<ChartData['bollinger']> = { period: p.bollingerPeriod, multiplier: p.bollingerMultiplier, bands: [] };
  const rows = chart.market.sourceCandles;
  const first = chart.candles[0]?.openTime ?? Infinity; const last = chart.candles.at(-1)?.openTime ?? -Infinity;
  const smaEnabled = p.sma > 0 && p.deviation > 0;
  const atrEnabled = atrEnvelopeEnabled(p.atrEnvelope);
  const bollingerEnabled = p.bollingerPeriod > 0 && p.bollingerMultiplier > 0;
  let sum = 0; let bollingerSum = 0; let bollingerSquareSum = 0;
  let atrState: AtrEnvelopeState | undefined;
  for (let index = 0; index < rows.length; index += 1) {
    const candle = rows[index]!;
    if (smaEnabled) { sum += candle.close; if (index >= p.sma) sum -= rows[index - p.sma]!.close; }
    if (bollingerEnabled) {
      bollingerSum += candle.close; bollingerSquareSum += candle.close * candle.close;
      if (index >= p.bollingerPeriod) {
        const previousClose = rows[index - p.bollingerPeriod]!.close;
        bollingerSum -= previousClose; bollingerSquareSum -= previousClose * previousClose;
      }
    }
    if (atrEnabled) atrState = advanceAtrEnvelope(atrState, candle, p.atrEnvelope);
    if (candle.openTime < first || candle.openTime > last) continue;
    if (smaEnabled && index + 1 >= p.sma) {
      const center = sum / p.sma;
      envelope.bands.push({ openTime: candle.openTime, center, upper: center * (1 + p.deviation / 100), lower: center * (1 - p.deviation / 100) });
    }
    if (atrState) atrEnvelope.bands.push({ openTime: candle.openTime, ...atrEnvelopeBand(atrState, p.atrEnvelope) });
    if (bollingerEnabled && index + 1 >= p.bollingerPeriod) {
      const center = bollingerSum / p.bollingerPeriod;
      const variance = Math.max(0, bollingerSquareSum / p.bollingerPeriod - center * center);
      const width = p.bollingerMultiplier * Math.sqrt(variance);
      bollinger.bands.push({ openTime: candle.openTime, center, upper: center + width, lower: center - width });
    }
  }
  return { ...chart, side: null, markers: [], executions: [], waves: [], priceLines: [], envelope: smaEnabled ? envelope : undefined, atrEnvelope: atrEnabled ? atrEnvelope : undefined, bollinger: bollingerEnabled ? bollinger : undefined };
}
