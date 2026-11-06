// Изменение данных: создание/правка/удаление, напоминания, поиск.
import { randomUUID } from 'node:crypto';

import { EventIn, NoteIn, ProjectIn, TaskIn, splitInbox } from '@planb/shared';
import type { EventOut, NoteOut, ProjectOut, TaskOut } from '@planb/shared';
import { Row, reindex } from './db';
import { Ctx, catId, hydrateEvents, hydrateTasks, loadTasks, noteOut, projectOut } from './data';
import { addDays, nowIso, remindAt, todayKey, zonedToUtc } from './time';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const fail = (status: number, code: string, msg: string): never => { throw new HttpError(status, code, msg); };

type Mode = 'put' | 'patch' | 'post';
const sameSet = (a: number[], b: number[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

function ownRow(c: Ctx, table: string, id: string): Row | undefined {
  const r = c.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
  if (r && r.user_id !== c.userId) return fail(404, 'not_found', 'Не найдено');
  return r;
}
function checkOwned(c: Ctx, table: 'categories' | 'projects', id: string | null | undefined) {
  if (id && !c.db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND user_id = ? AND ${table === 'projects' ? 'deleted_at IS NULL' : '1=1'}`).get(id, c.userId))
    fail(400, 'validation', 'Неизвестная категория или проект');
}

// ---------- Напоминания ----------
/**
 * Пересоздаёт напоминания сущности. offsets не передан — берутся уже сохранённые (после отмены/восстановления).
 * Просроченные и неактивные (выполнено/удалено) сохраняются со статусом cancelled: так не теряются настройки.
 */
export function syncReminders(c: Ctx, type: 'task' | 'event', id: string, offsets?: number[]) {
  const table = type === 'task' ? 'tasks' : 'events';
  const ent = c.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
  if (!ent) return;
  const old = c.db.prepare('SELECT offset_minutes FROM reminders WHERE entity_type = ? AND entity_id = ? AND offset_minutes IS NOT NULL').all(type, id) as Row[];
  const offs = offsets ?? [...new Set(old.map((r) => r.offset_minutes as number))];
  c.db.prepare('DELETE FROM reminders WHERE entity_type = ? AND entity_id = ?').run(type, id);
  const base = type === 'task' ? (ent.due_at ? { at: ent.due_at, hasTime: !!ent.due_has_time } : null) : { at: ent.starts_at, hasTime: !ent.all_day };
  if (!base) return;
  const active = !ent.deleted_at && (type === 'event' || ent.status === 'open');
  const now = nowIso();
  const ins = c.db.prepare('INSERT INTO reminders (id, user_id, entity_type, entity_id, offset_minutes, remind_at, status, created_at) VALUES (?,?,?,?,?,?,?,?)');
  for (const offset of new Set(offs)) {
    const at = remindAt({ ...base, offset, tz: c.tz, dateOnlyTime: c.s.date_only_reminder_time });
    ins.run(randomUUID(), c.userId, type, id, offset, at, active && at > now ? 'pending' : 'cancelled', now);
  }
}

// ---------- Задачи ----------
export function upsertTask(c: Ctx, id: string, raw: unknown, mode: Mode, source = 'app'): TaskOut {
  const body = TaskIn.parse(raw);
  const ex = ownRow(c, 'tasks', id);
  if (!ex && mode === 'patch') fail(404, 'not_found', 'Задача не найдена');
  if (ex && mode === 'post') return hydrateTasks(c, [ex])[0];
  if (!ex && !body.title) fail(400, 'validation', 'Укажите название');
  checkOwned(c, 'categories', body.category_id);
  checkOwned(c, 'projects', body.project_id);

  const cur = ex ? (hydrateTasks(c, [ex])[0]) : null;
  let dueAt: string | null = ex?.due_at ?? null, hasTime = ex?.due_has_time ?? 0;
  if (body.due_date !== undefined || body.due_time !== undefined) {
    const date = body.due_date !== undefined ? body.due_date : cur?.due_date ?? null;
    const time = body.due_time !== undefined ? body.due_time : cur?.due_time ?? null;
    if (!date) { dueAt = null; hasTime = 0; } else if (time) { dueAt = zonedToUtc(date, time, c.tz); hasTime = 1; } else { dueAt = date; hasTime = 0; }
  }
  const now = nowIso();
  const status = body.status ?? ex?.status ?? 'open';
  const row = {
    id, user_id: c.userId, title: body.title ?? ex!.title,
    description: body.description !== undefined ? body.description : ex?.description ?? null,
    category_id: body.category_id ?? ex?.category_id ?? catId(c, 'misc'),
    project_id: body.project_id !== undefined ? body.project_id : ex?.project_id ?? null,
    due_at: dueAt, due_has_time: hasTime, status,
    completed_at: status === 'done' ? (ex?.status === 'done' ? ex.completed_at : now) : null,
    position: ex?.position ?? Date.now(),
    nag_enabled: body.nag_enabled !== undefined ? (body.nag_enabled == null ? null : +body.nag_enabled) : ex?.nag_enabled ?? null,
    rrule: ex?.rrule ?? null, source: ex?.source ?? source, external_id: ex?.external_id ?? null,
    created_at: ex?.created_at ?? now, updated_at: now, deleted_at: ex?.deleted_at ?? null,
  };
  c.db.transaction(() => {
    const cols = Object.keys(row);
    c.db.prepare(`INSERT OR REPLACE INTO tasks (${cols.join()}) VALUES (${cols.map((k) => '@' + k).join()})`).run(row);
    if (body.checklist) {
      const keep = body.checklist.map((i) => i.id);
      c.db.prepare(`DELETE FROM checklist_items WHERE task_id = ? ${keep.length ? `AND id NOT IN (${keep.map(() => '?').join()})` : ''}`).run(id, ...keep);
      const up = c.db.prepare(`INSERT INTO checklist_items (id, task_id, user_id, title, done, position) VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, done = excluded.done, position = excluded.position WHERE user_id = excluded.user_id`);
      body.checklist.forEach((i, n) => up.run(i.id, id, c.userId, i.title, +i.done, n));
    }
    const dueChanged = !ex || ex.due_at !== dueAt || ex.due_has_time !== hasTime;
    const offsetsChanged = body.reminders !== undefined && !sameSet(body.reminders, cur?.reminders ?? []);
    if (dueChanged || offsetsChanged || ex?.status !== status) {
      const dflt = !ex && body.reminders === undefined && hasTime ? [0] : undefined; // срок со временем → напоминание «в момент срока»
      syncReminders(c, 'task', id, body.reminders ?? dflt);
    }
    reindex(c.db, 'task', id);
  })();
  return loadTasks(c, 'AND id = ?', [id])[0];
}

/** Перенос открытых задач: просроченные → сегодня, сегодняшние → завтра (время сохраняется). Возвращает число задач. */
export function moveTasks(c: Ctx, from: 'overdue' | 'today', to: 'today' | 'tomorrow', now = new Date()): number {
  const today = todayKey(now, c.tz);
  const target = to === 'today' ? today : addDays(today, 1);
  const list = loadTasks(c, `AND deleted_at IS NULL AND status = 'open' AND due_at IS NOT NULL`)
    .filter((t) => (from === 'overdue' ? t.due_date! < today : t.due_date === today));
  list.forEach((t) => upsertTask(c, t.id, { due_date: target }, 'patch'));
  return list.length;
}

// ---------- События ----------
export function upsertEvent(c: Ctx, id: string, raw: unknown, mode: Mode): EventOut {
  const body = EventIn.parse(raw);
  const ex = ownRow(c, 'events', id);
  if (!ex && mode === 'patch') fail(404, 'not_found', 'Событие не найдено');
  if (ex && mode === 'post') return hydrateEvents(c, [ex])[0];
  checkOwned(c, 'categories', body.category_id);
  const cur = ex ? hydrateEvents(c, [ex])[0] : null;
  const title = body.title ?? cur?.title;
  const allDay = body.all_day ?? cur?.all_day ?? false;
  const sd = body.start_date ?? cur?.start_date;
  if (!title || !sd) fail(400, 'validation', 'Укажите название и дату начала');
  const st = allDay ? null : (body.start_time !== undefined ? body.start_time : cur?.start_time) ?? '09:00';
  const ed = body.end_date !== undefined ? body.end_date : cur?.end_date ?? null;
  const et = allDay ? null : body.end_time !== undefined ? body.end_time : cur?.end_time ?? null;
  const startsAt = allDay ? sd! : zonedToUtc(sd!, st!, c.tz);
  let endsAt: string | null = null;
  if (allDay) endsAt = ed;
  else if (et || ed) endsAt = zonedToUtc(ed ?? sd!, et ?? st!, c.tz);
  if (endsAt && endsAt < startsAt) fail(400, 'validation', 'Окончание не может быть раньше начала');
  const now = nowIso();
  const row = {
    id, user_id: c.userId, title, description: body.description !== undefined ? body.description : ex?.description ?? null,
    location: body.location !== undefined ? body.location : ex?.location ?? null,
    category_id: body.category_id ?? ex?.category_id ?? catId(c, 'misc'),
    starts_at: startsAt, ends_at: endsAt, all_day: +allDay, timezone: body.timezone ?? ex?.timezone ?? c.tz,
    rrule: ex?.rrule ?? null, source: ex?.source ?? 'app', external_id: ex?.external_id ?? null,
    created_at: ex?.created_at ?? now, updated_at: now, deleted_at: ex?.deleted_at ?? null,
  };
  c.db.transaction(() => {
    const cols = Object.keys(row);
    c.db.prepare(`INSERT OR REPLACE INTO events (${cols.join()}) VALUES (${cols.map((k) => '@' + k).join()})`).run(row);
    const changed = !ex || ex.starts_at !== startsAt || ex.all_day !== +allDay;
    const offsetsChanged = body.reminders !== undefined && !sameSet(body.reminders, cur?.reminders ?? []);
    if (changed || offsetsChanged) syncReminders(c, 'event', id, body.reminders ?? (!ex ? [allDay ? 0 : 30] : undefined));
    reindex(c.db, 'event', id);
  })();
  return hydrateEvents(c, [c.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Row])[0];
}

// ---------- Заметки ----------
export function upsertNote(c: Ctx, id: string, raw: unknown, mode: Mode, source = 'app'): NoteOut {
  const body = NoteIn.parse(raw);
  const ex = ownRow(c, 'notes', id);
  if (!ex && mode === 'patch') fail(404, 'not_found', 'Заметка не найдена');
  if (ex && mode === 'post') return noteOut(ex);
  checkOwned(c, 'categories', body.category_id);
  const now = nowIso();
  const pinned = body.pinned !== undefined ? +body.pinned : ex?.pinned ?? 0;
  const row = {
    id, user_id: c.userId, title: body.title !== undefined ? body.title : ex?.title ?? null, body: body.body ?? ex?.body ?? '',
    category_id: body.category_id ?? ex?.category_id ?? catId(c, 'misc'), pinned,
    pinned_at: pinned ? (ex?.pinned ? ex.pinned_at : now) : null, source: ex?.source ?? source, external_id: ex?.external_id ?? null,
    created_at: ex?.created_at ?? now, updated_at: now, deleted_at: ex?.deleted_at ?? null,
  };
  if (!row.title?.trim() && !row.body.trim()) fail(400, 'validation', 'Пустая заметка не сохраняется');
  const cols = Object.keys(row);
  c.db.prepare(`INSERT OR REPLACE INTO notes (${cols.join()}) VALUES (${cols.map((k) => '@' + k).join()})`).run(row);
  reindex(c.db, 'note', id);
  return noteOut(c.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Row);
}

// ---------- Проекты ----------
export function upsertProject(c: Ctx, id: string, raw: unknown, mode: Mode): ProjectOut {
  const body = ProjectIn.parse(raw);
  const ex = ownRow(c, 'projects', id);
  if (!ex && mode === 'patch') fail(404, 'not_found', 'Проект не найден');
  if (!ex && !body.name) fail(400, 'validation', 'Укажите название проекта');
  const now = nowIso();
  const row = {
    id, user_id: c.userId, name: body.name ?? ex!.name,
    archived_at: body.archived === undefined ? ex?.archived_at ?? null : body.archived ? ex?.archived_at ?? now : null,
    created_at: ex?.created_at ?? now, updated_at: now, deleted_at: ex?.deleted_at ?? null,
  };
  const cols = Object.keys(row);
  c.db.prepare(`INSERT OR REPLACE INTO projects (${cols.join()}) VALUES (${cols.map((k) => '@' + k).join()})`).run(row);
  return projectOut(row);
}

// ---------- Удаление / восстановление ----------
const TABLE = { task: 'tasks', event: 'events', note: 'notes', project: 'projects' } as const;
export type Kind = keyof typeof TABLE;

export function softDelete(c: Ctx, kind: Kind, id: string, restore = false) {
  const ex = ownRow(c, TABLE[kind], id);
  if (!ex) fail(404, 'not_found', 'Не найдено');
  const now = nowIso();
  c.db.transaction(() => {
    c.db.prepare(`UPDATE ${TABLE[kind]} SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(restore ? null : now, now, id);
    if (kind === 'project' && !restore) c.db.prepare('UPDATE tasks SET project_id = NULL, updated_at = ? WHERE project_id = ? AND user_id = ?').run(now, id, c.userId);
    if (kind === 'task' || kind === 'event') syncReminders(c, kind, id);
    if (kind !== 'project') reindex(c.db, kind, id);
  })();
}

// ---------- Входящие ----------
export function convertInbox(c: Ctx, inboxId: string, to: 'task' | 'note', newId: string, data: Record<string, unknown> = {}) {
  const item = ownRow(c, 'inbox_items', inboxId);
  if (!item) return fail(404, 'not_found', 'Запись не найдена');
  if (item.result_id) return { type: item.result_type, id: item.result_id };
  const text = (item.text as string) || (JSON.parse(item.attachments)[0]?.caption ?? '') || 'Вложение';
  const now = nowIso();
  c.db.transaction(() => {
    if (to === 'task') upsertTask(c, newId, { ...splitInbox(text), ...data }, 'post', 'inbox');
    else upsertNote(c, newId, { body: text, ...data }, 'post', 'inbox');
    c.db.prepare('UPDATE inbox_items SET processed_at = ?, result_type = ?, result_id = ?, updated_at = ? WHERE id = ?').run(now, to, newId, now, inboxId);
    reindex(c.db, 'inbox', inboxId);
  })();
  return { type: to, id: newId };
}

export function discardInbox(c: Ctx, id: string) {
  if (!ownRow(c, 'inbox_items', id)) fail(404, 'not_found', 'Запись не найдена');
  const now = nowIso();
  c.db.prepare(`UPDATE inbox_items SET processed_at = coalesce(processed_at, ?), result_type = coalesce(result_type, 'discarded'), updated_at = ? WHERE id = ?`).run(now, now, id);
  reindex(c.db, 'inbox', id);
}

export function completeTask(c: Ctx, id: string) { upsertTask(c, id, { status: 'done' }, 'patch'); }

// ---------- Аккаунт ----------
const USER_TABLES = ['tasks', 'checklist_items', 'events', 'notes', 'projects', 'categories', 'inbox_items', 'reminders', 'digest_log', 'search', 'settings'];

export function exportAll(c: Ctx) {
  const out: Record<string, unknown> = {};
  for (const t of USER_TABLES.filter((t) => t !== 'search')) out[t] = c.db.prepare(`SELECT * FROM ${t} WHERE user_id = ?`).all(c.userId);
  return { exported_at: nowIso(), timezone: c.tz, ...out };
}

export function deleteAccount(c: Ctx) {
  c.db.transaction(() => {
    for (const t of USER_TABLES) c.db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(c.userId);
    c.db.prepare('DELETE FROM users WHERE telegram_id = ?').run(c.userId);
  })();
}

