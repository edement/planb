// Планировщик: раз в 30 секунд отправляет напоминания, повторы и сводки.
import type { DB, Row } from './db';
import { Ctx, getCtx, getEvening, getToday, loadEvents, loadTasks } from './data';
import { Tg, TgError } from './tg';
import { Msg, eveningDigest, morningDigest, reminderMsg } from './texts';
import { dateTitle, isQuiet, nowIso, todayAt, todayKey } from './time';

export interface Log { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void }
export interface Deps { db: DB; tg: Tg; webapp: string; log: Log; state: { pauseUntil: number; lastCleanup: number } }
export const newState = () => ({ pauseUntil: 0, lastCleanup: 0 });

type Sent = { ok: true; mid: number } | { ok: false; retry: boolean };

async function trySend(d: Deps, userId: number, m: Msg, now: Date): Promise<Sent> {
  try { return { ok: true, mid: await d.tg.send(userId, m) }; } catch (e) {
    const err = e as TgError;
    if (err.code === 403) { d.db.prepare('UPDATE users SET blocked = 1 WHERE telegram_id = ?').run(userId); d.log.warn({ userId }, 'user blocked the bot'); return { ok: false, retry: false }; }
    if (err.code === 429) { d.state.pauseUntil = now.getTime() + (err.retryAfter ?? 5) * 1000; d.log.warn({ retryAfter: err.retryAfter }, 'telegram 429'); return { ok: false, retry: true }; }
    d.log.error({ userId, code: err.code }, 'send failed');
    return { ok: false, retry: err.code === 0 || err.code >= 500 };
  }
}

/** Сообщение для напоминания; null — сущность неактуальна (удалена/выполнена). */
function build(c: Ctx, r: Row, now: Date, webapp: string, repeat: number): { msg: Msg; nag: boolean } | null {
  const cat = (id: string) => (c.db.prepare('SELECT name FROM categories WHERE id = ?').get(id) as Row | undefined)?.name ?? '';
  const today = todayKey(now, c.tz);
  if (r.entity_type === 'task') {
    const t = loadTasks(c, 'AND id = ? AND deleted_at IS NULL AND status = ?', [r.entity_id, 'open'])[0];
    if (!t) return null;
    const nag = (t.nag_enabled ?? !!c.s.nag_enabled_default) && c.s.nag_max_count > 0;
    return { nag, msg: reminderMsg({ kind: 'task', id: t.id, title: t.title, date: t.due_date ?? today, time: t.due_time, category: cat(t.category_id) }, { rid: r.id, today, webapp, repeat }) };
  }
  const e = loadEvents(c, 'AND id = ? AND deleted_at IS NULL', [r.entity_id])[0];
  if (!e) return null;
  return { nag: false, msg: reminderMsg({ kind: 'event', id: e.id, title: e.title, date: e.start_date, time: e.start_time, category: cat(e.category_id) }, { rid: r.id, today, webapp }) };
}

async function sendDue(d: Deps, now: Date) {
  const rows = d.db.prepare(`SELECT r.* FROM reminders r JOIN users u ON u.telegram_id = r.user_id
    WHERE r.status = 'pending' AND r.remind_at <= ? AND u.blocked = 0 ORDER BY r.remind_at LIMIT 100`).all(nowIso(now)) as Row[];
  for (const r of rows) {
    if (now.getTime() < d.state.pauseUntil) return;
    const c = getCtx(d.db, r.user_id);
    const b = build(c, r, now, d.webapp, 0);
    if (!b) { d.db.prepare(`UPDATE reminders SET status = 'cancelled' WHERE id = ?`).run(r.id); continue; }
    // Атомарная «заявка»: после рестарта одно и то же напоминание не уйдёт дважды.
    if (!d.db.prepare(`UPDATE reminders SET status = 'sent', sent_count = 1 WHERE id = ? AND status = 'pending'`).run(r.id).changes) continue;
    const res = await trySend(d, r.user_id, b.msg, now);
    if (res.ok) {
      d.db.prepare('UPDATE reminders SET last_message_id = ?, next_nag_at = ? WHERE id = ?')
        .run(res.mid, b.nag ? nowIso(new Date(now.getTime() + c.s.nag_interval_min * 60000)) : null, r.id);
      // Один активный ряд повторов на задачу.
      d.db.prepare('UPDATE reminders SET next_nag_at = NULL WHERE entity_type = ? AND entity_id = ? AND id != ?').run(r.entity_type, r.entity_id, r.id);
      d.log.info({ reminder: r.id }, 'reminder sent');
    } else if (res.retry) {
      d.db.prepare(`UPDATE reminders SET status = 'pending', sent_count = 0 WHERE id = ?`).run(r.id);
      if (d.state.pauseUntil > now.getTime()) return;
    }
  }
}

