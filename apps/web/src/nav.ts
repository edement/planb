// Мини-навигация: стек экранов и всплывающих окон + уведомления-«снекбар». Без внешних библиотек.
import { useSyncExternalStore } from 'react';
import type { EventOut, InboxOut, NoteOut, TaskOut } from '@planb/shared';

export type Entry =
  | { t: 'search' } | { t: 'inbox' } | { t: 'settings' }
  | { t: 'task'; id?: string; task?: TaskOut; draft?: Partial<TaskOut>; inboxId?: string; fab?: boolean }
  | { t: 'event'; id?: string; event?: EventOut; date?: string; fab?: boolean }
  | { t: 'note'; id?: string; note?: NoteOut; fab?: boolean }
  | { t: 'reschedule'; task: TaskOut }
  | { t: 'inboxItem'; item: InboxOut }
  | { t: 'projectMenu'; id: string; name: string; archived: boolean }
  | { t: 'projectName'; id?: string; name?: string };

let stack: Entry[] = [];
const subs = new Set<() => void>();
const set = (s: Entry[]) => { stack = s; subs.forEach((f) => f()); };
export const nav = {
  push: (e: Entry) => set([...stack, e]),
  pop: () => set(stack.slice(0, -1)),
  replace: (e: Entry) => set([...stack.slice(0, -1), e]),
};
export const useStack = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => stack);

export interface Toast { id: number; text: string; undo?: () => void }
let toastState: Toast | null = null;
const tsubs = new Set<() => void>();
let timer: ReturnType<typeof setTimeout>;
export function toast(text: string, undo?: () => void) {
  toastState = { id: Date.now(), text, undo };
  tsubs.forEach((f) => f());
  clearTimeout(timer);
  timer = setTimeout(() => { toastState = null; tsubs.forEach((f) => f()); }, 5000);
}
export const dismissToast = () => { toastState = null; tsubs.forEach((f) => f()); };
export const useToast = () => useSyncExternalStore((f) => { tsubs.add(f); return () => tsubs.delete(f); }, () => toastState);
