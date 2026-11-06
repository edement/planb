// Чтение данных и сериализация. Все запросы фильтруются по user_id.
import { HL_CLOSE, HL_OPEN } from '@planb/shared';
import type { CalendarOut, CategoryOut, DayItems, EventOut, InboxOut, Item, NoteOut, ProjectOut, SearchHit, SettingsOut, TaskOut, TodayOut } from '@planb/shared';
import { DB, Row, ftsQuery } from './db';
import { addDays, lastOccurrence, toLocal, todayKey } from './time';

export interface Ctx { db: DB; userId: number; tz: string; s: Row }

export function getCtx(db: DB, userId: number): Ctx {
  const s = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(userId) as Row | undefined;
  if (!s) throw new Error('no settings');
  return { db, userId, tz: s.timezone, s };
}

const bool = (v: unknown) => !!v;
const BOOLS = ['morning_digest_enabled', 'evening_digest_enabled', 'nag_enabled_default', 'skip_empty_digest'];
export function settingsOut(s: Row): SettingsOut {
  const { user_id: _u, ...rest } = s;
  for (const k of BOOLS) rest[k] = bool(rest[k]);
  return rest as SettingsOut;
}

export const categoriesOf = (c: Ctx) =>
  c.db.prepare('SELECT id, slug, name, color FROM categories WHERE user_id = ? ORDER BY rowid').all(c.userId) as CategoryOut[];
export const catId = (c: Ctx, slug: string) =>
  (c.db.prepare('SELECT id FROM categories WHERE user_id = ? AND slug = ?').get(c.userId, slug) as Row).id as string;

// ---------- Сериализаторы ----------
const inList = (ids: string[]) => ids.map(() => '?').join();

function offsetsOf(c: Ctx, type: 'task' | 'event', ids: string[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  if (!ids.length) return m;
  const rows = c.db.prepare(`SELECT DISTINCT entity_id, offset_minutes FROM reminders WHERE entity_type = ? AND offset_minutes IS NOT NULL AND entity_id IN (${inList(ids)}) ORDER BY offset_minutes`).all(type, ...ids) as Row[];
  for (const r of rows) m.set(r.entity_id, [...(m.get(r.entity_id) ?? []), r.offset_minutes]);
  return m;
}

export function hydrateTasks(c: Ctx, rows: Row[]): TaskOut[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const cl = c.db.prepare(`SELECT * FROM checklist_items WHERE task_id IN (${inList(ids)}) ORDER BY position`).all(...ids) as Row[];
  const rem = offsetsOf(c, 'task', ids);
  return rows.map((r) => {
    const loc = r.due_at ? (r.due_has_time ? toLocal(r.due_at, c.tz) : { date: r.due_at as string, time: null }) : null;
    return {
      id: r.id, title: r.title, description: r.description, category_id: r.category_id, project_id: r.project_id,
      due_date: loc?.date ?? null, due_time: loc?.time ?? null, status: r.status, completed_at: r.completed_at,
      nag_enabled: r.nag_enabled == null ? null : bool(r.nag_enabled), reminders: rem.get(r.id) ?? [],
      checklist: cl.filter((i) => i.task_id === r.id).map((i) => ({ id: i.id, title: i.title, done: bool(i.done) })),
      created_at: r.created_at, updated_at: r.updated_at, deleted_at: r.deleted_at,
    };
  });
}

export function hydrateEvents(c: Ctx, rows: Row[]): EventOut[] {
  const rem = offsetsOf(c, 'event', rows.map((r) => r.id));
  return rows.map((r) => {
    const allDay = bool(r.all_day);
    const s = allDay ? { date: r.starts_at, time: null } : toLocal(r.starts_at, c.tz);
    const e = r.ends_at ? (allDay ? { date: r.ends_at, time: null } : toLocal(r.ends_at, c.tz)) : null;
    return {
      id: r.id, title: r.title, description: r.description, location: r.location, category_id: r.category_id,
      all_day: allDay, start_date: s.date, start_time: s.time, end_date: e?.date ?? null, end_time: e?.time ?? null,
      timezone: r.timezone, reminders: rem.get(r.id) ?? [], created_at: r.created_at, updated_at: r.updated_at, deleted_at: r.deleted_at,
    };
  });
}

export const noteOut = (r: Row): NoteOut => ({
  id: r.id, title: r.title, body: r.body, category_id: r.category_id, pinned: bool(r.pinned),
  created_at: r.created_at, updated_at: r.updated_at, deleted_at: r.deleted_at,
});
export const projectOut = (r: Row): ProjectOut => ({
  id: r.id, name: r.name, archived: !!r.archived_at, created_at: r.created_at, updated_at: r.updated_at, deleted_at: r.deleted_at,
});
export const inboxOut = (r: Row): InboxOut => ({
  id: r.id, text: r.text, forward_origin: r.forward_origin, urls: JSON.parse(r.urls), attachments: JSON.parse(r.attachments),
  processed_at: r.processed_at, result_type: r.result_type, created_at: r.created_at,
});

// ---------- Выборки ----------
/** where — готовый SQL-фрагмент (только константы), значения — через params. */
export const loadTasks = (c: Ctx, where = '', params: unknown[] = []): TaskOut[] =>
  hydrateTasks(c, c.db.prepare(`SELECT * FROM tasks WHERE user_id = ? ${where}`).all(c.userId, ...params) as Row[]);
export const loadEvents = (c: Ctx, where = '', params: unknown[] = []): EventOut[] =>
  hydrateEvents(c, c.db.prepare(`SELECT * FROM events WHERE user_id = ? ${where}`).all(c.userId, ...params) as Row[]);

export const openTasksWithDue = (c: Ctx, beforeKey?: string) =>
  loadTasks(c, `AND deleted_at IS NULL AND status = 'open' AND due_at IS NOT NULL ${beforeKey ? 'AND due_at < ?' : ''} ORDER BY due_at`, beforeKey ? [addDays(beforeKey, 2)] : []);

/** События, пересекающие [from, to] (ключи дней). Грубый отбор в SQL, точный — по локальным датам. */
export function eventsBetween(c: Ctx, from: string, to: string): EventOut[] {
  return loadEvents(c, `AND deleted_at IS NULL AND starts_at < ? AND coalesce(ends_at, starts_at) >= ? ORDER BY starts_at`, [addDays(to, 2), addDays(from, -2)])
    .filter((e) => e.start_date <= to && (e.end_date ?? e.start_date) >= from);
}

const byKey = (a: { k: string }, b: { k: string }) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0);

