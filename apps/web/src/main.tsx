import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider, dehydrate, hydrate } from '@tanstack/react-query';
import { App } from './App';
import { queryClient } from './queries';
import { initTelegram, userId } from './tg';
import './styles.css';

initTelegram();

// Офлайн-кэш: последние данные показываются сразу, затем обновляются (stale-while-revalidate).
const key = `planb:cache:${userId}`;
try { const s = localStorage.getItem(key); if (s) hydrate(queryClient, JSON.parse(s)); } catch { /* кэш повреждён — игнорируем */ }
let timer: ReturnType<typeof setTimeout>;
queryClient.getQueryCache().subscribe(() => {
  clearTimeout(timer);
  timer = setTimeout(() => { try { localStorage.setItem(key, JSON.stringify(dehydrate(queryClient))); } catch { /* нет места или доступа */ } }, 1000);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={queryClient}><App /></QueryClientProvider></StrictMode>,
);
