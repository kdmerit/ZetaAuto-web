import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BacktestMenu } from './BacktestMenu';
import { ChartModal } from './ChartModal';
import { MarketIndicatorControls } from './MarketIndicatorControls';
import { defaultMarketIndicators, enrichMarketCandles } from '../marketIndicators';
import type { Candle, ChartData } from '../types';

const rows: Candle[] = Array.from({ length: 130 }, (_, index) => ({ openTime: index * 86400, closeTime: (index + 1) * 86400, open: 100, high: 105, low: 95, close: 100, volume: index === 129 ? 1000 : 500 }));
const chart: ChartData = { symbol: 'BTCUSDT', interval: '1d', side: null, referenceAt: new Date(rows.at(-1)!.openTime * 1000).toISOString(), referenceIndex: 129,
  candles: enrichMarketCandles(rows, '1d'), market: { sourceCandles: rows }, markers: [], executions: [], priceLines: [], waves: [] };
describe('standalone market chart presentation', () => {
  it('puts chart browsing first and removes all menu explanation controls/content', () => {
    const html = renderToStaticMarkup(<BacktestMenu onOpen={() => {}} onOpenChart={() => {}} onSignOut={() => {}} email="tester@example.com" />);
    expect(html.indexOf('차트 보기')).toBeLessThan(html.indexOf('눌림목 백테스트'));
    expect(html.indexOf('차트 보기')).toBeLessThan(html.indexOf('신고가 백테스트')); expect(html.indexOf('신고가 백테스트')).toBeLessThan(html.indexOf('눌림목 백테스트'));
    expect(html).toContain('메뉴 순서 편집'); expect(html).not.toContain('상세설명'); expect(html).not.toContain('분석할 전략'); expect(html).toContain('엔벨로프 백테스트'); expect(html).toContain('로그아웃');
  });
  it('omits position/entry/exit labels and includes twenty-day ATR, prior volume ratio and independent indicator bands', () => {
    const html = renderToStaticMarkup(<ChartModal chart={chart} onClose={() => {}} />);
    expect(html).toContain('종목 차트'); expect(html).toContain('종목 캔들 차트'); expect(html).not.toContain('매수가'); expect(html).not.toContain('청산가'); expect(html).not.toContain('숏');
    expect(html).toContain('aria-label="BTCUSDT 팝업 닫기"');
    expect(html).toContain('ATR 10 (10.00%)'); expect(html).not.toContain('>TR '); expect(html).toContain('market-true-range positive'); expect(html).toContain('거래량 1,000 / 500 (200.0%)');
    expect(html).toContain('atr-upper'); expect(html).toContain('bollinger-upper'); expect(html).toContain('#64D8E8'); expect(html).toContain('#F2C66D'); expect(html).toContain('볼린저밴드'); expect(html).not.toContain('envelope-upper');
  });
  it('renders independent validated controls with the selected EMA20/ATR14/2.0 and Bollinger20/2.0 defaults', () => {
    const html = renderToStaticMarkup(<MarketIndicatorControls value={defaultMarketIndicators} onApply={() => {}} />);
    for (const label of ['엔벨로프 SMA', '엔벨로프 이격 (%)', 'ATR 중심 EMA', 'ATR 기간', 'ATR 승수', '볼린저밴드 기간', '볼린저밴드 표준편차 배수']) expect(html).toContain(label);
    expect(html).toContain('value="14"'); expect(html).toContain('value="2.0"'); expect(html).toContain('value="20"'); expect(html).not.toContain('입력 후'); expect(html).not.toContain('market-indicator-hint');
  });
  it('leaves backtest chart controls, entry/exit links and title intact', () => {
    const html = renderToStaticMarkup(<ChartModal chart={{ ...chart, market: undefined, side: 'LONG', candles: chart.candles.map(candle => ({ ...candle, marketMetrics: undefined })) }} onClose={() => {}} />);
    expect(html).toContain('백테스트 차트'); expect(html).toContain('BACKTEST'); expect(html).toContain('롱'); expect(html).toContain('매수가'); expect(html).toContain('청산가');
    expect(html).not.toContain('ATR 엔벨로프 설정'); expect(html).toContain('market-true-range'); expect(html).toContain('ATR 10 (10.00%)');
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
    const html = renderToStaticMarkup(<ChartModal chart={{ ...chart, market: undefined, side: 'LONG', priceLines: [{ kind: 'ENTRY', price: 100 }, { kind: 'SL', price: 90 }] }} onClose={() => {}} />);
    expect(html).toContain('백테스트 차트'); expect(html).toContain('ATR 10 (10.00%)'); expect(html).toContain('market-true-range positive');
  });
});
