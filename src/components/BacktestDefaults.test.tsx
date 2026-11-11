import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultSettings, StrategyBacktest } from './StrategyBacktest';
import { EnvelopeWorkspace } from './EnvelopeWorkspace';
import { loadSettings, saveSettings } from '../storage';

const strategies = ['PULLBACK', 'DISPARITY', 'VOLATILITY', 'ENVELOPE', 'NEW_HIGH', 'REFERENCE'] as const;
const context = { apiBaseUrl: 'https://example.invalid', accessToken: 'fixture-only' };
let values: Map<string, string>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-10T16:00:00Z')); // 11 November in Korea.
  values = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('one-month backtest start defaults', () => {
  it.each(strategies)('uses one Korean calendar month ago for a new %s form', strategy => {
    expect(defaultSettings(strategy).startDate).toBe('2026-10-11');
    const markup = renderToStaticMarkup(<StrategyBacktest strategy={strategy} context={context} />);
    expect(markup).toMatch(/시작일<input[^>]*value="2026-10-11"/);
  });

  it.each([
    ['2026-03-31T03:00:00Z', '2026-02-28'],
    ['2024-03-31T03:00:00Z', '2024-02-29'],
    ['2026-05-31T03:00:00Z', '2026-04-30'],
    ['2026-01-31T03:00:00Z', '2025-12-31'],
    ['2026-12-31T15:01:00Z', '2026-12-01'],
  ])('handles month-end, leap years and Korean midnight at %s', (now, expected) => {
    vi.setSystemTime(new Date(now));
    expect(defaultSettings().startDate).toBe(expected);
  });

  it.each(strategies)('restores the last %s date/time rather than replacing them with defaults', strategy => {
    saveSettings(strategy, { ...defaultSettings(strategy), startDate: '2025-02-03', startTime: '13:45' });
    vi.setSystemTime(new Date('2026-12-15T03:00:00Z'));
    expect(loadSettings(strategy, defaultSettings(strategy))).toMatchObject({ startDate: '2025-02-03', startTime: '13:45' });
    const markup = renderToStaticMarkup(<StrategyBacktest strategy={strategy} context={context} />);
    expect(markup).toMatch(/시작일<input[^>]*value="2025-02-03"/);
  });

  it.each(['SINGLE_STATS', 'ALL_STATS'])('uses the same date fallback and preserves saved %s dates', view => {
    values.set('zetaauto.web.envelope.view', view);
    expect(renderToStaticMarkup(<EnvelopeWorkspace context={context} />)).toMatch(/시작일<input[^>]*value="2026-10-11"/);
    values.set(`zetaauto.web.envelope.${view}.settings`, JSON.stringify({ startDate: '2025-02-03', startTime: '13:45' }));
    expect(renderToStaticMarkup(<EnvelopeWorkspace context={context} />)).toMatch(/시작일<input[^>]*value="2025-02-03"/);
  });
});
