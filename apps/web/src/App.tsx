import { useEffect, useMemo, useState } from 'react';
import type { Bootstrap } from '@planb/shared';
import { AppContext } from './app-context';
import { ApiError } from './api';
import { nav, useStack } from './nav';
import { Inbox, InboxItemSheet, ProjectMenu, ProjectName, RescheduleSheet, Search, Settings } from './overlays';
import { useGet } from './queries';
import { t } from './ru';
import { Calendar, Notes, Tasks, Today } from './screens';
import { EventSheet, NoteSheet, TaskSheet } from './sheets';
import { inTelegram, startParam, useBackButton } from './tg';
import { Empty, Icon, Skeleton, Snackbar, TabBar } from './ui';
import { ymd } from './util';

const Gate = ({ title, text }: { title: string; text: string }) => <div className="gate"><h1>{title}</h1><p>{text}</p></div>;

function useOnline() {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const u = () => setOn(true), d = () => setOn(false);
    addEventListener('online', u); addEventListener('offline', d);
    return () => { removeEventListener('online', u); removeEventListener('offline', d); };
  }, []);
  return on;
}

function openDeepLink(p: string) {
  const [kind, id] = [p.split('_')[0], p.slice(p.indexOf('_') + 1)];
  if (p === 'inbox' || p === 'settings' || p === 'search') nav.push({ t: p });
  else if (id && kind === 'task') nav.push({ t: 'task', id });
  else if (id && kind === 'event') nav.push({ t: 'event', id });
  else if (id && kind === 'note') nav.push({ t: 'note', id });
}

export function App() {
  const boot = useGet<Bootstrap>('/bootstrap', inTelegram);
  const stack = useStack();
  const online = useOnline();
  const [tab, setTab] = useState('today');
  const [calDay, setCalDay] = useState('');
  const [, tick] = useState(0);
  useBackButton(stack.length ? nav.pop : null);
  useEffect(() => { const h = setInterval(() => tick((n) => n + 1), 60_000); return () => clearInterval(h); }, []);
  useEffect(() => { if (startParam && boot.data) openDeepLink(startParam); }, [!!boot.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctx = useMemo(() => boot.data && ({ ...boot.data, catMap: Object.fromEntries(boot.data.categories.map((c) => [c.id, c])) }), [boot.data]);
  if (!inTelegram) return <Gate title={t.openInTg} text={t.openInTgText} />;
  if (boot.error instanceof ApiError && [401, 403].includes(boot.error.status)) return <Gate title={t.denied} text={t.deniedText} />;
  if (boot.isError && !ctx) return <Empty text={t.loadError} action={<button className="btn" onClick={() => boot.refetch()}>{t.retry}</button>} />;
  if (!ctx) return <Skeleton />;

  const today = ymd(new Date(), ctx.settings.timezone);
  const day = calDay || today;
  const fab = () => nav.push(tab === 'calendar' ? { t: 'event', fab: true, date: day } : tab === 'notes' ? { t: 'note', fab: true } : { t: 'task', fab: true });

  return (
    <AppContext.Provider value={{ ...ctx, today }}>
      {!online && <div className="offline" role="status">{t.offline}</div>}
      <main className="page">
        {tab === 'today' && <Today go={setTab} />}
        {tab === 'tasks' && <Tasks />}
        {tab === 'calendar' && <Calendar day={day} setDay={setCalDay} />}
        {tab === 'notes' && <Notes />}
      </main>
      <button className="fab" aria-label={t.addTask} onClick={fab}><Icon n="plus" size={26} /></button>
      <TabBar tab={tab} onTab={setTab} />
      {stack.map((e, i) => (
        <div key={i} className="layer" style={{ zIndex: 10 + i }}>
          {e.t === 'search' && <Search />}
          {e.t === 'inbox' && <Inbox />}
          {e.t === 'settings' && <Settings />}
          {e.t === 'task' && <TaskSheet {...e} />}
          {e.t === 'event' && <EventSheet {...e} />}
          {e.t === 'note' && <NoteSheet {...e} />}
          {e.t === 'reschedule' && <RescheduleSheet task={e.task} />}
          {e.t === 'inboxItem' && <InboxItemSheet item={e.item} />}
          {e.t === 'projectMenu' && <ProjectMenu id={e.id} name={e.name} archived={e.archived} />}
          {e.t === 'projectName' && <ProjectName id={e.id} name={e.name} />}
        </div>
      ))}
      <Snackbar />
    </AppContext.Provider>
  );
}
