import { beforeEach, describe, expect, it } from 'vitest';
import { tick } from './scheduler';
import { TgError } from './tg';
import { setup, uid } from './testutil';

let t: Awaited<ReturnType<typeof setup>>;
const at = (iso: string) => new Date(iso);
// 2035-05-05 15:30 МСК = 12:30Z
const NOW0 = '2035-05-05T12:29:00Z';
const mkTask = async (over: object = {}) => {
  const id = uid();
  await t.call('POST', '/tasks', { id, title: 'Сдать отчёт', due_date: '2035-05-05', due_time: '15:30', category_id: undefined, ...over });
  return id;
};
const noDigests = () => t.call('PATCH', '/settings', { morning_digest_enabled: false, evening_digest_enabled: false });
beforeEach(async () => { t = await setup(); await t.call('GET', '/bootstrap'); });

describe('напоминания', () => {
  beforeEach(noDigests);
  it('приходит вовремя, один раз, с кнопками', async () => {
    await mkTask();
    await tick(t.deps, at(NOW0));
    expect(t.tg.sent).toHaveLength(0);
    await tick(t.deps, at('2035-05-05T12:30:20Z'));
    await tick(t.deps, at('2035-05-05T12:30:50Z')); // повторный проход — без дублей
    expect(t.tg.sent).toHaveLength(1);
    expect(t.tg.sent[0].m.text).toBe('<b>Сдать отчёт</b>\nСегодня, 15:30 · Разное');
    expect(t.tg.sent[0].m.buttons[0].map((b) => b.text)).toEqual(['✅ Выполнено', '⏰ Отложить', 'Открыть']);
  });
  it('пропущенное после простоя отправляется сразу', async () => {
    await mkTask();
    await tick(t.deps, at('2035-05-05T14:00:00Z'));
    expect(t.tg.sent).toHaveLength(1);
  });
  it('выполненная или удалённая задача не напоминает', async () => {
    const id = await mkTask();
    await t.call('PATCH', `/tasks/${id}`, { status: 'done' });
    await tick(t.deps, at('2035-05-05T13:00:00Z'));
    expect(t.tg.sent).toHaveLength(0);
  });
  it('изменение срока пересчитывает ещё не отправленное напоминание', async () => {
    const id = await mkTask();
    await t.call('PATCH', `/tasks/${id}`, { due_time: '18:00' });
    await tick(t.deps, at('2035-05-05T12:31:00Z'));
    expect(t.tg.sent).toHaveLength(0);
    await tick(t.deps, at('2035-05-05T15:00:30Z'));
    expect(t.tg.sent).toHaveLength(1);
  });
  it('тихие часы не подавляют одиночные напоминания', async () => {
    await mkTask({ due_time: '23:30' }); // 20:30Z, тихие часы 23:00–08:00
    await tick(t.deps, at('2035-05-05T20:31:00Z'));
    expect(t.tg.sent).toHaveLength(1);
  });
  it('429: напоминание не теряется и уходит после retry_after', async () => {
    await mkTask();
    t.tg.failWith = new TgError(429, 10);
    await tick(t.deps, at('2035-05-05T12:31:00Z'));
    expect(t.tg.sent).toHaveLength(0);
    t.tg.failWith = null;
    await tick(t.deps, at('2035-05-05T12:31:05Z')); // пауза ещё идёт
    expect(t.tg.sent).toHaveLength(0);
    await tick(t.deps, at('2035-05-05T12:31:20Z'));
    expect(t.tg.sent).toHaveLength(1);
  });
  it('403: пользователь помечается заблокировавшим бота, рассылка прекращается', async () => {
    await mkTask();
    t.tg.failWith = new TgError(403);
    await tick(t.deps, at('2035-05-05T12:31:00Z'));
    expect((t.db.prepare('SELECT blocked FROM users WHERE telegram_id = 42').get() as any).blocked).toBe(1);
    t.tg.failWith = null;
    await mkTask({ title: 'Другая', due_time: '16:00' });
    await tick(t.deps, at('2035-05-05T13:05:00Z'));
    expect(t.tg.sent).toHaveLength(0);
  });
});

