import { enrichCandles, intervalSeconds } from './api';
import { atrWindowSeconds, calendarAtr } from './atr';
import type { BacktestSettings, Candle } from './types';

export interface PreparedNewHigh {
  atr: number | null;
  sum9: number;
  sum19: number;
  previousMa10: number;
  high: number;
  low: number;
  long: boolean;
  short: boolean;
}

export function newHighPeriod(settings: BacktestSettings): number {
  const text = settings.newHighLookback ?? '20';
  if (!/^\d+$/.test(text) || Number(text) < 6 || Number(text) > 1000) throw new Error('신고가 기준 봉수는 최근 5봉 제외를 위해 6~1000 정수로 입력해 주세요.');
  if (settings.interval !== '1h' && settings.interval !== '4h') throw new Error('신고가 백테스트는 1h·4h만 사용할 수 있습니다.');
  return Number(text);
}
export function newHighWarmup(settings: BacktestSettings): number {
  return Math.max(atrWindowSeconds + intervalSeconds(settings.interval), (newHighPeriod(settings) + 40) * intervalSeconds(settings.interval));
}
export function currentNewHighSettings(settings: BacktestSettings): BacktestSettings {
  return { ...settings, interval: settings.interval === '4h' ? '4h' : '1h', newHighLookback: settings.newHighLookback ?? '20', partialTpEnabled: false };
}

/** Every field is fixed from candles strictly before the execution candle. */
export function prepareNewHigh(candles: Candle[], settings: BacktestSettings): (PreparedNewHigh | undefined)[] {
  const period = newHighPeriod(settings); const enriched = enrichCandles(candles); const atr = calendarAtr(candles, settings.interval);
  const sums = [0]; for (const row of candles) sums.push(sums.at(-1)! + row.close);
  const extremes = (field: 'high' | 'low', direction: number): number[] => {
    const deque: number[] = []; let left = 0;
    return candles.map((_row, index) => {
      while (left < deque.length && deque[left]! < index - period) left += 1;
      const extreme = left < deque.length ? candles[deque[left]!]![field] : NaN;
      while (deque.length > left && direction * candles[deque.at(-1)!]![field] <= direction * candles[index]![field]) deque.pop();
      deque.push(index); return extreme;
    });
  };
  const highs = extremes('high', 1); const lows = extremes('low', -1);
  return candles.map((_candle, index) => {
    if (index < Math.max(period, 40)) return undefined;
    const recent = candles.slice(index - 5, index);
    const cross = enriched.slice(index - 20, index);
    return { atr: atr[index]!.complete ? atr[index]!.value : null,
      sum9: sums[index]! - sums[index - 9]!, sum19: sums[index]! - sums[index - 19]!, previousMa10: enriched[index - 1]!.ma10!,
      high: highs[index]!, low: lows[index]!,
      long: settings.side !== 'SHORT' && recent.every(row => row.high < highs[index]!) && cross.some(row => row.ma10 !== null && row.ma20 !== null && row.ma10 < row.ma20),
      short: settings.side !== 'LONG' && recent.every(row => row.low > lows[index]!) && cross.some(row => row.ma10 !== null && row.ma20 !== null && row.ma10 > row.ma20),
    };
  });
}

export const newHighRules = {
  long: [
    '현재 봉을 제외한 이전 N봉 최고가를 위로 돌파한 그 봉에서 즉시 1Unit 진입합니다. N은 입력값(기본 20)이며 실제 체결가가 돌파선 + 1ATR 이내여야 합니다.',
    '돌파 순간 현재가를 반영한 MA10 > MA20이고, 이전 20봉 안에 MA10 < MA20인 봉이 하나 이상 있어야 합니다.',
    '이전 N봉 최고가가 최근 5개 완성봉 안에 한 번이라도 있으면 진입하지 않습니다. 초기 SL은 실제 매수가 − 2×ATR입니다.',
    'MA10이 직전 확정 MA10보다 상승하고 현재가가 MA10·MA20 위일 때, 마지막 실제 매수가보다 ATR만큼 오르면 1Unit씩 최대 4회 추가매수합니다.',
    '추가매수 직후 전체 보유 수량의 SL을 해당 추가매수가 − 2×ATR로 변경합니다.',
    '현재가 < MA10 이고 현재가 < MA20이면 전량 청산합니다. SL 접촉도 전량 청산합니다.',
  ],
  short: [
    '현재 봉을 제외한 이전 N봉 최저가를 아래로 돌파한 그 봉에서 즉시 1Unit 숏 진입합니다. 실제 체결가가 돌파선 − 1ATR 이상이어야 합니다.',
    '돌파 순간 현재가를 반영한 MA10 < MA20이고, 이전 20봉 안에 MA10 > MA20인 봉이 하나 이상 있어야 합니다.',
    '이전 N봉 최저가가 최근 5개 완성봉 안에 한 번이라도 있으면 진입하지 않습니다. 초기 SL은 실제 매수가 + 2×ATR입니다.',
    'MA10이 직전 확정 MA10보다 하락하고 현재가가 MA10·MA20 아래일 때, 마지막 실제 매수가보다 ATR만큼 내리면 1Unit씩 최대 4회 추가매수합니다.',
    '추가매수 직후 전체 보유 수량의 SL을 해당 추가매수가 + 2×ATR로 변경합니다.',
    '현재가 > MA10 이고 현재가 > MA20이면 전량 청산합니다. SL 접촉도 전량 청산합니다.',
  ],
  common: 'ATR은 선택 주기 TR의 직전 20일 단순평균(1h 480봉·4h 120봉)이며 매 봉 시작 전에 확정합니다. 자료가 부족하면 신규/추가 진입하지 않습니다. 1Unit은 입력한 고정 베팅액이며 최초 1회+추가 4회, 총 최대 5Unit입니다. 추가 진입은 수량 가중 평단가에 반영하고 자금이 부족하거나 SL 가격이 유효하지 않으면 생략합니다. 첫 돌파 순간 조건이 맞지 않거나 갭이 진입 허용 범위를 넘으면 같은 봉에서 추격/재시도하지 않습니다. 갭은 과거 돌파가가 아닌 관측 시가에 체결하며 진입/청산 0.02% 슬리피지·편도 0.055% 수수료를 반영합니다. 진입 범위는 슬리피지 반영 실제 체결가로 검사합니다. 두 OHLC 경로 중 낮은 계좌 평가액을 선택하고 동시 경계는 SL 우선입니다. 정확한 틱 재현은 아닙니다. 한 봉에서 청산 후 재진입하지 않으며 전체종목은 한 계좌·종목명 순서·봉 시작 가용자금만 사용합니다.',
};
