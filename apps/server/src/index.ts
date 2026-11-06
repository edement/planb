import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildApp } from './app';
import { createBot, setupTelegram } from './bot';
import { loadConfig } from './config';
import { openDb } from './db';
import { newState, startScheduler } from './scheduler';
import { grammyTg } from './tg';

const cfg = loadConfig();
mkdirSync(dirname(cfg.DATABASE_URL), { recursive: true });
const db = openDb(cfg.DATABASE_URL);

const logRef = { current: console as unknown as { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void } };
const bot = createBot(cfg, db, { error: (o, m) => logRef.current.error(o, m) });
const tg = grammyTg(bot);
const app = await buildApp({ cfg, db, tg, bot });
logRef.current = app.log;

const stop = startScheduler({ db, tg, webapp: cfg.WEBAPP_URL, log: app.log, state: newState() });
await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
// Вебхук ставится с повторами: если Telegram временно недоступен, сервер не остаётся «глухим».
const connect = (attempt = 1) => setupTelegram(bot, cfg).then(
  () => app.log.info('webhook set'),
  (e) => { app.log.error({ err: String(e), attempt }, 'webhook setup failed'); if (attempt < 20) setTimeout(() => connect(attempt + 1), 30_000); },
);
void connect();

const shutdown = async () => { stop(); await app.close(); db.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
