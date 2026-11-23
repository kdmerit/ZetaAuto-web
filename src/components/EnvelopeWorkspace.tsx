import { useState } from 'react';
import type { ApiContext } from '../api';
import { useAnalysisBusy } from '../analysisActivity';
import { loadSettings, saveSettings } from '../storage';
import { currentEnvelopeSettings } from '../envelope';
import { fixedEnvelopeStatisticsSettings, statisticsAnalysisWindow, statisticsIntervals } from '../envelopeStatistics';
import { statisticsAxes, statisticsRanges } from '../envelopeStatisticsRanges';
import { defaultEnvelopeResultOptions, validateEnvelopeResultOptions } from '../envelopeResults';
import type { BacktestSettings, EnvelopeStatisticsRange } from '../types';
import { defaultSettings, formatDateInput, formatTimeInput, StrategyBacktest } from './StrategyBacktest';
import { EnvelopeStatisticsPanel } from './EnvelopeStatisticsPanel';
import { EnvelopeMa20Control } from './EnvelopeMa20Control';
import { EnvelopeCenterReturnControl } from './EnvelopeCenterReturnControl';
import { EnvelopeCenterTouchControl } from './EnvelopeCenterTouchControl';
import { EnvelopeSideRatioControl } from './EnvelopeSideRatioControl';
import { EnvelopeHalfCandleControl } from './EnvelopeHalfCandleControl';
import { EnvelopeCandleFilterControl } from './EnvelopeCandleFilterControl';
import { EnvelopeTrailingStopControl } from './EnvelopeStopLossControl';

