import type { BacktestSettings } from './types';

/** TP is measured from the reference candle's low/high across its full range. */
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
    partialTpEnabled: false,
  };
}

export const referenceRules = {
  long: [
    '현재 캔들의 거래량과 몸통 크기가 각각 직전 캔들의 2배 이상인 양봉을 기준봉으로 삼습니다.',
    '기준봉 중심선(고가·저가의 중간값)에서 롱 진입하고, 기준봉 저가를 SL로 사용합니다.',
    '기준봉 다음 캔들은 기준봉 고가를 넘지 않고 중심선을 터치하며 거래량이 더 작을 때만 같은 진입을 허용합니다. 그 이후에는 진입하지 않습니다.',
    'TP는 기준봉 저가에서 기준봉 전체 범위의 입력 비율만큼 위에 둡니다. 기본값은 80%(중심선보다 30% 위)입니다.',
  ],
  short: [
    '현재 캔들의 거래량과 몸통 크기가 각각 직전 캔들의 2배 이상인 음봉을 기준봉으로 삼습니다.',
    '기준봉 중심선(고가·저가의 중간값)에서 숏 진입하고, 기준봉 고가를 SL로 사용합니다.',
    '기준봉 다음 캔들은 기준봉 저가를 깨지 않고 중심선을 터치하며 거래량이 더 작을 때만 같은 진입을 허용합니다. 그 이후에는 진입하지 않습니다.',
    'TP는 기준봉 고가에서 기준봉 전체 범위의 입력 비율만큼 아래에 둡니다. 기본값은 80%(중심선보다 30% 아래)입니다.',
  ],
  common: '분석 주기는 1h·4h·1d만 사용하며 개별 종목 또는 전체 종목을 선택할 수 있습니다. 기준봉과 바로 다음 봉만 진입 대상으로 계산합니다.',
};
