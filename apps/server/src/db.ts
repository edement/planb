import Database from 'better-sqlite3';

export type DB = Database.Database;
export type Row = Record<string, any>;

const COMMON = `created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT`;

// Версионные миграции: порядок менять нельзя, только добавлять в конец.
const MIGRATIONS: string[] = [`
CREATE TABLE users (telegram_id INTEGER PRIMARY KEY, first_name TEXT, username TEXT, language_code TEXT,
  blocked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE settings (user_id INTEGER PRIMARY KEY, timezone TEXT NOT NULL, week_start INTEGER NOT NULL DEFAULT 1,
  morning_digest_enabled INTEGER NOT NULL DEFAULT 1, morning_digest_time TEXT NOT NULL DEFAULT '08:00',
  evening_digest_enabled INTEGER NOT NULL DEFAULT 1, evening_digest_time TEXT NOT NULL DEFAULT '21:00',
  quiet_hours_start TEXT NOT NULL DEFAULT '23:00', quiet_hours_end TEXT NOT NULL DEFAULT '08:00',
  date_only_reminder_time TEXT NOT NULL DEFAULT '09:00', nag_enabled_default INTEGER NOT NULL DEFAULT 1,
  nag_interval_min INTEGER NOT NULL DEFAULT 30, nag_max_count INTEGER NOT NULL DEFAULT 3,
  skip_empty_digest INTEGER NOT NULL DEFAULT 1);
CREATE TABLE categories (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL,
  color TEXT NOT NULL, is_system INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (user_id, slug));
CREATE TABLE projects (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, archived_at TEXT, ${COMMON});
CREATE INDEX projects_user ON projects (user_id, deleted_at);
CREATE TABLE tasks (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT,
  category_id TEXT NOT NULL, project_id TEXT, due_at TEXT, due_has_time INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open', completed_at TEXT, position REAL NOT NULL DEFAULT 0, nag_enabled INTEGER,
  rrule TEXT, source TEXT NOT NULL DEFAULT 'app', external_id TEXT, ${COMMON});
CREATE INDEX tasks_due ON tasks (user_id, deleted_at, due_at);
CREATE INDEX tasks_project ON tasks (project_id);
CREATE INDEX tasks_category ON tasks (category_id);
CREATE INDEX tasks_updated ON tasks (user_id, updated_at);
CREATE TABLE checklist_items (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, user_id INTEGER NOT NULL,
  title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0);
CREATE INDEX checklist_task ON checklist_items (task_id);
CREATE TABLE events (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, location TEXT,
  category_id TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT, all_day INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL, rrule TEXT, source TEXT NOT NULL DEFAULT 'app', external_id TEXT, ${COMMON});
CREATE INDEX events_start ON events (user_id, starts_at);
CREATE INDEX events_category ON events (category_id);
CREATE TABLE notes (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT, body TEXT NOT NULL DEFAULT '',
  category_id TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, pinned_at TEXT, source TEXT NOT NULL DEFAULT 'app',
  external_id TEXT, ${COMMON});
CREATE INDEX notes_user ON notes (user_id, deleted_at, pinned, updated_at);
CREATE INDEX notes_category ON notes (category_id);
CREATE TABLE inbox_items (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '',
  forward_origin TEXT, urls TEXT NOT NULL DEFAULT '[]', attachments TEXT NOT NULL DEFAULT '[]',
  media_group_id TEXT, tg_message_id INTEGER, processed_at TEXT, result_type TEXT, result_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX inbox_user ON inbox_items (user_id, processed_at, created_at);
CREATE TABLE reminders (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  offset_minutes INTEGER, remind_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  sent_count INTEGER NOT NULL DEFAULT 0, next_nag_at TEXT, last_message_id INTEGER, created_at TEXT NOT NULL);
CREATE INDEX reminders_due ON reminders (status, remind_at);
CREATE INDEX reminders_nag ON reminders (status, next_nag_at);
CREATE INDEX reminders_entity ON reminders (entity_type, entity_id);
CREATE TABLE digest_log (user_id INTEGER NOT NULL, kind TEXT NOT NULL, date TEXT NOT NULL, sent_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, date));
CREATE VIRTUAL TABLE search USING fts5(type UNINDEXED, id UNINDEXED, user_id UNINDEXED, category_id UNINDEXED,
  flag UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
`];

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  const v = db.pragma('user_version', { simple: true }) as number;
  MIGRATIONS.slice(v).forEach((sql, i) => db.transaction(() => { db.exec(sql); db.pragma(`user_version = ${v + i + 1}`); })());
  return db;
}

// ---------- Полнотекстовый поиск (FTS5, префиксный, регистронезависимый) ----------
const SRC: Record<string, string> = {
  task: `SELECT id, user_id, category_id, title, status = 'done' AS flag, deleted_at,
    trim(coalesce(description,'') || ' ' || coalesce((SELECT group_concat(title, ' ') FROM checklist_items c WHERE c.task_id = t.id), '')) AS body
    FROM tasks t WHERE id = ?`,
  event: `SELECT id, user_id, category_id, title, 0 AS flag, deleted_at, trim(coalesce(description,'') || ' ' || coalesce(location,'')) AS body FROM events WHERE id = ?`,
  note: `SELECT id, user_id, category_id, coalesce(title,'') AS title, 0 AS flag, deleted_at, body FROM notes WHERE id = ?`,
  inbox: `SELECT id, user_id, NULL AS category_id, substr(text, 1, 120) AS title, processed_at IS NOT NULL AS flag, NULL AS deleted_at, text AS body FROM inbox_items WHERE id = ?`,
};

/** Пересобирает строку поиска для сущности (или удаляет, если запись удалена). */
export function reindex(db: DB, type: keyof typeof SRC, id: string) {
  db.prepare('DELETE FROM search WHERE type = ? AND id = ?').run(type, id);
  const r = db.prepare(SRC[type]).get(id) as Row | undefined;
  if (!r || r.deleted_at) return;
  db.prepare('INSERT INTO search (type, id, user_id, category_id, flag, title, body) VALUES (?,?,?,?,?,?,?)')
    .run(type, id, r.user_id, r.category_id, r.flag, r.title ?? '', r.body ?? '');
}

/** Безопасный MATCH-запрос: только буквы/цифры, каждый токен в кавычках с префиксом. */
export const ftsQuery = (q: string) => (q.match(/[\p{L}\p{N}]+/gu) ?? []).map((t) => `"${t}"*`).join(' ');
