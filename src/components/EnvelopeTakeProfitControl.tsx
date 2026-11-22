import { defaultEnvelopeTakeProfitPercent } from '../envelope';

export function EnvelopeTakeProfitControl({ enabled, value = defaultEnvelopeTakeProfitPercent, onToggle, onChange }: {
  enabled: boolean;
  value?: string;
  onToggle: (enabled: boolean) => void;
  onChange: (value: string) => void;
}) {
  return <>
    <label className="checkbox-row">
      <input type="checkbox" checked={enabled} onChange={event => onToggle(event.target.checked)} />
      <span>TP사용</span>
    </label>
    <label className="field-label">TP (%)
      <span className="suffix-field">
        <input type="number" min="0.1" max="20" step="any" inputMode="decimal" disabled={!enabled}
          value={value} onChange={event => onChange(event.target.value)} />
        <b>%</b>
      </span>
      <small>0.1~20% · 실제 체결가 기준 롱 +%, 숏 −%</small>
    </label>
  </>;
}
