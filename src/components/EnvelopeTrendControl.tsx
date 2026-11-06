export function EnvelopeTrendControl({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  return <div className="envelope-trend-control">
    <label className="checkbox-row"><input type="checkbox" checked={enabled} onChange={event => onChange(event.target.checked)} /><span>일봉 MA20 5봉 추세 필터 (기존 설정)</span></label>
    <p className="muted small">입력값은 저장되지만 현재 엔벨로프 새 조건에서는 사용하지 않습니다.</p>
  </div>;
}
