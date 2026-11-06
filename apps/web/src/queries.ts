import { QueryClient, useQuery } from '@tanstack/react-query';
import type { TaskOut } from '@planb/shared';
import { api } from './api';
import { toast } from './nav';
import { t } from './ru';
import { haptic } from './tg';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, gcTime: 24 * 3600_000, retry: 1, refetchOnWindowFocus: true } },
});
export const useGet = <T,>(path: string, enabled = true) => useQuery({ queryKey: [path], queryFn: () => api<T>(path), enabled });
export const refresh = () => queryClient.invalidateQueries();

const msg = (e: unknown) => (e instanceof Error ? e.message : t.error);

/** Запрос на изменение: после успеха обновляет все данные, при ошибке показывает понятное сообщение. */
export async function mutate<T = unknown>(path: string, method: string, body?: unknown): Promise<T> {
  try { const r = await api<T>(path, { method, body }); await refresh(); return r; }
  catch (e) { haptic('error'); toast(msg(e)); throw e; }
}

// Оптимистичное обновление: убираем запись из всех закэшированных списков, при ошибке возвращаем.
const prune = (v: any, id: string): any =>
  Array.isArray(v) ? v.filter((e) => e?.id !== id && e?.task?.id !== id && e?.event?.id !== id).map((e) => prune(e, id))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, prune(x, id)])) : v;

async function optimistic(id: string, run: () => Promise<unknown>, onDone: () => void) {
  const snap = queryClient.getQueriesData({});
  queryClient.setQueriesData({}, (old) => (old === undefined ? old : prune(old, id)));
  try { await run(); onDone(); }
  catch (e) { snap.forEach(([k, v]) => queryClient.setQueryData(k, v)); haptic('error'); toast(msg(e)); }
  refresh();
}

export const completeTask = (task: TaskOut) => {
  haptic('success');
  return optimistic(task.id, () => api(`/tasks/${task.id}`, { method: 'PATCH', body: { status: 'done' } }),
    () => toast(t.completedToast, () => void mutate(`/tasks/${task.id}`, 'PATCH', { status: 'open' })));
};

export const removeItem = (kind: 'tasks' | 'events' | 'notes', id: string) =>
  optimistic(id, () => api(`/${kind}/${id}`, { method: 'DELETE' }),
    () => toast(t.deletedToast, () => void mutate(`/${kind}/${id}/restore`, 'POST')));

export const reschedule = async (task: TaskOut, date: string | null, time: string | null) => {
  await mutate(`/tasks/${task.id}`, 'PATCH', { due_date: date, due_time: time });
  toast(t.movedToast, () => void mutate(`/tasks/${task.id}`, 'PATCH', { due_date: task.due_date, due_time: task.due_time }));
};