async function sendNags(d: Deps, now: Date) {
  const rows = d.db.prepare(`SELECT r.* FROM reminders r JOIN users u ON u.telegram_id = r.user_id
    WHERE r.status = 'sent' AND r.next_nag_at IS NOT NULL AND r.next_nag_at <= ? AND u.blocked = 0`).all(nowIso(now)) as Row[];
  for (const r of rows) {
    if (now.getTime() < d.state.pauseUntil) return;
    const c = getCtx(d.db, r.user_id);
    if (isQuiet(now, c.tz, c.s.quiet_hours_start, c.s.quiet_hours_end)) continue; // не копятся: одно next_nag_at, отправится после тихих часов
    const b = build(c, r, now, d.webapp, r.sent_count);
    if (!b || !b.nag) { d.db.prepare('UPDATE reminders SET next_nag_at = NULL WHERE id = ?').run(r.id); continue; }
    if (!d.db.prepare('UPDATE reminders SET next_nag_at = NULL WHERE id = ? AND next_nag_at = ?').run(r.id, r.next_nag_at).changes) continue;
    if (r.last_message_id) await d.tg.remove(r.user_id, r.last_message_id).catch(() => {});
    const res = await trySend(d, r.user_id, b.msg, now);
    if (res.ok) {
      const count = r.sent_count + 1;
      d.db.prepare('UPDATE reminders SET sent_count = ?, last_message_id = ?, next_nag_at = ? WHERE id = ?')
        .run(count, res.mid, count < 1 + c.s.nag_max_count ? nowIso(new Date(now.getTime() + c.s.nag_interval_min * 60000)) : null, r.id);
    } else if (res.retry) {
      d.db.prepare('UPDATE reminders SET next_nag_at = ? WHERE id = ?').run(r.next_nag_at, r.id);
      if (d.state.pauseUntil > now.getTime()) return;
    }
  }
}

async function sendDigests(d: Deps, now: Date) {
  const users = d.db.prepare('SELECT telegram_id FROM users WHERE blocked = 0').all() as Row[];
  for (const u of users) {
    const c = getCtx(d.db, u.telegram_id);
    for (const kind of ['morning', 'evening'] as const) {
      if (now.getTime() < d.state.pauseUntil) return;
      if (!c.s[`${kind}_digest_enabled`]) continue;
      const at = todayAt(now, c.tz, c.s[`${kind}_digest_time`]).getTime();
      if (now.getTime() < at || now.getTime() - at > 2 * 3600_000) continue; // пропущенные более чем на 2 часа не отправляются
      if (isQuiet(now, c.tz, c.s.quiet_hours_start, c.s.quiet_hours_end)) continue;
      const date = todayKey(now, c.tz);
      if (!d.db.prepare('INSERT OR IGNORE INTO digest_log (user_id, kind, date, sent_at) VALUES (?,?,?,?)').run(c.userId, kind, date, nowIso(now)).changes) continue;
      let msg = kind === 'morning' ? morningDigest(getToday(c, now), d.webapp) : eveningDigest(getEvening(c, now), d.webapp);
      if (!msg && c.s.skip_empty_digest) continue;
      msg ??= { text: `${kind === 'morning' ? '☀️' : '🌙'} <b>${dateTitle(date)}</b>\nНа сегодня всё.`, buttons: [] };
      const res = await trySend(d, c.userId, msg, now);
      if (!res.ok && res.retry) d.db.prepare('DELETE FROM digest_log WHERE user_id = ? AND kind = ? AND date = ?').run(c.userId, kind, date);
    }
  }
}

function cleanup(d: Deps, now: Date) {
  if (now.getTime() - d.state.lastCleanup < 3600_000) return;
  d.state.lastCleanup = now.getTime();
  const old = nowIso(new Date(now.getTime() - 30 * 86400_000));
  const ids = d.db.prepare('SELECT id FROM inbox_items WHERE processed_at IS NOT NULL AND processed_at < ?').all(old) as Row[];
  d.db.transaction(() => {
    for (const { id } of ids) { d.db.prepare(`DELETE FROM search WHERE type = 'inbox' AND id = ?`).run(id); d.db.prepare('DELETE FROM inbox_items WHERE id = ?').run(id); }
    d.db.prepare('DELETE FROM digest_log WHERE date < ?').run(old.slice(0, 10));
  })();
}

export async function tick(d: Deps, now = new Date()) {
  if (now.getTime() < d.state.pauseUntil) return;
  await sendDue(d, now);
  await sendNags(d, now);
  await sendDigests(d, now);
  cleanup(d, now);
}

export function startScheduler(d: Deps, everyMs = 30_000) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await tick(d); } catch (e) { d.log.error({ err: (e as Error).message }, 'tick failed'); } finally { running = false; }
  };
  void run(); // после простоя пропущенные напоминания уходят сразу
  const timer = setInterval(run, everyMs);
  return () => clearInterval(timer);
}
