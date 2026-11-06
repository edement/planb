import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TgUser { id: number; first_name?: string; username?: string; language_code?: string }

/** Проверка Telegram initData по официальному алгоритму (HMAC-SHA256). Бросает Error при любой проблеме. */
export function verifyInitData(raw: string, botToken: string, now = Date.now(), maxAgeSec = 86400): TgUser {
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('no hash');
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = createHmac('sha256', secret).update(check).digest();
  if (!timingSafeEqual(calc, Buffer.from(hash, 'hex'))) throw new Error('bad signature');
  const authDate = Number(params.get('auth_date'));
  if (!authDate || now / 1000 - authDate > maxAgeSec || authDate - now / 1000 > 300) throw new Error('expired');
  const user = JSON.parse(params.get('user') ?? 'null') as TgUser | null;
  if (!user || typeof user.id !== 'number') throw new Error('no user');
  return user;
}

/** Подпись initData для тестов. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const check = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}
