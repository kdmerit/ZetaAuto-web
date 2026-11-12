import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultSettings, StrategyBacktest } from './StrategyBacktest';
import { EnvelopeWorkspace } from './EnvelopeWorkspace';
import { envelopeCandleFilterCopyText } from './EnvelopeCandleFilterControl';
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
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain('MA20 위에서만 매수 (롱)');
    expect(rows[0]).toContain('checked=""');
    expect(rows[1]).toContain('중심선 터치후 이탈시 매도');
    expect(rows[1]).not.toContain('checked=""');
    expect(rows[2]).toContain('롱/숏 비율 50%');
    expect(rows[2]).not.toContain('checked=""');
    expect(rows[3]).toContain('매수금지 캔들 필터 적용');
    expect(rows[3]).not.toContain('checked=""');
    expect(html).toMatch(/SL \(%\)[\s\S]*?<input[^>]*min="0.1"[^>]*max="20"[^>]*step="0.1"[^>]*value="3"/);
    expect(html).not.toContain('MA20 아래에서만 매수 (롱)');
    expect(html).not.toContain('종가 &gt; 엔벨로프 상단 확정 시 청산');
  });

  it('uses 3% without changing the defaults of other strategies or the center SMA period', () => {
    expect(defaultSettings('ENVELOPE')).toMatchObject({ interval: '1d', envelopeStatisticsInterval: '1d', envelopeDeviationPercent: '3', envelopeStopLossPercent: '3', envelopeCandleFilterEnabled: false, envelopeMa20Enabled: true, envelopeMaPeriod: '20' });
    expect(defaultSettings()).toMatchObject({ interval: '15m', envelopeDeviationPercent: '0.5', envelopeMa20Enabled: false });
    const html = renderToStaticMarkup(<StrategyBacktest strategy="ENVELOPE" context={context} />);
    expect(html).toMatch(/엔벨로프 이격 \(%\)[\s\S]*?<input[^>]*value="3"/);
  });

  it('places the center-return exit immediately after the above-MA20 filter', () => {
    const html = renderToStaticMarkup(<StrategyBacktest strategy="ENVELOPE" context={context} />);
    const above = html.indexOf('MA20 위에서만 매수 (롱)');
    expect(above).toBeGreaterThanOrEqual(0);
    const centerReturn = html.indexOf('중심선 터치후 이탈시 매도');
    expect(centerReturn).toBeGreaterThan(above);
    const ratio = html.indexOf('롱/숏 비율 50%');
    expect(ratio).toBeGreaterThan(centerReturn);
    expect(html.indexOf('매수금지 캔들 필터 적용')).toBeGreaterThan(ratio);
    expect(html.indexOf('SL (%)')).toBeGreaterThan(html.indexOf('엔벨로프 이격 (%)'));
    expect(html).not.toContain('MA20 아래에서만 매수 (롱)');
    expect(html).not.toContain('종가 &gt; 엔벨로프 상단 확정 시 청산 (롱)');
    expect(html).not.toContain('첫 번째는 롱 저가');
    expect(ratio).toBeLessThan(html.indexOf('<h2>엔벨로프 중심선 봉수</h2>'));
  });

  it('shows and copies the four directional candle-entry exclusions', () => {
    const html = renderToStaticMarkup(<StrategyBacktest strategy="ENVELOPE" context={context} />);
    expect(html).toContain('매수금지 조건');
    expect(html).toContain('조건 복사');
    expect(html).toContain('4h 직전 캔들의 윗꼬리');
    expect(html).toContain('현재 캔들의 저점이 직전 캔들의 저점보다 높으면');
    expect(envelopeCandleFilterCopyText).toContain('선택한 백테스트 주기와 관계없이 적용');
    expect(envelopeCandleFilterCopyText.split('\n')).toHaveLength(17);
  });

  it('retains explicit saved intervals, deviations and unchecked filters', () => {
    saveSettings('ENVELOPE', { ...defaultSettings('ENVELOPE'), interval: '4h', envelopeDeviationPercent: '7.5', envelopeStopLossPercent: '1.5', envelopeCandleFilterEnabled: true, envelopeMa20Enabled: false, envelopeCloseOnConfirmedBreakout: true });
    const html = renderToStaticMarkup(<StrategyBacktest strategy="ENVELOPE" context={context} />);
    expect(html).toContain('중심선 · 매매 기준 4H');
    expect(html).toMatch(/엔벨로프 이격 \(%\)[\s\S]*?<input[^>]*value="7.5"/);
    expect(options(html)[0]).not.toContain('checked=""');
    expect(options(html)[3]).toContain('checked=""');
    expect(html).toMatch(/SL \(%\)[\s\S]*?<input[^>]*value="1.5"/);
  });

  it('restores the saved center-return exit in ordinary analysis and statistics', () => {
    saveSettings('ENVELOPE', { ...defaultSettings('ENVELOPE'), envelopeCloseOnCenterReturn: true, envelopeSideRatio50Enabled: true });
    const ordinary = renderToStaticMarkup(<StrategyBacktest strategy="ENVELOPE" context={context} />);
    expect(options(ordinary)[1]).toContain('checked=""');
    expect(options(ordinary)[2]).toContain('checked=""');
    values.set('zetaauto.web.envelope.view', 'SINGLE_STATS');
    values.set('zetaauto.web.envelope.SINGLE_STATS.settings', JSON.stringify({ envelopeCloseOnCenterReturn: true, envelopeSideRatio50Enabled: true }));
    const statistics = renderToStaticMarkup(<EnvelopeWorkspace context={context} />);
    expect(options(statistics)[1]).toContain('checked=""');
    expect(options(statistics)[2]).toContain('checked=""');
  });

  it('keeps saved statistics preferences instead of replacing them with new defaults', () => {
    values.set('zetaauto.web.envelope.view', 'SINGLE_STATS');
    values.set('zetaauto.web.envelope.SINGLE_STATS.settings', JSON.stringify({ envelopeStatisticsInterval: '4h', envelopeMa20Enabled: false, envelopeCloseOnConfirmedBreakout: true }));
    const html = renderToStaticMarkup(<EnvelopeWorkspace context={context} />);
    expect(html).toMatch(/aria-pressed="true" class="selected">4H</);
    expect(options(html)[0]).not.toContain('checked=""');
  });
});
