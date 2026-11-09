/** Shared entry filter for ordinary analysis, parameter searches and virtual evaluation. */
export function EnvelopeMa20Control({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  return <div>
    <label className="checkbox-row"><input type="checkbox" checked={enabled} onChange={event => onChange(event.target.checked)} /><span>MA20 위에서만 매수 (롱) / MA20 아래에서만 매수 (숏)</span></label>
    <p className="muted small">선택 주기 캔들의 저가 &gt; MA20 (롱) / 고가 &lt; MA20 (숏). MA20에 닿거나 걸친 캔들은 제외합니다.</p>
  </div>;
}
