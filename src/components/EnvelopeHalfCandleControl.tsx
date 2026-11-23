/** Optional daily entry-band half-candle exclusion. */
export function EnvelopeHalfCandleControl({ enabled, disabled, onChange }: { enabled: boolean; disabled?: boolean; onChange: (enabled: boolean) => void }) {
  return <label className="checkbox-row"><input type="checkbox" checked={enabled} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span>캔들 절반 엔벨 이내</span></label>;
}