/** Содержимое одного дня: события на весь день (и многодневные, начатые раньше), лента по времени, задачи без времени. */
export function dayItems(tasks: TaskOut[], events: EventOut[], day: string): DayItems {
  const evs = events.filter((e) => e.start_date <= day && (e.end_date ?? e.start_date) >= day);
  const tk = tasks.filter((t) => t.due_date === day);
  const timeline = [
    ...evs.filter((e) => !e.all_day && e.start_date === day).map((event) => ({ k: event.start_time!, item: { kind: 'event', event } as Item })),
    ...tk.filter((t) => t.due_time).map((task) => ({ k: task.due_time!, item: { kind: 'task', task } as Item })),
  ].sort(byKey).map((x) => x.item);
  return { allDay: evs.filter((e) => e.all_day || e.start_date < day), timeline, noTime: tk.filter((t) => !t.due_time) };
}

const flat = (d: DayItems): Item[] => [
  ...d.allDay.map((event) => ({ kind: 'event', event }) as Item), ...d.timeline, ...d.noTime.map((task) => ({ kind: 'task', task }) as Item),
];

export const countInbox = (c: Ctx) =>
  (c.db.prepare('SELECT COUNT(*) n FROM inbox_items WHERE user_id = ? AND processed_at IS NULL').get(c.userId) as Row).n as number;

export function getToday(c: Ctx, now = new Date()): TodayOut {
  const today = todayKey(now, c.tz), tmr = addDays(today, 1);
  const tasks = openTasksWithDue(c, tmr);
  const events = eventsBetween(c, today, tmr);
  const pinned = c.db.prepare('SELECT * FROM notes WHERE user_id = ? AND deleted_at IS NULL AND pinned = 1 ORDER BY pinned_at DESC').all(c.userId) as Row[];
  const tomorrow = flat(dayItems(tasks, events, tmr));
  return {
    date: today,
    overdue: tasks.filter((t) => t.due_date! < today),
    day: dayItems(tasks, events, today),
    pinned: pinned.slice(0, 3).map(noteOut), pinned_total: pinned.length,
    tomorrow: tomorrow.slice(0, 3), tomorrow_total: tomorrow.length,
    inbox_count: countInbox(c),
  };
}

/** Данные вечерней сводки: невыполненное на сегодня и события на завтра. */
export function getEvening(c: Ctx, now = new Date()) {
  const today = todayKey(now, c.tz), tmr = addDays(today, 1);
  const tasks = openTasksWithDue(c, tmr);
  const d = dayItems(tasks, eventsBetween(c, today, tmr), today);
  const t = dayItems([], eventsBetween(c, tmr, tmr), tmr);
  return {
    date: today,
    tasks: [...d.timeline.flatMap((i) => (i.kind === 'task' ? [i.task] : [])), ...d.noTime],
    events: [...t.allDay, ...t.timeline.flatMap((i) => (i.kind === 'event' ? [i.event] : []))],
    inbox_count: countInbox(c),
  };
}

export function getCalendar(c: Ctx, from: string, to: string): CalendarOut {
  const tasks = openTasksWithDue(c).filter((t) => t.due_date! >= from && t.due_date! <= to);
  const events = eventsBetween(c, from, to);
  const days: CalendarOut['days'] = {};
  for (let d = from, i = 0; d <= to && i < 42; d = addDays(d, 1), i++) {
    const di = dayItems(tasks, events, d);
    days[d] = {
      events: [...di.allDay, ...di.timeline.flatMap((x) => (x.kind === 'event' ? [x.event] : []))],
      tasks: [...di.timeline.flatMap((x) => (x.kind === 'task' ? [x.task] : [])), ...di.noTime],
    };
  }
  return { days };
}

/** Выполненные задачи показываются до вечернего «ревью дня»: с момента последней вечерней сводки. */
export function doneCutoff(c: Ctx, now = new Date()): string {
  return lastOccurrence(now, c.tz, c.s.evening_digest_enabled ? c.s.evening_digest_time : '00:00').toISOString();
}

export function search(c: Ctx, q: string, category?: string): SearchHit[] {
  const m = ftsQuery(q);
  if (q.trim().length < 2 || !m) return [];
  const rows = c.db.prepare(
    `SELECT type, id, category_id, flag, title, snippet(search, -1, ?, ?, '…', 12) AS snippet FROM search
     WHERE search MATCH ? AND user_id = ? ${category ? 'AND (category_id = ?)' : ''} ORDER BY rank LIMIT 60`,
  ).all(HL_OPEN, HL_CLOSE, m, c.userId, ...(category ? [category] : [])) as Row[];
  return rows.map((r) => ({ type: r.type, id: r.id, title: r.title, snippet: r.snippet, category_id: r.category_id, flag: bool(r.flag) }));
}

