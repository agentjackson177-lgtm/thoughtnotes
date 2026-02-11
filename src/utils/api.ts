import type { UserData, User } from '../types';

const normalizeBase = (u: string) => u.replace(/\/+$/, '');

const envUrl = String((import.meta as any).env?.VITE_API_URL || '').trim();
// Fallbacks:
// - Known prod sites → use your deployed API
// - Local dev (vite default) → use local API
const inferCandidates = (): string[] => {
  if (typeof window === 'undefined') return [];
  const host = window.location?.hostname;
  if (host === 'thoughtnotes.onrender.com') return ['https://mindmap-api-qcew.onrender.com'];
  if (host === 'thoughtnotes.pages.dev') return ['https://mindmap-api.agent-jackson177.workers.dev'];
  if (host === 'localhost' || host === '127.0.0.1') return ['http://localhost:11000', 'http://localhost:10000'];
  return [];
};

const envBase = envUrl ? normalizeBase(envUrl) : '';
const inferredBases = inferCandidates().map(normalizeBase);
const candidates = (envBase ? [envBase] : inferredBases).filter(Boolean);
let apiBase = candidates[0] || '';

const getToken = () => localStorage.getItem('auth_token');
export const setToken = (token: string | null) => {
  if (token) localStorage.setItem('auth_token', token);
  else localStorage.removeItem('auth_token');
};

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!apiBase) {
    const err = new Error('missing_api_url');
    (err as any).status = 0;
    throw err;
  }
  const token = getToken();
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const startIndex = Math.max(0, candidates.indexOf(apiBase));
  const ordered = [...candidates.slice(startIndex), ...candidates.slice(0, startIndex)];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let lastErr: unknown = null;
  for (let i = 0; i < ordered.length; i++) {
    const base = ordered[i];
    const maxAttempts = ordered.length === 1 ? 4 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(`${base}${path}`, { ...init, headers });
        const text = await res.text();
        let json: any = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          const err = new Error('bad_response');
          (err as any).status = res.status;
          (err as any).raw = text?.slice?.(0, 200) ?? '';
          throw err;
        }
        if (!res.ok) {
          const err = new Error(json?.error || `http_${res.status}`);
          (err as any).status = res.status;
          throw err;
        }
        apiBase = base;
        return json as T;
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message || '');
        const status = Number(e?.status || 0);
        const retryable =
          e instanceof TypeError || msg.includes('Failed to fetch') || (msg === 'bad_response' && (status === 502 || status === 503));
        const canRetrySameBase = retryable && attempt < maxAttempts;
        if (canRetrySameBase) {
          await sleep(700 * attempt);
          continue;
        }
        const canTryNextBase = retryable && i < ordered.length - 1;
        if (!canTryNextBase) throw e;
        break;
      }
    }
  }
  throw lastErr ?? new Error('unknown_error');
}

export async function apiRegister(params: {
  username: string;
  email: string;
  password: string;
}): Promise<{ token: string; user: User }>
{
  return apiFetch('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function apiLogin(params: {
  usernameOrEmail: string;
  password: string;
}): Promise<{ token: string; user: User }>
{
  return apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function apiMe(): Promise<{ user: User }>
{
  return apiFetch('/api/auth/me');
}

export async function apiGetUserData(): Promise<{ data: UserData | null; updatedAt: string | null }>
{
  return apiFetch('/api/user/data');
}

export async function apiPutUserData(data: UserData): Promise<{ ok: boolean }>
{
  return apiFetch('/api/user/data', {
    method: 'PUT',
    body: JSON.stringify({ data }),
  });
}
