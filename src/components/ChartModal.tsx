import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';

import { chartTimestamp, entryCandleIndex, firstEntryTime, visibleCandleRange } from '../chartData';
import { chartMaStorageKey, loadChartMas, saveChartMas } from '../storage';
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
  if (!Number.isFinite(price) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return height / 2;
  return ((max - price) / (max - min)) * height;
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
  const scrollFrameRef = useRef<number | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; factor: number; anchorIndex: number } | null>(null);
  const pendingZoomLeftRef = useRef<number | null>(null);
  const [zoom, setZoom] = useState({ factor: 1 });
  const [pinching, setPinching] = useState(false);
  const [viewport, setViewport] = useState({ left: 0, width: 0 });
  const plotClipId = useId();
  const syncViewport = useCallback(() => {
    const host = scrollRef.current;
    if (!host) return;
    setViewport((current) => current.left === host.scrollLeft && current.width === host.clientWidth
      ? current
      : { left: host.scrollLeft, width: host.clientWidth });
  }, []);
  const selectedIndex = selection === null ? -1 : chart.candles.findIndex((candle) => candle.openTime === selection.openTime);
  const baseWidth = Math.max(760, Math.min(12_000, chart.candles.length * 14));
  const widthForZoom = (factor: number): number => Math.max(viewport.width || 320, Math.min(24_000, baseWidth * factor));
  const width = widthForZoom(zoom.factor);
  const height = 360;
  const volumeHeight = 58;
  const plotHeight = height - volumeHeight;
  const plotPadding = 24;
  const priceHeight = plotHeight - 2 * plotPadding;
  const step = width / Math.max(chart.candles.length, 1);
  const rangeStart = viewport.width > 0
    ? Math.max(0, Math.floor(viewport.left / step))
    : Math.max(0, (entryCandleIndex(chart) ?? 0) - 20);
  const rangeEnd = viewport.width > 0
    ? Math.min(chart.candles.length - 1, Math.ceil((viewport.left + viewport.width) / step) - 1)
    : Math.min(chart.candles.length - 1, rangeStart + 40);
  const { min, max, maxVolume } = useMemo(
    () => visibleCandleRange(chart.candles, rangeStart, rangeEnd),
    [chart.candles, rangeStart, rangeEnd],
  );
  const drawStart = Math.max(0, rangeStart - 1);
  const drawEnd = Math.min(chart.candles.length - 1, rangeEnd + 1);
  const drawnCandles = chart.candles.slice(drawStart, drawEnd + 1);
  useLayoutEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const previous = previousViewRef.current;
    if (pendingZoomLeftRef.current !== null) {
      host.scrollLeft = Math.max(0, pendingZoomLeftRef.current);
      pendingZoomLeftRef.current = null;
    } else if (!previous || previous.focusRequest !== focusRequest) {
      const entryIndex = entryCandleIndex(chart);
      host.scrollLeft = entryIndex === null ? 0 : Math.max(0, (entryIndex + 0.5) * step - host.clientWidth / 2);
    } else if (previous.firstAt !== chart.candles[0]?.openTime) {
      const prepended = chart.candles.findIndex((candle) => candle.openTime === previous.firstAt);
      if (prepended >= 0) host.scrollLeft = (host.scrollLeft / previous.step + prepended) * step;
    }
    previousViewRef.current = { firstAt: chart.candles[0]?.openTime, step, focusRequest };
    syncViewport();
  }, [chart, step, focusRequest, syncViewport, zoom]);
  useLayoutEffect(() => {
    const host = scrollRef.current;
    if (!host) return undefined;
    const observer = new ResizeObserver(syncViewport);
    observer.observe(host);
    const preventBrowserPinch = (event: TouchEvent): void => {
      if (event.touches.length >= 2) event.preventDefault();
    };
    host.addEventListener('touchstart', preventBrowserPinch, { passive: false });
    host.addEventListener('touchmove', preventBrowserPinch, { passive: false });
    return () => {
      observer.disconnect();
      host.removeEventListener('touchstart', preventBrowserPinch);
      host.removeEventListener('touchmove', preventBrowserPinch);
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    };
  }, [syncViewport]);
  const candleWidth = Math.max(3, step * 0.48);
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
  const yFor = (price: number): number => lineY(price, min, max, priceHeight) + plotPadding;
  const pointString = (key: keyof EnrichedCandle): string => drawnCandles
    .map((candle, index) => typeof candle[key] === 'number' && Number.isFinite(candle[key] as number) ? `${xFor(drawStart + index)},${yFor(candle[key] as number)}` : '')
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
    const y = Math.max(plotPadding, Math.min(plotHeight - plotPadding, (event.clientY - rect.top) / rect.height * height));
    const price = max - (y - plotPadding) / priceHeight * (max - min);
    onSelect({ openTime: candle.openTime, price });
  };

  const requestOlderAtEdge = (): void => {
    const firstAt = chart.candles[0]?.openTime;
    if (!onLoadOlder || loadingOlder || selection || pinchRef.current || !scrollRef.current || scrollRef.current.scrollLeft > 16 || firstAt === undefined || requestedBeforeRef.current === firstAt) return;
    requestedBeforeRef.current = firstAt;
    void onLoadOlder().finally(() => { requestedBeforeRef.current = null; });
  };

  const forgetPointer = (pointerId: number): void => {
    pointersRef.current.delete(pointerId);
    gestureRef.current = null;
    if (pointersRef.current.size < 2) {
      pinchRef.current = null;
      setPinching(false);
    }
  };

  return (
    <div className="chart-frame">
    <div ref={scrollRef} className={`chart-scroll${selection === null ? '' : ' crosshair-active'}${pinching ? ' pinching' : ''}`} onScroll={() => {
      if (scrollFrameRef.current === null) scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        syncViewport();
      });
      requestOlderAtEdge();
    }}>
      <svg
        className="chart-svg"
        role="img"
        aria-label="백테스트 캔들 차트"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        data-candle-count={chart.candles.length}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (pointersRef.current.size === 2 && scrollRef.current) {
            const [first, second] = [...pointersRef.current.values()];
            if (!first || !second) return;
            const host = scrollRef.current;
            const centerX = (first.x + second.x) / 2 - host.getBoundingClientRect().left;
            pinchRef.current = {
              distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
              factor: zoom.factor,
              anchorIndex: (host.scrollLeft + centerX) / step,
            };
            gestureRef.current = null;
            setPinching(true);
            for (const pointerId of pointersRef.current.keys()) event.currentTarget.setPointerCapture(pointerId);
            event.preventDefault();
            return;
          }
          if (!event.isPrimary || pointersRef.current.size !== 1) return;
          gestureRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, inspecting: selection !== null };
          if (selection !== null) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        }}
        onPointerUp={(event) => {
          const gesture = gestureRef.current;
          forgetPointer(event.pointerId);
          if (!gesture || gesture.pointerId !== event.pointerId) return;
          const moved = gesture.moved || Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 6;
          if (!moved) {
            if (gesture.inspecting) onClear();
            else selectPointer(event);
          } else if (!gesture.inspecting) requestOlderAtEdge();
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => forgetPointer(event.pointerId)}
        onLostPointerCapture={(event) => {
          if (event.target === event.currentTarget) forgetPointer(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (pointersRef.current.has(event.pointerId)) pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          const pinch = pinchRef.current;
          if (pinch && scrollRef.current && pointersRef.current.size >= 2) {
            const [first, second] = [...pointersRef.current.values()];
            if (!first || !second) return;
            const distance = Math.hypot(first.x - second.x, first.y - second.y);
            const factor = Math.max(0.25, Math.min(4, pinch.factor * distance / pinch.distance));
            const centerX = (first.x + second.x) / 2 - scrollRef.current.getBoundingClientRect().left;
            pendingZoomLeftRef.current = pinch.anchorIndex * widthForZoom(factor) / Math.max(chart.candles.length, 1) - centerX;
            setZoom({ factor });
            event.preventDefault();
            return;
          }
          const gesture = gestureRef.current;
          if (!gesture || gesture.pointerId !== event.pointerId) return;
          if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 6) gesture.moved = true;
          if (gesture.inspecting && gesture.moved) selectPointer(event);
        }}
      >
        <defs><clipPath id={plotClipId}><rect x="0" y="0" width={width} height={plotHeight} /></clipPath></defs>
        <rect width={width} height={height} fill="#202D42" rx="10" />
        {[0, 1, 2, 3, 4].map((index) => (
          <line key={`grid-${index}`} x1="0" x2={width} y1={(plotHeight / 4) * index} y2={(plotHeight / 4) * index} stroke="#34435B" strokeWidth="1" />
        ))}
        <g clipPath={`url(#${plotClipId})`}>
        {chart.waves.filter((wave) => wave.startIndex <= drawEnd && wave.endIndex >= drawStart).map((wave) => {
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
          if (!Number.isFinite(y) || y < 0 || y > plotHeight) return null;
          const style = lineStyles[priceLine.kind];
          return <line key={`${priceLine.kind}-${priceLine.price}`} x1="0" x2={width} y1={y} y2={y} stroke={style.color} strokeWidth="1.4" strokeDasharray="4 5" />;
        })}
        {drawnCandles.map((candle, offset) => {
          const index = drawStart + offset;
          const x = xFor(index);
          const openY = yFor(candle.open);
          const closeY = yFor(candle.close);
          const highY = yFor(candle.high);
          const lowY = yFor(candle.low);
          const positive = candle.close >= candle.open;
          const color = positive ? '#5BD5A5' : '#FF8A8A';
          const markers = markerByIndex.get(index) ?? [];
          return (
            <g key={`candle-${candle.openTime}`} data-candle-index={index}>
              <line x1={x} x2={x} y1={highY} y2={lowY} stroke={color} strokeWidth="1.2" />
              <rect x={x - candleWidth / 2} y={Math.min(openY, closeY)} width={candleWidth} height={Math.max(2, Math.abs(closeY - openY))} fill={color} rx="1" />
              {markers.map((marker, markerIndex) => (
                <g key={marker.id} transform={`translate(${x - 10 + markerIndex * 20},${marker.kind === 'CLOSE' || marker.kind === 'PARTIAL_TP' ? highY - 24 : lowY + 8})`}>
                  <rect width="20" height="20" rx="5" fill={marker.label === 'C' ? '#FF5C78' : marker.label === 'S' ? '#FF5C78' : '#7EA2FF'} />
                  <text x="10" y="14" textAnchor="middle" fill="#071020" fontSize="13" fontWeight="800">{marker.label}</text>
                </g>
              ))}
            </g>
          );
        })}
        </g>
        {drawnCandles.map((candle, offset) => {
          const volume = Math.max(0, Math.min(1, candle.volume / maxVolume)) * (volumeHeight - 8);
          return <rect key={`volume-${candle.openTime}`} x={xFor(drawStart + offset) - candleWidth / 2} y={height - 2 - volume} width={candleWidth} height={volume} fill={candle.close >= candle.open ? '#5BD5A5' : '#FF8A8A'} opacity=".7" />;
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
  const backdropPointer = useRef<number | null>(null);
  const [visibleMas, setVisibleMas] = useState(loadChartMas);
  const [selection, setSelection] = useState<CrosshairSelection | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    const refresh = () => setVisibleMas(loadChartMas());
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === chartMaStorageKey) refresh();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', refresh);
    };
  }, []);
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
    <div className="modal-backdrop" role="presentation"
      onPointerDown={(event) => { backdropPointer.current = event.target === event.currentTarget ? event.pointerId : null; }}
      onPointerUp={(event) => {
        const close = backdropPointer.current === event.pointerId && event.target === event.currentTarget;
        backdropPointer.current = null;
        if (close) onClose();
      }}
      onPointerCancel={() => { backdropPointer.current = null; }}
    >
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
                <input type="checkbox" checked={visibleMas[definition.key]} onChange={(event) => {
                  const next = { ...visibleMas, [definition.key]: event.target.checked };
                  saveChartMas(next);
                  setVisibleMas(next);
                }} />
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
        ) : <p className="muted chart-hint">차트를 터치하면 십자선과 캔들 정보가 표시됩니다. 십자선 상태에서 드래그하면 위치가 이동합니다. 두 손가락을 벌리면 확대되고 오므리면 더 많은 캔들이 보입니다.</p>}
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
