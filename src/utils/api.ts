import type { UserData, User } from '../types';

const normalizeBase = (u: string) => u.replace(/\/+$/, '');

const envUrl = String((import.meta as any).env?.VITE_API_URL || '').trim();
// Fallbacks:
// - Render prod site → use your deployed API
// - Local dev (vite default) → use local API
const inferredUrl =
  typeof window !== 'undefined' && window.location?.hostname === 'thoughtnotes.onrender.com'
    ? 'https://mindmap-api-qcew.onrender.com'
    : typeof window !== 'undefined' &&
        (window.location?.hostname === 'localhost' || window.location?.hostname === '127.0.0.1')
      ? 'http://localhost:10000'
      : '';

const API_URL = normalizeBase(envUrl || inferredUrl);

const getToken = () => localStorage.getItem('auth_token');
export const setToken = (token: string | null) => {
  if (token) localStorage.setItem('auth_token', token);
  else localStorage.removeItem('auth_token');
};

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_URL) {
    const err = new Error('missing_api_url');
    (err as any).status = 0;
    throw err;
  }
  const token = getToken();
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON response (often HTML 404/502)
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
  return json as T;
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
