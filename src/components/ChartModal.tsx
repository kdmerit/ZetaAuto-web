import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';

import { chartTimestamp, entryCandleIndex, firstEntryTime } from '../chartData';
import type { ChartData, ChartMarker, EnrichedCandle, PriceLine } from '../types';

interface ChartModalProps {
  chart: ChartData;
  onClose: () => void;
  onLoadOlder?: () => Promise<boolean>;
  loadingOlder?: boolean;
  historyError?: string | null;
}

interface CrosshairSelection {
  openTime: number;
  price: number;
}

const maDefinitions = [
  { key: 'ma5' as const, label: 'MA5', color: '#C05CFF' },
  { key: 'ma10' as const, label: 'MA10', color: '#5B8CFF' },
  { key: 'ma20' as const, label: 'MA20', color: '#FF5C78' },
  { key: 'ma60' as const, label: 'MA60', color: '#39C98A' },
  { key: 'ma120' as const, label: 'MA120', color: '#AAB4C6' },
];

const lineStyles: Record<PriceLine['kind'], { label: string; color: string }> = {
  ENTRY: { label: '매수가', color: '#F0A34A' },
  FIRST_ENTRY: { label: '1차 매수가', color: '#F0A34A' },
  SECOND_ENTRY: { label: '2차 매수가', color: '#F0A34A' },
  AVERAGE_ENTRY: { label: '매수 평단가', color: '#AE7BFA' },
  SL: { label: 'SL', color: '#FF5C78' },
  INITIAL_SL: { label: '최초 SL', color: '#FF5C78' },
  INITIAL_TP: { label: '최초 TP', color: '#39C98A' },
  TP: { label: 'TP', color: '#39C98A' },
  PARTIAL_TP: { label: '부분 TP', color: '#39C98A' },
};

function formatPrice(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('ko-KR', { maximumSignificantDigits: 10 }) : '—';
}

function formatDate(value: number | string): string {
  const seconds = chartTimestamp(value);
  if (seconds === null) return '—';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(seconds * 1000));
}

function signedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function bodyPercent(candle: EnrichedCandle): number | null {
  return candle.open !== 0 ? (candle.close - candle.open) / candle.open * 100 : null;
}

function rangePercent(candle: EnrichedCandle): number | null {
  return candle.open !== 0 ? (candle.high - candle.low) / candle.open * 100 : null;
}

function selectedAngle(candles: EnrichedCandle[], index: number, key: keyof EnrichedCandle): number | null {
  if (index < 2) return null;
  const current = candles[index]?.[key];
  const start = candles[index - 2]?.[key];
  if (typeof current !== 'number' || typeof start !== 'number' || !Number.isFinite(current) || !Number.isFinite(start)) return null;
  return Math.atan2(start - current, 2) * 180 / Math.PI;
}

function lineY(price: number, min: number, max: number, height: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(min) || !Number.isFinite(max)) return height / 2;
  return ((max - price) / Math.max(max - min, 0.0000001)) * height;
}

