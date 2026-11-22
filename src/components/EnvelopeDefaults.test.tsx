import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultSettings, StrategyBacktest } from './StrategyBacktest';
import { EnvelopeWorkspace } from './EnvelopeWorkspace';
import { envelopeCandleFilterCopyText } from './EnvelopeCandleFilterControl';
import { defaultVerificationFilterOptions, defaultVerificationResultOptions } from '../envelopeVerification';
import { loadEnvelopeVerificationPreferences, saveEnvelopeVerificationPreferences, type EnvelopeVerificationPreferences } from '../envelopeVerificationPreferences';
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
    if (view === 'SINGLE' || view === 'ALL') {
      expect(html).toMatch(/엔벨로프 중심선 봉수\s*<input[^>]*type="number"[^>]*min="1" max="240" step="1"[^>]*value="20"/);
      expect(html).toMatch(/SL \(%\)[\s\S]*?<input[^>]*min="0.1"[^>]*max="20"[^>]*step="0.1"[^>]*value="3"/);
    } else {
      expect(html).toContain('중심선은 1~10봉을 1봉씩');
      expect(html).toContain('이격과 SL은 각각 0.1~10.0%');
      expect(html).not.toContain('SL (%)');
      expect(html).toContain('월별 검증');
      expect(html).toMatch(/aria-pressed="true">과거<\/button>/);
      expect(html).toMatch(/disabled=""[^>]*>검증<\/button>/);
    }
    const rows = options(html);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toContain('MA20 위에서만 매수 (롱)');
    expect(rows[0]).toContain('checked=""');
    expect(rows[1]).toContain('중심선 터치후 이탈시 매도');
    expect(rows[1]).not.toContain('checked=""');
    expect(rows[2]).toContain('롱/숏 비율 50%');
    expect(rows[2]).not.toContain('checked=""');
    expect(rows[3]).toContain('종가에서만 매수');
    expect(rows[3]).not.toContain('checked=""');
    expect(rows[4]).toContain('캔들 절반 엔벨 이내');
    expect(rows[4]).toContain('checked=""');
    expect(rows[5]).toContain('매수금지 캔들 필터 적용');
    expect(rows[5]).not.toContain('checked=""');
    expect(rows[6]).toContain('TP사용');
    expect(rows[6]).not.toContain('checked=""');
    expect(rows[7]).toContain('트레일링 스탑 적용');
    expect(rows[7]).not.toContain('checked=""');
    expect(html).toMatch(/TP \(%\)[\s\S]*?<input[^>]*min="0.1" max="20"[^>]*disabled=""[^>]*value="6"/);
    expect(html).toMatch(/트레일링 스탑 \(%\)[\s\S]*?<input[^>]*min="1"[^>]*max="100"[^>]*step="0.1"[^>]*value="3"/);
    expect(html).not.toContain('MA20 아래에서만 매수 (롱)');
    expect(html).not.toContain('종가 &gt; 엔벨로프 상단 확정 시 청산');
  });

  it('uses 3% without changing the defaults of other strategies or the center SMA period', () => {
    expect(defaultSettings('ENVELOPE')).toMatchObject({ interval: '1d', envelopeStatisticsInterval: '1d', envelopeDeviationPercent: '3', envelopeStopLossPercent: '3', envelopeCloseOnlyEntryEnabled: false, envelopeHalfCandleEnabled: true, envelopeCandleFilterEnabled: false, envelopeMa20Enabled: true, envelopeMaPeriod: '20' });
    expect(defaultSettings()).toMatchObject({ interval: '15m', envelopeDeviationPercent: '0.5', envelopeMa20Enabled: false });
    const html = renderToStaticMarkup(<StrategyBacktest strategy="ENVELOPE" context={context} />);
    expect(html).toMatch(/엔벨로프 이격 \(%\)[\s\S]*?<input[^>]*value="3"/);
    expect(html).toContain('엔벨로프 개별 종목은 슬리피지 필터 없이 분석합니다.');
  });

  it('offers only ATR individual/all analysis with the chart inputs and the shared entry filters', () => {
    values.set('zetaauto.web.envelope.view', 'ALL_STATS');
    const html = renderToStaticMarkup(<EnvelopeWorkspace strategy="ATR_ENVELOPE" context={context} />);
    expect(html).toContain('<h1>ATR 엔벨로프 백테스트</h1>');
    expect(html).toContain('>개별분석</button>');
    expect(html).toContain('>전체분석</button>');
    for (const label of ['개별통계', '전체통계', '가상매매', '엔벨로프 중심선 봉수', '엔벨로프 이격 (%)', 'SL (%)', 'TP사용']) expect(html).not.toContain(label);
    for (const label of ['MA20 위에서만 매수 (롱)', '중심선 터치후 이탈시 매도', '롱/숏 비율 50%', '종가에서만 매수', '캔들 절반 엔벨 이내', '매수금지 캔들 필터 적용', '트레일링 스탑 적용']) {
      expect(html).toContain(label);
    }
    expect(html).toMatch(/aria-label="ATR 중심 EMA"[^>]*min="0" max="120" step="1"[^>]*value="20"/);
    expect(html).toMatch(/aria-label="ATR 기간"[^>]*min="0" max="120" step="1"[^>]*value="14"/);
    expect(html).toMatch(/aria-label="ATR 승수"[^>]*min="0" max="20" step="0\.1"[^>]*value="2\.0"/);
    expect(html).toMatch(/SL 배수 \(ATR\)\s*<input[^>]*min="0" max="20" step="0\.1"[^>]*value="0\.5"/);
    expect(html.indexOf('SL 배수 (ATR)')).toBeGreaterThan(html.indexOf('× N'));
    expect(html.indexOf('SL 배수 (ATR)')).toBeLessThan(html.indexOf('트레일링 스탑 적용'));
    expect(html).toContain('BTC 이력보기');
    values.set('zetaauto.web.atrEnvelope.view', 'ALL');
    saveSettings('ATR_ENVELOPE', { ...defaultSettings('ATR_ENVELOPE'), atrEnvelope: { emaPeriod: '3', atrPeriod: '3', atrMultiplier: '0.5' }, atrEnvelopeStopMultiplier: '1.2' });
    const all = renderToStaticMarkup(<EnvelopeWorkspace strategy="ATR_ENVELOPE" context={context} />);
    expect(all).not.toContain('placeholder="BTC"');
    expect(all).toContain('전체종목 이력보기');
    expect(all).toMatch(/aria-label="ATR 승수"[^>]*value="0\.5"/);
    expect(all).toMatch(/SL 배수 \(ATR\)\s*<input[^>]*value="1\.2"/);
  });

  it('places the center-return exit immediately after the above-MA20 filter', () => {
    const html = renderToStaticMarkup(<StrategyBacktest strategy="ENVELOPE" context={context} />);
    const above = html.indexOf('MA20 위에서만 매수 (롱)');
    expect(above).toBeGreaterThanOrEqual(0);
    const centerReturn = html.indexOf('중심선 터치후 이탈시 매도');
    expect(centerReturn).toBeGreaterThan(above);
    const ratio = html.indexOf('롱/숏 비율 50%');
    expect(ratio).toBeGreaterThan(centerReturn);
    const halfCandle = html.indexOf('캔들 절반 엔벨 이내');
    const closeOnly = html.indexOf('종가에서만 매수');
    expect(closeOnly).toBeGreaterThan(ratio);
    expect(halfCandle).toBeGreaterThan(closeOnly);
    expect(html.indexOf('매수금지 캔들 필터 적용')).toBeGreaterThan(halfCandle);
    expect(html.indexOf('SL (%)')).toBeGreaterThan(html.indexOf('엔벨로프 이격 (%)'));
    expect(html).not.toContain('MA20 아래에서만 매수 (롱)');
    expect(html).not.toContain('종가 &gt; 엔벨로프 상단 확정 시 청산 (롱)');
    expect(html).not.toContain('첫 번째는 롱 저가');
    expect(ratio).toBeLessThan(html.indexOf('엔벨로프 중심선 봉수'));
    expect(html.indexOf('엔벨로프 중심선 봉수')).toBeLessThan(html.indexOf('엔벨로프 이격 (%)'));
  });

  it('shows and copies the body and daily/four-hour wick exclusions', () => {
    const html = renderToStaticMarkup(<StrategyBacktest strategy="ENVELOPE" context={context} />);
    expect(html).toContain('매수금지 조건');
    expect(html).toContain('조건 복사');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('id="envelope-candle-filter-conditions" hidden=""');
    expect(html).toContain('<rect x="8" y="3" width="12" height="12"');
    expect(html).toContain('4h 직전 캔들이 음봉이고 몸통이 전전 캔들 몸통의 5배 이상이면');
    expect(html).toContain('4h 현재 캔들이 양봉이고 몸통이 직전 캔들 몸통의 5배 이상이면');
    expect(html).toContain('윗꼬리 + 음봉 몸통이 전체 캔들 길이의 70% 이상');
    expect(html).toContain('아랫꼬리 + 양봉 몸통이 전체 캔들 길이의 70% 이상');
    expect(envelopeCandleFilterCopyText).toContain('선택한 백테스트 주기와 관계없이 적용');
    expect(envelopeCandleFilterCopyText).toContain('6. 4h 현재 또는 직전 캔들에서 윗꼬리');
    expect(envelopeCandleFilterCopyText).toContain('6. 4h 현재 또는 직전 캔들에서 아랫꼬리');
    expect(html).toContain('6. 4h 현재 또는 직전 캔들에서 윗꼬리');
    expect(html).toContain('6. 4h 현재 또는 직전 캔들에서 아랫꼬리');
  });

  it('retains explicit saved intervals, deviations and unchecked filters', () => {
    saveSettings('ENVELOPE', { ...defaultSettings('ENVELOPE'), interval: '4h', envelopeMaPeriod: '137', envelopeDeviationPercent: '7.5', envelopeStopLossPercent: '1.5', envelopeHalfCandleEnabled: false, envelopeCandleFilterEnabled: true, envelopeMa20Enabled: false, envelopeCloseOnConfirmedBreakout: true });
    const html = renderToStaticMarkup(<StrategyBacktest strategy="ENVELOPE" context={context} />);
    expect(html).toContain('중심선 · 매매 기준 4H');
    expect(html).toMatch(/엔벨로프 중심선 봉수\s*<input[^>]*value="137"/);
    expect(html).toMatch(/엔벨로프 이격 \(%\)[\s\S]*?<input[^>]*value="7.5"/);
    expect(options(html)[0]).not.toContain('checked=""');
    expect(options(html)[3]).toContain('종가에서만 매수');
    expect(options(html)[3]).not.toContain('checked=""');
    expect(options(html)[4]).not.toContain('checked=""');
    expect(options(html)[5]).toContain('checked=""');
    expect(html).toMatch(/SL \(%\)[\s\S]*?<input[^>]*value="1.5"/);
  });

  it('restores the saved center-return exit in ordinary analysis and statistics', () => {
    saveSettings('ENVELOPE', { ...defaultSettings('ENVELOPE'), envelopeCloseOnCenterReturn: true, envelopeSideRatio50Enabled: true, envelopeTakeProfitEnabled: true, envelopeTakeProfitPercent: '6.25' });
    const ordinary = renderToStaticMarkup(<StrategyBacktest strategy="ENVELOPE" context={context} />);
    expect(options(ordinary)[1]).toContain('checked=""');
    expect(options(ordinary)[2]).toContain('checked=""');
    expect(options(ordinary)[6]).toContain('checked=""');
    expect(ordinary).toMatch(/TP \(%\)[\s\S]*?<input[^>]*value="6\.25"/);
    expect(ordinary).not.toMatch(/TP \(%\)[\s\S]*?<input(?=[^>]*value="6\.25")[^>]*disabled=""/);
    values.set('zetaauto.web.envelope.view', 'SINGLE_STATS');
    values.set('zetaauto.web.envelope.SINGLE_STATS.settings', JSON.stringify({ envelopeCloseOnCenterReturn: true, envelopeSideRatio50Enabled: true, envelopeTakeProfitEnabled: false, envelopeTakeProfitPercent: '7' }));
    const statistics = renderToStaticMarkup(<EnvelopeWorkspace context={context} />);
    expect(options(statistics)[1]).toContain('checked=""');
    expect(options(statistics)[2]).toContain('checked=""');
    expect(statistics).toMatch(/TP \(%\)[\s\S]*?<input[^>]*disabled=""[^>]*value="7"/);
  });

  it('keeps saved statistics preferences instead of replacing them with new defaults', () => {
    values.set('zetaauto.web.envelope.view', 'SINGLE_STATS');
    values.set('zetaauto.web.envelope.SINGLE_STATS.settings', JSON.stringify({ envelopeStatisticsInterval: '4h', envelopeMa20Enabled: false, envelopeCloseOnConfirmedBreakout: true }));
    const html = renderToStaticMarkup(<EnvelopeWorkspace context={context} />);
    expect(html).toMatch(/aria-pressed="true" class="selected">4H</);
    expect(options(html)[0]).not.toContain('checked=""');
  });

  it('restores each statistics screen with its own verification inputs and preserves unapplied filter edits', () => {
    const single: EnvelopeVerificationPreferences = {
      direction: 'FUTURE', months: '24',
      options: { sortBy: 'netUsdt', sortOrder: 'LOW', filterBy: 'lossMonths', comparison: 'MAX', threshold: '2', deviationSlEnabled: true, deviationSlMultiplier: '2.5' },
      filterDraft: { filterBy: 'averageProfit', comparison: 'MIN', threshold: '', deviationSlEnabled: false, deviationSlMultiplier: '' },
    };
    const all: EnvelopeVerificationPreferences = {
      direction: 'PAST', months: '6', options: defaultVerificationResultOptions, filterDraft: defaultVerificationFilterOptions,
    };
    saveEnvelopeVerificationPreferences('SINGLE_STATS', single);
    saveEnvelopeVerificationPreferences('ALL_STATS', all);

    expect(loadEnvelopeVerificationPreferences('SINGLE_STATS')).toEqual(single);
    expect(loadEnvelopeVerificationPreferences('ALL_STATS')).toEqual(all);
    values.set('zetaauto.web.envelope.view', 'SINGLE_STATS');
    const individual = renderToStaticMarkup(<EnvelopeWorkspace context={context} />);
    expect(individual).toMatch(/aria-pressed="true">미래<\/button>/);
    expect(individual).toMatch(/검증 개월 수<input[^>]*value="24"/);
    values.set('zetaauto.web.envelope.view', 'ALL_STATS');
    const whole = renderToStaticMarkup(<EnvelopeWorkspace context={context} />);
    expect(whole).toMatch(/aria-pressed="true">과거<\/button>/);
    expect(whole).toMatch(/검증 개월 수<input[^>]*value="6"/);
  });

  it('restores editable inputs without activating invalid stored filter values', () => {
    values.set('zetaauto.web.envelope.SINGLE_STATS.verification', JSON.stringify({
      months: '', options: { sortBy: 'toString', threshold: 'Infinity', deviationSlEnabled: true, deviationSlMultiplier: '0' },
    }));
    const saved = loadEnvelopeVerificationPreferences('SINGLE_STATS');
    expect(saved.months).toBe('');
    expect(saved.options).toMatchObject({ sortBy: '', threshold: '', deviationSlEnabled: false });
    expect(saved.filterDraft).toMatchObject({ deviationSlEnabled: true, deviationSlMultiplier: '0' });
    values.set('zetaauto.web.envelope.SINGLE_STATS.verification', '{');
    expect(loadEnvelopeVerificationPreferences('SINGLE_STATS')).toEqual({
      direction: 'PAST', months: '12', options: defaultVerificationResultOptions, filterDraft: defaultVerificationFilterOptions,
    });
  });
});
