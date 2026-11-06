import { CSSProperties, ReactNode, useEffect, useRef, useState } from 'react';
import { useApp } from './app-context';
import { dismissToast, nav, useToast } from './nav';
import { t } from './ru';
import { haptic } from './tg';

// ---------- Иконки ----------
const P: Record<string, string> = {
  search: 'M11 4a7 7 0 1 0 4.2 12.6l4.1 4.1 1.4-1.4-4.1-4.1A7 7 0 0 0 11 4Zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z',
  gear: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8.4 4.6-.1-2.2 1.7-1.4-1.8-3.2-2.1.7-1.8-1.2L16 3.5h-3.6l-.5 2.1-1.8 1.2-2.1-.7-1.8 3.2 1.7 1.4-.1 2.2-1.7 1.4 1.8 3.2 2.1-.7 1.8 1.2.5 2.1H16l.4-2.1 1.8-1.2 2.1.7 1.8-3.2Z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6Z',
  back: 'm14.7 5.3 1.4 1.4L10.8 12l5.3 5.3-1.4 1.4L8 12Z',
  inbox: 'M4 4h16l2 8v8H2v-8Zm1.6 2L4.2 12H8a4 4 0 0 0 8 0h3.8L18.4 6Z',
  chev: 'm9 6 6 6-6 6-1.4-1.4L12.2 12 7.6 7.4Z',
  today: 'M7 2v2H4v17h16V4h-3V2h-2v2H9V2Zm-1 7h12v10H6Zm2 2v2h2v-2Z',
  list: 'M4 6h2v2H4Zm4 0h12v2H8ZM4 11h2v2H4Zm4 0h12v2H8ZM4 16h2v2H4Zm4 0h12v2H8Z',
  cal: 'M7 2v2H4v17h16V4h-3V2h-2v2H9V2Zm-1 7h12v10H6Z',
  note: 'M5 3h14v18H5Zm3 4v2h8V7Zm0 4v2h8v-2Zm0 4v2h5v-2Z',
  pin: 'M14 3l7 7-2 1-3-1-3 3 1 4-2 2-4-4-5 5-1-1 5-5-4-4 2-2 4 1 3-3-1-3Z',
  x: 'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4Z',
};
export const Icon = ({ n, size = 22 }: { n: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={P[n]} /></svg>
);

export const IconBtn = ({ n, label, onClick }: { n: string; label: string; onClick: () => void }) => (
  <button className="icon-btn" aria-label={label} onClick={onClick}><Icon n={n} /></button>
);

// ---------- Категории ----------
export const catStyle = (color?: string) => ({ '--c': color ?? '#999' }) as CSSProperties;
export function CatDot({ id }: { id: string }) {
  const { catMap } = useApp();
  return <i className="dot c" style={catStyle(catMap[id]?.color)} />;
}
export function CatLabel({ id }: { id: string }) {
  const { catMap } = useApp();
  return <span className="cat c" style={catStyle(catMap[id]?.color)}><i className="dot" />{catMap[id]?.name}</span>;
}

export function CatChips({ value, onChange, all = true }: { value: string; onChange: (v: string) => void; all?: boolean }) {
  const { categories } = useApp();
  return (
    <div className="chips" role="tablist">
      {all && <button className={`chip ${value === 'all' ? 'on' : ''}`} onClick={() => onChange('all')}>{t.all}</button>}
      {categories.map((c) => (
        <button key={c.id} className={`chip c ${value === c.id ? 'on' : ''}`} style={catStyle(c.color)} onClick={() => { haptic('select'); onChange(c.id); }}>
          <i className="dot" />{c.name}
        </button>
      ))}
    </div>
  );
}

// ---------- Окна ----------
export function Sheet({ children, title, tall }: { children: ReactNode; title?: string; tall?: boolean }) {
  const [dy, setDy] = useState(0);
  const start = useRef<number | null>(null);
  return (
    <div className="backdrop" onClick={nav.pop}>
      <div className={`sheet ${tall ? 'tall' : ''}`} style={{ transform: dy ? `translateY(${dy}px)` : undefined, transition: start.current === null ? 'transform .2s' : 'none' }}
        onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="grip" onPointerDown={(e) => { start.current = e.clientY; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={(e) => start.current !== null && setDy(Math.max(0, e.clientY - start.current))}
          onPointerUp={() => { const far = dy > 100; start.current = null; setDy(0); if (far) nav.pop(); }} />
        {title && <h2 className="sheet-title">{title}</h2>}
        {children}
      </div>
    </div>
  );
}

export function Screen({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="screen">
      <header className="bar"><IconBtn n="back" label={t.back} onClick={nav.pop} /><h1>{title}</h1><div className="grow" />{right}</header>
      <div className="body">{children}</div>
    </div>
  );
}

export function Snackbar() {
  const s = useToast();
  if (!s) return null;
  return (
    <div className="snack" role="status" key={s.id}>
      <span>{s.text}</span>
      {s.undo && <button onClick={() => { s.undo!(); dismissToast(); }}>{t.undo}</button>}
    </div>
  );
}

// ---------- Списки ----------
export function Section({ title, count, children, action, collapsed = false, tone }: { title: string; count?: number; children: ReactNode; action?: ReactNode; collapsed?: boolean; tone?: 'warn' }) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <section className={`section ${tone ?? ''}`}>
      <div className="section-head">
        <button className="section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={`caret ${open ? 'open' : ''}`}><Icon n="chev" size={16} /></span>{title}{count !== undefined && <em>{count}</em>}
        </button>
        {action}
      </div>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

export const Empty = ({ text, action }: { text: string; action?: ReactNode }) => <div className="empty"><p>{text}</p>{action}</div>;
export const ErrorBox = ({ onRetry }: { onRetry: () => void }) => <div className="empty"><p>{t.loadError}</p><button className="btn" onClick={onRetry}>{t.retry}</button></div>;
export const Skeleton = () => <div className="skel">{[0, 1, 2, 3].map((i) => <div key={i} className="skel-row" />)}</div>;

export function Check({ done, onClick, label }: { done?: boolean; onClick: () => void; label: string }) {
  return (
    <button className={`check ${done ? 'on' : ''}`} aria-label={label} aria-pressed={!!done} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      {done && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"><path d="m5 12 5 5 9-10" /></svg>}
    </button>
  );
}

/** Строка со свайпом: вправо — основное действие, влево — второе. */
export function SwipeRow({ children, onRight, onLeft, rightLabel, leftLabel }: { children: ReactNode; onRight?: () => void; onLeft?: () => void; rightLabel?: string; leftLabel?: string }) {
  const [dx, setDx] = useState(0);
  const st = useRef<{ x: number; y: number; lock: boolean | null } | null>(null);
  const moved = useRef(false);
  const reset = () => { st.current = null; setDx(0); };
  return (
    <div className="swipe">
      <div className="swipe-bg"><span className="r">{rightLabel}</span><span className="l">{leftLabel}</span></div>
      <div className="swipe-fg" style={{ transform: `translateX(${dx}px)`, transition: dx ? 'none' : 'transform .2s' }}
        onPointerDown={(e) => { st.current = { x: e.clientX, y: e.clientY, lock: null }; moved.current = false; }}
        onPointerMove={(e) => {
          const s = st.current; if (!s) return;
          const mx = e.clientX - s.x, my = e.clientY - s.y;
          if (s.lock === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) { s.lock = Math.abs(mx) > Math.abs(my); if (s.lock) e.currentTarget.setPointerCapture(e.pointerId); }
          if (s.lock) { moved.current = true; setDx(Math.max(onLeft ? -120 : 0, Math.min(onRight ? 120 : 0, mx))); }
        }}
        onPointerUp={() => { const v = dx; reset(); if (v > 80) { haptic('light'); onRight?.(); } else if (v < -80) { haptic('light'); onLeft?.(); } }}
        onPointerCancel={reset}
        onClickCapture={(e) => { if (moved.current) { e.stopPropagation(); e.preventDefault(); moved.current = false; } }}>
        {children}
      </div>
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => { haptic('select'); onChange(!on); }}><i /></button>;
}

export function TabBar({ tab, onTab }: { tab: string; onTab: (t: string) => void }) {
  const tabs = [['today', t.today, 'today'], ['tasks', t.tasks, 'list'], ['calendar', t.calendar, 'cal'], ['notes', t.notes, 'note']];
  return (
    <nav className="tabbar">
      {tabs.map(([id, label, icon]) => (
        <button key={id} className={tab === id ? 'on' : ''} aria-current={tab === id} onClick={() => { haptic('select'); onTab(id); }}><Icon n={icon} />{label}</button>
      ))}
    </nav>
  );
}

export function TypeSwitch({ current, date }: { current: 'task' | 'event' | 'note'; date?: string }) {
  const go = (k: string) => nav.replace(k === 'task' ? { t: 'task', fab: true } : k === 'event' ? { t: 'event', fab: true, date } : { t: 'note', fab: true });
  return (
    <div className="seg">
      {([['task', t.task], ['event', t.event], ['note', t.note]] as const).map(([k, l]) => (
        <button key={k} className={current === k ? 'on' : ''} onClick={() => current !== k && go(k)}>{l}</button>
      ))}
    </div>
  );
}

export function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => { const h = setTimeout(() => setD(v), ms); return () => clearTimeout(h); }, [v, ms]);
  return d;
}
