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
  '3. 4h 현재 캔들이 음봉이고 몸통이 직전 캔들 몸통의 5배 이상이면 매수 금지',
  '4. 4h 직전 캔들이 음봉이고 몸통이 전전 캔들 몸통의 5배 이상이면 매수 금지',
  '',
  '숏 포지션',
  '1. 1d 현재 캔들이 양봉이고 몸통이 직전 캔들 몸통의 5배 이상이면 매수 금지',
  '2. 1d 직전 캔들이 양봉이고 몸통이 전전 캔들 몸통의 5배 이상이면 매수 금지',
  '3. 4h 현재 캔들이 양봉이고 몸통이 직전 캔들 몸통의 5배 이상이면 매수 금지',
  '4. 4h 직전 캔들이 양봉이고 몸통이 전전 캔들 몸통의 5배 이상이면 매수 금지',
  '',
  '※ 1d·4h 모두 몸통 5배와 정확히 같은 경우도 포함합니다. 몸통은 시가와 종가의 차이의 절댓값입니다.',
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

function CopyIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8" y="3" width="12" height="12" rx="2" /><rect x="4" y="9" width="12" height="12" rx="2" /></svg>;
}

function CheckIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 12 4 4L19 6" /></svg>;
}

export function EnvelopeCandleFilterControl({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  const [expanded, setExpanded] = useState(false);
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
      <div className="candle-filter-heading"><button className="candle-filter-toggle" type="button" aria-expanded={expanded} aria-controls="envelope-candle-filter-conditions" onClick={() => setExpanded(value => !value)}><strong>매수금지 조건</strong><span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span></button><button className={'candle-filter-copy' + (copyState === 'copied' ? ' copied' : '')} type="button" aria-label={copyState === 'copied' ? '매수금지 조건 복사됨' : copyState === 'error' ? '매수금지 조건 복사 실패, 다시 시도' : '매수금지 조건 복사'} title={copyState === 'copied' ? '복사됨' : copyState === 'error' ? '복사 실패' : '조건 복사'} onClick={() => { void copyConditions(); }}>{copyState === 'copied' ? <CheckIcon /> : <CopyIcon />}</button></div>
      <div id="envelope-candle-filter-conditions" hidden={!expanded}>
        <p>진입 시점까지 확인된 1d·4h 캔들을 기준으로 검사합니다. 아래 조건 중 하나라도 해당하면 해당 방향은 매수하지 않습니다.</p>
        <div className="candle-filter-side"><strong>롱 포지션</strong>{envelopeCandleFilterCopyText.split('\n').slice(5, 9).map(text => <p key={text}>{text}</p>)}</div>
        <div className="candle-filter-side"><strong>숏 포지션</strong>{envelopeCandleFilterCopyText.split('\n').slice(11, 15).map(text => <p key={text}>{text}</p>)}</div>
        <p className="candle-filter-footnote">1d·4h 모두 몸통 5배와 정확히 같은 경우도 포함합니다. 몸통은 시가와 종가 차이의 절댓값입니다.</p>
      </div>
    </section>
  </>;
}
