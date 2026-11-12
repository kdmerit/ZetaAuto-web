/** Independent, fill-relative envelope stop percentage. */
export function EnvelopeStopLossControl({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label className="field-label">SL (%)<span className="suffix-field"><input type="number" min="0.1" max="20" step="0.1" inputMode="decimal" value={value} onChange={event => onChange(event.target.value)} /><b>%</b></span><small>0.1~20.0 · 기본 3% · 실제 매수가 기준</small></label>;
}
