import { useState } from 'react';
import type { CategoryOut, InboxOut, SearchHit, SettingsOut } from '@planb/shared';
import { HL_CLOSE, HL_OPEN, splitInbox } from '@planb/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useApp } from './app-context';
import { api } from './api';
import { InboxRow } from './rows';
import { nav, toast } from './nav';
import { mutate, reschedule, useGet } from './queries';
import { t } from './ru';
import { close, confirmDialog, haptic, userId } from './tg';
import { CatChips, Empty, ErrorBox, Screen, Sheet, Skeleton, Toggle, useDebounced } from './ui';
import { addDays, dow, uid, usePersisted } from './util';

// ---------- Входящие ----------
export function Inbox() {
  const q = useGet<InboxOut[]>('/inbox');
  return (
    <Screen title={t.inbox}>
      {q.isError && !q.data ? <ErrorBox onRetry={() => q.refetch()} /> : !q.data ? <Skeleton /> : q.data.length ? q.data.map((i) => <InboxRow key={i.id} item={i} />) : <Empty text={t.emptyInbox} />}
    </Screen>
  );
}

export function InboxItemSheet({ item }: { item: InboxOut }) {
  const done = () => nav.pop();
  return (
    <Sheet title={t.inbox}>
      <p className="selectable">{item.text || item.attachments[0]?.caption}</p>
      {item.forward_origin && <p className="muted">{t.fromForward}{item.forward_origin}</p>}
      <div className="stack">
        <button className="btn" onClick={() => nav.replace({ t: 'task', draft: splitInbox(item.text || item.attachments[0]?.caption || 'Вложение'), inboxId: item.id })}>{t.toTask}</button>
        <button className="btn" onClick={async () => { await mutate(`/inbox/${item.id}/convert`, 'POST', { to: 'note', id: uid() }); haptic('success'); done(); }}>{t.toNote}</button>
        {item.attachments.length > 0 && <button className="btn ghost" onClick={async () => { await api(`/inbox/${item.id}/show`, { method: 'POST' }).then(() => toast('Отправлено в чат'), (e) => toast(e.message)); }}>{t.showInChat}</button>}
        <button className="btn danger" onClick={async () => { await mutate(`/inbox/${item.id}`, 'DELETE'); done(); }}>{t.delete}</button>
      </div>
    </Sheet>
  );
}

// ---------- Перенос задачи ----------
export function RescheduleSheet({ task }: { task: import('@planb/shared').TaskOut }) {
  const { today, settings } = useApp();
  const go = async (date: string, time: string | null = task.due_time) => { nav.pop(); await reschedule(task, date, time); };
  const sat = addDays(today, (6 - dow(today) + 7) % 7 || 7);
  const mon = addDays(today, ((8 - dow(today)) % 7) || 7);
  return (
    <Sheet title={t.rescheduleTitle}>
      <div className="stack">
        <button className="btn" onClick={() => go(today, settings.evening_digest_time)}>{t.tonight} · {settings.evening_digest_time}</button>
        <button className="btn" onClick={() => go(addDays(today, 1))}>{t.tomorrowOpt}</button>
        <button className="btn" onClick={() => go(sat)}>{t.weekend}</button>
        <button className="btn" onClick={() => go(mon)}>{t.nextWeek}</button>
        <label className="btn ghost">{t.pickDate}<input type="date" className="hidden-input" onChange={(e) => e.target.value && go(e.target.value)} /></label>
      </div>
    </Sheet>
  );
}

// ---------- Проекты ----------
export function ProjectMenu({ id, name, archived }: { id: string; name: string; archived: boolean }) {
  return (
    <Sheet title={name}>
      <div className="stack">
        <button className="btn" onClick={() => nav.replace({ t: 'projectName', id, name })}>{t.rename}</button>
        <button className="btn" onClick={async () => { nav.pop(); await mutate(`/projects/${id}`, 'PATCH', { archived: !archived }); }}>{archived ? t.unarchive : t.archive}</button>
        <button className="btn danger" onClick={async () => { if (await confirmDialog(t.confirmProjectDelete)) { nav.pop(); await mutate(`/projects/${id}`, 'DELETE'); } }}>{t.delete}</button>
      </div>
    </Sheet>
  );
}

export function ProjectName({ id, name }: { id?: string; name?: string }) {
  const [v, setV] = useState(name ?? '');
  const save = async () => {
    if (!v.trim()) return haptic('error');
    nav.pop();
    await mutate(`/projects/${id ?? uid()}`, 'PUT', { name: v.trim() });
  };
  return (
    <Sheet title={id ? t.rename : t.newProject}>
      <input className="input" autoFocus placeholder={t.projectName} value={v} maxLength={200} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      <button className="btn primary" onClick={save}>{t.save}</button>
    </Sheet>
  );
}

// ---------- Поиск ----------
const Hl = ({ s }: { s: string }) => (
  <>{s.split(HL_OPEN).map((p, i) => { if (!i) return p; const [m, ...r] = p.split(HL_CLOSE); return <span key={i}><mark>{m}</mark>{r.join(HL_CLOSE)}</span>; })}</>
);

