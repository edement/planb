import { randomUUID } from 'node:crypto';
import { buildApp } from './app';
import { signInitData } from './auth';
import type { Config } from './config';
import { openDb } from './db';
import type { Deps } from './scheduler';
import { newState } from './scheduler';
import { Tg, TgError } from './tg';
import type { Msg } from './texts';

export const TOKEN = '123456:TEST-TOKEN';
export const cfg: Config = {
  BOT_TOKEN: TOKEN, WEBHOOK_SECRET: 'x'.repeat(24), WEBAPP_URL: 'https://app.test', ALLOWED_TELEGRAM_IDS: [42, 43],
  DATABASE_URL: ':memory:', DEFAULT_TZ: 'Europe/Moscow', LOG_LEVEL: 'silent', PORT: 0, WEB_DIR: '/nonexistent',
};

export class FakeTg implements Tg {
  sent: { chat: number; m: Msg; id: number }[] = [];
  removed: number[] = [];
  failWith: TgError | null = null;
  private n = 100;
  async send(chat: number, m: Msg) { if (this.failWith) throw this.failWith; const id = ++this.n; this.sent.push({ chat, m, id }); return id; }
  async remove(_c: number, id: number) { this.removed.push(id); }
  async sendFile() {}
  async sendAttachment() {}
}

export const auth = (id = 42, token = TOKEN) =>
  'tma ' + signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: 'Тест' }) }, token);

export async function setup() {
  const db = openDb(':memory:');
  const tg = new FakeTg();
  const app = await buildApp({ cfg, db, tg, logger: false });
  const call = async (method: string, url: string, body?: unknown, as = 42) => {
    const res = await app.inject({ method: method as 'GET', url: '/api/v1' + url, headers: { authorization: auth(as), 'x-timezone': 'Europe/Moscow' }, payload: body as object });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const deps: Deps = { db, tg, webapp: cfg.WEBAPP_URL, log: { info() {}, warn() {}, error() {} }, state: newState() };
  return { app, db, tg, call, deps };
}
export const uid = () => randomUUID();
