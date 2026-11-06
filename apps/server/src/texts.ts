// Чистые функции: данные → текст и кнопки. Без обращений к Telegram и БД.
import type { EventOut, TaskOut, TodayOut } from '@planb/shared';
import { dateTitle, whenLabel } from './time';

export interface Button { text: string; cb?: string; web?: string }
export interface Msg { text: string; buttons: Button[][] }

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cut = (s: string, n = 200) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function plural(n: number, f: [string, string, string]): string {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? f[0] : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? f[1] : f[2];
}
export const tasksWord = (n: number) => `${n} ${plural(n, ['задача', 'задачи', 'задач'])}`;

export const openUrl = (webapp: string, target: string) => `${webapp}/?open=${target}`;

/** Напоминание о задаче/событии. repeat > 0 — настойчивый повтор. */
export function reminderMsg(
  e: { kind: 'task' | 'event'; id: string; title: string; date: string; time: string | null; category: string },
  o: { rid: string; today: string; webapp: string; repeat?: number },
): Msg {
  const text = `${o.repeat ? '🔁 ' : ''}<b>${esc(cut(e.title))}</b>\n${esc(whenLabel(e.date, e.time, o.today))} · ${esc(e.category)}`;
  const row: Button[] = [];
  if (e.kind === 'task') row.push({ text: '✅ Выполнено', cb: `d:${o.rid}` });
  row.push({ text: '⏰ Отложить', cb: `z:${o.rid}` }, { text: 'Открыть', web: openUrl(o.webapp, `${e.kind}_${e.id}`) });
  return { text, buttons: [row] };
}

export const snoozeButtons = (rid: string, webapp: string, target: string): Button[][] => [
  [{ text: 'Через час', cb: `s:${rid}:1h` }, { text: 'Вечером', cb: `s:${rid}:ev` }],
  [{ text: 'Завтра утром', cb: `s:${rid}:mo` }, { text: 'Выбрать время', web: openUrl(webapp, target) }],
];

/** Сообщение не длиннее 4096 символов: лишние строки заменяются на «ещё M». */
function fit(lines: string[], limit = 4000): string {
  const out = [...lines];
  let hidden = 0;
  while (out.join('\n').length > limit && out.length > 1) {
    const l = out.pop()!;
    if (l.startsWith('•')) hidden++;
  }
  return hidden ? `${out.join('\n')}\n… ещё ${hidden}, откройте приложение` : out.join('\n');
}

const taskLine = (t: TaskOut) => `• ${t.due_time ? t.due_time + ' · ' : ''}${esc(cut(t.title))}`;
const eventLine = (e: EventOut) => `• ${e.all_day || !e.start_time ? 'весь день' : e.start_time} · ${esc(cut(e.title))}`;

export function morningDigest(t: TodayOut, webapp: string): Msg | null {
  const events = [...t.day.allDay, ...t.day.timeline.flatMap((i) => (i.kind === 'event' ? [i.event] : []))];
  const tasks = [...t.day.timeline.flatMap((i) => (i.kind === 'task' ? [i.task] : [])), ...t.day.noTime];
  if (!events.length && !tasks.length && !t.overdue.length && !t.pinned_total && !t.inbox_count) return null;
  const lines = [`☀️ <b>${dateTitle(t.date)}</b>`];
  if (events.length) lines.push('', '<b>События</b>', ...events.map(eventLine));
  if (tasks.length) lines.push('', '<b>Задачи</b>', ...tasks.map(taskLine));
  if (t.overdue.length) lines.push('', `<b>Просрочено: ${t.overdue.length}</b>`, ...t.overdue.slice(0, 3).map(taskLine));
  if (t.pinned.length) lines.push('', '<b>Заметки</b>', ...t.pinned.map((n) => `• ${esc(cut(n.title || n.body.split('\n')[0]))}`));
  if (t.inbox_count) lines.push('', `Входящие: ${t.inbox_count} неразобранных`);
  return { text: fit(lines), buttons: [[{ text: 'Открыть Сегодня', web: openUrl(webapp, 'today') }]] };
}

export function eveningDigest(d: { date: string; tasks: TaskOut[]; events: EventOut[]; inbox_count: number }, webapp: string): Msg | null {
  if (!d.tasks.length && !d.events.length && !d.inbox_count) return null;
  const lines = ['🌙 <b>Итоги дня</b>'];
  if (d.tasks.length) lines.push('', '<b>Не выполнено на сегодня</b>', ...d.tasks.map(taskLine));
  if (d.events.length) lines.push('', '<b>Завтра</b>', ...d.events.map(eventLine));
  if (d.inbox_count) lines.push('', `Входящие: ${d.inbox_count} неразобранных`);
  const row: Button[] = [];
  if (d.tasks.length) row.push({ text: 'Всё на завтра', cb: 't:tomorrow' });
  row.push({ text: 'Открыть', web: openUrl(webapp, 'today') });
  return { text: fit(lines), buttons: [row] };
}
