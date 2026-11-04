import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StrategyBacktest } from './StrategyBacktest';

describe('new high workspace', () => {
  it('provides the two target tabs, Unit/capital/N fields and only 1h/4h without unsupported exit options', () => {
    const html = renderToStaticMarkup(<StrategyBacktest strategy="NEW_HIGH" context={{ apiBaseUrl: 'https://example.invalid', accessToken: 'fixture-only' }} />);
    for (const text of ['신고가 백테스트', '개별 종목', '전체 종목', '가상 초기자금', '고정 베팅액', '신고가 기준 봉수', '>1H<', '>4H<', '돌파선 ± 1ATR', '이전 파동 몸통 저점', '트레일링 스탑']) expect(html).toContain(text);
    for (const text of ['>15M<', '>1D<', '변동폭 최소', '>K1<', '>K2<', '부분 TP 50%', '서버에서 분석', '엔벨로프 이격', '추가매수', '불타기', 'SL 배수 (ATR)']) expect(html).not.toContain(text);
    expect(html).toContain('min="6"'); expect(html).toContain('max="1000"'); expect(html).toContain('최근 5봉');
  });
});
