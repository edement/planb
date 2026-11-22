import { randomUUID } from 'node:crypto';
import { Bot, InlineKeyboard } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Attachment } from '@planb/shared';
import type { Config } from './config';
import { getCtx, getToday } from './data';
import { DB, Row, reindex } from './db';
import { completeTask, moveTasks } from './mutate';
import { Tg, keyboard } from './tg';
import { Button, esc, morningDigest, openUrl, snoozeButtons, tasksWord } from './texts';
import { hhmm, nextOccurrence, nowIso, todayKey, whenLabel } from './time';
import { ensureUser } from './users';

const originOf = (o: any): string | null => {
  if (!o) return null;
  if (o.type === 'user') return [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ');
  if (o.type === 'hidden_user') return o.sender_user_name;
  return o.sender_chat?.title ?? o.chat?.title ?? null;
};

const attachmentOf = (m: any): Attachment | null => {
  if (m.photo?.length) return { type: 'photo', file_id: m.photo[m.photo.length - 1].file_id, caption: m.caption };
  for (const t of ['document', 'voice', 'audio', 'video', 'video_note'])
    if (m[t]) return { type: t, file_id: m[t].file_id, caption: m.caption };
  return null;
};

export function createBot(cfg: Config, db: DB, log: { error(o: object, m?: string): void }): Bot {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const bot = new Bot(cfg.BOT_TOKEN, proxy ? {client: {baseFetchConfig: {agent: new HttpsProxyAgent(proxy)}}} : {});
  const open = (target: string, label = 'Открыть'): InlineKeyboard => keyboard([[{ text: label, web: openUrl(cfg.WEBAPP_URL, target) }]]);

  bot.catch((e) => log.error({ err: String(e.error) }, 'bot error'));

  // Только личные чаты и только пользователи из whitelist.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return;
    const id = ctx.from?.id;
    if (!id || !cfg.ALLOWED_TELEGRAM_IDS.includes(id)) {
      if (ctx.message) await ctx.reply('Это личный бот, доступ закрыт. Спасибо за интерес!');
      else if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      return;
    }
    ensureUser(db, ctx.from!, cfg.DEFAULT_TZ);
    db.prepare('UPDATE users SET blocked = 0 WHERE telegram_id = ? AND blocked = 1').run(id); // раз пишет — бот не заблокирован
    await next();
  });

  bot.command('start', (ctx) => ctx.reply('Привет! Я PlanB — задачи, события и заметки в одном месте.\n\nПросто пришлите мне любое сообщение или перешлите чужое — оно попадёт во «Входящие».', { reply_markup: open('today') }));
  bot.command('help', (ctx) => ctx.reply('Любое сообщение или пересылка → «Входящие».\n/today — сводка на сегодня\n/inbox — неразобранное\n/settings — настройки', { reply_markup: open('today') }));
  bot.command('settings', (ctx) => ctx.reply('Настройки приложения:', { reply_markup: open('settings', 'Открыть настройки') }));
  bot.command('today', async (ctx) => {
    const m = morningDigest(getToday(getCtx(db, ctx.from!.id)), cfg.WEBAPP_URL);
    if (!m) return void (await ctx.reply('На сегодня всё.', { reply_markup: open('today') }));
    await ctx.reply(m.text, { parse_mode: 'HTML', reply_markup: keyboard(m.buttons), link_preview_options: { is_disabled: true } });
  });
  bot.command('inbox', async (ctx) => {
    const rows = db.prepare('SELECT text, attachments FROM inbox_items WHERE user_id = ? AND processed_at IS NULL ORDER BY created_at DESC LIMIT 10').all(ctx.from!.id) as Row[];
    if (!rows.length) return void (await ctx.reply('Во «Входящих» пусто.', { reply_markup: open('inbox') }));
    const line = (r: Row) => `• ${esc((r.text.split('\n')[0] || 'Вложение').slice(0, 80))}`;
    await ctx.reply(`<b>Входящие</b>\n${rows.map(line).join('\n')}`, { parse_mode: 'HTML', reply_markup: open('inbox') });
  });

  // ---------- Любое другое сообщение → «Входящие» ----------
  bot.on(['message', 'edited_message'], async (ctx) => {
    const m = ctx.msg as any;
    const uid = ctx.from!.id;
    const text: string = m.text ?? m.caption ?? '';
    const att = attachmentOf(m);
    if (!text && !att) return void (await ctx.reply('Пока умею сохранять текст, ссылки, фото, файлы и голосовые.'));
    const urls = (m.entities ?? m.caption_entities ?? []).flatMap((e: any) =>
      e.type === 'url' ? [text.slice(e.offset, e.offset + e.length)] : e.type === 'text_link' ? [e.url] : []);
    const now = nowIso();
    const react = async (quiet = false) => { try { await ctx.react('✍'); } catch { if (!quiet) await ctx.reply('Записал'); } };

    if (ctx.editedMessage) { // правка обновляет запись, пока она не разобрана
      const r = db.prepare('SELECT id FROM inbox_items WHERE user_id = ? AND tg_message_id = ? AND processed_at IS NULL').get(uid, m.message_id) as Row | undefined;
      if (r) { db.prepare('UPDATE inbox_items SET text = ?, urls = ?, updated_at = ? WHERE id = ?').run(text, JSON.stringify(urls), now, r.id); reindex(db, 'inbox', r.id); }
      return;
    }
    if (m.media_group_id) { // части альбома объединяются в одну запись
      const g = db.prepare('SELECT * FROM inbox_items WHERE user_id = ? AND media_group_id = ?').get(uid, m.media_group_id) as Row | undefined;
      if (g) {
        const list: Attachment[] = JSON.parse(g.attachments);
        if (att) list.push(att);
        db.prepare('UPDATE inbox_items SET attachments = ?, text = ?, urls = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(list), g.text || text, JSON.stringify([...new Set([...JSON.parse(g.urls), ...urls])]), now, g.id);
        reindex(db, 'inbox', g.id);
        return void (await react(true));
      }
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO inbox_items (id, user_id, text, forward_origin, urls, attachments, media_group_id, tg_message_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, uid, text, originOf(m.forward_origin), JSON.stringify(urls), JSON.stringify(att ? [att] : []), m.media_group_id ?? null, m.message_id, now, now);
    reindex(db, 'inbox', id);
    await react();
  });

  // ---------- Inline-кнопки (идемпотентны: после нажатия сообщение редактируется и кнопки исчезают) ----------
  bot.on('callback_query:data', async (ctx) => {
    const [kind, a, b] = ctx.callbackQuery.data.split(':');
    const uid = ctx.from.id;
    const c = getCtx(db, uid);
    const answer = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {});
    const edit = (text: string, rows: Button[][] = []) => ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard(rows) }).catch(() => {});

    if (kind === 't') { // «Всё на завтра» из вечерней сводки
      const n = moveTasks(c, 'today', 'tomorrow');
      if (n) await edit(`Перенесено ${tasksWord(n)}`);
      return void (await answer());
    }
    const r = db.prepare('SELECT * FROM reminders WHERE id = ? AND user_id = ?').get(a, uid) as Row | undefined;
    if (!r) return void (await answer('Уже неактуально'));
    const title = (db.prepare(`SELECT title FROM ${r.entity_type === 'task' ? 'tasks' : 'events'} WHERE id = ?`).get(r.entity_id) as Row | undefined)?.title ?? '';

    if (kind === 'd') {
      if (r.entity_type === 'task') completeTask(c, r.entity_id);
      await edit(`✅ Выполнено: <b>${esc(title)}</b>`);
    } else if (kind === 'z') {
      await ctx.editMessageReplyMarkup({ reply_markup: keyboard(snoozeButtons(r.id, cfg.WEBAPP_URL, `${r.entity_type}_${r.entity_id}`)) }).catch(() => {});
    } else if (kind === 's') {
      const now = new Date();
      const until = b === '1h' ? new Date(now.getTime() + 3600_000) : nextOccurrence(now, c.tz, b === 'ev' ? c.s.evening_digest_time : c.s.morning_digest_time);
      db.prepare(`UPDATE reminders SET status = 'pending', remind_at = ?, sent_count = 0, next_nag_at = NULL WHERE id = ?`).run(nowIso(until), r.id);
      const day = todayKey(until, c.tz), label = day === todayKey(now, c.tz) ? hhmm(until, c.tz) : whenLabel(day, hhmm(until, c.tz), todayKey(now, c.tz));
      await edit(`⏰ Отложено до ${label}\n<b>${esc(title)}</b>`);
    }
    await answer();
  });

  return bot;
}

export async function setupTelegram(bot: Bot, cfg: Config) {
  await bot.api.setWebhook(`${cfg.WEBAPP_URL}/bot/${cfg.WEBHOOK_SECRET}`, { secret_token: cfg.WEBHOOK_SECRET, allowed_updates: ['message', 'edited_message', 'callback_query'] });
  await bot.api.setMyCommands([
    { command: 'today', description: 'Сводка на сегодня' }, { command: 'inbox', description: 'Неразобранные входящие' },
    { command: 'settings', description: 'Настройки' }, { command: 'help', description: 'Помощь' },
  ]);
  await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Открыть', web_app: { url: cfg.WEBAPP_URL } } });
}