function ChartSvg({
  chart,
  visibleMas,
  selection,
  onSelect,
  onClear,
  focusRequest,
  onLoadOlder,
  loadingOlder,
}: {
  chart: ChartData;
  visibleMas: Record<string, boolean>;
  selection: CrosshairSelection | null;
  onSelect: (selection: CrosshairSelection) => void;
  onClear: () => void;
  focusRequest: number;
  onLoadOlder?: () => Promise<boolean>;
  loadingOlder?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean; inspecting: boolean } | null>(null);
  const previousViewRef = useRef<{ firstAt: number | undefined; step: number; focusRequest: number } | null>(null);
  const requestedBeforeRef = useRef<number | null>(null);
  const selectedIndex = selection === null ? -1 : chart.candles.findIndex((candle) => candle.openTime === selection.openTime);
  const width = Math.max(760, Math.min(12_000, chart.candles.length * 14));
  const height = 360;
  const volumeHeight = 58;
  const plotHeight = height - volumeHeight;
  const values = chart.candles
    .flatMap((candle) => [candle.high, candle.low])
    .filter(Number.isFinite);
  chart.priceLines.forEach((line) => {
    if (Number.isFinite(line.price)) values.push(line.price);
  });
  const safeValues = values.length > 0 ? values : [0, 1];
  const min = Math.min(...safeValues) * 0.998;
  const max = Math.max(...safeValues) * 1.002;
  const step = width / Math.max(chart.candles.length, 1);
  useLayoutEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const previous = previousViewRef.current;
    if (!previous || previous.focusRequest !== focusRequest) {
      const entryIndex = entryCandleIndex(chart);
      host.scrollLeft = entryIndex === null ? 0 : Math.max(0, (entryIndex + 0.5) * step - host.clientWidth / 2);
    } else if (previous.firstAt !== chart.candles[0]?.openTime) {
      const prepended = chart.candles.findIndex((candle) => candle.openTime === previous.firstAt);
      if (prepended >= 0) host.scrollLeft = (host.scrollLeft / previous.step + prepended) * step;
    }
    previousViewRef.current = { firstAt: chart.candles[0]?.openTime, step, focusRequest };
  }, [chart, step, focusRequest]);
  const candleWidth = Math.max(3, step * 0.48);
  const maxVolume = chart.candles.reduce(
    (highest, candle) => Number.isFinite(candle.volume) ? Math.max(highest, candle.volume) : highest,
    1,
  );
  const markerByIndex = useMemo(() => {
    const map = new Map<number, ChartMarker[]>();
    for (const marker of chart.markers) {
      const current = map.get(marker.candleIndex) ?? [];
      current.push(marker);
      map.set(marker.candleIndex, current);
    }
    return map;
  }, [chart.markers]);
  const xFor = (index: number): number => (index + 0.5) * step;
  const yFor = (price: number): number => lineY(price, min, max, plotHeight - 8) + 4;
  const pointString = (key: keyof EnrichedCandle): string => chart.candles
    .map((candle, index) => typeof candle[key] === 'number' && Number.isFinite(candle[key] as number) ? `${xFor(index)},${yFor(candle[key] as number)}` : '')
    .filter(Boolean)
    .join(' ');

  const selectPointer = (event: PointerEvent<SVGSVGElement>): void => {
    if (chart.candles.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = (event.clientX - rect.left) / rect.width * width;
    const index = Math.max(0, Math.min(chart.candles.length - 1, Math.floor(x / step)));
    const candle = chart.candles[index];
    if (!candle) return;
    const y = Math.max(4, Math.min(plotHeight - 4, (event.clientY - rect.top) / rect.height * height));
    const price = max - (y - 4) / (plotHeight - 8) * (max - min);
    onSelect({ openTime: candle.openTime, price });
  };

  const requestOlderAtEdge = (): void => {
    const firstAt = chart.candles[0]?.openTime;
    if (!onLoadOlder || loadingOlder || selection || !scrollRef.current || scrollRef.current.scrollLeft > 16 || firstAt === undefined || requestedBeforeRef.current === firstAt) return;
    requestedBeforeRef.current = firstAt;
    void onLoadOlder().finally(() => { requestedBeforeRef.current = null; });
  };

  return (
    <div className="chart-frame">
    <div ref={scrollRef} className={selection === null ? 'chart-scroll' : 'chart-scroll crosshair-active'} onScroll={requestOlderAtEdge}>
      <svg
        className="chart-svg"
        role="img"
        aria-label="백테스트 캔들 차트"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          gestureRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, inspecting: selection !== null };
          if (selection !== null) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        }}
        onPointerUp={(event) => {
          const gesture = gestureRef.current;
          gestureRef.current = null;
          if (!gesture || gesture.pointerId !== event.pointerId) return;
          const moved = gesture.moved || Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 6;
          if (!moved) {
            if (gesture.inspecting) onClear();
            else selectPointer(event);
          } else if (!gesture.inspecting) requestOlderAtEdge();
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { gestureRef.current = null; }}
        onLostPointerCapture={() => { gestureRef.current = null; }}
        onPointerMove={(event) => {
          const gesture = gestureRef.current;
          if (!gesture || gesture.pointerId !== event.pointerId) return;
          if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 6) gesture.moved = true;
          if (gesture.inspecting && gesture.moved) selectPointer(event);
        }}
      >
        <rect width={width} height={height} fill="#202D42" rx="10" />
        {[0, 1, 2, 3, 4].map((index) => (
          <line key={`grid-${index}`} x1="0" x2={width} y1={(plotHeight / 4) * index} y2={(plotHeight / 4) * index} stroke="#34435B" strokeWidth="1" />
        ))}
        {chart.waves.map((wave) => {
          const x = Math.max(0, wave.startIndex) * step;
          const w = Math.max(step, (wave.endIndex - wave.startIndex + 1) * step);
          const top = yFor(wave.high);
          const bottom = yFor(wave.low);
          const color = wave.label === 'CURRENT' ? 'rgba(91,213,165,.20)' : wave.label === 'PREVIOUS' ? 'rgba(126,162,255,.20)' : 'rgba(240,180,93,.20)';
          return <rect key={wave.label} x={x} y={Math.min(top, bottom)} width={w} height={Math.abs(bottom - top)} fill={color} stroke={color.replace('.20', '.8')} strokeWidth="1" />;
        })}
        {maDefinitions.filter((definition) => visibleMas[definition.key]).map((definition) => (
          <polyline key={definition.key} points={pointString(definition.key)} fill="none" stroke={definition.color} strokeWidth="2" opacity=".95" />
        ))}
        {chart.priceLines.map((priceLine) => {
          const y = yFor(priceLine.price);
          const style = lineStyles[priceLine.kind];
          return <line key={`${priceLine.kind}-${priceLine.price}`} x1="0" x2={width} y1={y} y2={y} stroke={style.color} strokeWidth="1.4" strokeDasharray="4 5" />;
        })}
        {chart.candles.map((candle, index) => {
          const x = xFor(index);
          const openY = yFor(candle.open);
          const closeY = yFor(candle.close);
          const highY = yFor(candle.high);
          const lowY = yFor(candle.low);
          const positive = candle.close >= candle.open;
          const color = positive ? '#5BD5A5' : '#FF8A8A';
          const markers = markerByIndex.get(index) ?? [];
          return (
            <g key={`candle-${candle.openTime}`}>
              <line x1={x} x2={x} y1={highY} y2={lowY} stroke={color} strokeWidth="1.2" />
              <rect x={x - candleWidth / 2} y={Math.min(openY, closeY)} width={candleWidth} height={Math.max(2, Math.abs(closeY - openY))} fill={color} rx="1" />
              <rect x={x - candleWidth / 2} y={height - 2 - (candle.volume / maxVolume) * (volumeHeight - 8)} width={candleWidth} height={(candle.volume / maxVolume) * (volumeHeight - 8)} fill={color} opacity=".7" />
              {markers.map((marker, markerIndex) => (
                <g key={marker.id} transform={`translate(${x - 10 + markerIndex * 20},${marker.kind === 'CLOSE' || marker.kind === 'PARTIAL_TP' ? highY - 24 : lowY + 8})`}>
                  <rect width="20" height="20" rx="5" fill={marker.label === 'C' ? '#FF5C78' : marker.label === 'S' ? '#FF5C78' : '#7EA2FF'} />
                  <text x="10" y="14" textAnchor="middle" fill="#071020" fontSize="13" fontWeight="800">{marker.label}</text>
                </g>
              ))}
            </g>
          );
        })}
        {selectedIndex >= 0 && selection ? (
          <>
            <line className="crosshair-vertical" x1={xFor(selectedIndex)} x2={xFor(selectedIndex)} y1="0" y2={height} stroke="#FFFFFF" strokeWidth="1" strokeDasharray="3 5" />
            <line className="crosshair-horizontal" x1="0" x2={width} y1={yFor(selection.price)} y2={yFor(selection.price)} stroke="#FFFFFF" strokeWidth="1" strokeDasharray="3 5" />
          </>
        ) : null}
      </svg>
    </div>
    {selection ? <span className="crosshair-price" style={{ top: Math.max(12, Math.min(plotHeight - 12, yFor(selection.price))) }}>{formatPrice(selection.price)}</span> : null}
    </div>
  );
}

