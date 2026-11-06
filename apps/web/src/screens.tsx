import { useRef } from 'react';
import type { CalendarOut, NoteOut, ProjectOut, TaskOut, TodayOut } from '@planb/shared';
import { useApp } from './app-context';
import { nav } from './nav';
import { mutate, useGet } from './queries';
import { EventRow, ItemRow, NoteCard, TaskRow } from './rows';
import { t } from './ru';
import { haptic } from './tg';
import { CatChips, Empty, ErrorBox, Icon, IconBtn, Section, Skeleton, Toggle, catStyle } from './ui';
import { addDays, dayNum, dow, longDay, monthTitle, usePersisted, weekStartOf, weekdayShort } from './util';

function TopBar({ title, sub, inbox }: { title: string; sub?: string; inbox?: number }) {
  return (
    <header className="topbar">
      <div><h1>{title}</h1>{sub && <div className="sub">{sub}</div>}</div>
      <div className="grow" />
      {!!inbox && <button className="chip inbox-chip" onClick={() => nav.push({ t: 'inbox' })}><Icon n="inbox" size={16} />{inbox}</button>}
      <IconBtn n="search" label={t.search} onClick={() => nav.push({ t: 'search' })} />
      <IconBtn n="gear" label={t.settings} onClick={() => nav.push({ t: 'settings' })} />
    </header>
  );
}

// ---------- Сегодня ----------
export function Today({ go }: { go: (tab: string) => void }) {
  const { today } = useApp();
  const q = useGet<TodayOut>('/today');
  const [cat, setCat] = usePersisted('cat-today', 'all');
  const d = q.data;
  const f = <T extends { category_id: string }>(x: T) => cat === 'all' || x.category_id === cat;
  const fi = (i: TodayOut['tomorrow'][number]) => f(i.kind === 'task' ? i.task : i.event);
  const view = d && {
    overdue: d.overdue.filter(f), allDay: d.day.allDay.filter(f), timeline: d.day.timeline.filter(fi), noTime: d.day.noTime.filter(f),
    pinned: d.pinned.filter(f), tomorrow: d.tomorrow.filter(fi),
  };
  const empty = view && !view.overdue.length && !view.allDay.length && !view.timeline.length && !view.noTime.length;
  return (
    <>
      <TopBar title={t.today} sub={longDay(today)} inbox={d?.inbox_count} />
      <CatChips value={cat} onChange={setCat} />
      {q.isError && !d ? <ErrorBox onRetry={() => q.refetch()} /> : !view ? <Skeleton /> : (
        <>
          {view.overdue.length > 0 && (
            <Section title={t.overdue} count={view.overdue.length} tone="warn"
              action={<button className="link" onClick={async () => { await mutate('/tasks/move', 'POST', { from: 'overdue', to: 'today' }); haptic('success'); }}>{t.moveToToday}</button>}>
              {view.overdue.map((x) => <TaskRow key={x.id} task={x} showDate />)}
            </Section>
          )}
          {view.allDay.length > 0 && <Section title={t.allDay}>{view.allDay.map((e) => <EventRow key={e.id} event={e} />)}</Section>}
          {(view.timeline.length > 0 || view.noTime.length > 0) && (
            <Section title={t.today}>
              {view.timeline.map((i) => <ItemRow key={i.kind === 'task' ? i.task.id : i.event.id} item={i} />)}
              {view.noTime.map((x) => <TaskRow key={x.id} task={x} />)}
            </Section>
          )}
          {empty && <Empty text={t.emptyToday} action={<button className="btn" onClick={() => nav.push({ t: 'task', fab: true })}>{t.addTask}</button>} />}
          {view.pinned.length > 0 && (
            <Section title={t.pinned} action={d!.pinned_total > 3 ? <button className="link" onClick={() => go('notes')}>{t.allNotes} {d!.pinned_total}</button> : undefined}>
              {view.pinned.map((n) => <NoteCard key={n.id} note={n} />)}
            </Section>
          )}
          {view.tomorrow.length > 0 && (
            <Section title={t.tomorrow} count={d!.tomorrow_total} collapsed>
              {view.tomorrow.map((i) => <ItemRow key={i.kind === 'task' ? i.task.id : i.event.id} item={i} />)}
            </Section>
          )}
        </>
      )}
    </>
  );
}

// ---------- Задачи ----------
type Bucket = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'none';
const ORDER: [Bucket, string][] = [['overdue', t.overdue], ['today', t.today], ['tomorrow', t.tomorrow], ['week', t.thisWeek], ['later', t.later], ['none', t.noDate]];

