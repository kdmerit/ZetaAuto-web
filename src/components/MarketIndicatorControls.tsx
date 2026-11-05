import { useEffect, useState } from 'react';
import { marketIndicatorParameters, type MarketIndicatorSettings } from '../marketIndicators';

export function MarketIndicatorControls({ value, onApply }: { value: MarketIndicatorSettings; onApply: (value: MarketIndicatorSettings) => void }) {
  const [draft, setDraft] = useState(value); const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(value); setError(null); }, [value]);
  const apply = (group: 'SMA' | 'ATR' | 'BOLLINGER'): void => {
    const next = group === 'SMA' ? { ...value, smaPeriod: draft.smaPeriod, deviationPercent: draft.deviationPercent }
      : group === 'ATR' ? { ...value, emaPeriod: draft.emaPeriod, atrPeriod: draft.atrPeriod, atrMultiplier: draft.atrMultiplier }
      : { ...value, bollingerPeriod: draft.bollingerPeriod, bollingerMultiplier: draft.bollingerMultiplier };
    try { marketIndicatorParameters(next); setError(null); onApply(next); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '지표 수치를 확인해 주세요.'); }
  };
  const field = (key: keyof MarketIndicatorSettings, label: string, name: string, group: 'SMA' | 'ATR' | 'BOLLINGER', maximum: number, integer = false) => <label>
    <span>{label}</span><input aria-label={name} type="number" inputMode={integer ? 'numeric' : 'decimal'} min="0" max={maximum} step={integer ? '1' : '0.1'}
      value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value })} onBlur={() => apply(group)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
  </label>;
  return <div className="market-indicator-controls">
    <div className="market-indicator-row sma-controls" role="group" aria-label="엔벨로프 설정"><strong>엔벨로프</strong>
      {field('smaPeriod', 'SMA', '엔벨로프 SMA', 'SMA', 120, true)}{field('deviationPercent', '이격 %', '엔벨로프 이격 (%)', 'SMA', 20)}
    </div>
    <div className="market-indicator-row atr-controls" role="group" aria-label="ATR 엔벨로프 설정"><strong>ATR 엔벨로프</strong>
      {field('emaPeriod', 'EMA', 'ATR 중심 EMA', 'ATR', 120, true)}{field('atrPeriod', 'ATR', 'ATR 기간', 'ATR', 120, true)}{field('atrMultiplier', '×', 'ATR 승수', 'ATR', 20)}
    </div>
    <div className="market-indicator-row bollinger-controls" role="group" aria-label="볼린저밴드 설정"><strong>볼린저밴드</strong>
      {field('bollingerPeriod', '기간', '볼린저밴드 기간', 'BOLLINGER', 120, true)}{field('bollingerMultiplier', '표준편차 ×', '볼린저밴드 표준편차 배수', 'BOLLINGER', 10)}
    </div>
    {error ? <p className="indicator-error" role="alert">{error}</p> : null}
  </div>;
}
