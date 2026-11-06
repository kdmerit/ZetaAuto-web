import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StrategyBacktest } from './StrategyBacktest';

describe('new high workspace', () => {
  it('provides the two target tabs, Unit/capital/N fields and supported intervals without unsupported exit options', () => {
    const html = renderToStaticMarkup(<StrategyBacktest strategy="NEW_HIGH" context={{ apiBaseUrl: 'https://example.invalid', accessToken: 'fixture-only' }} />);
    for (const text of ['신고가 백테스트', '개별 종목', '전체 종목', '가상 초기자금', '고정 베팅액', '신고가 기준 봉수', 'SL 배수 (ATR)', '고정 손실액', '현재가 &gt; MA60', 'MA10 아래에서 매수', '>1H<', '>4H<', '>1D<', '돌파선 +0.5~1.0ATR 범위에서만 매수', '단계형 트레일링 SL', '봉 중간 1회 진입']) expect(html).toContain(text);
    for (const text of ['>15M<', '변동폭 최소', '>K1<', '>K2<', '부분 TP 50%', '서버에서 분석', '엔벨로프 이격', '추가매수', '불타기', 'MA5&lt;MA20', '돌파 허용 상한 (ATR)', '종가/꼬리 확인', '돌파 방향으로 마감']) expect(html).not.toContain(text);
    expect(html).toContain('min="6"'); expect(html).toContain('max="1000"'); expect(html).toContain('최근 5봉');
  });
});
