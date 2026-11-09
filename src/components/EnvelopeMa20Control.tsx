/** Shared entry filter for ordinary analysis, parameter searches and virtual evaluation. */
export function EnvelopeMa20Control({ enabled, onChange, belowEnabled, onBelowChange }: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  belowEnabled: boolean;
  onBelowChange: (enabled: boolean) => void;
}) {
  return <div>
    <label className="checkbox-row"><input type="checkbox" checked={enabled} onChange={event => onChange(event.target.checked)} /><span>MA20 위에서만 매수 (롱) / MA20 아래에서만 매수 (숏)</span></label>
    <label className="checkbox-row"><input type="checkbox" checked={belowEnabled} onChange={event => onBelowChange(event.target.checked)} /><span>MA20 아래에서만 매수 (롱) / MA20 위에서만 매수 (숏)</span></label>
    <p className="muted small">첫 번째는 롱 저가 &gt; MA20 / 숏 고가 &lt; MA20인 캔들만 허용합니다. 두 번째는 롱 고가 &lt; MA20 / 숏 저가 &gt; MA20인 캔들만 허용합니다. MA20에 닿거나 걸친 캔들은 제외하며, 두 필터를 동시에 켜면 조건이 충돌해 진입하지 않습니다.</p>
  </div>;
}
