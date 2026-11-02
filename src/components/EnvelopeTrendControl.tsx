export function EnvelopeTrendControl({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  return <div className="envelope-trend-control">
    <label className="checkbox-row"><input type="checkbox" checked={enabled} onChange={event => onChange(event.target.checked)} /><span>일봉 MA20 5봉 추세 필터</span></label>
    <p className="muted small">켜짐: 확정 일봉 MA20이 5봉 전보다 롱 +0.5% 이상 상승 / 숏 −0.5% 이하 하락일 때만 신규 진입. 꺼짐: 이 조건 미적용.</p>
  </div>;
}
