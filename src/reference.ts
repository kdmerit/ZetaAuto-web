import type { BacktestSettings } from './types';

/** TP is measured from the SL line to the reference candle's defining extreme. */
export function referenceTpPercent(settings: BacktestSettings): number {
  const text = settings.referenceTpPercent ?? '80';
  const value = Number(text);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || !Number.isFinite(value) || value < 51 || value > 200) {
    throw new Error('기준봉 TP 비율은 51~200으로 입력해 주세요.');
  }
  return value;
}

export function currentReferenceSettings(settings: BacktestSettings): BacktestSettings {
  return {
    ...settings,
    interval: settings.interval === '1d' ? '1d' : settings.interval === '4h' ? '4h' : '1h',
    referenceTpPercent: settings.referenceTpPercent ?? '80',
    referenceMa10Enabled: settings.referenceMa10Enabled === true,
    partialTpEnabled: false,
  };
}

export const referenceRules = {
  long: [
    '현재 캔들의 거래량과 몸통 크기가 각각 직전 캔들의 5배 이상인 양봉을 기준봉으로 삼습니다.',
    'SL은 직전봉과 기준봉 저가 중 더 낮은 가격이며, 매수라인은 SL과 기준봉 고가의 중간값입니다. 기준봉 고가가 15분봉에서 확정된 뒤 위에서 매수라인으로 하락 재터치할 때 롱 진입합니다.',
    '기준봉 다음 캔들은 기준봉 고가를 넘지 않고 매수라인을 터치하며 거래량이 더 작을 때만 같은 진입을 허용합니다. 그 이후에는 진입하지 않습니다.',
    'TP는 SL라인부터 기준봉 고가까지의 간격을 100%로 보고 입력 비율만큼 위에 둡니다. 기본값은 80%입니다.',
  ],
  short: [
    '현재 캔들의 거래량과 몸통 크기가 각각 직전 캔들의 5배 이상인 음봉을 기준봉으로 삼습니다.',
    'SL은 직전봉과 기준봉 고가 중 더 높은 가격이며, 매수라인은 SL과 기준봉 저가의 중간값입니다. 기준봉 저가가 15분봉에서 확정된 뒤 아래에서 매수라인으로 상승 재터치할 때 숏 진입합니다.',
    '기준봉 다음 캔들은 기준봉 저가를 깨지 않고 매수라인을 터치하며 거래량이 더 작을 때만 같은 진입을 허용합니다. 그 이후에는 진입하지 않습니다.',
    'TP는 SL라인부터 기준봉 저가까지의 간격을 100%로 보고 입력 비율만큼 아래에 둡니다. 기본값은 80%입니다.',
  ],
  common: '분석 주기는 1h·4h·1d만 사용하며 개별 종목 또는 전체 종목을 선택할 수 있습니다. 기준봉과 바로 다음 봉만 진입 대상으로 계산합니다. MA10 필터를 켜면 기준봉 종가가 MA10 아래인 롱, MA10 위인 숏만 매수합니다.',
};
