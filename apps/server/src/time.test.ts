import { describe, expect, it } from 'vitest';
import { addDays, dayKey, isQuiet, lastOccurrence, nextOccurrence, remindAt, todayKey, toLocal, whenLabel, zonedToUtc } from './time';

const MSK = 'Europe/Moscow';
const BER = 'Europe/Berlin';

describe('zonedToUtc / toLocal', () => {
  it('Москва UTC+3', () => {
    expect(zonedToUtc('2026-11-06', '15:00', MSK)).toBe('2026-11-06T12:00:00.000Z');
    expect(toLocal('2026-11-06T12:00:00.000Z', MSK)).toEqual({ date: '2026-11-06', time: '15:00' });
  });
  it('учитывает смену пояса: тот же момент — другой день', () => {
    const iso = '2026-11-06T22:30:00.000Z';
    expect(dayKey(iso, MSK)).toBe('2026-11-07');
    expect(dayKey(iso, 'America/New_York')).toBe('2026-11-06');
  });
  it('значение «только дата» возвращается как есть', () => {
    expect(dayKey('2026-11-06', 'Asia/Tokyo')).toBe('2026-11-06');
  });
  it('переход на летнее время (Берлин, 2026-03-29): несуществующее 02:30 сдвигается', () => {
    expect(zonedToUtc('2026-03-29', '01:30', BER)).toBe('2026-03-29T00:30:00.000Z'); // CET
    expect(zonedToUtc('2026-03-29', '03:30', BER)).toBe('2026-03-29T01:30:00.000Z'); // CEST
    expect(zonedToUtc('2026-03-29', '02:30', BER)).toBe('2026-03-29T01:30:00.000Z'); // 02:30 не существует
  });
  it('переход на зимнее время (Берлин, 2026-10-25)', () => {
    expect(zonedToUtc('2026-10-25', '12:00', BER)).toBe('2026-10-25T11:00:00.000Z');
    expect(zonedToUtc('2026-10-24', '12:00', BER)).toBe('2026-10-24T10:00:00.000Z');
  });
});

describe('todayKey / addDays', () => {
  it('граница суток зависит от пояса', () => {
    const now = new Date('2026-11-06T22:30:00Z');
    expect(todayKey(now, MSK)).toBe('2026-11-07');
    expect(todayKey(now, 'America/New_York')).toBe('2026-11-06');
  });
  it('addDays через границу месяца и года', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('remindAt', () => {
  const base = { tz: MSK, dateOnlyTime: '09:00' };
  it('в момент срока и за N минут', () => {
    const at = '2026-11-06T12:00:00.000Z';
    expect(remindAt({ ...base, at, hasTime: true, offset: 0 })).toBe(at);
    expect(remindAt({ ...base, at, hasTime: true, offset: 30 })).toBe('2026-11-06T11:30:00.000Z');
    expect(remindAt({ ...base, at, hasTime: true, offset: 60 })).toBe('2026-11-06T11:00:00.000Z');
  });
  it('без времени: в 09:00 по местному в день срока, «за 1 день» — накануне', () => {
    expect(remindAt({ ...base, at: '2026-11-06', hasTime: false, offset: 0 })).toBe('2026-11-06T06:00:00.000Z');
    expect(remindAt({ ...base, at: '2026-11-06', hasTime: false, offset: 1440 })).toBe('2026-11-05T06:00:00.000Z');
  });
  it('«за 1 день» держит местное время при переходе на летнее время', () => {
    const at = zonedToUtc('2026-03-30', '10:00', BER); // CEST, после перехода
    // накануне 10:00 по Берлину — это 29 марта 10:00 CEST = 08:00Z (а не 09:00Z, как дало бы вычитание 24 часов)
    expect(remindAt({ tz: BER, dateOnlyTime: '09:00', at, hasTime: true, offset: 1440 })).toBe('2026-03-29T08:00:00.000Z');
  });
  it('без времени при переходе на летнее время', () => {
    expect(remindAt({ tz: BER, dateOnlyTime: '09:00', at: '2026-03-29', hasTime: false, offset: 0 })).toBe('2026-03-29T07:00:00.000Z');
    expect(remindAt({ tz: BER, dateOnlyTime: '09:00', at: '2026-03-30', hasTime: false, offset: 1440 })).toBe('2026-03-29T07:00:00.000Z');
  });
});

describe('isQuiet', () => {
  const q = (utc: string) => isQuiet(new Date(utc), MSK, '23:00', '08:00');
  it('переход через полночь', () => {
    expect(q('2026-11-06T20:00:00Z')).toBe(true);  // 23:00 МСК
    expect(q('2026-11-06T22:00:00Z')).toBe(true);  // 01:00
    expect(q('2026-11-07T04:59:00Z')).toBe(true);  // 07:59
    expect(q('2026-11-07T05:00:00Z')).toBe(false); // 08:00 — уже не тихо
    expect(q('2026-11-06T19:59:00Z')).toBe(false); // 22:59
  });
  it('обычный интервал и пустой интервал', () => {
    expect(isQuiet(new Date('2026-11-06T10:00:00Z'), MSK, '12:00', '14:00')).toBe(true);
    expect(isQuiet(new Date('2026-11-06T10:00:00Z'), MSK, '08:00', '08:00')).toBe(false);
  });
});

describe('nextOccurrence / lastOccurrence', () => {
  const now = new Date('2026-11-06T15:00:00Z'); // 18:00 МСК
  it('вечер сегодня, утро завтра', () => {
    expect(nextOccurrence(now, MSK, '21:00').toISOString()).toBe('2026-11-06T18:00:00.000Z');
    expect(nextOccurrence(now, MSK, '08:00').toISOString()).toBe('2026-11-07T05:00:00.000Z');
  });
  it('последнее прошедшее', () => {
    expect(lastOccurrence(now, MSK, '08:00').toISOString()).toBe('2026-11-06T05:00:00.000Z');
    expect(lastOccurrence(now, MSK, '21:00').toISOString()).toBe('2026-11-05T18:00:00.000Z');
  });
});

describe('whenLabel', () => {
  it('сегодня / завтра / дата', () => {
    expect(whenLabel('2026-11-06', '15:00', '2026-11-06')).toBe('Сегодня, 15:00');
    expect(whenLabel('2026-11-07', null, '2026-11-06')).toBe('Завтра');
    expect(whenLabel('2026-11-20', '09:00', '2026-11-06')).toBe('20 ноября, 09:00');
  });
});
