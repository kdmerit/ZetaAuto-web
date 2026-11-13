/** Independent, fill-relative envelope stop percentage. */
export function EnvelopeStopLossControl({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label className="field-label">SL (%)<span className="suffix-field"><input type="number" min="0.1" max="20" step="0.1" inputMode="decimal" value={value} onChange={event => onChange(event.target.value)} /><b>%</b></span><small>0.1~20.0 · 기본 3% · 실제 매수가 기준</small></label>;
}

/** Optional single-stage exchange-style trailing protection, separate from fixed SL. */
export function EnvelopeTrailingStopControl({ enabled, value, onToggle, onChange }: {
  enabled: boolean; value: string; onToggle: (value: boolean) => void; onChange: (value: string) => void;
}) {
  return <>
    <label className="checkbox-row"><input type="checkbox" checked={enabled} onChange={event => onToggle(event.target.checked)} /><span>트레일링 스탑 적용</span></label>
    <label className="field-label">트레일링 스탑 (%)<span className="suffix-field"><input type="number" min="1" max="100" step="0.1" inputMode="decimal" disabled={!enabled} value={value} onChange={event => onChange(event.target.value)} /><b>%</b></span><small>1~100.0 · 기본 3% · 실제 매수가 × 비율로 고정 가격 간격을 계산합니다. 롱 최고가·숏 최저가에서 이 간격만큼 되돌아오면 청산합니다. 15분봉 순서로 확인하며 고정 SL도 유지합니다.</small></label>
  </>;
}
