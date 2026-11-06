import { beforeEach, describe, expect, it } from 'vitest';
import { auth, setup, uid } from './testutil';

let t: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { t = await setup(); });

describe('доступ', () => {
  it('без заголовка и с поддельным initData → 401', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/today' })).statusCode).toBe(401);
    const bad = (await t.app.inject({ method: 'GET', url: '/api/v1/today', headers: { authorization: auth(42, '1:OTHER-TOKEN') } })).statusCode;
    expect(bad).toBe(401);
  });
  it('ID вне whitelist → 403', async () => expect((await t.call('GET', '/today', undefined, 777)).status).toBe(403));
  it('первый вход создаёт пользователя, настройки и три категории', async () => {
    const r = await t.call('GET', '/bootstrap');
    expect(r.status).toBe(200);
    expect(r.body.categories.map((c: any) => c.name)).toEqual(['Учёба', 'Работа', 'Разное']);
    expect(r.body.settings.timezone).toBe('Europe/Moscow');
    expect(r.body.user.first_name).toBe('Тест');
  });
  it('данные пользователей изолированы', async () => {
    const id = uid();
    await t.call('POST', '/tasks', { id, title: 'Секрет' }, 42);
    expect((await t.call('GET', `/tasks/${id}`, undefined, 43)).status).toBe(404);
    expect((await t.call('PATCH', `/tasks/${id}`, { title: 'x' }, 43)).status).toBe(404);
    expect((await t.call('GET', '/tasks', undefined, 43)).body).toEqual([]);
  });
});

describe('задачи', () => {
  it('повторная отправка того же id не создаёт дубль', async () => {
    const id = uid();
    await t.call('POST', '/tasks', { id, title: 'Купить молоко' });
    await t.call('POST', '/tasks', { id, title: 'Купить молоко' });
    expect((await t.call('GET', '/tasks')).body).toHaveLength(1);
  });
  it('достаточно одного названия; категория по умолчанию — «Разное»', async () => {
    const id = uid();
    const r = await t.call('POST', '/tasks', { id, title: 'Позвонить' });
    const cats = (await t.call('GET', '/categories')).body;
    expect(r.status).toBe(201);
    expect(r.body.category_id).toBe(cats.find((c: any) => c.slug === 'misc').id);
    expect((await t.call('POST', '/tasks', { id: uid(), title: '  ' })).status).toBe(400);
  });
  it('срок со временем автоматически даёт напоминание «в момент срока»', async () => {
    const r = await t.call('POST', '/tasks', { id: uid(), title: 'Встреча', due_date: '2035-05-05', due_time: '15:00' });
    expect(r.body.reminders).toEqual([0]);
    expect(r.body.due_time).toBe('15:00');
  });
  it('выполнение, отмена, мягкое удаление и восстановление', async () => {
    const id = uid();
    await t.call('POST', '/tasks', { id, title: 'Дело', due_date: '2035-05-05', due_time: '10:00' });
    await t.call('PATCH', `/tasks/${id}`, { status: 'done' });
    expect((await t.call('GET', '/tasks')).body).toHaveLength(0);
    expect((await t.call('GET', '/tasks?scope=done')).body).toHaveLength(1);
    await t.call('PATCH', `/tasks/${id}`, { status: 'open' });
    expect((await t.call('GET', `/tasks/${id}`)).body.reminders).toEqual([0]); // напоминание восстановилось
    await t.call('DELETE', `/tasks/${id}`);
    expect((await t.call('GET', '/tasks')).body).toHaveLength(0);
    expect((await t.call('GET', '/tasks?updated_since=2000-01-01T00:00:00Z')).body[0].deleted_at).toBeTruthy();
    expect((await t.call('POST', `/tasks/${id}/restore`)).status).toBe(200);
    expect((await t.call('GET', '/tasks')).body).toHaveLength(1);
  });
  it('чек-лист сохраняется и синхронизируется', async () => {
    const id = uid(), a = uid(), b = uid();
    await t.call('POST', '/tasks', { id, title: 'Поездка', checklist: [{ id: a, title: 'Билеты', done: true }, { id: b, title: 'Паспорт', done: false }] });
    let r = (await t.call('GET', `/tasks/${id}`)).body;
    expect(r.checklist.map((i: any) => i.title)).toEqual(['Билеты', 'Паспорт']);
    await t.call('PATCH', `/tasks/${id}`, { checklist: [{ id: b, title: 'Паспорт', done: true }] });
    r = (await t.call('GET', `/tasks/${id}`)).body;
    expect(r.checklist).toEqual([{ id: b, title: 'Паспорт', done: true }]);
  });
  it('«Сегодня»: просрочено, сегодня, завтра', async () => {
    const day = (await t.call('GET', '/today')).body.date as string;
    const shift = (n: number) => new Date(Date.parse(day) + n * 86400000).toISOString().slice(0, 10);
    await t.call('POST', '/tasks', { id: uid(), title: 'Старое', due_date: shift(-3) });
    await t.call('POST', '/tasks', { id: uid(), title: 'Сегодняшнее', due_date: day });
    await t.call('POST', '/tasks', { id: uid(), title: 'Завтрашнее', due_date: shift(1) });
    const r = (await t.call('GET', '/today')).body;
    expect(r.overdue.map((x: any) => x.title)).toEqual(['Старое']);
    expect(r.day.noTime.map((x: any) => x.title)).toEqual(['Сегодняшнее']);
    expect(r.tomorrow).toHaveLength(1);
    expect((await t.call('POST', '/tasks/move', { from: 'overdue', to: 'today' })).body.moved).toBe(1);
    expect((await t.call('GET', '/today')).body.overdue).toHaveLength(0);
  });
});

