import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChecklistItem, EventOut, NoteOut, ProjectOut, TaskOut } from '@planb/shared';
import { useApp } from './app-context';
import { api } from './api';
import { Entry, nav, toast } from './nav';
import { completeTask, mutate, refresh, removeItem, useGet } from './queries';
import { t } from './ru';
import { haptic, openLink, useMainButton } from './tg';
import { CatChips, Check, Icon, IconBtn, Sheet, Skeleton, Toggle, TypeSwitch } from './ui';
import { linkParts, nextHour, offsetLabel, uid } from './util';

/** Кнопка «Сохранить» в нативной MainButton; обработчик всегда актуален, подписка не пересоздаётся. */
function useSave(save: () => void, busy: boolean) {
  const ref = useRef(save);
  ref.current = save;
  useMainButton(t.save, useCallback(() => ref.current(), []), !busy);
}

function Reminders({ value, onChange, hasTime }: { value: number[]; onChange: (v: number[]) => void; hasTime: boolean }) {
  const [n, setN] = useState('');
  const [unit, setUnit] = useState(60);
  const all = [...new Set([...(hasTime ? [0, 10, 30, 60, 1440] : [0, 1440]), ...value])].sort((a, b) => a - b);
  const toggle = (o: number) => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o]);
  const addCustom = () => {
    const m = Math.round(Number(n) * unit);
    if (m > 0 && m <= 525600 && value.length < 10) { onChange([...new Set([...value, m])]); setN(''); } else haptic('error');
  };
  return (
    <div className="field-block">
      <div className="muted">{t.remind}</div>
      <div className="chips wrap">
        {all.map((o) => <button key={o} className={`chip ${value.includes(o) ? 'on' : ''}`} onClick={() => toggle(o)}>{offsetLabel(o, hasTime)}</button>)}
      </div>
      <div className="custom">
        <input className="input sm" type="number" min={1} inputMode="numeric" placeholder={t.custom} value={n} onChange={(e) => setN(e.target.value)} />
        <select className="input sm" value={unit} onChange={(e) => setUnit(Number(e.target.value))}>
          <option value={1}>{t.minutes}</option><option value={60}>{t.hours}</option><option value={1440}>{t.days}</option>
        </select>
        <button className="chip" onClick={addCustom}>{t.add}</button>
      </div>
    </div>
  );
}

// ---------- Задача ----------
export function TaskSheet(p: Extract<Entry, { t: 'task' }>) {
  const q = useGet<TaskOut>(`/tasks/${p.id}`, !!p.id && !p.task);
  const src = p.task ?? q.data;
  if (p.id && !src) return <Sheet tall>{q.isError ? <p className="muted">{t.loadError}</p> : <Skeleton />}</Sheet>;
  return <TaskForm key={p.id ?? 'new'} src={src} draft={p.draft} inboxId={p.inboxId} fab={p.fab} />;
}

