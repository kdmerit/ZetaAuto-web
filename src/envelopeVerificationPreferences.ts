import {
  defaultVerificationFilterOptions,
  isVerificationDeviationSlMultiplier,
  verificationMetrics,
  type VerificationDirection,
  type VerificationFilterOptions,
  type VerificationMetric,
  type VerificationResultOptions,
  type VerificationSource,
} from './envelopeVerification';

export interface EnvelopeVerificationPreferences {
  direction: VerificationDirection;
  months: string;
  options: VerificationResultOptions;
  filterDraft: VerificationFilterOptions;
}

const storageKey = (source: VerificationSource): string => `zetaauto.web.envelope.${source}.verification`;

function isVerificationMetric(value: unknown): value is VerificationMetric {
  return typeof value === 'string' && Object.hasOwn(verificationMetrics, value);
}

function restoreFilters(saved?: Partial<VerificationFilterOptions>, fallback = defaultVerificationFilterOptions): VerificationFilterOptions {
  return {
    filterBy: isVerificationMetric(saved?.filterBy) ? saved.filterBy : fallback.filterBy,
    comparison: saved?.comparison === 'MIN' || saved?.comparison === 'MAX' ? saved.comparison : fallback.comparison,
    threshold: typeof saved?.threshold === 'string' ? saved.threshold : fallback.threshold,
    deviationSlEnabled: typeof saved?.deviationSlEnabled === 'boolean' ? saved.deviationSlEnabled : fallback.deviationSlEnabled,
    deviationSlMultiplier: typeof saved?.deviationSlMultiplier === 'string' ? saved.deviationSlMultiplier : fallback.deviationSlMultiplier,
  };
}

export function loadEnvelopeVerificationPreferences(source: VerificationSource): EnvelopeVerificationPreferences {
  let saved: Partial<EnvelopeVerificationPreferences> | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(storageKey(source)) ?? 'null');
  } catch {
    // Use default inputs if local storage is unavailable or unreadable.
  }
  const filters = restoreFilters(saved?.options);
  const filterDraft = restoreFilters(saved?.filterDraft, filters);
  const threshold = filters.threshold.trim();
  const sortBy = saved?.options?.sortBy;
  return {
    direction: saved?.direction === 'FUTURE' ? 'FUTURE' : 'PAST',
    months: typeof saved?.months === 'string' ? saved.months : '12',
    options: {
      ...filters,
      sortBy: isVerificationMetric(sortBy) ? sortBy : '',
      sortOrder: saved?.options?.sortOrder === 'LOW' ? 'LOW' : 'HIGH',
      threshold: Number.isFinite(Number(threshold)) ? threshold : '',
      deviationSlEnabled: filters.deviationSlEnabled && isVerificationDeviationSlMultiplier(filters.deviationSlMultiplier),
    },
    filterDraft,
  };
}

export function saveEnvelopeVerificationPreferences(source: VerificationSource, preferences: EnvelopeVerificationPreferences): void {
  try {
    localStorage.setItem(storageKey(source), JSON.stringify(preferences));
  } catch {
    // Keep the controls usable when storage is blocked or full.
  }
}
