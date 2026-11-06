import { useEffect } from 'react';

const w = (window as any).Telegram?.WebApp as any;
export const inTelegram = !!w?.initData;
export const initData: string = w?.initData ?? '';
export const userId: number = w?.initDataUnsafe?.user?.id ?? 0;
export const startParam: string = w?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('open') || '';
const atLeast = (v: string): boolean => !!w?.isVersionAtLeast?.(v);

function applyTheme() {
  if (!w) return;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(w.themeParams ?? {})) root.style.setProperty(`--tg-theme-${k.replace(/_/g, '-')}`, String(v));
  root.toggleAttribute('data-dark', w.colorScheme === 'dark');
  const si = { ...(w.safeAreaInset ?? {}) }, ci = w.contentSafeAreaInset ?? {};
  root.style.setProperty('--safe-top', `${(si.top ?? 0) + (ci.top ?? 0)}px`);
  root.style.setProperty('--safe-bottom', `${si.bottom ?? 0}px`);
}

export function initTelegram() {
  if (!w) return;
  w.ready();
  w.expand();
  if (atLeast('7.7')) w.disableVerticalSwipes?.();
  applyTheme();
  w.onEvent('themeChanged', applyTheme);
  w.onEvent('safeAreaChanged', applyTheme);
  w.onEvent('contentSafeAreaChanged', applyTheme);
}

export const haptic = (k: 'success' | 'error' | 'light' | 'select') => {
  const h = w?.HapticFeedback; if (!h) return;
  if (k === 'success' || k === 'error') h.notificationOccurred(k); else if (k === 'select') h.selectionChanged(); else h.impactOccurred('light');
};
export const confirmDialog = (msg: string) => new Promise<boolean>((res) => (w?.showConfirm ? w.showConfirm(msg, res) : res(window.confirm(msg))));
export const openLink = (url: string) => (w?.openLink ? w.openLink(url) : window.open(url, '_blank', 'noopener'));
export const close = () => w?.close?.();

/** Нативная кнопка «Назад»: показывается, пока передан обработчик. */
export function useBackButton(onBack: (() => void) | null) {
  useEffect(() => {
    const b = w?.BackButton; if (!b || !onBack) return;
    b.onClick(onBack); b.show();
    return () => { b.offClick(onBack); b.hide(); };
  }, [onBack]);
}

/** Нативная главная кнопка (например «Сохранить»). */
export function useMainButton(text: string, onClick: () => void, enabled = true) {
  useEffect(() => {
    const b = w?.MainButton; if (!b) return;
    b.setText(text); b.onClick(onClick); b.show();
    enabled ? b.enable() : b.disable();
    return () => { b.offClick(onClick); b.hide(); };
  }, [text, onClick, enabled]);
}