type View = 'SINGLE' | 'ALL' | 'SINGLE_STATS';
const views: { id: View; label: string }[] = [{ id: 'SINGLE', label: '개별분석' }, { id: 'ALL', label: '전체분석' }, { id: 'SINGLE_STATS', label: '개별통계' }];
const statisticsSettingsKey = 'zetaauto.web.envelope.SINGLE_STATS.settings';
const rangeFields: { key: keyof EnvelopeStatisticsRange; label: string }[] = [
  { key: 'start', label: '시작값' }, { key: 'end', label: '종료값' }, { key: 'increment', label: '증가값' },
];
function readStatisticsSettings(): BacktestSettings {
  const fallback: BacktestSettings = { ...loadSettings('ENVELOPE', defaultSettings('ENVELOPE')), mode: 'SINGLE', envelopeRisk: undefined, envelopeStatisticsInterval: '1d' };
  try {
    const saved = JSON.parse(localStorage.getItem(statisticsSettingsKey) ?? '{}') as Partial<BacktestSettings>;
    return currentEnvelopeSettings({ ...fallback, ...saved, mode: 'SINGLE' });
  } catch { return currentEnvelopeSettings(fallback); }
}
function validateSearch(settings: BacktestSettings): void {
  if (!/^[A-Z0-9]{1,36}$/.test(settings.symbol.replace(/USDT$/, ''))) throw new Error('종목명을 입력해 주세요.');
  if (!/^\d+(\.\d{1,2})?$/.test(settings.initialCapitalUsdt) || Number(settings.initialCapitalUsdt) < 10) throw new Error('초기자금을 확인해 주세요.');
  if (!/^\d+(\.\d{1,2})?$/.test(settings.betAmountUsdt) || Number(settings.betAmountUsdt) < 1 || Number(settings.betAmountUsdt) > Number(settings.initialCapitalUsdt)) throw new Error('고정 베팅액을 확인해 주세요.');
  fixedEnvelopeStatisticsSettings(settings);
  validateEnvelopeResultOptions(settings.envelopeResultOptions ?? defaultEnvelopeResultOptions);
  statisticsAnalysisWindow(settings);
}
function SearchFields({ settings, onChange, disabled }: { settings: BacktestSettings; onChange: (settings: BacktestSettings) => void; disabled: boolean }) {
  const update = <K extends keyof BacktestSettings>(key: K, value: BacktestSettings[K]): void => onChange({ ...settings, [key]: value });
  const ranges = statisticsRanges(settings);
  const takeProfitEnabled = settings.envelopeTakeProfitEnabled === true;
  const centerExitEnabled = settings.envelopeCloseOnCenterTouch === true;
  const bandExit = centerExitEnabled ? '중심선 터치' : '반대 밴드 터치';
  const exitNotice = takeProfitEnabled && centerExitEnabled ? '중심선 터치와 고정 TP 중 먼저 체결되는 조건으로 청산합니다.'
    : takeProfitEnabled ? '조합별 고정 TP로 익절합니다.' : `${bandExit}로 청산합니다.`;
  return <section className="surface-card form-card"><fieldset className="analysis-fields" disabled={disabled}>
    <label className="field-label">종목명<span className="suffix-field"><input value={settings.symbol} onChange={event => update('symbol', event.target.value.toUpperCase().replace(/USDT/g, '').replace(/[^A-Z0-9]/g, '').slice(0, 36))} /><b>USDT</b></span></label>
    <h2>분석 방향</h2><div className="segmented three" role="group" aria-label="통계 분석 방향">{(['BOTH', 'LONG', 'SHORT'] as const).map(side => <button key={side} type="button" aria-pressed={settings.side === side} className={settings.side === side ? 'selected' : ''} onClick={() => update('side', side)}>{side === 'BOTH' ? '롱 + 숏' : side === 'LONG' ? '롱' : '숏'}</button>)}</div>
    <p className="muted small">롱 + 숏은 방향별로 독립 분석해 필터·정렬 기준의 최적 세팅을 각각 찾습니다.</p>
    <h2>통계 캔들 주기</h2><div className="segmented interval-selector">{statisticsIntervals.map(interval => <button key={interval} type="button" aria-pressed={settings.envelopeStatisticsInterval === interval} className={settings.envelopeStatisticsInterval === interval ? 'selected' : ''} onClick={() => update('envelopeStatisticsInterval', interval)}>{interval.toUpperCase()}</button>)}</div>
    <p className="notice small">롱은 하단, 숏은 상단에서 진입합니다. {exitNotice}</p>
    <EnvelopeMa20Control enabled={settings.envelopeMa20Enabled === true} onChange={enabled => update('envelopeMa20Enabled', enabled)} />
    <EnvelopeCenterReturnControl enabled={settings.envelopeCloseOnCenterReturn === true} onChange={enabled => update('envelopeCloseOnCenterReturn', enabled)} />
    <EnvelopeCenterTouchControl enabled={centerExitEnabled} onChange={enabled => update('envelopeCloseOnCenterTouch', enabled)} />
    <EnvelopeSideRatioControl enabled={settings.envelopeSideRatio50Enabled === true} onChange={enabled => update('envelopeSideRatio50Enabled', enabled)} />
    <label className="checkbox-row"><input type="checkbox" checked={settings.envelopeCloseOnlyEntryEnabled === true} onChange={event => update('envelopeCloseOnlyEntryEnabled', event.target.checked)} /><span>종가에서만 매수</span></label>
    <EnvelopeHalfCandleControl enabled={settings.envelopeHalfCandleEnabled === true} onChange={enabled => update('envelopeHalfCandleEnabled', enabled)} />
    <EnvelopeCandleFilterControl enabled={settings.envelopeCandleFilterEnabled === true} onChange={enabled => update('envelopeCandleFilterEnabled', enabled)} />
    <EnvelopeTrailingStopControl enabled={settings.envelopeTrailingStopEnabled === true} value={settings.envelopeTrailingStopPercent ?? '3'} onToggle={enabled => update('envelopeTrailingStopEnabled', enabled)} onChange={value => update('envelopeTrailingStopPercent', value)} />
    <h2>분석 기간 (한국시간)</h2><div className="field-grid two">
      <label className="field-label">시작일<input inputMode="numeric" value={settings.startDate} onChange={event => update('startDate', formatDateInput(event.target.value))} /></label>
      <label className="field-label">시작시간<input inputMode="numeric" value={settings.startTime} onChange={event => update('startTime', formatTimeInput(event.target.value))} /></label>
      <label className="field-label">종료일 (선택)<input inputMode="numeric" value={settings.endDate} onChange={event => update('endDate', formatDateInput(event.target.value))} placeholder="현재까지" /></label>
      <label className="field-label">종료시간<input inputMode="numeric" value={settings.endTime} onChange={event => update('endTime', formatTimeInput(event.target.value))} /></label>
    </div><div className="field-grid three"><label className="field-label">가상 초기자금<input inputMode="decimal" value={settings.initialCapitalUsdt} onChange={event => update('initialCapitalUsdt', event.target.value)} /></label><label className="field-label">고정 베팅액<input inputMode="decimal" value={settings.betAmountUsdt} onChange={event => update('betAmountUsdt', event.target.value)} /></label><label className="field-label">고정 레버리지<input inputMode="decimal" value={settings.leverage} onChange={event => update('leverage', event.target.value)} /><small>1~100배 · 모든 조건에 동일 적용</small></label></div>
    <h2>탐색 범위</h2>
    {statisticsAxes.map(({ key, label, unit, min, max, scale }) => <div className="statistics-range" role="group" aria-label={`${label} 탐색 범위`} key={key}>
      {key === 'takeProfit' ? <label className="checkbox-row">
        <input type="checkbox" checked={takeProfitEnabled} onChange={event => update('envelopeTakeProfitEnabled', event.target.checked)} />
        <span>TP사용</span>
      </label> : null}
      {key !== 'takeProfit' || takeProfitEnabled ? <>
        <h3>{label} ({unit})</h3>
        <div className="field-grid statistics-range-inputs">{rangeFields.map(field => <label className="field-label" key={field.key}>{field.label}
          <input type="number" aria-label={`${label} ${field.label}`} inputMode={scale === 1 ? 'numeric' : 'decimal'} min={min} max={max} step={1 / scale}
            value={ranges[key][field.key]} onChange={event => update('envelopeStatisticsRanges', { ...ranges, [key]: { ...ranges[key], [field.key]: event.target.value } })} />
        </label>)}</div>
      </> : null}
    </div>)}
    <p className="muted small">SL ≤ 이격 × 2인 조합만 비교합니다. {takeProfitEnabled ? 'SL·TP는 실제 체결가 기준입니다.' : 'SL은 실제 체결가 기준입니다.'}</p>
    <p className="muted small">거래소 최대 레버리지·위험한도는 조회하지 않습니다. SL·수수료를 반영한 가정 계산이며 실제 계좌의 강제청산은 재현하지 않습니다. 중지 후 이어갈 수 있습니다.</p>
  </fieldset></section>;
}

