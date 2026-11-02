import type { Strategy } from '../types';

interface BacktestMenuProps {
  onOpen: (strategy: Strategy) => void;
  onOpenChart: () => void;
  onSignOut: () => void;
  email: string | null;
}

export function BacktestMenu({ onOpen, onOpenChart, onSignOut, email }: BacktestMenuProps) {
  const items = [
    { strategy: 'NEW_HIGH' as const, title: '신고가 백테스트' },
    {
      strategy: 'PULLBACK' as const,
      title: '눌림목 백테스트',
    },
    {
      strategy: 'DISPARITY' as const,
      title: '이격매매 백테스트',
    },
    {
      strategy: 'VOLATILITY' as const,
      title: '변동성 돌파 백테스트',
    },
    {
      strategy: 'ENVELOPE' as const,
      title: '엔벨로프 백테스트',
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

        <div className="menu-cards">
          <button className="menu-card market-menu-card" type="button" onClick={onOpenChart}>
            <span className="menu-card-copy"><strong>차트 보기</strong></span><span className="chevron" aria-hidden="true">›</span>
          </button>
          {items.map((item) => (
            <button
              className="menu-card"
              key={item.strategy}
              type="button"
              onClick={() => onOpen(item.strategy)}
            >
              <span className="menu-card-copy">
                <strong>{item.title}</strong>
              </span>
              <span className="chevron" aria-hidden="true">›</span>
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
