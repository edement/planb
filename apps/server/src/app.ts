import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { Bot, webhookCallback } from 'grammy';
import { ZodError, z } from 'zod';
import { CategoryIn, ConvertIn, MoveIn, SettingsIn, isTz } from '@planb/shared';
import type { Bootstrap } from '@planb/shared';
import { verifyInitData } from './auth';
import type { Config } from './config';
import { Ctx, categoriesOf, doneCutoff, eventsBetween, getCalendar, getCtx, getToday, inboxOut, loadEvents, loadTasks, noteOut, projectOut, search, settingsOut, countInbox } from './data';
import type { DB, Row } from './db';
import { HttpError, Kind, convertInbox, deleteAccount, discardInbox, exportAll, moveTasks, softDelete, syncReminders, upsertEvent, upsertNote, upsertProject, upsertTask } from './mutate';
import { Tg, TgError } from './tg';
import { nowIso } from './time';
import { ensureUser } from './users';

declare module 'fastify' { interface FastifyRequest { c: Ctx } }

export interface AppDeps { cfg: Config; db: DB; tg: Tg; bot?: Bot; logger?: boolean }

const uuid = (v: unknown) => z.string().uuid().parse(v);
const CSP = "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors https://*.telegram.org; base-uri 'none'; form-action 'none'";