export function Tasks() {
  const { today, settings } = useApp();
  const open = useGet<TaskOut[]>('/tasks');
  const done = useGet<TaskOut[]>('/tasks?scope=done');
  const projects = useGet<ProjectOut[]>('/projects');
  const [mode, setMode] = usePersisted<'all' | 'projects'>('tasks-mode', 'all');
  const [cat, setCat] = usePersisted('cat-tasks', 'all');
  const weekEnd = addDays(weekStartOf(today, settings.week_start), 6);
  const bucket = (x: TaskOut): Bucket => {
    const d = x.due_date;
    return !d ? 'none' : d < today ? 'overdue' : d === today ? 'today' : d === addDays(today, 1) ? 'tomorrow' : d <= weekEnd ? 'week' : 'later';
  };
  const list = (open.data ?? []).filter((x) => cat === 'all' || x.category_id === cat);
  const doneList = (done.data ?? []).filter((x) => cat === 'all' || x.category_id === cat);
  return (
    <>
      <TopBar title={t.tasks} />
      <div className="seg wide">
        <button className={mode === 'all' ? 'on' : ''} onClick={() => setMode('all')}>{t.all}</button>
        <button className={mode === 'projects' ? 'on' : ''} onClick={() => setMode('projects')}>{t.projects}</button>
      </div>
      <CatChips value={cat} onChange={setCat} />
      {open.isError && !open.data ? <ErrorBox onRetry={() => open.refetch()} /> : !open.data ? <Skeleton /> : (
        <>
          {mode === 'all' && ORDER.map(([b, title]) => {
            const items = list.filter((x) => bucket(x) === b);
            return items.length ? <Section key={b} title={title} count={items.length} tone={b === 'overdue' ? 'warn' : undefined}>{items.map((x) => <TaskRow key={x.id} task={x} showDate={b !== 'today'} />)}</Section> : null;
          })}
          {mode === 'projects' && (
            <>
              <button className="btn ghost" onClick={() => nav.push({ t: 'projectName' })}>+ {t.newProject}</button>
              {[...(projects.data ?? []), null].map((p) => {
                const items = list.filter((x) => (x.project_id ?? null) === (p?.id ?? null));
                if (!p && !items.length) return null;
                return (
                  <Section key={p?.id ?? 'none'} title={p ? p.name + (p.archived ? ' · архив' : '') : t.noProject} count={items.length}
                    action={p ? <IconBtn n="gear" label={t.project} onClick={() => nav.push({ t: 'projectMenu', id: p.id, name: p.name, archived: p.archived })} /> : undefined}>
                    {items.map((x) => <TaskRow key={x.id} task={x} showDate />)}
                  </Section>
                );
              })}
            </>
          )}
          {!list.length && <Empty text={t.emptyTasks} />}
          {doneList.length > 0 && <Section title={t.completed} count={doneList.length} collapsed>{doneList.map((x) => <TaskRow key={x.id} task={x} showDate />)}</Section>}
        </>
      )}
    </>
  );
}

// ---------- Календарь (неделя) ----------
export function Calendar({ day, setDay }: { day: string; setDay: (d: string) => void }) {
  const { today, settings, catMap } = useApp();
  const start = weekStartOf(day, settings.week_start);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const q = useGet<CalendarOut>(`/calendar?from=${start}&to=${days[6]}`);
  const [showTasks, setShowTasks] = usePersisted('cal-tasks', true);
  const touch = useRef<number | null>(null);
  const cur = q.data?.days[day];
  const shift = (n: number) => { haptic('select'); setDay(addDays(day, n * 7)); };
  return (
    <>
      <TopBar title={t.calendar} sub={monthTitle(day)} />
      <div className="cal-tools">
        <button className="chip" onClick={() => shift(-1)} aria-label="Предыдущая неделя">‹</button>
        <button className="chip" onClick={() => setDay(today)}>{t.todayBtn}</button>
        <button className="chip" onClick={() => shift(1)} aria-label="Следующая неделя">›</button>
        <div className="grow" />
        <label className="inline">{t.showTasks}<Toggle on={showTasks} onChange={setShowTasks} label={t.showTasks} /></label>
      </div>
      <div className="week" onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
        onTouchEnd={(e) => { if (touch.current === null) return; const dx = e.changedTouches[0].clientX - touch.current; touch.current = null; if (Math.abs(dx) > 60) shift(dx < 0 ? 1 : -1); }}>
        {days.map((d) => {
          const v = q.data?.days[d];
          const evs = v?.events ?? [], tks = showTasks ? v?.tasks ?? [] : [];
          return (
            <button key={d} className={`wday ${d === day ? 'sel' : ''} ${d === today ? 'today' : ''} ${[0, 6].includes(dow(d)) ? 'wk' : ''}`} onClick={() => setDay(d)} aria-label={longDay(d)}>
              <span className="wd">{weekdayShort(d)}</span><span className="wn">{dayNum(d)}</span>
              <span className="dots">
                {evs.slice(0, 3).map((e) => <i key={e.id} className="dot c" style={catStyle(catMap[e.category_id]?.color)} />)}
                {tks.slice(0, 3).map((x) => <i key={x.id} className="dot sm c" style={catStyle(catMap[x.category_id]?.color)} />)}
                {evs.length + tks.length > 3 && <b>+</b>}
              </span>
            </button>
          );
        })}
      </div>
      <h2 className="day-title">{longDay(day)}</h2>
      {q.isError && !q.data ? <ErrorBox onRetry={() => q.refetch()} /> : !q.data ? <Skeleton /> : (
        <div className="section-body">
          {cur?.events.map((e) => <EventRow key={e.id} event={e} />)}
          {showTasks && cur?.tasks.map((x) => <TaskRow key={x.id} task={x} />)}
          {!cur?.events.length && !(showTasks && cur?.tasks.length) && (
            <Empty text="В этот день ничего нет." action={<button className="btn" onClick={() => nav.push({ t: 'event', fab: true, date: day })}>{t.event} +</button>} />
          )}
        </div>
      )}
    </>
  );
}
// ---------- Заметки ----------
export function Notes() {
  const q = useGet<NoteOut[]>('/notes');
  const [cat, setCat] = usePersisted('cat-notes', 'all');
  const list = (q.data ?? []).filter((n) => cat === 'all' || n.category_id === cat);
  return (
    <>
      <TopBar title={t.notes} />
      <CatChips value={cat} onChange={setCat} />
      {q.isError && !q.data ? <ErrorBox onRetry={() => q.refetch()} /> : !q.data ? <Skeleton /> : list.length ? <div className="section-body">{list.map((n) => <NoteCard key={n.id} note={n} />)}</div> : <Empty text={t.emptyNotes} />}
    </>
  );
}
