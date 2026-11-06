// Тонкий слой над Telegram: всё остальное приложение зависит только от интерфейса Tg (удобно для тестов).
import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy';
import type { Attachment } from '@planb/shared';
import type { Button, Msg } from './texts';

export class TgError extends Error {
  constructor(public code: number, public retryAfter?: number, message = 'telegram error') { super(message); }
}

export interface Tg {
  send(chat: number, m: Msg): Promise<number>;
  remove(chat: number, messageId: number): Promise<void>;
  sendFile(chat: number, name: string, data: Buffer): Promise<void>;
  sendAttachment(chat: number, a: Attachment): Promise<void>;
}

export function keyboard(rows: Button[][]): InlineKeyboard {
  const kb = new InlineKeyboard();
  rows.forEach((row, i) => {
    row.forEach((b) => (b.web ? kb.webApp(b.text, b.web) : kb.text(b.text, b.cb!)));
    if (i < rows.length - 1) kb.row();
  });
  return kb;
}

const wrap = async <T>(p: Promise<T>): Promise<T> => {
  try { return await p; } catch (e) {
    if (e instanceof GrammyError) throw new TgError(e.error_code, e.parameters?.retry_after, e.description);
    throw new TgError(0, undefined, (e as Error).message); // сеть и прочее: считается временным сбоем
  }
};

export function grammyTg(bot: Bot): Tg {
  const api = bot.api;
  return {
    send: async (chat, m) => (await wrap(api.sendMessage(chat, m.text, { parse_mode: 'HTML', reply_markup: keyboard(m.buttons), link_preview_options: { is_disabled: true } }))).message_id,
    remove: async (chat, id) => { await wrap(api.deleteMessage(chat, id)); },
    sendFile: async (chat, name, data) => { await wrap(api.sendDocument(chat, new InputFile(data, name))); },
    sendAttachment: async (chat, a) => {
      const send = ({ photo: api.sendPhoto, voice: api.sendVoice, video: api.sendVideo, audio: api.sendAudio, video_note: api.sendVideoNote } as Record<string, Function>)[a.type] ?? api.sendDocument;
      await wrap(send.call(api, chat, a.file_id, a.type === 'video_note' ? {} : { caption: a.caption }));
    },
  };
}
