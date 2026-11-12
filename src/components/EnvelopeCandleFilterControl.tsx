/** Optional daily/four-hour entry exclusions, independent of the chart interval. */
export function EnvelopeCandleFilterControl({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  return <label className="checkbox-row"><input type="checkbox" checked={enabled} onChange={event => onChange(event.target.checked)} /><span>매수금지 캔들 필터 적용</span></label>;
}
