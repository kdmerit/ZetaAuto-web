import { describe, expect, it } from 'vitest';

import { formatBacktestHistorySettings } from './backtestHistory';
import { defaultSettings } from './components/StrategyBacktest';
import { envelopeOptimizerVersion } from './envelopeStatistics';

describe('backtest history setting summaries', () => {
  it('keeps dates but omits both times and unchecked envelope options', () => {
    const settings = {
      ...defaultSettings('ENVELOPE'),
      interval: '1d' as const,
      startDate: '2026-01-01',
      startTime: '12:34',
      endDate: '2026-02-01',
      endTime: '23:45',
      initialCapitalUsdt: '1000',
      betAmountUsdt: '500',
      leverage: '10',
      envelopeMa20Enabled: true,
      envelopeCloseOnCenterReturn: false,
      envelopeHalfCandleEnabled: true,
      envelopeCandleFilterEnabled: false,
      envelopeTrailingStopEnabled: false,
    };

    const summary = formatBacktestHistorySettings(settings, 'ENVELOPE').join(' · ');
    expect(summary.startsWith('방향 롱 + 숏 · 1D · 2026-01-01 ~ 2026-02-01 · 가상 초기자금 1000 USDT · 고정 베팅액 500 USDT · 레버리지 10배')).toBe(true);
    expect(summary).toContain('MA20 위·아래 방향 필터 적용');
    expect(summary).toContain('캔들 절반 엔벨 이내 적용');
    expect(summary).not.toContain('12:34');
    expect(summary).not.toContain('23:45');
    expect(summary).not.toContain('중심선 터치후 이탈시 매도');
    expect(summary).not.toContain('매수금지 캔들 필터');
    expect(summary).not.toContain('TP');
    expect(summary).not.toContain('트레일링 스탑');
    expect(formatBacktestHistorySettings({ ...settings, envelopeTakeProfitEnabled: true, envelopeTakeProfitPercent: '6' }, 'ENVELOPE')).toContain('TP 6%');
  });

  it('shows only enabled dependent inputs for the new-high strategy', () => {
    const settings = {
      ...defaultSettings('NEW_HIGH'),
      newHighBreakoutCandleMinEnabled: true,
      newHighBreakoutCandleMinAtr: '1.5',
      newHighBreakoutCandleMaxEnabled: false,
      newHighSlEnabled: false,
      newHighTpEnabled: true,
      newHighTpMultiplier: '4',
      newHighTrailingStopEnabled: true,
      newHighTrailingStopMultiplier: '2',
      newHighSizingMode: 'BET' as const,
      newHighDailyMa20Enabled: false,
    };

    const summary = formatBacktestHistorySettings(settings, 'NEW_HIGH').join(' · ');
    expect(summary).toContain('돌파봉 최소크기 1.5 ATR');
    expect(summary).not.toContain('돌파봉 최대크기');
    expect(summary).not.toContain('SL 배수');
    expect(summary).toContain('TP 배수 4 ATR');
    expect(summary).toContain('트레일링 스탑 배수 2 ATR');
    expect(summary).not.toContain('1d MA20 방향 필터');
  });

  it('uses the statistics period and displays saved result filters', () => {
    const settings = {
      ...defaultSettings('ENVELOPE'),
      interval: '1d' as const,
      envelopeStatisticsInterval: '4h' as const,
      envelopeResultOptions: {
        minTrades: '10',
        minReturnPercent: '5',
        minProfitRatioPercent: '55',
        sort: 'winRatePercent' as const,
      },
    };

    const summary = formatBacktestHistorySettings(settings, 'ENVELOPE', 'ENVELOPE_STATISTICS').join(' · ');
    expect(summary).toContain('4H');
    expect(summary).toContain('최소 진입횟수 10');
    expect(summary).toContain('최소 수익률 5%');
    expect(summary).toContain('최소 수익비 55%');
    expect(summary).toContain('정렬 기준 승률');
    expect(summary).toContain('SL 3%');
    for (const kind of ['ENVELOPE_STATISTICS', 'ENVELOPE_BATCH_STATS'] as const) {
      const updated = formatBacktestHistorySettings(settings, 'ENVELOPE', kind, envelopeOptimizerVersion);
      expect(updated).toEqual(expect.arrayContaining(['중심선 탐색 1~10봉', '이격 탐색 0.1~10.0%', 'SL 탐색 0.1~10.0%']));
      expect(updated).not.toContain('SL 3%');
    }
  });
});