describe('события', () => {
  it('окончание раньше начала → 400; по умолчанию напоминание за 30 минут', async () => {
    const base = { start_date: '2035-05-05', start_time: '10:00' };
    expect((await t.call('POST', '/events', { id: uid(), title: 'Лекция', ...base, end_date: '2035-05-05', end_time: '09:00' })).status).toBe(400);
    const ok = await t.call('POST', '/events', { id: uid(), title: 'Лекция', ...base, end_time: '11:30' });
    expect(ok.body.reminders).toEqual([30]);
    expect(ok.body.end_time).toBe('11:30');
  });
  it('многодневное событие видно в каждом дне недели', async () => {
    await t.call('POST', '/events', { id: uid(), title: 'Конференция', all_day: true, start_date: '2035-05-05', end_date: '2035-05-07' });
    const r = (await t.call('GET', '/calendar?from=2035-05-04&to=2035-05-10')).body.days;
    expect(Object.entries(r).filter(([, v]: any) => v.events.length).map(([k]) => k)).toEqual(['2035-05-05', '2035-05-06', '2035-05-07']);
  });
});

describe('заметки, входящие, поиск', () => {
  it('пустая заметка не сохраняется; закрепление', async () => {
    expect((await t.call('PUT', `/notes/${uid()}`, { title: '', body: '  ' })).status).toBe(400);
    const id = uid();
    await t.call('PUT', `/notes/${id}`, { body: 'Идея' });
    await t.call('PATCH', `/notes/${id}`, { pinned: true });
    expect((await t.call('GET', '/today')).body.pinned).toHaveLength(1);
  });
  it('префиксный поиск: «долг» находит «долги» и «долгов» в задачах, заметках и входящих', async () => {
    await t.call('POST', '/tasks', { id: uid(), title: 'Вернуть долги' });
    await t.call('PUT', `/notes/${uid()}`, { body: 'Список долгов за квартиру' });
    const inbox = uid();
    t.db.prepare(`INSERT INTO inbox_items (id, user_id, text, created_at, updated_at) VALUES (?,?,?,?,?)`).run(inbox, 42, 'Напомнить про Долг', 'x', 'x');
    const { reindex } = await import('./db');
    reindex(t.db, 'inbox', inbox);
    const hits = (await t.call('GET', '/search?q=' + encodeURIComponent('долг'))).body;
    expect(hits.map((h: any) => h.type).sort()).toEqual(['inbox', 'note', 'task']);
    expect((await t.call('GET', '/search?q=д')).body).toEqual([]); // минимум два символа
  });
  it('поиск не ломается на спецсимволах и не отдаёт чужое', async () => {
    await t.call('POST', '/tasks', { id: uid(), title: 'Секретный пароль' }, 42);
    expect((await t.call('GET', '/search?q=' + encodeURIComponent('"OR* ( --'))).status).toBe(200);
    expect((await t.call('GET', '/search?q=пароль', undefined, 43)).body).toEqual([]);
  });
  it('разбор входящих в задачу и в заметку', async () => {
    const mk = (text: string) => { const id = uid(); t.db.prepare(`INSERT INTO inbox_items (id, user_id, text, created_at, updated_at) VALUES (?,?,?,?,?)`).run(id, 42, text, 'x', 'x'); return id; };
    await t.call('GET', '/bootstrap');
    const a = mk('Купить билеты\nна пятницу, дёшево');
    const taskId = uid();
    await t.call('POST', `/inbox/${a}/convert`, { to: 'task', id: taskId });
    const task = (await t.call('GET', `/tasks/${taskId}`)).body;
    expect(task.title).toBe('Купить билеты');
    expect(task.description).toBe('на пятницу, дёшево');
    const b = mk('Просто мысль');
    await t.call('POST', `/inbox/${b}/convert`, { to: 'note', id: uid() });
    expect((await t.call('GET', '/inbox')).body).toHaveLength(0);
    expect((await t.call('GET', '/notes')).body[0].body).toBe('Просто мысль');
  });
});

describe('настройки и данные', () => {
  it('смена часового пояса пересчитывает напоминания для задач без времени', async () => {
    const id = uid();
    await t.call('POST', '/tasks', { id, title: 'Дата', due_date: '2035-05-05', reminders: [0] });
    const at = () => (t.db.prepare('SELECT remind_at FROM reminders WHERE entity_id = ?').get(id) as any).remind_at;
    expect(at()).toBe('2035-05-05T06:00:00.000Z'); // 09:00 МСК
    await t.call('PATCH', '/settings', { timezone: 'Asia/Yekaterinburg' });
    expect(at()).toBe('2035-05-05T04:00:00.000Z'); // 09:00 по Екатеринбургу
  });
  it('отклоняет неверные настройки', async () => {
    expect((await t.call('PATCH', '/settings', { timezone: 'Mars/Base' })).status).toBe(400);
    expect((await t.call('PATCH', '/settings', { morning_digest_time: '8:00' })).status).toBe(400);
  });
  it('удаление аккаунта стирает все данные', async () => {
    await t.call('POST', '/tasks', { id: uid(), title: 'x' });
    await t.call('DELETE', '/me');
    for (const tbl of ['tasks', 'settings', 'categories', 'users', 'reminders']) expect((t.db.prepare(`SELECT COUNT(*) n FROM ${tbl}`).get() as any).n).toBe(0);
  });
});
