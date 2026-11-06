import { describe, expect, it } from 'vitest';
import { signInitData, verifyInitData } from './auth';

const TOKEN = '123456:TEST-TOKEN';
const now = 1_800_000_000_000;
const mk = (over: Record<string, string> = {}, token = TOKEN) =>
  signInitData({ auth_date: String(now / 1000 - 10), user: JSON.stringify({ id: 42, first_name: 'Аня' }), query_id: 'AAA', ...over }, token);

describe('verifyInitData', () => {
  it('принимает корректную подпись', () => expect(verifyInitData(mk(), TOKEN, now).id).toBe(42));
  it('отклоняет подпись другим токеном', () => expect(() => verifyInitData(mk({}, 'other:token'), TOKEN, now)).toThrow());
  it('отклоняет подмену данных', () => {
    const raw = mk().replace('42', '43');
    expect(() => verifyInitData(raw, TOKEN, now)).toThrow();
  });
  it('отклоняет протухшие данные (старше 24 часов)', () => {
    expect(() => verifyInitData(mk({ auth_date: String(now / 1000 - 86401) }), TOKEN, now)).toThrow('expired');
  });
  it('отклоняет данные без hash и пустую строку', () => {
    expect(() => verifyInitData('user=%7B%7D&auth_date=1', TOKEN, now)).toThrow();
    expect(() => verifyInitData('', TOKEN, now)).toThrow();
  });
});
