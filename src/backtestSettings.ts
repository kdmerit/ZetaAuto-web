import type { BacktestSettings } from './types';

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
  for (const key of ['initialCapitalUsdt', 'betAmountUsdt', 'leverage', 'fullTpWavePercent', 'minDisparityPercent', 'roiClosePercent', 'volatilityK'] as const) {
    const value = request[key];
    if ((typeof value === 'string' && value.trim() !== '' || typeof value === 'number') && Number.isFinite(Number(value))) {
      settings[key] = String(value);
    }
  }
  for (const key of ['partialTpEnabled', 'ma20HalfCloseEnabled'] as const) {
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