function StatisticsPage({ onChoose }: { onChoose: (settings: BacktestSettings) => void }) {
  const [settings, setSettings] = useState(readStatisticsSettings);
  const busy = useAnalysisBusy();
  const [loading, setLoading] = useState(false);
  const update = (next: BacktestSettings): void => {
    const value = currentEnvelopeSettings({ ...next, mode: 'SINGLE' });
    setSettings(value);
    try { localStorage.setItem(statisticsSettingsKey, JSON.stringify(value)); } catch { /* Keep inputs usable without storage. */ }
  };
  return <div className="strategy-content envelope-statistics-page">
    <SearchFields settings={settings} onChange={update} disabled={busy || loading} />
    <section className="surface-card form-card">
      <EnvelopeStatisticsPanel settings={settings} disabled={busy} validate={() => validateSearch(settings)} onBusyChange={setLoading}
        onResultOptionsChange={options => update({ ...settings, envelopeResultOptions: options })}
        onChoose={(next, source) => { if (source === 'history') update(next); else onChoose(next); }} />
    </section>
  </div>;
}

export function EnvelopeWorkspace({ context, strategy = 'ENVELOPE' }: { context: ApiContext; strategy?: 'ENVELOPE' | 'ATR_ENVELOPE' | 'ENVELOPE_BREAKOUT' }) {
  const usesAtr = strategy === 'ATR_ENVELOPE';
  const breakout = strategy === 'ENVELOPE_BREAKOUT';
  const hasStatistics = strategy === 'ENVELOPE';
  const availableViews = hasStatistics ? views : views.slice(0, 2);
  const viewKey = breakout ? 'zetaauto.web.envelopeBreakout.view' : usesAtr ? 'zetaauto.web.atrEnvelope.view' : 'zetaauto.web.envelope.view';
  const title = breakout ? '엔벨돌파 백테스트' : usesAtr ? 'ATR 엔벨로프 백테스트' : '엔벨로프 백테스트';
  const [preset, setPreset] = useState<BacktestSettings>();
  const [view, setView] = useState<View>(() => {
    try {
      const saved = localStorage.getItem(viewKey);
      if (hasStatistics && saved === 'ALL_STATS') return 'SINGLE_STATS';
      return availableViews.find(item => item.id === saved)?.id ?? 'SINGLE';
    } catch { return 'SINGLE'; }
  });
  const navigate = (next: View): void => { setPreset(undefined); setView(next); try { localStorage.setItem(viewKey, next); } catch { /* Optional preference. */ } };
  const choose = (settings: BacktestSettings): void => { const selected = { ...settings, mode: 'SINGLE' as const }; saveSettings('ENVELOPE', selected); navigate('SINGLE'); setPreset(selected); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  return <main className="screen"><div className="content strategy-content envelope-workspace"><header className="page-header strategy-header"><div><p className="eyebrow">{breakout ? 'ENVELOPE BREAKOUT' : usesAtr ? 'ATR ENVELOPE' : 'ENVELOPE'} · BACKTEST</p><h1>{title}</h1></div></header>
    <h2>분석 대상</h2><div className={`segmented${hasStatistics ? ' three' : ''} envelope-mode-tabs`} role="group" aria-label="엔벨로프 분석 대상">{availableViews.map(item => <button key={item.id} type="button" aria-pressed={view === item.id} className={view === item.id ? 'selected' : ''} onClick={() => navigate(item.id)}>{item.label}</button>)}</div>
    {view === 'SINGLE_STATS' ? <StatisticsPage onChoose={choose} /> : <StrategyBacktest key={view} strategy={strategy} context={context} embedded forcedMode={view} preferredSettings={view === 'SINGLE' ? preset : undefined} />}
  </div></main>;
}
