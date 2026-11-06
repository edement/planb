import { randomUUID } from 'node:crypto';
import type { DB } from './db';
import { nowIso } from './time';

const CATEGORIES: [string, string, string][] = [['study', 'Учёба', '#4F7DF3'], ['work', 'Работа', '#E39A2D'], ['misc', 'Разное', '#4CAF8E']];

/** Создаёт User, Settings и три системные категории при первом входе. */
export function ensureUser(db: DB, u: { id: number; first_name?: string; username?: string; language_code?: string }, tz: string) {
  if (db.prepare('SELECT 1 FROM users WHERE telegram_id = ?').get(u.id)) return;
  const now = nowIso();
  db.transaction(() => {
    db.prepare('INSERT INTO users (telegram_id, first_name, username, language_code, created_at) VALUES (?,?,?,?,?)')
      .run(u.id, u.first_name ?? null, u.username ?? null, u.language_code ?? null, now);
    db.prepare('INSERT INTO settings (user_id, timezone) VALUES (?, ?)').run(u.id, tz);
    for (const [slug, name, color] of CATEGORIES)
      db.prepare('INSERT INTO categories (id, user_id, slug, name, color, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), u.id, slug, name, color, now, now);
  })();
}
