export function EnvelopeCenterReturnControl({ enabled, disabled, onChange }: {
  enabled: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return <label className="checkbox-row"><input type="checkbox" checked={enabled} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span>중심선 터치후 이탈시 매도</span></label>;
}
