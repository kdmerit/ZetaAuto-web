import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { openCacheDatabase, readValue } from './database';
import { loadContractRisk } from './contractRisk';
const baseTier = { symbol: 'BTCUSDT', riskLimitValue: '1000000', maintenanceMargin: '0.005', initialMargin: '0.01', maxLeverage: '100', mmDeduction: '0', isLowestRisk: 1 };
function replyWithTiers(rows: Record<string, unknown>[]): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify({ retCode: 0, result: String(input).includes('instruments-info')
    ? { list: [{ symbol: 'BTCUSDT', leverageFilter: { maxLeverage: '100' } }] } : { list: rows } }))));
}
beforeEach(async () => {
  const db = await openCacheDatabase(); await new Promise<void>(resolve => { const tx = db.transaction('publicData', 'readwrite'); tx.objectStore('publicData').clear(); tx.oncomplete = () => resolve(); });
});
afterEach(() => vi.unstubAllGlobals());
describe('public contract risk snapshots', () => {
  it('reads actual instrument maximum, all risk pages, and reuses a validated daily snapshot', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input)); expect(url.searchParams.get('category')).toBe('linear'); expect(url.searchParams.get('symbol')).toBe('BTCUSDT');
      const data = url.pathname.endsWith('instruments-info') ? { list: [{ symbol: 'BTCUSDT', leverageFilter: { maxLeverage: '100' } }] }
        : !url.searchParams.get('cursor') ? { list: [{ symbol: 'BTCUSDT', riskLimitValue: '1000000', maintenanceMargin: 0.005, initialMargin: 0.01, maxLeverage: '100', mmDeduction: '0' }], nextPageCursor: 'second' }
          : { list: [{ symbol: 'BTCUSDT', riskLimitValue: '2000000', maintenanceMargin: 0.01, initialMargin: 0.02, maxLeverage: '50', mmDeduction: '5000' }] };
      return new Response(JSON.stringify({ retCode: 0, result: data }));
    });
    vi.stubGlobal('fetch', fetcher); const risk = await loadContractRisk('BTCUSDT');
    expect(risk.maxLeverage).toBe(100); expect(risk.tiers).toHaveLength(2); expect(risk.tiers[1]!.deduction).toBe(5000);
    expect(await loadContractRisk('BTCUSDT')).toEqual(risk); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('normalizes percent-unit risk replies using their initial-margin/max-leverage relationship', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify({ retCode: 0, result: String(input).includes('instruments-info')
      ? { list: [{ symbol: 'BTCUSDT', leverageFilter: { maxLeverage: '100' } }] }
      : { list: [{ symbol: 'BTCUSDT', riskLimitValue: '1000000', maintenanceMargin: '0.5', initialMargin: '1', maxLeverage: '100', mmDeduction: '', isLowestRisk: 1 }] } }))));
    const risk = await loadContractRisk('BTCUSDT'); expect(risk.tiers[0]!.maintenanceRate).toBe(0.005); expect(risk.tiers[0]!.deduction).toBe(0);
  });
  it('does not invent risk data when a required public field is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ retCode: 0, result: { list: [{ symbol: 'BTCUSDT' }] } }))));
    await expect(loadContractRisk('BTCUSDT')).rejects.toThrow('최대 레버리지');
  });
  it.each(['', ' ', null, undefined])('accepts a string lowest-tier flag with an empty deduction (%s)', async mmDeduction => {
    replyWithTiers([{ ...baseTier, isLowestRisk: '1', mmDeduction }]);
    const risk = await loadContractRisk('BTCUSDT');
    expect(risk.tiers[0]!.deduction).toBe(0); expect(risk.tiers[0]!.maintenanceRate).toBe(0.005);
    expect(await readValue('publicData', 'contract-risk:v1:BTCUSDT')).toEqual(risk);
  });
  it.each([0, '0', undefined, true])('does not replace missing non-lowest/unknown-tier deductions with zero (flag=%s)', async isLowestRisk => {
    replyWithTiers([{ ...baseTier, isLowestRisk, mmDeduction: null }]);
    await expect(loadContractRisk('BTCUSDT')).rejects.toThrow('mmDeduction');
    expect(await readValue('publicData', 'contract-risk:v1:BTCUSDT')).toBeNull();
  });
  it.each([
    ['maintenanceMargin', null], ['maintenanceMargin', ''], ['maintenanceMargin', true],
    ['initialMargin', undefined], ['riskLimitValue', ''], ['maxLeverage', false], ['mmDeduction', false],
  ] as const)('rejects a missing or non-numeric %s with the field name instead of silently coercing %s', async (field, value) => {
    replyWithTiers([{ ...baseTier, [field]: value }]);
    await expect(loadContractRisk('BTCUSDT')).rejects.toThrow(field);
    expect(await readValue('publicData', 'contract-risk:v1:BTCUSDT')).toBeNull();
  });
  it('accepts a published high-maintenance upper tier instead of rejecting the entire symbol at an arbitrary 50% bound', async () => {
    replyWithTiers([baseTier, { ...baseTier, riskLimitValue: '2000000', maintenanceMargin: '0.55', initialMargin: '1', maxLeverage: '1', mmDeduction: '545000', isLowestRisk: '0' }]);
    expect((await loadContractRisk('BTCUSDT')).tiers[1]!.maintenanceRate).toBe(0.55);
  });
});