describe('настойчивые повторы', () => {
  beforeEach(noDigests);
  const setNag = (v: object) => t.call('PATCH', '/settings', v);
  it('идут с интервалом, удаляют предыдущее сообщение и ограничены nag_max_count', async () => {
    await setNag({ nag_interval_min: 30, nag_max_count: 2 });
    await mkTask();
    await tick(t.deps, at('2035-05-05T12:30:30Z'));                  // 1
    await tick(t.deps, at('2035-05-05T12:59:00Z'));                  // рано
    expect(t.tg.sent).toHaveLength(1);
    await tick(t.deps, at('2035-05-05T13:01:00Z'));                  // повтор 1
    expect(t.tg.sent).toHaveLength(2);
    expect(t.tg.removed).toEqual([t.tg.sent[0].id]);
    expect(t.tg.sent[1].m.text.startsWith('🔁')).toBe(true);
    await tick(t.deps, at('2035-05-05T13:32:00Z'));                  // повтор 2
    await tick(t.deps, at('2035-05-05T14:10:00Z'));                  // лимит исчерпан
    expect(t.tg.sent).toHaveLength(3);
  });
  it('прекращаются после выполнения', async () => {
    const id = await mkTask();
    await tick(t.deps, at('2035-05-05T12:30:30Z'));
    await t.call('PATCH', `/tasks/${id}`, { status: 'done' });
    await tick(t.deps, at('2035-05-05T13:05:00Z'));
    expect(t.tg.sent).toHaveLength(1);
  });
  it('не приходят в тихие часы и не копятся: после них — один повтор', async () => {
    await setNag({ nag_interval_min: 30, nag_max_count: 5 });
    await mkTask({ due_time: '22:40' });                              // 19:40Z
    await tick(t.deps, at('2035-05-05T19:41:00Z'));                  // 1
    await tick(t.deps, at('2035-05-05T20:15:00Z'));                  // 23:15 МСК — тихо
    await tick(t.deps, at('2035-05-06T01:00:00Z'));                  // 04:00 — тихо
    expect(t.tg.sent).toHaveLength(1);
    await tick(t.deps, at('2035-05-06T05:00:30Z'));                  // 08:00 МСК — один повтор
    await tick(t.deps, at('2035-05-06T05:01:00Z'));                  // следующий — только через интервал
    expect(t.tg.sent).toHaveLength(2);
  });
  it('отключаются на конкретной задаче', async () => {
    await mkTask({ nag_enabled: false });
    await tick(t.deps, at('2035-05-05T12:30:30Z'));
    await tick(t.deps, at('2035-05-05T13:30:00Z'));
    expect(t.tg.sent).toHaveLength(1);
  });
  it('изменение срока останавливает серию', async () => {
    const id = await mkTask();
    await tick(t.deps, at('2035-05-05T12:30:30Z'));
    await t.call('PATCH', `/tasks/${id}`, { due_time: '20:00' });
    await tick(t.deps, at('2035-05-05T13:05:00Z'));
    expect(t.tg.sent).toHaveLength(1);
  });
});

describe('сводки', () => {
  it('утренняя приходит один раз в день в нужное время; пустая пропускается', async () => {
    await tick(t.deps, at('2035-05-05T05:00:30Z')); // 08:00 МСК, данных нет
    expect(t.tg.sent).toHaveLength(0);
    await t.call('POST', '/tasks', { id: uid(), title: 'На 7 мая', due_date: '2035-05-07' });
    await tick(t.deps, at('2035-05-07T05:00:30Z'));
    await tick(t.deps, at('2035-05-07T05:05:00Z'));
    expect(t.tg.sent).toHaveLength(1);
    expect(t.tg.sent[0].m.text).toContain('На 7 мая');
  });
  it('сводка, пропущенная более чем на два часа, не отправляется', async () => {
    await t.call('POST', '/tasks', { id: uid(), title: 'Дело', due_date: '2035-05-05' });
    await tick(t.deps, at('2035-05-05T08:30:00Z')); // 11:30 МСК
    expect(t.tg.sent.filter((s) => s.m.text.includes('☀️'))).toHaveLength(0);
  });
  it('в пределах двух часов — отправляется после простоя', async () => {
    await t.call('POST', '/tasks', { id: uid(), title: 'Дело', due_date: '2035-05-05' });
    await tick(t.deps, at('2035-05-05T06:30:00Z')); // 09:30 МСК
    expect(t.tg.sent.filter((s) => s.m.text.includes('☀️'))).toHaveLength(1);
  });
  it('вечерняя: «Всё на завтра» переносит задачи с сохранением времени', async () => {
    const id = await mkTask({ due_time: '23:50' });
    await t.call('POST', '/tasks', { id: uid(), title: 'Без времени', due_date: '2035-05-05' });
    await tick(t.deps, at('2035-05-05T18:00:30Z')); // 21:00 МСК
    const evening = t.tg.sent.find((s) => s.m.text.includes('Итоги дня'))!;
    expect(evening.m.buttons[0][0].cb).toBe('t:tomorrow');
    const { moveTasks } = await import('./mutate');
    const { getCtx } = await import('./data');
    expect(moveTasks(getCtx(t.db, 42), 'today', 'tomorrow', at('2035-05-05T18:01:00Z'))).toBe(2);
    const moved = (await t.call('GET', `/tasks/${id}`)).body;
    expect([moved.due_date, moved.due_time]).toEqual(['2035-05-06', '23:50']);
  });
  it('тихие часы подавляют сводку, если она назначена внутри них', async () => {
    await t.call('PATCH', '/settings', { morning_digest_time: '07:00' });
    await t.call('POST', '/tasks', { id: uid(), title: 'Дело', due_date: '2035-05-05' });
    await tick(t.deps, at('2035-05-05T04:10:00Z')); // 07:10 МСК — тихие часы
    expect(t.tg.sent).toHaveLength(0);
  });
});
