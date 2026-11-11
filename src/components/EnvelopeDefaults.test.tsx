import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultSettings, StrategyBacktest } from './StrategyBacktest';
import { EnvelopeWorkspace } from './EnvelopeWorkspace';
import { saveSettings } from '../storage';

const context = { apiBaseUrl: 'https://example.invalid', accessToken: 'fixture-only' };
let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

function options(html: string): string[] {
  return [...html.matchAll(/<label class="checkbox-row">([\s\S]*?)<\/label>/g)].map(match => match[1]!);
}

describe('envelope input defaults and arrangement', () => {
  it.each(['SINGLE', 'ALL', 'SINGLE_STATS', 'ALL_STATS'])('starts %s at 1D with the above-MA20 filter checked', view => {
    values.set('zetaauto.web.envelope.view', view);
    const html = renderToStaticMarkup(<EnvelopeWorkspace context={context} />);
    expect(html).toMatch(/class="selected"[^>]*>1D<|aria-pressed="true"[^>]*>1D</);
    const rows = options(html);
    expect(rows[0]).toContain('MA20 위에서만 매수 (롱)');
    expect(rows[0]).toContain('checked=""');
    expect(rows[1]).not.toContain('checked=""');
    expect(rows[2]).toContain('종가 &gt; 엔벨로프 상단 확정 시 청산');
    expect(rows[2]).not.toContain('checked=""');
  });

  it('uses 3% without changing the defaults of other strategies or the center SMA period', () => {
    expect(defaultSettings('ENVELOPE')).toMatchObject({ interval: '1d', envelopeStatisticsInterval: '1d', envelopeDeviationPercent: '3', envelopeMa20Enabled: true, envelopeMaPeriod: '20' });
    expect(defaultSettings()).toMatchObject({ interval: '15m', envelopeDeviationPercent: '0.5', envelopeMa20Enabled: false });
    const html = renderToStaticMarkup(<StrategyBacktest strategy="ENVELOPE" context={context} />);
    expect(html).toMatch(/엔벨로프 이격 \(%\)[\s\S]*?<input[^>]*value="3"/);
  });

  it('places all three checkboxes together before the SMA and deviation inputs', () => {
    const html = renderToStaticMarkup(<StrategyBacktest strategy="ENVELOPE" context={context} />);
    const above = html.indexOf('MA20 위에서만 매수 (롱)');
    const below = html.indexOf('MA20 아래에서만 매수 (롱)');
    const confirm = html.indexOf('종가 &gt; 엔벨로프 상단 확정 시 청산 (롱)');
    expect(above).toBeLessThan(below);
    expect(below).toBeLessThan(confirm);
    expect(confirm).toBeLessThan(html.indexOf('첫 번째는 롱 저가'));
    expect(confirm).toBeLessThan(html.indexOf('<h2>엔벨로프 중심선 봉수</h2>'));
  });

  it('retains explicit saved intervals, deviations and unchecked filters', () => {
    saveSettings('ENVELOPE', { ...defaultSettings('ENVELOPE'), interval: '4h', envelopeDeviationPercent: '7.5', envelopeMa20Enabled: false, envelopeCloseOnConfirmedBreakout: true });
    const html = renderToStaticMarkup(<StrategyBacktest strategy="ENVELOPE" context={context} />);
    expect(html).toContain('중심선 · 매매 기준 4H');
    expect(html).toMatch(/엔벨로프 이격 \(%\)[\s\S]*?<input[^>]*value="7.5"/);
    expect(options(html)[0]).not.toContain('checked=""');
    expect(options(html)[2]).toContain('checked=""');
  });

  it('keeps saved statistics preferences instead of replacing them with new defaults', () => {
    values.set('zetaauto.web.envelope.view', 'SINGLE_STATS');
    values.set('zetaauto.web.envelope.SINGLE_STATS.settings', JSON.stringify({ envelopeStatisticsInterval: '4h', envelopeMa20Enabled: false, envelopeCloseOnConfirmedBreakout: true }));
    const html = renderToStaticMarkup(<EnvelopeWorkspace context={context} />);
    expect(html).toMatch(/aria-pressed="true" class="selected">4H</);
    expect(options(html)[0]).not.toContain('checked=""');
    expect(options(html)[2]).toContain('checked=""');
  });
});
