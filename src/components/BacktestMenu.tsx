import { useState } from 'react';

interface BacktestMenuProps {
  onOpen: (strategy: 'PULLBACK' | 'DISPARITY' | 'VOLATILITY') => void;
  onSignOut: () => void;
  email: string | null;
}

export function BacktestMenu({ onOpen, onSignOut, email }: BacktestMenuProps) {
  const [expanded, setExpanded] = useState(false);
  const items = [
    {
      strategy: 'PULLBACK' as const,
      title: '눌림목 백테스트',
      description:
        '반전 첫 봉과 1차가·SL의 중간에서 분할매수하며, 파동폭 비율 TP·2차 체결 후 매수봉 종가 TP를 분석합니다.',
    },
    {
      strategy: 'DISPARITY' as const,
      title: '이격매매 백테스트',
      description:
        'MA20·MA60 사이 이격과 직전 10봉 MA20 조건으로 진입하고, 직전 10봉 SL·MA60 청산을 분석합니다.',
    },
    {
      strategy: 'VOLATILITY' as const,
      title: '변동성 돌파 백테스트',
      description:
        '3봉 방향·최소 변동폭·K1~K2 종가 구간으로 진입하고, 매수봉 저가·고가 SL과 K1 종가 조건·변동폭 1배 TP로 청산합니다.',
    },
  ];

  return (
    <main className="screen">
      <div className="content menu-content">
        <header className="page-header">
          <div>
            <p className="eyebrow">BYBIT · BACKTEST</p>
            <h1>백테스트</h1>
          </div>
          <div className="account-actions">
            <span className="account-email" title={email ?? undefined}>{email ?? ''}</span>
            <button className="logout-button" type="button" onClick={onSignOut}>로그아웃</button>
          </div>
        </header>

        <button
          className="outline-button detail-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '상세설명접기' : '상세설명보기'}
        </button>
        {expanded ? (
          <p className="muted menu-description">
            분석할 전략을 선택해 과거 매매 성적을 확인합니다. 개별·전체 종목 모두 저장된 캔들을 우선 사용해 이 기기에서 계산합니다.
          </p>
        ) : null}

        <div className="menu-cards">
          {items.map((item) => (
            <button
              className="menu-card"
              key={item.strategy}
              type="button"
              onClick={() => onOpen(item.strategy)}
            >
              <span className="menu-card-copy">
                <strong>{item.title}</strong>
                {expanded ? <span>{item.description}</span> : null}
              </span>
              <span className="chevron" aria-hidden="true">›</span>
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
