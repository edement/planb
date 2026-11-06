import { describe, expect, it } from 'vitest';
import type { TaskOut, TodayOut } from '@planb/shared';
import { eveningDigest, esc, morningDigest, plural, reminderMsg } from './texts';

const task = (title: string, due_time: string | null = null): TaskOut => ({
  id: crypto.randomUUID(), title, description: null, category_id: 'c', project_id: null, due_date: '2026-11-06', due_time,
  status: 'open', completed_at: null, nag_enabled: null, reminders: [], checklist: [], created_at: '', updated_at: '', deleted_at: null,
});
const today = (over: Partial<TodayOut> = {}): TodayOut => ({
  date: '2026-11-06', overdue: [], day: { allDay: [], timeline: [], noTime: [] }, pinned: [], pinned_total: 0,
  tomorrow: [], tomorrow_total: 0, inbox_count: 0, ...over,
});

describe('digests', () => {
  it('пустая утренняя сводка → null (её не отправляют)', () => expect(morningDigest(today(), 'https://x.y')).toBeNull());
  it('содержит задачи, просрочку (первые три) и входящие', () => {
    const m = morningDigest(today({
      day: { allDay: [], timeline: [{ kind: 'task', task: task('Сдать отчёт', '15:00') }], noTime: [task('Купить хлеб')] },
      overdue: [task('a'), task('b'), task('c'), task('d')], inbox_count: 4,
    }), 'https://x.y')!;
    expect(m.text).toContain('Пятница, 6 ноября');
    expect(m.text).toContain('• 15:00 · Сдать отчёт');
    expect(m.text).toContain('Просрочено: 4');
    expect(m.text).not.toContain('• d');
    expect(m.text).toContain('Входящие: 4 неразобранных');
  });
  it('экранирует HTML в пользовательском тексте', () => {
    const m = morningDigest(today({ day: { allDay: [], timeline: [], noTime: [task('<b>&</b>')] } }), 'https://x.y')!;
    expect(m.text).toContain('&lt;b&gt;&amp;&lt;/b&gt;');
  });
  it('укладывается в 4096 символов и пишет «ещё M»', () => {
    const many = Array.from({ length: 400 }, (_, i) => task(`Задача номер ${i} `.repeat(3)));
    const m = morningDigest(today({ day: { allDay: [], timeline: [], noTime: many } }), 'https://x.y')!;
    expect(m.text.length).toBeLessThanOrEqual(4096);
    expect(m.text).toMatch(/… ещё \d+, откройте приложение$/);
  });
  it('вечерняя сводка: кнопка «Всё на завтра» только при невыполненных задачах', () => {
    const e1 = eveningDigest({ date: '2026-11-06', tasks: [task('x')], events: [], inbox_count: 0 }, 'https://x.y')!;
    expect(e1.buttons[0].map((b) => b.text)).toEqual(['Всё на завтра', 'Открыть']);
    const e2 = eveningDigest({ date: '2026-11-06', tasks: [], events: [], inbox_count: 2 }, 'https://x.y')!;
    expect(e2.buttons[0].map((b) => b.text)).toEqual(['Открыть']);
    expect(eveningDigest({ date: '2026-11-06', tasks: [], events: [], inbox_count: 0 }, 'https://x.y')).toBeNull();
  });
});

describe('reminderMsg', () => {
  const e = { kind: 'task' as const, id: 'i', title: 'Курсовая', date: '2026-11-06', time: '15:00', category: 'Учёба' };
  it('формат «Сегодня, 15:00 · Учёба» и кнопки задачи', () => {
    const m = reminderMsg(e, { rid: 'r', today: '2026-11-06', webapp: 'https://x.y' });
    expect(m.text).toBe('<b>Курсовая</b>\nСегодня, 15:00 · Учёба');
    expect(m.buttons[0].map((b) => b.text)).toEqual(['✅ Выполнено', '⏰ Отложить', 'Открыть']);
  });
  it('у события нет кнопки «Выполнено»', () => {
    const m = reminderMsg({ ...e, kind: 'event' }, { rid: 'r', today: '2026-11-06', webapp: 'https://x.y' });
    expect(m.buttons[0].map((b) => b.text)).toEqual(['⏰ Отложить', 'Открыть']);
  });
  it('повтор помечается', () => expect(reminderMsg(e, { rid: 'r', today: '2026-11-06', webapp: 'w', repeat: 1 }).text.startsWith('🔁')).toBe(true));
});

describe('helpers', () => {
  it('plural', () => { expect(plural(1, ['а', 'б', 'в'])).toBe('а'); expect(plural(3, ['а', 'б', 'в'])).toBe('б'); expect(plural(11, ['а', 'б', 'в'])).toBe('в'); expect(plural(22, ['а', 'б', 'в'])).toBe('б'); });
  it('esc', () => expect(esc('a<b>&')).toBe('a&lt;b&gt;&amp;'));
});
