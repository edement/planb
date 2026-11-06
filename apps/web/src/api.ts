import { initData } from './tg';
import { t } from './ru';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  if (method !== 'GET' && !navigator.onLine) throw new ApiError(0, 'offline', t.offline);
  const headers: Record<string, string> = { Authorization: `tma ${initData}`, 'X-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try { res = await fetch('/api/v1' + path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }); }
  catch { throw new ApiError(0, 'network', t.noConnection); }
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new ApiError(res.status, j?.error?.code ?? 'error', j?.error?.message ?? t.error);
  }
  return res.json() as Promise<T>;
}