function TaskForm({ src, draft, inboxId, fab }: { src?: TaskOut; draft?: Partial<TaskOut>; inboxId?: string; fab?: boolean }) {
  const { categories, settings } = useApp();
  const projects = useGet<ProjectOut[]>('/projects');
  const init = src ?? draft;
  const [title, setTitle] = useState(init?.title ?? '');
  const [desc, setDesc] = useState(init?.description ?? '');
  const [cat, setCat] = useState(src?.category_id ?? categories.find((c) => c.slug === 'misc')!.id);
  const [project, setProject] = useState(src?.project_id ?? '');
  const [date, setDate] = useState(src?.due_date ?? '');
  const [time, setTime] = useState(src?.due_time ?? '');
  const [rem, setRem] = useState<number[]>(src?.reminders ?? []);
  const [list, setList] = useState<ChecklistItem[]>(src?.checklist ?? []);
  const [nag, setNag] = useState<boolean | null>(src?.nag_enabled ?? null);
  const [item, setItem] = useState('');
  const [more, setMore] = useState(!!src || !!draft?.description);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const newId = useRef(uid());
  const id = src?.id ?? newId.current;

  const save = async () => {
    if (!title.trim()) { haptic('error'); setErr(t.titleRequired); return; }
    setBusy(true);
    const body = {
      title: title.trim(), description: desc.trim() || null, category_id: cat, project_id: project || null,
      due_date: date || null, due_time: date && time ? time : null, reminders: date ? rem : [], nag_enabled: nag, checklist: list,
    };
    try {
      if (inboxId) await api(`/inbox/${inboxId}/convert`, { method: 'POST', body: { to: 'task', id, data: body } });
      else await api(`/tasks/${id}`, { method: 'PUT', body });
      await refresh(); haptic('success'); nav.pop();
    } catch (e) { haptic('error'); toast((e as Error).message); setBusy(false); }
  };
  useSave(save, busy);

  const onDate = (v: string) => { setDate(v); if (!v) { setTime(''); setRem([]); } };
  const onTime = (v: string) => { if (v && !time && date && rem.length === 0) setRem([0]); setTime(v); };
  const addItem = () => { if (item.trim()) { setList([...list, { id: uid(), title: item.trim(), done: false }]); setItem(''); } };
  const allChecked = list.length > 0 && list.every((i) => i.done) && src?.status === 'open';

  return (
    <Sheet tall>
      {fab && !src && <TypeSwitch current="task" />}
      <input className="input title" autoFocus={!src} placeholder={t.titlePh} value={title} maxLength={500}
        onChange={(e) => { setTitle(e.target.value); setErr(''); }} onKeyDown={(e) => e.key === 'Enter' && !src && save()} />
      {err && <div className="err" role="alert">{err}</div>}
      <div className="chips wrap">
        <label className="chip">{t.date}: <input type="date" value={date} onChange={(e) => onDate(e.target.value)} /></label>
        {date && <label className="chip">{t.time}: <input type="time" value={time} onChange={(e) => onTime(e.target.value)} /></label>}
        <select className="chip" value={project} onChange={(e) => setProject(e.target.value)} aria-label={t.project}>
          <option value="">{t.noProject}</option>
          {(projects.data ?? []).filter((x) => !x.archived || x.id === project).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </div>
      <CatChips all={false} value={cat} onChange={setCat} />
      {date ? <Reminders value={rem} onChange={setRem} hasTime={!!time} /> : <div className="muted">{t.needDue}</div>}
      {!more ? <button className="link" onClick={() => setMore(true)}>Подробнее…</button> : (
        <>
          <textarea className="input" rows={3} placeholder={t.descPh} value={desc} onChange={(e) => setDesc(e.target.value)} />
          <div className="field-block">
            <div className="muted">{t.checklist}{list.length > 0 && ` · ${list.filter((i) => i.done).length}/${list.length}`}</div>
            {list.map((i) => (
              <div className="cl-item" key={i.id}>
                <Check done={i.done} label={i.title} onClick={() => setList(list.map((x) => (x.id === i.id ? { ...x, done: !x.done } : x)))} />
                <input className={`input plain ${i.done ? 'done' : ''}`} value={i.title} onChange={(e) => setList(list.map((x) => (x.id === i.id ? { ...x, title: e.target.value } : x)))} />
                <IconBtn n="x" label={t.delete} onClick={() => setList(list.filter((x) => x.id !== i.id))} />
              </div>
            ))}
            <input className="input" placeholder={`+ ${t.addItem}`} value={item} onChange={(e) => setItem(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addItem()} onBlur={addItem} />
            {allChecked && <div className="hint">{t.allChecked} <button className="link" onClick={() => { nav.pop(); completeTask(src!); }}>{t.markDone}</button></div>}
          </div>
          <div className="field">{t.nag}<Toggle on={nag ?? settings.nag_enabled_default} onChange={setNag} label={t.nag} /></div>
        </>
      )}
      {src && (
        <div className="stack">
          {src.status === 'open'
            ? <button className="btn" onClick={() => { nav.pop(); completeTask(src); }}>{t.done}</button>
            : <button className="btn" onClick={async () => { await mutate(`/tasks/${src.id}`, 'PATCH', { status: 'open' }); nav.pop(); }}>Вернуть в работу</button>}
          <button className="btn danger" onClick={() => { nav.pop(); removeItem('tasks', src.id); }}>{t.delete}</button>
        </div>
      )}
    </Sheet>
  );
}

// ---------- Событие ----------
export function EventSheet(p: Extract<Entry, { t: 'event' }>) {
  const q = useGet<EventOut>(`/events/${p.id}`, !!p.id && !p.event);
  const src = p.event ?? q.data;
  if (p.id && !src) return <Sheet tall>{q.isError ? <p className="muted">{t.loadError}</p> : <Skeleton />}</Sheet>;
  return <EventForm key={p.id ?? 'new'} src={src} date={p.date} fab={p.fab} />;
}

function EventForm({ src, date: d0, fab }: { src?: EventOut; date?: string; fab?: boolean }) {
  const { categories, today, settings } = useApp();
  const [title, setTitle] = useState(src?.title ?? '');
  const [allDay, setAllDay] = useState(src?.all_day ?? false);
  const [sd, setSd] = useState(src?.start_date ?? d0 ?? today);
  const [st, setSt] = useState(src?.start_time ?? nextHour(settings.timezone));
  const [ed, setEd] = useState(src?.end_date ?? '');
  const [et, setEt] = useState(src?.end_time ?? '');
  const [loc, setLoc] = useState(src?.location ?? '');
  const [desc, setDesc] = useState(src?.description ?? '');
  const [cat, setCat] = useState(src?.category_id ?? categories.find((c) => c.slug === 'misc')!.id);
  const [rem, setRem] = useState<number[]>(src?.reminders ?? [30]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useRef(src?.id ?? uid()).current;

  const save = async () => {
    if (!title.trim()) { haptic('error'); setErr(t.titleRequired); return; }
    const startKey = sd + (allDay ? '' : `T${st}`), endKey = (ed || sd) + (allDay ? '' : `T${et || st}`);
    if ((ed || et) && endKey < startKey) { haptic('error'); setErr(t.endBeforeStart); return; }
    setBusy(true);
    try {
      await api(`/events/${id}`, { method: 'PUT', body: {
        title: title.trim(), all_day: allDay, start_date: sd, start_time: allDay ? null : st, end_date: ed || null, end_time: allDay ? null : et || null,
        location: loc.trim() || null, description: desc.trim() || null, category_id: cat, reminders: rem } });
      await refresh(); haptic('success'); nav.pop();
    } catch (e) { haptic('error'); toast((e as Error).message); setBusy(false); }
  };
  useSave(save, busy);

  return (
    <Sheet tall>
      {fab && !src && <TypeSwitch current="event" date={d0} />}
      <input className="input title" autoFocus={!src} placeholder={t.titlePh} value={title} maxLength={500} onChange={(e) => { setTitle(e.target.value); setErr(''); }} />
      {err && <div className="err" role="alert">{err}</div>}
      <div className="field">{t.allDayLabel}<Toggle on={allDay} label={t.allDayLabel} onChange={(v) => { setAllDay(v); if (!src) setRem(v ? [0] : [30]); }} /></div>
      <div className="chips wrap">
        <label className="chip">{t.start}: <input type="date" value={sd} onChange={(e) => e.target.value && setSd(e.target.value)} /></label>
        {!allDay && <input className="chip" type="time" value={st} onChange={(e) => e.target.value && setSt(e.target.value)} aria-label={t.time} />}
      </div>
      <div className="chips wrap">
        <label className="chip">{t.end}: <input type="date" value={ed} onChange={(e) => setEd(e.target.value)} /></label>
        {!allDay && <input className="chip" type="time" value={et} onChange={(e) => setEt(e.target.value)} aria-label={t.time} />}
      </div>
      <CatChips all={false} value={cat} onChange={setCat} />
      <input className="input" placeholder={t.location} value={loc} maxLength={300} onChange={(e) => setLoc(e.target.value)} />
      <Reminders value={rem} onChange={setRem} hasTime={!allDay} />
      <textarea className="input" rows={3} placeholder={t.descPh} value={desc} onChange={(e) => setDesc(e.target.value)} />
      {src && <div className="stack"><button className="btn danger" onClick={() => { nav.pop(); removeItem('events', src.id); }}>{t.delete}</button></div>}
    </Sheet>
  );
}

// ---------- Заметка (автосохранение, ссылки открываются средствами Telegram) ----------
export function NoteSheet(p: Extract<Entry, { t: 'note' }>) {
  const q = useGet<NoteOut>(`/notes/${p.id}`, !!p.id && !p.note);
  const src = p.note ?? q.data;
  if (p.id && !src) return <Sheet tall>{q.isError ? <p className="muted">{t.loadError}</p> : <Skeleton />}</Sheet>;
  return <NoteForm key={p.id ?? 'new'} src={src} fab={p.fab} />;
}

function NoteForm({ src, fab }: { src?: NoteOut; fab?: boolean }) {
  const { categories } = useApp();
  const [title, setTitle] = useState(src?.title ?? '');
  const [body, setBody] = useState(src?.body ?? '');
  const [cat, setCat] = useState(src?.category_id ?? categories.find((c) => c.slug === 'misc')!.id);
  const [pinned, setPinned] = useState(src?.pinned ?? false);
  const [editing, setEditing] = useState(!src?.body);
  const id = useRef(src?.id ?? uid()).current;
  const dirty = useRef(false);
  const latest = useRef({ title, body, cat, pinned });
  latest.current = { title, body, cat, pinned };
  const on = <T,>(set: (v: T) => void) => (v: T) => { dirty.current = true; set(v); };

  const flush = useCallback(() => {
    const v = latest.current;
    if (!dirty.current || (!v.title.trim() && !v.body.trim())) return;
    dirty.current = false;
    api(`/notes/${id}`, { method: 'PUT', body: { title: v.title.trim() || null, body: v.body, category_id: v.cat, pinned: v.pinned } })
      .then(() => refresh(), (e) => { dirty.current = true; toast((e as Error).message); });
  }, [id]);
  useEffect(() => { if (!dirty.current) return; const h = setTimeout(flush, 1000); return () => clearTimeout(h); }, [title, body, cat, pinned, flush]);
  useEffect(() => () => flush(), [flush]); // при закрытии — сохранить сразу

  return (
    <Sheet tall>
      {fab && !src && <TypeSwitch current="note" />}
      <div className="note-bar">
        <button className={`chip ${pinned ? 'on' : ''}`} onClick={() => on(setPinned)(!pinned)}><Icon n="pin" size={14} /> {pinned ? t.unpin : t.pin}</button>
        <div className="grow" />
        {src && <button className="link danger-text" onClick={() => { dirty.current = false; nav.pop(); removeItem('notes', src.id); }}>{t.delete}</button>}
      </div>
      <input className="input title" placeholder={t.notesTitlePh} value={title} onChange={(e) => on(setTitle)(e.target.value)} />
      {editing ? (
        <textarea className="input note-area" autoFocus placeholder={t.notePh} value={body} onChange={(e) => on(setBody)(e.target.value)} />
      ) : (
        <div className="note-view selectable" onClick={() => setEditing(true)}>
          {linkParts(body).map((x, i) => x.link
            ? <a key={i} href={x.s} onClick={(e) => { e.preventDefault(); e.stopPropagation(); openLink(x.s); }}>{x.s}</a>
            : <span key={i}>{x.s}</span>)}
        </div>
      )}
      <CatChips all={false} value={cat} onChange={on(setCat)} />
    </Sheet>
  );
}
