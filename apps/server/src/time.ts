// Вся работа с датами и часовыми поясами — только здесь.
// В БД: моменты времени в UTC (ISO 8601), «только дата» — строка YYYY-MM-DD.
import { DateTime } from 'luxon';

const ruWeekday = (dt: DateTime) => dt.setLocale('ru').toFormat('cccc, d MMMM');

export const nowIso = (d = new Date()) => d.toISOString();

/** Локальные дата+время в поясе tz → UTC ISO. Несуществующее время (переход на летнее) сдвигается вперёд. */
export function zonedToUtc(date: string, time: string, tz: string): string {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: tz });
  if (!dt.isValid) throw new Error('invalid date');
  return dt.toUTC().toISO()!;
}

export function toLocal(iso: string, tz: string): { date: string; time: string } {
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz);
  return { date: dt.toISODate()!, time: dt.toFormat('HH:mm') };
}

/** Ключ дня YYYY-MM-DD в поясе tz. Для значений «только дата» возвращает их же. */
export const dayKey = (v: string, tz: string) => (v.length === 10 ? v : toLocal(v, tz).date);
export const todayKey = (now: Date, tz: string) => DateTime.fromJSDate(now, { zone: tz }).toISODate()!;
export const addDays = (key: string, n: number) => DateTime.fromISO(key, { zone: 'utc' }).plus({ days: n }).toISODate()!;

/**
 * Момент напоминания (UTC ISO).
 * offset — минуты «за сколько до срока». Для значений без времени отсчёт идёт от dateOnlyTime в день срока;
 * целые сутки вычитаются календарно (корректно при переходе на летнее время).
 */
export function remindAt(p: { at: string; hasTime: boolean; offset: number; tz: string; dateOnlyTime: string }): string {
  const base = p.hasTime
    ? DateTime.fromISO(p.at, { zone: 'utc' }).setZone(p.tz)
    : DateTime.fromISO(`${p.at}T${p.dateOnlyTime}`, { zone: p.tz });
  const days = Math.floor(p.offset / 1440);
  return base.minus({ days }).minus({ minutes: p.offset % 1440 }).toUTC().toISO()!;
}

const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Тихие часы [start, end); интервал может переходить через полночь. */
export function isQuiet(now: Date, tz: string, start: string, end: string): boolean {
  const l = DateTime.fromJSDate(now, { zone: tz });
  const m = l.hour * 60 + l.minute;
  const s = mins(start), e = mins(end);
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** Сегодняшний момент hh:mm в поясе tz (UTC). */
export const todayAt = (now: Date, tz: string, hhmm: string) => new Date(zonedToUtc(todayKey(now, tz), hhmm, tz));

/** Ближайшее будущее вхождение hh:mm. */
export function nextOccurrence(now: Date, tz: string, hhmm: string): Date {
  const t = todayAt(now, tz, hhmm);
  return t > now ? t : new Date(zonedToUtc(addDays(todayKey(now, tz), 1), hhmm, tz));
}

/** Последнее прошедшее вхождение hh:mm. */
export function lastOccurrence(now: Date, tz: string, hhmm: string): Date {
  const t = todayAt(now, tz, hhmm);
  return t <= now ? t : new Date(zonedToUtc(addDays(todayKey(now, tz), -1), hhmm, tz));
}

/** «Сегодня, 15:00» / «Завтра» / «5 ноября, 15:00». */
export function whenLabel(date: string, time: string | null, today: string): string {
  const day = date === today ? 'Сегодня' : date === addDays(today, 1) ? 'Завтра' : date === addDays(today, -1) ? 'Вчера'
    : DateTime.fromISO(date, { zone: 'utc' }).setLocale('ru').toFormat('d MMMM');
  return time ? `${day}, ${time}` : day;
}

export function dateTitle(date: string): string {
  const s = ruWeekday(DateTime.fromISO(date, { zone: 'utc' }));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const hhmm = (d: Date, tz: string) => DateTime.fromJSDate(d, { zone: tz }).toFormat('HH:mm');
