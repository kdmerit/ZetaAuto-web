import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openCacheDatabase, readValue, retentionMs, writeValue } from './database';
import type { EnvelopeStatisticsJob } from './envelopeStatistics';
import { loadEnvelopeStatisticsHistory, loadEnvelopeStatisticsReport, saveEnvelopeStatisticsHistory } from './envelopeStatisticsHistory';
import type { BacktestSettings } from './types';

const settings: BacktestSettings = { mode: 'SINGLE', symbol: 'BTC', interval: '1h', side: 'BOTH',
  startDate: '2026-01-01', startTime: '09:00', endDate: '2026-03-01', endTime: '09:00', initialCapitalUsdt: '1000', betAmountUsdt: '100', leverage: '2',
  partialTpEnabled: false, fullTpWavePercent: '100', minDisparityPercent: '1', ma20HalfCloseEnabled: false, roiClosePercent: '100', minVolatilityPercent: '0.5',
  volatilityK1: '0.5', volatilityK2: '1', volatilityTpEnabled: true, volatilityNextCloseEnabled: false,
  envelopeMaPeriod: '40', envelopeDeviationPercent: '1.2', envelopeExitMode: 'HALF' };
function report(id: string, symbol = 'BTC', at = Date.now()): EnvelopeStatisticsJob {
  return { id, version: '2.10.36', settings: { ...settings, symbol }, status: 'COMPLETED', updatedAt: at,
    intervalIndex: 4, periodIndex: 0, step: 1, exitIndex: 0, maxSteps: {}, skippedIntervals: {}, message: '통계분석 완료',
    rows: [{ interval: '1h', maPeriod: 40, deviationPercent: 1.2, exitMode: 'HALF', returnPercent: 12.34, profitUsdt: 123.4,
      realizedProfitUsdt: 123.4, feesUsdt: 10, entryCount: 10, closedTradeCount: 10, winCount: 7, lossCount: 3, winRatePercent: 70,
      maxDrawdownPercent: 4, openPositionCount: 0 }] };
}
beforeEach(async () => {
  const db = await openCacheDatabase();
  await new Promise<void>(resolve => {
    const transaction = db.transaction([...db.objectStoreNames], 'readwrite');
    for (const name of db.objectStoreNames) transaction.objectStore(name).clear();
    transaction.oncomplete = () => resolve();
  });
});

describe('statistics history browsing', () => {
  it('reads original v2.10.36 archives without a new analysis, filters by symbol, and restores full data', async () => {
    const btc = report('legacy-btc'); const eth = report('legacy-eth', 'ETH', Date.now() - 1000);
    await writeValue('results', `envelope-statistics:${btc.id}`, btc);
    await writeValue('results', `envelope-statistics:${eth.id}`, eth);
    const index = [{ id: btc.id, at: btc.updatedAt }, { id: eth.id, at: eth.updatedAt }];
    await writeValue('publicData', 'envelope-statistics-index', index);
    const cards = await loadEnvelopeStatisticsHistory('BTCUSDT');
    expect(cards).toHaveLength(1); expect(cards[0]).toMatchObject({ id: btc.id, comparedCount: 1, bestReturnPercent: 12.34 });
    expect(cards[0]!.settings).toEqual(btc.settings); expect(await loadEnvelopeStatisticsReport(btc.id)).toEqual(btc);
    expect(await loadEnvelopeStatisticsHistory('SOL')).toEqual([]); expect(await loadEnvelopeStatisticsHistory()).toHaveLength(2);
    expect(await readValue('publicData', 'envelope-statistics-index')).toEqual(index);
  });
  it('does not replace or remove the paused latest job when browsing a completed report', async () => {
    const paused = { ...report('paused'), status: 'PAUSED', intervalIndex: 1 };
    await writeValue('jobs', 'ENVELOPE_STATISTICS', paused);
    const done = report('done'); await saveEnvelopeStatisticsHistory(done);
    const cards = await loadEnvelopeStatisticsHistory('BTC');
    expect(await loadEnvelopeStatisticsReport(cards[0]!.id)).toEqual(done);
    expect(await readValue('jobs', 'ENVELOPE_STATISTICS')).toEqual(paused);
  });
  it('keeps at most twenty unique completed reports and prunes expired archives when saving', async () => {
    const base = Date.now() - 100000;
    const old = report('expired', 'BTC', Date.now() - retentionMs - 1000);
    await writeValue('results', 'envelope-statistics:expired', old);
    await writeValue('publicData', 'envelope-statistics-index', [{ id: old.id, at: old.updatedAt }]);
    for (let index = 0; index < 21; index += 1) await saveEnvelopeStatisticsHistory(report(`report-${index}`, 'BTC', base + index));
    await saveEnvelopeStatisticsHistory(report('report-20', 'BTC', base + 30));
    const cards = await loadEnvelopeStatisticsHistory();
    expect(cards).toHaveLength(20); expect(new Set(cards.map(card => card.id)).size).toBe(20); expect(cards[0]!.id).toBe('report-20');
    expect(await readValue('results', 'envelope-statistics:expired')).toBeNull(); expect(await readValue('results', 'envelope-statistics:report-0')).toBeNull();
    const index = (await readValue<{ summary: unknown }[]>('publicData', 'envelope-statistics-index'))!;
    expect(index.every(item => item.summary)).toBe(true);
  });
  it('omits missing/expired original archives and never publishes paused work as a history card', async () => {
    const old = report('old', 'BTC', Date.now() - retentionMs - 1);
    await writeValue('results', 'envelope-statistics:old', old);
    await writeValue('publicData', 'envelope-statistics-index', [{ id: 'missing', at: Date.now() }, { id: old.id, at: old.updatedAt }]);
    await saveEnvelopeStatisticsHistory({ ...report('paused'), status: 'PAUSED' });
    expect(await loadEnvelopeStatisticsHistory()).toEqual([]); expect(await loadEnvelopeStatisticsReport('missing')).toBeNull();
    expect(await loadEnvelopeStatisticsReport('old')).toBeNull();
  });
});