export async function buildApp({ cfg, db, tg, bot, logger = true }: AppDeps) {
  const app = Fastify({
    trustProxy: true,
    logger: logger ? { level: cfg.LOG_LEVEL, serializers: { req: (r) => ({ method: r.method, url: r.url.split('?')[0] }) } } : false, // без текстов запросов
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.headers({ 'strict-transport-security': 'max-age=31536000; includeSubDomains', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': CSP });
  });
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'validation', message: 'Некорректные данные' } });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: { code: 'bad_request', message: 'Некорректный запрос' } });
    req.log.error({ err: err.message }, 'unhandled');
    return reply.code(500).send({ error: { code: 'internal', message: 'Что-то пошло не так. Попробуйте ещё раз.' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Не найдено' } }));
  app.get('/healthz', async () => ({ ok: true }));
  if (bot) {
    const handle = webhookCallback(bot, 'fastify', { secretToken: cfg.WEBHOOK_SECRET });
    app.post(`/bot/${cfg.WEBHOOK_SECRET}`, async (req, reply) => {
      if (req.headers['x-telegram-bot-api-secret-token'] !== cfg.WEBHOOK_SECRET) return reply.code(401).send({ error: { code: 'unauthorized', message: 'Unauthorized' } });
      return handle(req, reply);
    });
  }

  // ---------- Авторизация и ограничение частоты ----------
  const hits = new Map<number, { n: number; reset: number }>();
  const limited = (id: number) => {
    const now = Date.now();
    if (hits.size > 1000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    const h = hits.get(id);
    if (!h || h.reset < now) { hits.set(id, { n: 1, reset: now + 60_000 }); return false; }
    return ++h.n > 60;
  };
  const auth = async (req: FastifyRequest) => {
    const h = req.headers.authorization ?? '';
    let user;
    try {
      if (!h.startsWith('tma ')) throw new Error('no header');
      user = verifyInitData(h.slice(4), cfg.BOT_TOKEN);
    } catch { throw new HttpError(401, 'unauthorized', 'Откройте приложение из Telegram'); }
    if (!cfg.ALLOWED_TELEGRAM_IDS.includes(user.id)) throw new HttpError(403, 'forbidden', 'Доступ закрыт');
    if (limited(user.id)) throw new HttpError(429, 'rate_limited', 'Слишком много запросов. Подождите минуту.');
    const tzHeader = String(req.headers['x-timezone'] ?? '');
    ensureUser(db, user, isTz(tzHeader) ? tzHeader : cfg.DEFAULT_TZ);
    req.c = getCtx(db, user.id);
  };

  await app.register(async (api) => {
    api.addHook('onRequest', auth);

    api.get('/bootstrap', async (req): Promise<Bootstrap> => {
      const u = db.prepare('SELECT telegram_id, first_name, username FROM users WHERE telegram_id = ?').get(req.c.userId) as Row;
      return { user: { id: u.telegram_id, first_name: u.first_name, username: u.username }, settings: settingsOut(req.c.s), categories: categoriesOf(req.c) };
    });
    api.get('/today', async (req) => getToday(req.c));
    api.get('/calendar', async (req) => {
      const q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
      return getCalendar(req.c, q.from, q.to);
    });
    api.get('/search', async (req) => {
      const q = z.object({ q: z.string().max(200), category: z.string().uuid().optional() }).parse(req.query);
      return search(req.c, q.q, q.category);
    });

    // --- CRUD: POST (создание с клиентским id, повтор не создаёт дубль), PUT (создать или обновить), PATCH, DELETE (мягкое) ---
    const crud = (name: string, kind: Kind, upsert: (c: Ctx, id: string, b: unknown, m: 'put' | 'patch' | 'post') => unknown, one: (c: Ctx, id: string) => unknown) => {
      const body = (r: FastifyRequest) => (r.body && typeof r.body === 'object' ? (r.body as Record<string, unknown>) : {});
      api.post(`/${name}`, async (req, reply) => { const { id, ...rest } = body(req); reply.code(201); return upsert(req.c, uuid(id), rest, 'post'); });
      api.put(`/${name}/:id`, async (req) => upsert(req.c, uuid((req.params as Row).id), body(req), 'put'));
      api.patch(`/${name}/:id`, async (req) => upsert(req.c, uuid((req.params as Row).id), body(req), 'patch'));
      api.delete(`/${name}/:id`, async (req) => { softDelete(req.c, kind, uuid((req.params as Row).id)); return { ok: true }; });
      api.post(`/${name}/:id/restore`, async (req) => { const id = uuid((req.params as Row).id); softDelete(req.c, kind, id, true); return one(req.c, id); });
      api.get(`/${name}/:id`, async (req) => one(req.c, uuid((req.params as Row).id)) ?? Promise.reject(new HttpError(404, 'not_found', 'Не найдено')));
    };
    const since = (r: FastifyRequest) => z.object({ updated_since: z.string().optional() }).parse(r.query).updated_since;

    crud('tasks', 'task', upsertTask, (c, id) => loadTasks(c, 'AND id = ? AND deleted_at IS NULL', [id])[0]);
    api.get('/tasks', async (req) => {
      const { scope } = z.object({ scope: z.enum(['open', 'done']).default('open') }).parse(req.query);
      const s = since(req);
      if (s) return loadTasks(req.c, 'AND updated_at > ? ORDER BY updated_at', [s]); // включая мягко удалённые (для будущей синхронизации)
      return scope === 'done'
        ? loadTasks(req.c, `AND deleted_at IS NULL AND status = 'done' AND completed_at >= ? ORDER BY completed_at DESC`, [doneCutoff(req.c)])
        : loadTasks(req.c, `AND deleted_at IS NULL AND status = 'open' ORDER BY due_at IS NULL, due_at, position`);
    });
    api.post('/tasks/move', async (req) => { const b = MoveIn.parse(req.body); return { moved: moveTasks(req.c, b.from, b.to) }; });

    crud('events', 'event', upsertEvent, (c, id) => loadEvents(c, 'AND id = ? AND deleted_at IS NULL', [id])[0]);
    api.get('/events', async (req) => {
      const q = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query);
      const s = since(req);
      if (s) return loadEvents(req.c, 'AND updated_at > ? ORDER BY updated_at', [s]);
      return q.from && q.to ? eventsBetween(req.c, q.from, q.to) : loadEvents(req.c, 'AND deleted_at IS NULL ORDER BY starts_at');
    });

    const noteRow = (c: Ctx, id: string) => { const r = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, c.userId) as Row | undefined; return r && noteOut(r); };
    crud('notes', 'note', upsertNote, noteRow);
    api.get('/notes', async (req) => {
      const s = since(req);
      const rows = db.prepare(`SELECT * FROM notes WHERE user_id = ? ${s ? 'AND updated_at > ? ORDER BY updated_at' : 'AND deleted_at IS NULL ORDER BY pinned DESC, pinned_at DESC, updated_at DESC'}`).all(req.c.userId, ...(s ? [s] : [])) as Row[];
      return rows.map(noteOut);
    });

    crud('projects', 'project', upsertProject, (c, id) => { const r = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, c.userId) as Row | undefined; return r && projectOut(r); });
    api.get('/projects', async (req) => (db.prepare('SELECT * FROM projects WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at').all(req.c.userId) as Row[]).map(projectOut));

    api.get('/categories', async (req) => categoriesOf(req.c));
    api.patch('/categories/:id', async (req) => {
      const { color } = CategoryIn.parse(req.body);
      const r = db.prepare('UPDATE categories SET color = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(color, nowIso(), uuid((req.params as Row).id), req.c.userId);
      if (!r.changes) throw new HttpError(404, 'not_found', 'Не найдено');
      return categoriesOf(req.c);
    });

    // --- Входящие ---
    api.get('/inbox', async (req) =>
      (db.prepare('SELECT * FROM inbox_items WHERE user_id = ? AND processed_at IS NULL ORDER BY created_at DESC').all(req.c.userId) as Row[]).map(inboxOut));
    api.post('/inbox/:id/convert', async (req) => {
      const b = ConvertIn.parse(req.body);
      return convertInbox(req.c, uuid((req.params as Row).id), b.to, b.id, b.data);
    });
    api.delete('/inbox/:id', async (req) => { discardInbox(req.c, uuid((req.params as Row).id)); return { ok: true }; });
    api.post('/inbox/:id/show', async (req) => {
      const r = db.prepare('SELECT attachments FROM inbox_items WHERE id = ? AND user_id = ?').get(uuid((req.params as Row).id), req.c.userId) as Row | undefined;
      if (!r) throw new HttpError(404, 'not_found', 'Запись не найдена');
      try { for (const a of JSON.parse(r.attachments)) await tg.sendAttachment(req.c.userId, a); } catch (e) {
        if (e instanceof TgError) throw new HttpError(502, 'telegram', 'Не удалось отправить вложение в чат');
        throw e;
      }
      return { ok: true };
    });

    // --- Настройки, экспорт, удаление данных ---
    api.get('/settings', async (req) => settingsOut(req.c.s));
    api.patch('/settings', async (req) => {
      const b = SettingsIn.parse(req.body) as Record<string, unknown>;
      const keys = Object.keys(b);
      if (keys.length) db.prepare(`UPDATE settings SET ${keys.map((k) => `${k} = @${k}`).join()} WHERE user_id = @uid`)
        .run({ ...Object.fromEntries(keys.map((k) => [k, typeof b[k] === 'boolean' ? +(b[k] as boolean) : b[k]])), uid: req.c.userId });
      const c = getCtx(db, req.c.userId);
      if ('timezone' in b || 'date_only_reminder_time' in b) { // напоминания «без времени» привязаны к местному времени
        const tasks = db.prepare(`SELECT id FROM tasks WHERE user_id = ? AND deleted_at IS NULL AND status = 'open' AND due_at IS NOT NULL AND due_has_time = 0`).all(c.userId) as Row[];
        const events = db.prepare(`SELECT id FROM events WHERE user_id = ? AND deleted_at IS NULL AND all_day = 1`).all(c.userId) as Row[];
        db.transaction(() => { tasks.forEach((t) => syncReminders(c, 'task', t.id)); events.forEach((e) => syncReminders(c, 'event', e.id)); })();
      }
      return settingsOut(c.s);
    });
    api.post('/export', async (req) => {
      await tg.sendFile(req.c.userId, 'planb-export.json', Buffer.from(JSON.stringify(exportAll(req.c), null, 2))).catch(() => { throw new HttpError(502, 'telegram', 'Не удалось отправить файл в чат'); });
      return { ok: true };
    });
    api.delete('/me', async (req) => { deleteAccount(req.c); return { ok: true }; });
    api.get('/inbox/count', async (req) => ({ count: countInbox(req.c) }));
  }, { prefix: '/api/v1' });

  const webDir = resolve(cfg.WEB_DIR);
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, {
      root: webDir,
      setHeaders: (res, path) => res.setHeader('cache-control', path.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable'),
    });
  }
  return app;
}

