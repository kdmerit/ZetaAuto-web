export function EnvelopeCenterReturnControl({ enabled, onChange }: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return <label className="checkbox-row"><input type="checkbox" checked={enabled} onChange={event => onChange(event.target.checked)} /><span>중심선 터치후 이탈시 매도</span></label>;
}
