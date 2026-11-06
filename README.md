# PlanB — личный планер в Telegram (Mini App)

Задачи, события, заметки и «Входящие» в одном месте. Мини-приложение внутри Telegram + бот: напоминания, настойчивые повторы, утренняя и вечерняя сводки, сохранение любых сообщений во «Входящие».

**Стек:** TypeScript · Node 22 · Fastify · grammY · SQLite (better-sqlite3, FTS5) · React + Vite + TanStack Query · Docker Compose + Caddy (HTTPS).
Один контейнер приложения (API + бот + планировщик + статика), одна база-файл.

```
apps/server     API, бот (webhook), планировщик, SQLite
apps/web        Mini App (React)
packages/shared схемы валидации (zod) и общие типы
scripts/        бэкап
DECISIONS.md    принятые решения и отличия от ТЗ — прочитайте
```

## Быстрый деплой (VPS с Docker)

Нужны: сервер с Docker, домен с A-записью на сервер, порты 80 и 443 открыты.

1. **Бот.** В [@BotFather](https://t.me/BotFather): `/newbot` → сохраните токен. Дополнительно ничего настраивать не нужно: кнопку меню, команды и webhook приложение выставит само при старте.
2. **Свой Telegram ID** — у бота [@userinfobot](https://t.me/userinfobot).
3. ```bash
   git clone <ваш-репозиторий> planb && cd planb
   cp .env.example .env
   nano .env            # BOT_TOKEN, WEBHOOK_SECRET (openssl rand -hex 24), DOMAIN, WEBAPP_URL, ALLOWED_TELEGRAM_IDS
   docker compose up -d --build
   docker compose logs -f app     # ждём «webhook set»
   ```
4. Откройте бота, нажмите `/start` → «Открыть».

**Обновление:** `git pull && docker compose up -d --build` (миграции БД применяются автоматически при старте).

> ⚠️ Сервер должен иметь доступ к `api.telegram.org`. Если хостинг в РФ и доступ нестабилен — берите VPS за пределами РФ. Если Telegram недоступен при старте, приложение будет пытаться поставить webhook каждые 30 секунд (до 20 раз).

## Проверка после деплоя (чек-лист в Telegram)

Автотесты проверяют логику, но сам Telegram можно проверить только вручную:

- [ ] Бот отвечает на `/start`, кнопка «Открыть» запускает приложение, видно «Вы вошли как …» (Настройки)
- [ ] С чужого аккаунта бот вежливо отказывает, приложение показывает «Доступ закрыт»
- [ ] Задача с временем «через 2 минуты» → пришло сообщение с кнопками «Выполнено / Отложить / Открыть»
- [ ] «Отложить → Через час» меняет сообщение на «Отложено до …»; «Выполнено» — на «✅ Выполнено»
- [ ] Не отметили выполненной — через 30 минут пришёл повтор (🔁), старое сообщение удалилось
- [ ] Любое сообщение/пересылка боту → реакция ✍ и запись во «Входящих»
- [ ] Светлая и тёмная тема, поворот экрана, iOS и Android, Telegram Desktop
- [ ] Время сводок поставить на ближайшие минуты и убедиться, что пришли

## Локальная разработка

```bash
pnpm install
pnpm test            # 67 тестов: время/часовые пояса, initData, API, планировщик, сводки
pnpm typecheck
pnpm build
```

Telegram открывает Mini App только по HTTPS, поэтому для ручной проверки нужен туннель (cloudflared / ngrok):

```bash
cp .env.example .env        # WEBAPP_URL = https-адрес туннеля, DOMAIN не нужен
pnpm dev:server             # порт 3000 (читает .env)
pnpm dev:web                # порт 5173, проксирует /api и /bot на 3000
# туннель направьте на порт 5173 (с горячей перезагрузкой) или на 3000 после `pnpm build`
```

## Бэкапы

Данные — один SQLite-файл в docker-томе `planb-data`. `scripts/backup.sh` делает консистентную копию, шифрует (GPG, AES-256), выгружает через `rclone` во внешнее хранилище и хранит последние 14 копий:

```bash
echo 'длинный-пароль' > ~/.planb-backup-pass && chmod 600 ~/.planb-backup-pass
rclone config                                   # настроить внешнее хранилище
# cron (ежедневно в 04:00):
0 4 * * * BACKUP_PASSPHRASE_FILE=$HOME/.planb-backup-pass RCLONE_REMOTE=myremote:planb-backups /opt/planb/scripts/backup.sh
```

**Восстановление:**
```bash
gpg -d planb-YYYYMMDD-HHMMSS.db.gpg > planb.db
docker compose stop app
docker compose cp planb.db app:/data/planb.db     # затем: docker compose run --rm --no-deps -u root app rm -f /data/planb.db-wal /data/planb.db-shm
docker compose start app
```
**Обязательно один раз проверьте восстановление** на тестовой копии, прежде чем на него полагаться.

## Безопасность (что сделано)

- Каждый запрос проверяется по подписи Telegram `initData` (HMAC-SHA256, не старше 24 ч); доступ только для ID из `ALLOWED_TELEGRAM_IDS`; чужим бот отвечает вежливым отказом и ничего не сохраняет.
- Все запросы к БД параметризованы и фильтруются по владельцу; вход валидируется zod-схемами; поисковый запрос превращается в безопасный FTS-запрос.
- Webhook защищён секретным путём **и** заголовком `X-Telegram-Bot-Api-Secret-Token`.
- Лимит 60 запросов/мин на пользователя; CSP, HSTS, `nosniff`, `no-referrer`; CORS выключен (приложение и API на одном домене); `frame-ancestors` — только Telegram.
- Тексты записей не попадают в логи (URL в логах без query-строки, заголовок авторизации не логируется). Секреты — только в `.env` (в `.gitignore`).
- В интерфейсе: экспорт всех данных в чат с ботом и полное удаление аккаунта.
- Пользовательский текст в сообщениях бота экранируется (HTML parse mode).

Рекомендации хозяину сервера: SSH только по ключам, `ufw allow 22,80,443`, `unattended-upgrades`, шифрование диска у хостера.
