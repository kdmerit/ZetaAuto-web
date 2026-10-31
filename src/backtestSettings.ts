import type { BacktestSettings } from './types';

export function volatilityParameters(settings: BacktestSettings): { minimum: number; k1: number; k2: number } {
  const minimum = Number(settings.minVolatilityPercent);
  const k1 = Number(settings.volatilityK1);
  const k2 = Number(settings.volatilityK2);
  if (!Number.isFinite(minimum) || minimum < 0.1 || minimum > 10) throw new Error('최소 변동폭은 0.1~10.0%로 입력해 주세요.');
  if (![k1, k2].every(value => Number.isFinite(value) && value >= 0.1 && value <= 1)) throw new Error('K1·K2는 0.1~1.0으로 입력해 주세요.');
  if (k1 > k2) throw new Error('K1은 K2 이하로 입력해 주세요.');
  return { minimum, k1, k2 };
}

function koreanDateTime(value: unknown): { date: string; time: string } | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const text = new Date(timestamp + 9 * 60 * 60 * 1000).toISOString();
  return { date: text.slice(0, 10), time: text.slice(11, 16) };
}

// A resumed server job may have been run with different settings than the form
// currently saved in Chrome. Its own request is the authoritative snapshot.
export function serverSettingsSnapshot(
  request: Record<string, unknown>,
  fallback: BacktestSettings,
): BacktestSettings {
  const settings = { ...fallback };
  if (request.mode === 'ALL' || request.mode === 'SINGLE') settings.mode = request.mode;
  if (typeof request.symbol === 'string' && request.symbol) {
    settings.symbol = request.symbol.toUpperCase().replace(/USDT$/, '');
  }
  if (request.interval === '15m' || request.interval === '1h' || request.interval === '4h' || request.interval === '1d') {
    settings.interval = request.interval;
  }
  if (request.side === 'BOTH' || request.side === 'LONG' || request.side === 'SHORT') settings.side = request.side;
  for (const key of ['initialCapitalUsdt', 'betAmountUsdt', 'leverage', 'fullTpWavePercent', 'minDisparityPercent', 'roiClosePercent', 'minVolatilityPercent', 'volatilityK1', 'volatilityK2'] as const) {
    const value = request[key];
    if ((typeof value === 'string' && value.trim() !== '' || typeof value === 'number') && Number.isFinite(Number(value))) {
      settings[key] = String(value);
    }
  }
  for (const key of ['partialTpEnabled', 'ma20HalfCloseEnabled', 'volatilityTpEnabled', 'volatilityNextCloseEnabled'] as const) {
    if (typeof request[key] === 'boolean') settings[key] = request[key];
  }
  const start = koreanDateTime(request.startAt);
  const end = koreanDateTime(request.endAt);
  if (start) {
    settings.startDate = start.date;
    settings.startTime = start.time;
  }
  if (end) {
    settings.endDate = end.date;
    settings.endTime = end.time;
  }
  return settings;
}
