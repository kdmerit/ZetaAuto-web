export function EnvelopeSideRatioControl({ enabled, onChange }: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return <label className="checkbox-row"><input type="checkbox" checked={enabled} onChange={event => onChange(event.target.checked)} /><span>롱/숏 비율 50%</span></label>;
}
