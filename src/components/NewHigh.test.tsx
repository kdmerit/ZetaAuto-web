import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StrategyBacktest } from './StrategyBacktest';

describe('new high workspace', () => {
  it('shows the mirrored strategy and keeps only analysis and sizing controls', () => {
    const html = renderToStaticMarkup(<StrategyBacktest strategy="NEW_HIGH" context={{ apiBaseUrl: 'https://example.invalid', accessToken: 'fixture-only' }} />);
    for (const text of ['신고가 백테스트', '개별 종목', '전체 종목', '가상 초기자금', '고정 베팅액', '고정 손실액',
      '>1H<', '>4H<', '>1D<', '롱은 20봉 신고가, 숏은 20봉 신저가', 'MA20·MA60 이격은 ATR 이하',
      '진입봉의 저가(롱)·고가(숏)']) expect(html).toContain(text);
    for (const text of ['>15M<', '신고가 기준 봉수', '돌파봉 최소크기', '돌파봉 최대크기', 'SL 배수', 'TP 배수',
      '트레일링 스탑', '1d MA20 위에서만 매수', '부분 TP 50%', '서버에서 분석']) expect(html).not.toContain(text);
  });
});