export function ChartModal({ chart, onClose, onLoadOlder, loadingOlder, historyError }: ChartModalProps) {
  const [visibleMas, setVisibleMas] = useState<Record<string, boolean>>({ ma5: true, ma10: false, ma20: true, ma60: false, ma120: false });
  const [selection, setSelection] = useState<CrosshairSelection | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const selectedIndex = selection === null ? -1 : chart.candles.findIndex((candle) => candle.openTime === selection.openTime);
  const selected = chart.candles[selectedIndex] ?? null;
  const selectedReadings = !selected
    ? []
    : maDefinitions.filter((definition) => visibleMas[definition.key]).map((definition) => {
        const value = selected[definition.key];
        const deviation = typeof value === 'number' && value !== 0 ? (selected.close - value) / value * 100 : null;
        return { ...definition, value, deviation, angle: selectedAngle(chart.candles, selectedIndex, definition.key) };
      });
  return (
    <div className="modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="chart-modal" role="dialog" aria-modal="true" aria-label="백테스트 차트">
        <div className="chart-header">
          <div>
            <p className="eyebrow">{chart.interval.toUpperCase()} · BACKTEST</p>
            <h2>{chart.symbol} <span className={chart.side === 'LONG' ? 'long-text' : 'short-text'}>{chart.side === 'LONG' ? '롱' : '숏'}</span></h2>
            <p className="muted chart-reference">{formatDate(firstEntryTime(chart) ?? chart.referenceAt)}</p>
          </div>
          <button className="close-button" type="button" onClick={onClose} aria-label="차트 닫기">×</button>
        </div>
        <div className="ma-panel">
          <strong>이동평균선 표시</strong>
          <div className="ma-toggles">
            {maDefinitions.map((definition) => (
              <label className="ma-toggle" key={definition.key} style={{ '--ma-color': definition.color } as CSSProperties}>
                <input type="checkbox" checked={visibleMas[definition.key]} onChange={() => setVisibleMas((current) => ({ ...current, [definition.key]: !current[definition.key] }))} />
                <span>{definition.label}</span>
              </label>
            ))}
          </div>
        </div>
        <ChartSvg chart={chart} visibleMas={visibleMas} selection={selection} onSelect={setSelection} onClear={() => setSelection(null)} focusRequest={focusRequest} onLoadOlder={onLoadOlder} loadingOlder={loadingOlder} />
        {selected ? (
          <div className="candle-info">
            <strong>{formatDate(selected.openTime)}</strong>
            <span>시가 {formatPrice(selected.open)} · 고가 {formatPrice(selected.high)}</span>
            <span>저가 {formatPrice(selected.low)} · 종가 {formatPrice(selected.close)}</span>
            <span>몸통 등락률 <em className={selected.close >= selected.open ? 'positive' : 'negative'}>{signedPercent(bodyPercent(selected))}</em></span>
            <span>최대 등락률 {signedPercent(rangePercent(selected))}</span>
            <span>거래량 {formatPrice(selected.volume)}</span>
            {selectedReadings.map((reading) => (
              <span key={reading.key} style={{ color: reading.color }}>{reading.label} 이격 {signedPercent(reading.deviation)} <em>({reading.angle === null ? '—' : `${reading.angle >= 0 ? '+' : ''}${reading.angle.toFixed(1)}°`})</em></span>
            ))}
          </div>
        ) : <p className="muted chart-hint">차트를 터치하면 십자선과 캔들 정보가 표시됩니다. 십자선 상태에서 드래그하면 위치가 이동합니다.</p>}
        <div className="price-legend">
          {chart.priceLines.map((priceLine) => {
            const style = lineStyles[priceLine.kind];
            if (priceLine.kind === 'ENTRY' || priceLine.kind === 'FIRST_ENTRY') {
              return <button className="entry-focus" key={`${priceLine.kind}-${priceLine.price}`} type="button" style={{ color: style.color }} aria-label={`${style.label} ${formatPrice(priceLine.price)} · 최초 매수 지점으로 이동`} onClick={() => { setSelection(null); setFocusRequest((value) => value + 1); }}>{style.label} {formatPrice(priceLine.price)}</button>;
            }
            return <span key={`${priceLine.kind}-${priceLine.price}`} style={{ color: style.color }}>{style.label} {formatPrice(priceLine.price)}</span>;
          })}
        </div>
        {loadingOlder ? <p className="muted small" role="status">과거 캔들 불러오는 중…</p> : null}
        {historyError ? <p className="error" role="alert">{historyError}</p> : null}
      </section>
    </div>
  );
}
