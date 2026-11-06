import { z } from 'zod';
import { isTz } from '@planb/shared';

const Env = z.object({
  BOT_TOKEN: z.string().min(10),
  // Используется и как секретный путь вебхука, и как secret_token Telegram (A-Z a-z 0-9 _ -).
  WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
  WEBAPP_URL: z.string().url().transform((s) => s.replace(/\/+$/, '')),
  ALLOWED_TELEGRAM_IDS: z.string().transform((s) => s.split(',').map((x) => Number(x.trim())).filter(Boolean))
    .pipe(z.array(z.number().int().positive()).min(1)),
  DATABASE_URL: z.string().default('./data/planb.db'),
  DEFAULT_TZ: z.string().refine(isTz).default('Europe/Moscow'),
  LOG_LEVEL: z.string().default('info'),
  PORT: z.coerce.number().default(3000),
  WEB_DIR: z.string().default('../web/dist'),
});
export type Config = z.infer<typeof Env>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => Env.parse(env);
