import { useEffect, useState } from 'react';

export const uid = () => crypto.randomUUID();
const pad = (n: number) => String(n).padStart(2, '0');

export const ymd = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const utc = (k: string) => new Date(k + 'T00:00:00Z');
export const addDays = (k: string, n: number) => { const d = utc(k); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const dow = (k: string) => utc(k).getUTCDay();
export const weekStartOf = (k: string, ws: number) => addDays(k, -((dow(k) - ws + 7) % 7));
export const dayNum = (k: string) => Number(k.slice(8));
const fmt = (k: string, o: Intl.DateTimeFormatOptions) => utc(k).toLocaleDateString('ru-RU', { ...o, timeZone: 'UTC' });
export const dayLabel = (k: string, today: string) =>
  k === today ? 'Сегодня' : k === addDays(today, 1) ? 'Завтра' : k === addDays(today, -1) ? 'Вчера' : fmt(k, { day: 'numeric', month: 'long' });
export const longDay = (k: string) => fmt(k, { weekday: 'long', day: 'numeric', month: 'long' });
export const weekdayShort = (k: string) => fmt(k, { weekday: 'short' });
export const monthTitle = (k: string) => fmt(k, { month: 'long', year: 'numeric' });
export const nextHour = (tz: string) => {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date()));
  return `${pad(Math.min(h + 1, 23))}:00`;
};
export const offsetLabel = (n: number, hasTime = true) => {
  if (n === 0) return hasTime ? 'В момент срока' : 'В день срока';
  if (n % 1440 === 0) return `За ${n / 1440} дн.`;
  if (n % 60 === 0) return `За ${n / 60} ч`;
  return `За ${n} мин`;
};

export function usePersisted<T>(key: string, init: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => { try { const s = localStorage.getItem('planb:' + key); return s ? (JSON.parse(s) as T) : init; } catch { return init; } });
  useEffect(() => { try { localStorage.setItem('planb:' + key, JSON.stringify(v)); } catch { /* хранилище недоступно */ } }, [key, v]);
  return [v, setV];
}

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g;
export const linkParts = (text: string) => text.split(URL_RE).map((s, i) => ({ s, link: i % 2 === 1 }));
export const firstLine = (s: string) => s.trim().split('\n')[0];
