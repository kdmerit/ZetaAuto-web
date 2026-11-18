/** Optional daily entry-band half-candle exclusion. */
export function EnvelopeHalfCandleControl({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  return <label className="checkbox-row"><input type="checkbox" checked={enabled} onChange={event => onChange(event.target.checked)} /><span>캔들 절반 엔벨 이내</span></label>;
}
