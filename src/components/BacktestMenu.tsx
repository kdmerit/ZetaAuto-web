import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { Strategy } from '../types';

type MenuItemId = 'CHART' | Strategy;

interface MenuItem {
  id: MenuItemId;
  title: string;
  strategy?: Strategy;
}

export const backtestMenuOrderStorageKey = 'zetaauto.web.backtestMenu.order.v1';

const menuItems: MenuItem[] = [
  { id: 'CHART', title: '차트 보기' },
  { id: 'NEW_HIGH', title: '신고가 백테스트', strategy: 'NEW_HIGH' },
  { id: 'PULLBACK', title: '눌림목 백테스트', strategy: 'PULLBACK' },
  { id: 'DISPARITY', title: '이격매매 백테스트', strategy: 'DISPARITY' },
  { id: 'VOLATILITY', title: '변동성 돌파 백테스트', strategy: 'VOLATILITY' },
  { id: 'ENVELOPE', title: '엔벨로프 백테스트', strategy: 'ENVELOPE' },
];

const defaultOrder = menuItems.map(item => item.id);
const menuItemById = new Map(menuItems.map(item => [item.id, item]));

function loadMenuOrder(): MenuItemId[] {
  if (typeof window === 'undefined') return defaultOrder;
  try {
    const saved = JSON.parse(window.localStorage.getItem(backtestMenuOrderStorageKey) ?? 'null') as unknown;
    if (!Array.isArray(saved)) return defaultOrder;
    const order = saved.filter((value): value is MenuItemId => typeof value === 'string' && menuItemById.has(value as MenuItemId));
    return defaultOrder.every(id => order.includes(id)) && order.length === defaultOrder.length ? order : defaultOrder;
  } catch {
    return defaultOrder;
  }
}

interface BacktestMenuProps {
  onOpen: (strategy: Strategy) => void;
  onOpenChart: () => void;
  onSignOut: () => void;
  email: string | null;
}

export function BacktestMenu({ onOpen, onOpenChart, onSignOut, email }: BacktestMenuProps) {
  const [order, setOrder] = useState<MenuItemId[]>(loadMenuOrder);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState<MenuItemId | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const pointer = useRef<{ id: MenuItemId; pointerId: number; startY: number; moved: boolean } | null>(null);
  const itemRefs = useRef(new Map<MenuItemId, HTMLButtonElement>());
  const layoutBeforeOrderRef = useRef(new Map<MenuItemId, number>());

  useEffect(() => {
    try { window.localStorage.setItem(backtestMenuOrderStorageKey, JSON.stringify(order)); } catch { /* The menu still works if storage is unavailable. */ }
  }, [order]);

  useLayoutEffect(() => {
    const before = layoutBeforeOrderRef.current;
    if (before.size) {
      for (const [id, element] of itemRefs.current) {
        if (id === dragging) continue;
        const previousTop = before.get(id);
        if (previousTop === undefined) continue;
        const delta = previousTop - element.getBoundingClientRect().top;
        if (Math.abs(delta) < 1 || typeof element.animate !== 'function') continue;
        element.animate(
          [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
          { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' },
        );
      }
    }
    layoutBeforeOrderRef.current = new Map([...itemRefs.current].map(([id, element]) => [id, element.getBoundingClientRect().top]));
  }, [order, dragging]);

  const finishDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (pointer.current?.pointerId !== event.pointerId) return;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* Pointer capture may already be released. */ }
    pointer.current = null;
    setDragging(null);
    setDragOffset(0);
  };

  const moveItem = (event: React.PointerEvent<HTMLButtonElement>, id: MenuItemId): void => {
    const active = pointer.current;
    if (!editing || !active || active.id !== id || active.pointerId !== event.pointerId) return;
    if (!active.moved && Math.abs(event.clientY - active.startY) < 5) return;
    active.moved = true;
    event.preventDefault();
    setDragging(id);
    const from = order.indexOf(id);
    if (from < 0) return;
    const target = order.findIndex(candidate => {
      if (candidate === id) return false;
      const element = itemRefs.current.get(candidate);
      if (!element) return false;
      const bounds = element.getBoundingClientRect();
      return event.clientY < bounds.top + bounds.height / 2;
    });
    const insertAt = target < 0 ? order.length - 1 : from < target ? target - 1 : target;
    if (insertAt === from) {
      setDragOffset(event.clientY - active.startY);
      return;
    }
    const element = itemRefs.current.get(id);
    const rowStep = element ? element.getBoundingClientRect().height + 10 : 0;
    // Keep the card under the finger while its flow position changes. The
    // non-dragged cards animate into their new positions in the layout effect.
    active.startY += (insertAt - from) * rowStep;
    layoutBeforeOrderRef.current = new Map([...itemRefs.current].map(([itemId, node]) => [itemId, node.getBoundingClientRect().top]));
    setOrder(current => {
      const next = current.filter(candidate => candidate !== id);
      next.splice(Math.max(0, Math.min(insertAt, next.length)), 0, id);
      return next;
    });
    setDragOffset(event.clientY - active.startY);
  };

  const orderedItems = order.map(id => menuItemById.get(id)).filter((item): item is MenuItem => Boolean(item));

  return (
    <main className="screen">
      <div className="content menu-content">
        <header className="page-header">
          <div className="menu-title-row">
            <div>
              <p className="eyebrow">BYBIT · BACKTEST</p>
              <h1>백테스트</h1>
            </div>
          </div>
          <div className="account-actions">
            <span className="account-email" title={email ?? undefined}>{email ?? ''}</span>
            <button className="logout-button" type="button" onClick={onSignOut}>로그아웃</button>
            <button
              className={`menu-edit-button${editing ? ' active' : ''}`}
              type="button"
              aria-label={editing ? '메뉴 순서 편집 완료' : '메뉴 순서 편집'}
              aria-pressed={editing}
              onClick={() => { setEditing(value => !value); setDragging(null); setDragOffset(0); pointer.current = null; }}
            >{editing ? '✓' : '✎'}</button>
          </div>
        </header>
        {editing ? <p className="menu-edit-hint">버튼을 위아래로 드래그해 순서를 바꾼 뒤 ✓를 누르세요.</p> : null}

        <div className={`menu-cards${editing ? ' editing' : ''}`}>
          {orderedItems.map((item) => (
            <button
              className={`menu-card${item.id === 'CHART' ? ' market-menu-card' : ''}${dragging === item.id ? ' dragging' : ''}`}
              key={item.id}
              type="button"
              ref={element => { if (element) itemRefs.current.set(item.id, element); else itemRefs.current.delete(item.id); }}
              aria-label={editing ? `${item.title} 순서 변경` : item.title}
              aria-roledescription={editing ? '드래그 가능한 메뉴' : undefined}
              onClick={event => { if (editing) event.preventDefault(); else if (item.id === 'CHART') onOpenChart(); else if (item.strategy) onOpen(item.strategy); }}
              onPointerDown={event => {
                if (!editing) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                pointer.current = { id: item.id, pointerId: event.pointerId, startY: event.clientY, moved: false };
                setDragOffset(0);
              }}
              onPointerMove={event => moveItem(event, item.id)}
              onPointerUp={event => finishDrag(event)}
              onPointerCancel={event => finishDrag(event)}
              style={dragging === item.id ? { transform: `translateY(${dragOffset}px)`, zIndex: 2 } : undefined}
            >
              <span className="menu-card-copy"><strong>{item.title}</strong></span>
              {editing ? <span className="menu-drag-handle" aria-hidden="true">☷</span> : <span className="chevron" aria-hidden="true">›</span>}
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
