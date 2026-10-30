interface ProgressBarProps {
  completed: number;
  total: number;
  label: string;
}

export function ProgressBar({ completed, total, label }: ProgressBarProps) {
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  return (
    <div className="progress-panel" aria-live="polite">
      <div className="progress-label">
        <span>{label}</span>
        <span>{percent}%</span>
      </div>
      <div className="progress-track">
        <div className="progress-value" style={{ width: `${percent}%` }} />
      </div>
      <span className="muted small">{completed.toLocaleString()} / {total.toLocaleString()}개</span>
    </div>
  );
}
