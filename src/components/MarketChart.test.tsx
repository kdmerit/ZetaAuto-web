import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BacktestMenu, backtestMenuOrderStorageKey } from './BacktestMenu';
import { ChartModal } from './ChartModal';
import { MarketIndicatorControls } from './MarketIndicatorControls';
import { defaultMarketIndicators, enrichMarketCandles } from '../marketIndicators';
import { chartAtrPeriod } from '../atr';
import type { Candle, ChartData } from '../types';

const rows: Candle[] = Array.from({ length: 130 }, (_, index) => ({ openTime: index * 86400, closeTime: (index + 1) * 86400, open: 100, high: 105, low: 95, close: 100, volume: index === 129 ? 1000 : 500 }));
const chart: ChartData = { symbol: 'BTCUSDT', interval: '1d', side: null, referenceAt: new Date(rows.at(-1)!.openTime * 1000).toISOString(), referenceIndex: 129,
  candles: enrichMarketCandles(rows, '1d', chartAtrPeriod), market: { sourceCandles: rows }, markers: [], executions: [], priceLines: [], waves: [] };
describe('standalone market chart presentation', () => {
  it('keeps only the chart and disparity backtest entries', () => {
    const html = renderToStaticMarkup(<BacktestMenu onOpen={() => {}} onOpenChart={() => {}} onSignOut={() => {}} email="tester@example.com" />);
    expect(html).toContain('종합차트');
    expect(html).toContain('이격매매 백테스트');
    for (const title of ['신고가 백테스트', '캔들돌파 백테스트', 'ATR 엔벨로프 백테스트', '변동성 돌파 백테스트', '기준봉 백테스트', '엔벨로프 백테스트']) expect(html).not.toContain(title);
    expect(html).toContain('메뉴 순서 편집'); expect(html).not.toContain('상세설명'); expect(html).toContain('로그아웃');
  });
  it('ignores removed entries in a previously saved menu order', () => {
    const order = ['NEW_HIGH', 'CHART', 'ENVELOPE', 'MA_DISPARITY'];
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => key === backtestMenuOrderStorageKey ? JSON.stringify(order) : null } });
    try {
      const html = renderToStaticMarkup(<BacktestMenu onOpen={() => {}} onOpenChart={() => {}} onSignOut={() => {}} email={null} />);
      expect(html).toContain('aria-label="종합차트"');
      expect(html).toContain('aria-label="이격매매 백테스트"');
      expect(html.indexOf('aria-label="종합차트"')).toBeLessThan(html.indexOf('aria-label="이격매매 백테스트"'));
      expect(html).not.toContain('신고가 백테스트');
    } finally { vi.unstubAllGlobals(); }
  });
  it('omits position/entry/exit labels and keeps only the primary envelope and Bollinger chart indicators', () => {
    const html = renderToStaticMarkup(<ChartModal chart={chart} onClose={() => {}} />);
    expect(html).toContain('종목 차트'); expect(html).toContain('종목 캔들 차트'); expect(html).not.toContain('매수가'); expect(html).not.toContain('청산가'); expect(html).not.toContain('숏');
    expect(html).toContain('aria-label="BTCUSDT 팝업 닫기"');
    expect(html).toContain('ATR14 10 (10.00%)'); expect(html).not.toContain('>TR '); expect(html).toContain('market-true-range positive'); expect(html).toContain('거래량 1,000 / 500 (200.0%)');
    expect(html).toContain('bollinger-upper'); expect(html).toContain('#F0B45D'); expect(html).toContain('볼린저밴드');
    expect(html).not.toContain('atr-upper'); expect(html).not.toContain('#64D8E8'); expect(html).not.toContain('ATR 엔벨로프');
    expect(html).not.toContain('envelope2-upper'); expect(html).not.toContain('#7EA2FF'); expect(html).not.toContain('엔벨로프 2');
  });
  it('renders the primary envelope and Bollinger controls without secondary envelope inputs', () => {
    const html = renderToStaticMarkup(<MarketIndicatorControls value={defaultMarketIndicators} onApply={() => {}} />);
    for (const label of ['엔벨로프 SMA', '엔벨로프 이격 (%)', '볼린저밴드 기간', '볼린저밴드 표준편차 배수']) expect(html).toContain(label);
    expect(html).not.toContain('엔벨로프 2'); expect(html).not.toContain('ATR 중심 EMA'); expect(html).not.toContain('ATR 기간'); expect(html).not.toContain('ATR 승수');
    expect(html).not.toContain('입력 후'); expect(html).not.toContain('market-indicator-hint');
  });
  it('leaves backtest chart controls, entry/exit links and title intact', () => {
    const html = renderToStaticMarkup(<ChartModal chart={{ ...chart, market: undefined, side: 'LONG', candles: chart.candles.map(candle => ({ ...candle, marketMetrics: undefined })) }} onClose={() => {}} />);
    expect(html).toContain('백테스트 차트'); expect(html).toContain('BACKTEST'); expect(html).toContain('롱'); expect(html).toContain('매수가'); expect(html).toContain('청산가');
    expect(html).not.toContain('ATR 엔벨로프 설정'); expect(html).toContain('market-true-range'); expect(html).toContain('ATR 10 (10.00%)');
  });
  it('shows selected MA pair differences and gap percentages', () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'zetaauto.web.chart.visibleMas' ? JSON.stringify({ ma5: true, ma10: true, ma20: true, ma60: true, ma120: false }) : null });
    try {
      const candles = chart.candles.map(candle => ({ ...candle, ma5: 110, ma10: 105, ma20: 100, ma60: 80 }));
      const html = renderToStaticMarkup(<ChartModal chart={{ ...chart, market: undefined, candles, side: 'LONG' }} onClose={() => {}} />);
      expect(html).toContain('MA5 - MA10 +5 <em>(+4.76%)</em>');
      expect(html).toContain('MA10 - MA20 +5 <em>(+5.00%)</em>');
      expect(html).toContain('MA20 - MA60 +20 <em>(+25.00%)</em>');
      expect(html.indexOf('MA5 - MA10')).toBeLessThan(html.indexOf('MA10 - MA20'));
    } finally { vi.unstubAllGlobals(); }
  });
  it('draws the final exit price and colors a profitable close green', () => {
    const entry = { id: 'entry', orderId: 'entry', kind: 'ENTRY' as const, label: 'B' as const, openTime: rows.at(-1)!.openTime, price: 100, quantity: 1, candleIndex: 129 };
    const close = { id: 'close', orderId: 'close', kind: 'CLOSE' as const, label: 'C' as const, openTime: rows.at(-1)!.openTime, price: 105, quantity: 1, candleIndex: 129 };
    const html = renderToStaticMarkup(<ChartModal chart={{ ...chart, market: undefined, side: 'LONG', markers: [entry, close], executions: [entry, close], priceLines: [{ kind: 'ENTRY', price: 100 }, { kind: 'EXIT', price: 105 }], exitReason: 'FULL_TP', exitProfit: true }} onClose={() => {}} />);
    expect(html).toContain('stroke="#AE7BFA"'); expect(html).toContain('fill="#39C98A"'); expect(html).toContain('청산가 105');
    const sl = renderToStaticMarkup(<ChartModal chart={{ ...chart, market: undefined, side: 'LONG', markers: [entry, close], executions: [entry, close], priceLines: [{ kind: 'ENTRY', price: 100 }, { kind: 'EXIT', price: 105 }], exitReason: 'SL', exitProfit: false }} onClose={() => {}} />);
    expect(sl).toContain('stroke="#FF5C78"'); expect(sl).toContain('SL 105'); expect(sl).toContain('trade-price-link close stop'); expect(sl).toContain('fill="#FF5C78"');
    const loss = renderToStaticMarkup(<ChartModal chart={{ ...chart, market: undefined, side: 'LONG', markers: [entry, close], executions: [entry, close], priceLines: [{ kind: 'ENTRY', price: 100 }, { kind: 'EXIT', price: 105 }], exitReason: 'FULL_TP', exitProfit: false }} onClose={() => {}} />);
    expect(loss).toContain('청산가 105'); expect(loss).toContain('trade-price-link close loss');
  });
  it('shows the 20-day ATR in a volatility backtest popup', () => {
    const html = renderToStaticMarkup(<ChartModal chart={{ ...chart, candles: enrichMarketCandles(rows, '1d'), market: undefined, side: 'LONG', priceLines: [{ kind: 'ENTRY', price: 100 }, { kind: 'SL', price: 90 }] }} onClose={() => {}} />);
    expect(html).toContain('백테스트 차트'); expect(html).toContain('ATR 10 (10.00%)'); expect(html).toContain('market-true-range positive');
  });
});
