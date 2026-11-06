import { z } from 'zod';

/** Проверка IANA-часового пояса (работает и в браузере, и в Node). */
export const isTz = (v: string) => {
  try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; }
};

const Id = z.string().uuid();
const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const T = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Offsets = z.array(z.number().int().min(0).max(525600)).max(10);

// ---------- Входные схемы (все поля необязательны: PUT/PATCH; обязательность title проверяет сервер) ----------
export const TaskIn = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10000).nullable(),
  category_id: Id.nullable(),
  project_id: Id.nullable(),
  due_date: D.nullable(),
  due_time: T.nullable(),
  status: z.enum(['open', 'done']),
  nag_enabled: z.boolean().nullable(),
  reminders: Offsets,
  checklist: z.array(z.object({ id: Id, title: z.string().trim().min(1).max(300), done: z.boolean() })).max(100),
}).partial();

export const EventIn = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10000).nullable(),
  location: z.string().max(300).nullable(),
  category_id: Id.nullable(),
  all_day: z.boolean(),
  start_date: D,
  start_time: T.nullable(),
  end_date: D.nullable(),
  end_time: T.nullable(),
  timezone: z.string().refine(isTz).optional(),
  reminders: Offsets,
}).partial();

export const NoteIn = z.object({
  title: z.string().max(500).nullable(),
  body: z.string().max(100000),
  category_id: Id.nullable(),
  pinned: z.boolean(),
}).partial();

export const ProjectIn = z.object({ name: z.string().trim().min(1).max(200), archived: z.boolean() }).partial();
export const CategoryIn = z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/) });

export const SettingsIn = z.object({
  timezone: z.string().refine(isTz),
  week_start: z.union([z.literal(0), z.literal(1)]),
  morning_digest_enabled: z.boolean(),
  morning_digest_time: T,
  evening_digest_enabled: z.boolean(),
  evening_digest_time: T,
  quiet_hours_start: T,
  quiet_hours_end: T,
  date_only_reminder_time: T,
  nag_enabled_default: z.boolean(),
  nag_interval_min: z.number().int().min(5).max(720),
  nag_max_count: z.number().int().min(0).max(10),
  skip_empty_digest: z.boolean(),
}).partial();

export const ConvertIn = z.object({
  to: z.enum(['task', 'note']),
  id: Id,
  data: z.record(z.unknown()).optional(),
});
export const MoveIn = z.object({ from: z.enum(['overdue', 'today']), to: z.enum(['today', 'tomorrow']) });

// ---------- Выходные типы ----------
export interface ChecklistItem { id: string; title: string; done: boolean }
export interface TaskOut {
  id: string; title: string; description: string | null; category_id: string; project_id: string | null;
  due_date: string | null; due_time: string | null; status: 'open' | 'done'; completed_at: string | null;
  nag_enabled: boolean | null; reminders: number[]; checklist: ChecklistItem[];
  created_at: string; updated_at: string; deleted_at: string | null;
}
export interface EventOut {
  id: string; title: string; description: string | null; location: string | null; category_id: string;
  all_day: boolean; start_date: string; start_time: string | null; end_date: string | null; end_time: string | null;
  timezone: string; reminders: number[]; created_at: string; updated_at: string; deleted_at: string | null;
}
export interface NoteOut {
  id: string; title: string | null; body: string; category_id: string; pinned: boolean;
  created_at: string; updated_at: string; deleted_at: string | null;
}
export interface ProjectOut { id: string; name: string; archived: boolean; created_at: string; updated_at: string; deleted_at: string | null }
export interface CategoryOut { id: string; slug: 'study' | 'work' | 'misc'; name: string; color: string }
export interface Attachment { type: string; file_id: string; caption?: string }
export interface InboxOut {
  id: string; text: string; forward_origin: string | null; urls: string[]; attachments: Attachment[];
  processed_at: string | null; result_type: string | null; created_at: string;
}
export interface SettingsOut {
  timezone: string; week_start: 0 | 1; morning_digest_enabled: boolean; morning_digest_time: string;
  evening_digest_enabled: boolean; evening_digest_time: string; quiet_hours_start: string; quiet_hours_end: string;
  date_only_reminder_time: string; nag_enabled_default: boolean; nag_interval_min: number; nag_max_count: number;
  skip_empty_digest: boolean;
}
export type Item = { kind: 'event'; event: EventOut } | { kind: 'task'; task: TaskOut };
export interface DayItems { allDay: EventOut[]; timeline: Item[]; noTime: TaskOut[] }
export interface TodayOut {
  date: string; overdue: TaskOut[]; day: DayItems; pinned: NoteOut[]; pinned_total: number;
  tomorrow: Item[]; tomorrow_total: number; inbox_count: number;
}
export interface CalendarOut { days: Record<string, { events: EventOut[]; tasks: TaskOut[] }> }
export interface SearchHit { type: 'task' | 'event' | 'note' | 'inbox'; id: string; title: string; snippet: string; category_id: string | null; flag: boolean }
export interface Bootstrap { user: { id: number; first_name: string | null; username: string | null }; settings: SettingsOut; categories: CategoryOut[] }

/** Маркеры подсветки совпадения в сниппетах поиска (управляющие символы, не HTML). */
export const HL_OPEN = '\u0001';
export const HL_CLOSE = '\u0002';

/** Разбор записи «Входящих» на название (первая строка, до 120 символов) и описание. */
export function splitInbox(text: string): { title: string; description: string | null } {
  const t = text.trim();
  const nl = t.indexOf('\n');
  let first = nl === -1 ? t : t.slice(0, nl).trim();
  let rest = nl === -1 ? '' : t.slice(nl + 1).trim();
  if (first.length > 120) { rest = (first.slice(120) + (rest ? '\n' + rest : '')).trim(); first = first.slice(0, 120); }
  return { title: first || 'Без названия', description: rest || null };
}
