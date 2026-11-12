import { useState } from 'react';

/** Optional daily/four-hour entry exclusions, independent of the chart interval. */
export const envelopeCandleFilterCopyText = [
  '매수금지 캔들 필터 조건',
  '',
  '진입 시점까지 확인된 1d·4h 캔들을 기준으로 검사합니다. 선택한 백테스트 주기와 관계없이 적용되며, 아래 조건 중 하나라도 해당하는 방향은 매수하지 않습니다.',
  '',
  '롱 포지션',
  '1. 1d 현재 캔들이 음봉이고 몸통이 직전 캔들 몸통의 5배 이상이면 매수 금지',
  '2. 1d 직전 캔들이 음봉이고 몸통이 전전 캔들 몸통의 5배 이상이면 매수 금지',
  '3. 4h 현재 캔들의 윗꼬리 + 음봉 몸통이 아랫꼬리 + 양봉 몸통보다 크면 매수 금지',
  '4. 4h 직전 캔들의 윗꼬리 + 음봉 몸통이 아랫꼬리 + 양봉 몸통보다 크고, 현재 캔들의 고점이 직전 캔들의 고점보다 낮으면 매수 금지',
  '',
  '숏 포지션',
  '1. 1d 현재 캔들이 양봉이고 몸통이 직전 캔들 몸통의 5배 이상이면 매수 금지',
  '2. 1d 직전 캔들이 양봉이고 몸통이 전전 캔들 몸통의 5배 이상이면 매수 금지',
  '3. 4h 현재 캔들의 윗꼬리 + 음봉 몸통이 아랫꼬리 + 양봉 몸통보다 작으면 매수 금지',
  '4. 4h 직전 캔들의 윗꼬리 + 음봉 몸통이 아랫꼬리 + 양봉 몸통보다 작고, 현재 캔들의 저점이 직전 캔들의 저점보다 높으면 매수 금지',
  '',
  '※ 1d 몸통 5배 조건은 같거나 큰 경우를 포함합니다. 4h 비교 조건은 초과·미만일 때만 적용됩니다. 몸통은 시가와 종가의 차이의 절댓값입니다.',
].join('\n');

async function copyText(value: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back to the selection API when clipboard permission is unavailable.
    }
  }
  if (typeof document === 'undefined') throw new Error('clipboard unavailable');
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = typeof document.execCommand === 'function' && document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('clipboard unavailable');
}

export function EnvelopeCandleFilterControl({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const copyConditions = async (): Promise<void> => {
    try {
      await copyText(envelopeCandleFilterCopyText);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  };
  return <>
    <label className="checkbox-row"><input type="checkbox" checked={enabled} onChange={event => onChange(event.target.checked)} /><span>매수금지 캔들 필터 적용</span></label>
    <section className="candle-filter-info" aria-label="매수금지 캔들 필터 조건">
      <div className="candle-filter-heading"><strong>매수금지 조건</strong><button className="candle-filter-copy" type="button" onClick={() => { void copyConditions(); }}>{copyState === 'copied' ? '복사됨' : copyState === 'error' ? '복사 실패' : '조건 복사'}</button></div>
      <p>진입 시점까지 확인된 1d·4h 캔들을 기준으로 검사합니다. 아래 조건 중 하나라도 해당하면 해당 방향은 매수하지 않습니다.</p>
      <div className="candle-filter-side"><strong>롱 포지션</strong><p>1. 1d 현재 캔들이 음봉이고 몸통이 직전 캔들 몸통의 5배 이상이면 매수 금지</p><p>2. 1d 직전 캔들이 음봉이고 몸통이 전전 캔들 몸통의 5배 이상이면 매수 금지</p><p>3. 4h 현재 캔들의 윗꼬리 + 음봉 몸통이 아랫꼬리 + 양봉 몸통보다 크면 매수 금지</p><p>4. 4h 직전 캔들의 윗꼬리 + 음봉 몸통이 아랫꼬리 + 양봉 몸통보다 크고, 현재 캔들의 고점이 직전 캔들의 고점보다 낮으면 매수 금지</p></div>
      <div className="candle-filter-side"><strong>숏 포지션</strong><p>1. 1d 현재 캔들이 양봉이고 몸통이 직전 캔들 몸통의 5배 이상이면 매수 금지</p><p>2. 1d 직전 캔들이 양봉이고 몸통이 전전 캔들 몸통의 5배 이상이면 매수 금지</p><p>3. 4h 현재 캔들의 윗꼬리 + 음봉 몸통이 아랫꼬리 + 양봉 몸통보다 작으면 매수 금지</p><p>4. 4h 직전 캔들의 윗꼬리 + 음봉 몸통이 아랫꼬리 + 양봉 몸통보다 작고, 현재 캔들의 저점이 직전 캔들의 저점보다 높으면 매수 금지</p></div>
      <p className="candle-filter-footnote">1d 몸통 5배 조건은 같거나 큰 경우를 포함하고, 4h 비교 조건은 초과·미만일 때만 적용합니다. 몸통은 시가와 종가 차이의 절댓값입니다.</p>
    </section>
  </>;
}
