/** Small history cards reference full reports in IndexedDB, including original v2.10.36 archives. */
import { deleteValue, readValue, retentionMs, writeValue } from './database';
import type { EnvelopeStatisticsJob } from './envelopeStatistics';
import type { BacktestSettings } from './types';

const indexKey = 'envelope-statistics-index';
const reportKey = (id: string): string => `envelope-statistics:${id}`;
const maximum = 20;

export interface EnvelopeStatisticsHistoryEntry {
  id: string;
  savedAt: number;
  settings: BacktestSettings;
  comparedCount: number;
  bestReturnPercent: number | null;
}
interface IndexEntry { id: string; at: number; summary?: EnvelopeStatisticsHistoryEntry }

function summaryFor(job: EnvelopeStatisticsJob): EnvelopeStatisticsHistoryEntry {
  let best: number | null = null;
  for (const row of job.rows) if (row.closedTradeCount > 0 && Number.isFinite(row.returnPercent)) {
    best = best === null ? row.returnPercent : Math.max(best, row.returnPercent);
  }
  return { id: job.id, savedAt: job.updatedAt, settings: job.settings, comparedCount: job.rows.length, bestReturnPercent: best };
}

export async function loadEnvelopeStatisticsReport(id: string): Promise<EnvelopeStatisticsJob | null> {
  if (typeof id !== 'string' || !id || id.length > 128) return null;
  const job = await readValue<EnvelopeStatisticsJob>('results', reportKey(id));
  if (!job || job.id !== id || job.status !== 'COMPLETED' || !job.settings || job.settings.mode !== 'SINGLE'
    || !Array.isArray(job.rows) || !Number.isFinite(job.updatedAt) || Date.now() - job.updatedAt > retentionMs) return null;
  return job;
}

async function readIndex(): Promise<IndexEntry[]> {
  const value = await readValue<unknown>('publicData', indexKey);
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, IndexEntry>();
  for (const item of value) if (item && typeof item === 'object' && typeof item.id === 'string'
    && Number.isFinite(item.at) && item.at <= Date.now()) {
    if (!unique.has(item.id)) unique.set(item.id, item as IndexEntry);
  }
  return [...unique.values()].sort((a, b) => b.at - a.at);
}

export async function saveEnvelopeStatisticsHistory(job: EnvelopeStatisticsJob): Promise<void> {
  if (job.status !== 'COMPLETED') return;
  const previous = await readIndex();
  const keep = [{ id: job.id, at: job.updatedAt, summary: summaryFor(job) }, ...previous.filter(item => item.id !== job.id)]
    .filter(item => Date.now() - item.at <= retentionMs).slice(0, maximum);
  // Report precedes index publication, so a visible card never refers to an unfinished write.
  await writeValue('results', reportKey(job.id), job);
  await writeValue('publicData', indexKey, keep);
  for (const item of previous) if (!keep.some(value => value.id === item.id)) await deleteValue('results', reportKey(item.id));
}

export async function loadEnvelopeStatisticsHistory(symbol?: string): Promise<EnvelopeStatisticsHistoryEntry[]> {
  const previous = await readIndex();
  const keep: IndexEntry[] = [];
  const cutoff = Date.now() - retentionMs;
  for (const item of previous) {
    if (item.at < cutoff || keep.length >= maximum) continue;
    if (item.summary?.id === item.id && item.summary.settings && Number.isFinite(item.summary.comparedCount)) {
      keep.push(item); continue;
    }
    // Original archives have no summary. Read one report at a time, not all large row arrays at once.
    const report = await loadEnvelopeStatisticsReport(item.id);
    if (report) keep.push({ ...item, summary: summaryFor(report) });
  }
  // Reads never replace the index: another tab may be publishing a new report concurrently.
  const selected = symbol?.toUpperCase().replace(/USDT$/, '');
  return keep.flatMap(item => item.summary && (!selected || item.summary.settings.symbol.toUpperCase().replace(/USDT$/, '') === selected) ? [item.summary] : []);
}
