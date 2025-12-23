import type { UserData, User } from '../types';

const API_URL = (import.meta as any).env?.VITE_API_URL || '';

const getToken = () => localStorage.getItem('auth_token');
export const setToken = (token: string | null) => {
  if (token) localStorage.setItem('auth_token', token);
  else localStorage.removeItem('auth_token');
};

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
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