export function Search() {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [recent, setRecent] = usePersisted<string[]>('recent', []);
  const dq = useDebounced(q.trim(), 250);
  const res = useGet<SearchHit[]>(`/search?q=${encodeURIComponent(dq)}${cat !== 'all' ? `&category=${cat}` : ''}`, dq.length >= 2);
  const remember = () => setRecent([dq, ...recent.filter((r) => r !== dq)].slice(0, 5));
  const open = async (h: SearchHit) => {
    remember();
    if (h.type === 'inbox') return nav.push({ t: 'inbox' });
    nav.push(h.type === 'task' ? { t: 'task', id: h.id } : h.type === 'event' ? { t: 'event', id: h.id } : { t: 'note', id: h.id });
  };
  const label = { task: t.task, event: t.event, note: t.note, inbox: t.inbox };
  return (
    <Screen title={t.search}>
      <input className="input" autoFocus type="search" placeholder={t.search} value={q} onChange={(e) => setQ(e.target.value)} />
      <CatChips value={cat} onChange={setCat} />
      {dq.length < 2 ? (
        recent.length > 0 && <div className="recent"><div className="muted">{t.recent}</div>{recent.map((r) => <button key={r} className="chip" onClick={() => setQ(r)}>{r}</button>)}</div>
      ) : res.isError ? <ErrorBox onRetry={() => res.refetch()} /> : !res.data ? <Skeleton /> : res.data.length === 0 ? <Empty text={t.emptySearch} /> : (
        res.data.map((h) => (
          <button key={h.type + h.id} className={`row hit ${h.flag ? 'done' : ''}`} onClick={() => open(h)}>
            <div className="row-main">
              <div className="row-title">{h.title || '…'}</div>
              <div className="row-meta"><span>{label[h.type]}{h.flag ? (h.type === 'task' ? ' · выполнена' : ' · разобрано') : ''}</span><span className="snippet"><Hl s={h.snippet} /></span></div>
            </div>
          </button>
        ))
      )}
    </Screen>
  );
}

// ---------- Настройки ----------
const TZS: string[] = (Intl as any).supportedValuesOf ? (Intl as any).supportedValuesOf('timeZone') : ['Europe/Moscow'];

export function Settings() {
  const { settings: s, categories, user } = useApp();
  const qc = useQueryClient();
  const [colors, setColors] = useState<Record<string, string>>({});
  const set = (patch: Partial<SettingsOut>) => void mutate('/settings', 'PATCH', patch);
  const Time = ({ k, label }: { k: keyof SettingsOut; label: string }) => (
    <label className="field">{label}<input type="time" className="input sm" value={s[k] as string} onChange={(e) => e.target.value && set({ [k]: e.target.value })} /></label>
  );
  const Num = ({ k, label, min, max }: { k: 'nag_interval_min' | 'nag_max_count'; label: string; min: number; max: number }) => (
    <label className="field">{label}<input type="number" className="input sm" min={min} max={max} defaultValue={s[k]}
      onBlur={(e) => { const n = Math.round(Number(e.target.value)); if (n >= min && n <= max && n !== s[k]) set({ [k]: n }); else e.target.value = String(s[k]); }} /></label>
  );
  const Sw = ({ k, label }: { k: keyof SettingsOut; label: string }) => <div className="field">{label}<Toggle on={s[k] as boolean} onChange={(v) => set({ [k]: v })} label={label} /></div>;
  const tzs = TZS.includes(s.timezone) ? TZS : [s.timezone, ...TZS];
  return (
    <Screen title={t.settings}>
      <div className="card">
        <label className="field">{t.tzLabel}<select className="input sm" value={s.timezone} onChange={(e) => set({ timezone: e.target.value })}>{tzs.map((z) => <option key={z}>{z}</option>)}</select></label>
        <label className="field">{t.weekStart}<select className="input sm" value={s.week_start} onChange={(e) => set({ week_start: Number(e.target.value) as 0 | 1 })}><option value={1}>{t.monday}</option><option value={0}>{t.sunday}</option></select></label>
      </div>
      <div className="card">
        <Sw k="morning_digest_enabled" label={t.morningDigest} />{s.morning_digest_enabled && <Time k="morning_digest_time" label={t.time} />}
        <Sw k="evening_digest_enabled" label={t.eveningDigest} />{s.evening_digest_enabled && <Time k="evening_digest_time" label={t.time} />}
        <Sw k="skip_empty_digest" label={t.skipEmpty} />
      </div>
      <div className="card">
        <div className="muted">{t.quiet}</div>
        <Time k="quiet_hours_start" label={t.quietFrom} /><Time k="quiet_hours_end" label={t.quietTo} />
        <Time k="date_only_reminder_time" label={t.dateOnlyTime} />
      </div>
      <div className="card">
        <Sw k="nag_enabled_default" label={t.nagDefault} />
        <Num k="nag_interval_min" label={t.nagInterval} min={5} max={720} /><Num k="nag_max_count" label={t.nagMax} min={0} max={10} />
      </div>
      <div className="card">
        <div className="muted">{t.colors}</div>
        {categories.map((c: CategoryOut) => (
          <label key={c.id} className="field">{c.name}
            <input type="color" value={colors[c.id] ?? c.color} onChange={(e) => setColors({ ...colors, [c.id]: e.target.value })}
              onBlur={(e) => void mutate(`/categories/${c.id}`, 'PATCH', { color: e.target.value })} />
          </label>
        ))}
      </div>
      <div className="stack">
        <button className="btn" onClick={() => api('/export', { method: 'POST' }).then(() => toast(t.exported), (e) => toast(e.message))}>{t.export}</button>
        <button className="btn danger" onClick={async () => {
          if (!(await confirmDialog(t.deleteAccountConfirm)) || !(await confirmDialog(t.deleteAccountConfirm2))) return;
          await api('/me', { method: 'DELETE' }); qc.clear(); try { localStorage.clear(); } catch { /* нет доступа */ } close();
        }}>{t.deleteAccount}</button>
      </div>
      <p className="muted center">{t.signedAs} {user.first_name ?? user.username ?? userId}</p>
    </Screen>
  );
}
