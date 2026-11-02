import { useEffect, useState } from 'react';
import { defaultEnvelopeResultOptions, validateEnvelopeResultOptions } from '../envelopeResults';
import type { EnvelopeResultOptions } from '../types';

export function EnvelopeResultControls({ value = defaultEnvelopeResultOptions, onApply, disabled = false }: {
  value?: EnvelopeResultOptions; onApply: (value: EnvelopeResultOptions) => void; disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value); const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(value); setError(null); }, [value]);
  const apply = (next = draft): void => {
    try { validateEnvelopeResultOptions(next); setError(null); onApply({ ...next }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '필터 값을 확인해 주세요.'); }
  };
  return <fieldset className="analysis-fields envelope-result-controls" disabled={disabled} aria-label="통계 결과 필터 및 정렬">
    <h3>결과 필터 · 정렬</h3><div className="field-grid three">
      <label className="field-label">매매횟수<input type="number" min="0" step="1" inputMode="numeric" value={draft.minTrades} onChange={event => setDraft({ ...draft, minTrades: event.target.value })} /><small>회 이상 · 진입횟수 기준</small></label>
      <label className="field-label">수익률<input type="number" step="0.1" inputMode="decimal" value={draft.minReturnPercent} onChange={event => setDraft({ ...draft, minReturnPercent: event.target.value })} /><small>% 이상</small></label>
      <label className="field-label">최소수익비<input type="number" min="0" max="100" step="0.1" inputMode="decimal" value={draft.minProfitRatioPercent} onChange={event => setDraft({ ...draft, minProfitRatioPercent: event.target.value })} /><small>% 이상</small></label>
    </div><label className="field-label">내림차순 정렬<select value={draft.sort} onChange={event => { const next = { ...draft, sort: event.target.value as EnvelopeResultOptions['sort'] }; setDraft(next); apply(next); }}><option value="returnPercent">수익률 높은 순</option><option value="winRatePercent">승률 높은 순</option></select></label>
    <button className="outline-button full-width" type="button" onClick={() => apply()}>필터 적용</button>
    <p className="muted small">세 필터를 모두 충족한 결과만 표시합니다. 정렬 지표가 가장 높은 세팅을 방향별 최적 세팅으로 선정합니다. 승률은 별도 고정 제한 없이 정렬에 사용합니다.</p>
    <p className="muted small">수익비 = 수익금 ÷ (수익금 + 손실금의 절댓값) × 100. 수수료를 뺀 완료 매매의 이익·손실 합계이며, 완료 매매가 없으면 계산하지 않습니다.</p>
    {error ? <p className="error" role="alert">{error}</p> : null}
  </fieldset>;
}
