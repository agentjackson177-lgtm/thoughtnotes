import bcrypt from 'bcryptjs';

const json = (body, init = {}) => {
  const headers = new Headers(init.headers || {});
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { ...init, headers });
};

const normalizeOriginList = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const originMatches = (origin, rule) => {
  if (!origin || !rule) return false;
  if (rule === '*') return true;
  if (rule.endsWith('*')) return origin.startsWith(rule.slice(0, -1));
  return origin === rule;
};

const withCors = (req, env, res) => {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.FRONTEND_ORIGIN || '*').trim();

  const headers = new Headers(res.headers || {});
  headers.set('Vary', 'Origin');

  if (allowed === '*') {
    headers.set('Access-Control-Allow-Origin', origin || '*');
  } else {
    const list = normalizeOriginList(allowed);
    if (origin && list.some((rule) => originMatches(origin, rule))) headers.set('Access-Control-Allow-Origin', origin);
  }
  headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};

const base64UrlEncode = (bytes) => {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlDecodeToBytes = (s) => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const hmacSha256 = async (key, data) => {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, data);
  return new Uint8Array(sig);
};

const jwtSign = async (payload, secret, expiresInSeconds) => {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };

  const headerPart = base64UrlEncode(textEncoder.encode(JSON.stringify(header)));
  const payloadPart = base64UrlEncode(textEncoder.encode(JSON.stringify(fullPayload)));
  const data = textEncoder.encode(`${headerPart}.${payloadPart}`);
  const sig = await hmacSha256(secret, data);
  const sigPart = base64UrlEncode(sig);
  return `${headerPart}.${payloadPart}.${sigPart}`;
};

const jwtVerify = async (token, secret) => {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('invalid_token');
  const [headerPart, payloadPart, sigPart] = parts;
  const data = textEncoder.encode(`${headerPart}.${payloadPart}`);
  const expected = await hmacSha256(secret, data);
  const provided = base64UrlDecodeToBytes(sigPart);
  if (provided.length !== expected.length) throw new Error('invalid_token');
  for (let i = 0; i < expected.length; i++) if (provided[i] !== expected[i]) throw new Error('invalid_token');

  const payloadJson = textDecoder.decode(base64UrlDecodeToBytes(payloadPart));
  const payload = JSON.parse(payloadJson);
  const now = Math.floor(Date.now() / 1000);
  if (!payload || typeof payload.exp !== 'number' || payload.exp < now) throw new Error('invalid_token');
  return payload;
};

const randomHex = (byteLen) => {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

const isValidUsername = (username) => /^[a-zA-Z0-9_-]{3,20}$/.test(String(username || ''));
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
const isValidPassword = (password) => typeof password === 'string' && password.length >= 6;

const readJson = async (req) => {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('bad_request');
  }
};

const getBearerToken = (req) => {
  const header = req.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
};

const requireAuth = async (req, env) => {
  const token = getBearerToken(req);
  if (!token) throw new Error('missing_token');
  const payload = await jwtVerify(token, env.JWT_SECRET);
  const userId = String(payload?.sub || '');
  const username = String(payload?.username || '');
  if (!userId || !username) throw new Error('invalid_token');
  return { id: userId, username };
};

const route = (url) => {
  const path = url.pathname || '/';
  if (path === '/') return { name: 'root' };
  if (path === '/healthz') return { name: 'healthz' };
  if (path === '/api/auth/register') return { name: 'register' };
  if (path === '/api/auth/login') return { name: 'login' };
  if (path === '/api/auth/me') return { name: 'me' };
  if (path === '/api/user/data') return { name: 'user_data' };
  if (path === '/api/items') return { name: 'items' };
  if (path.startsWith('/api/items/')) return { name: 'item', id: path.slice('/api/items/'.length) };
  return { name: 'not_found' };
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return withCors(request, env, new Response(null, { status: 204 }));
    }

    try {
      const r = route(url);

      if (r.name === 'root') {
        return withCors(request, env, json({ ok: true }));
      }

      if (r.name === 'healthz') {
        return withCors(request, env, json({ ok: true }));
      }

      if (r.name === 'register') {
        if (request.method !== 'POST') return withCors(request, env, json({ error: 'method_not_allowed' }, { status: 405 }));
        const { username, email, password } = await readJson(request);
        if (!isValidUsername(username)) return withCors(request, env, json({ error: 'invalid_username' }, { status: 400 }));
        if (!isValidEmail(email)) return withCors(request, env, json({ error: 'invalid_email' }, { status: 400 }));
        if (!isValidPassword(password)) return withCors(request, env, json({ error: 'invalid_password' }, { status: 400 }));

        const id = randomHex(16);
        const passwordHash = await bcrypt.hash(password, 12);

        try {
          await env.DB.prepare(
            'INSERT INTO app_user (id, username, email, password_hash) VALUES (?, ?, ?, ?)',
          )
            .bind(id, username, email, passwordHash)
            .run();
        } catch (e) {
          const msg = String(e?.message || '');
          if (msg.includes('UNIQUE') && (msg.includes('app_user.username') || msg.includes('username'))) {
            return withCors(request, env, json({ error: 'username_taken' }, { status: 409 }));
          }
          if (msg.includes('UNIQUE') && (msg.includes('app_user.email') || msg.includes('email'))) {
            return withCors(request, env, json({ error: 'email_taken' }, { status: 409 }));
          }
          return withCors(request, env, json({ error: 'server_error' }, { status: 500 }));
        }

        const token = await jwtSign({ sub: id, username }, env.JWT_SECRET, 30 * 24 * 60 * 60);
        return withCors(request, env, json({ token, user: { id, username, email } }));
      }

      if (r.name === 'login') {
        if (request.method !== 'POST') return withCors(request, env, json({ error: 'method_not_allowed' }, { status: 405 }));
        const { usernameOrEmail, password } = await readJson(request);
        if (!password) return withCors(request, env, json({ error: 'invalid_password' }, { status: 400 }));
        const identifier = String(usernameOrEmail || '').trim();
        if (!identifier) return withCors(request, env, json({ error: 'missing_username' }, { status: 400 }));

        const u = await env.DB.prepare(
          'SELECT id, username, email, password_hash FROM app_user WHERE username = ? OR email = ? LIMIT 1',
        )
          .bind(identifier, identifier)
          .first();

        if (!u) return withCors(request, env, json({ error: 'invalid_credentials' }, { status: 401 }));
        const ok = await bcrypt.compare(String(password), String(u.password_hash || ''));
        if (!ok) return withCors(request, env, json({ error: 'invalid_credentials' }, { status: 401 }));

        const token = await jwtSign({ sub: String(u.id), username: String(u.username) }, env.JWT_SECRET, 30 * 24 * 60 * 60);
        return withCors(request, env, json({ token, user: { id: String(u.id), username: String(u.username), email: String(u.email) } }));
      }

      if (r.name === 'me') {
        if (request.method !== 'GET') return withCors(request, env, json({ error: 'method_not_allowed' }, { status: 405 }));
        let user = null;
        try {
          const auth = await requireAuth(request, env);
          const u = await env.DB.prepare('SELECT id, username, email FROM app_user WHERE id = ? LIMIT 1').bind(auth.id).first();
          if (!u) return withCors(request, env, json({ error: 'invalid_token' }, { status: 401 }));
          user = { id: String(u.id), username: String(u.username), email: String(u.email) };
        } catch (e) {
          const msg = String(e?.message || '');
          return withCors(request, env, json({ error: msg === 'missing_token' ? 'missing_token' : 'invalid_token' }, { status: 401 }));
        }
        return withCors(request, env, json({ user }));
      }

      if (r.name === 'user_data') {
        let auth;
        try {
          auth = await requireAuth(request, env);
        } catch (e) {
          const msg = String(e?.message || '');
          return withCors(request, env, json({ error: msg === 'missing_token' ? 'missing_token' : 'invalid_token' }, { status: 401 }));
        }

        if (request.method === 'GET') {
          const row = await env.DB.prepare('SELECT data, updated_at FROM user_data WHERE user_id = ? LIMIT 1')
            .bind(auth.id)
            .first();
          if (!row) return withCors(request, env, json({ data: null, updatedAt: null }));
          let parsed = null;
          try {
            parsed = JSON.parse(String(row.data || 'null'));
          } catch {
            parsed = null;
          }
          return withCors(request, env, json({ data: parsed, updatedAt: String(row.updated_at || null) }));
        }

        if (request.method === 'PUT') {
          const { data } = await readJson(request);
          if (data === undefined) return withCors(request, env, json({ error: 'missing_data' }, { status: 400 }));
          const text = JSON.stringify(data);
          await env.DB.prepare(
            `INSERT INTO user_data (id, user_id, data)
             VALUES (?, ?, ?)
             ON CONFLICT(user_id)
             DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP`,
          )
            .bind(auth.id, auth.id, text)
            .run();
          return withCors(request, env, json({ ok: true }));
        }

        return withCors(request, env, json({ error: 'method_not_allowed' }, { status: 405 }));
      }

      if (r.name === 'items' || r.name === 'item') {
        let auth;
        try {
          auth = await requireAuth(request, env);
        } catch (e) {
          const msg = String(e?.message || '');
          return withCors(request, env, json({ error: msg === 'missing_token' ? 'missing_token' : 'invalid_token' }, { status: 401 }));
        }

        const itemId = r.name === 'item' ? String(r.id || '').trim() : '';
        if (r.name === 'item' && !itemId) return withCors(request, env, json({ error: 'not_found' }, { status: 404 }));

        if (request.method === 'GET' && r.name === 'items') {
          const result = await env.DB.prepare(
            'SELECT id, title, content, created_at, updated_at FROM items WHERE user_id = ? ORDER BY updated_at DESC',
          )
            .bind(auth.id)
            .all();
          return withCors(request, env, json(result.results || []));
        }

        if (request.method === 'POST' && r.name === 'items') {
          const { title, content } = await readJson(request);
          const t = String(title || '').trim();
          if (!t) return withCors(request, env, json({ error: 'invalid_title' }, { status: 400 }));
          const id = randomHex(16);
          await env.DB.prepare('INSERT INTO items (id, user_id, title, content) VALUES (?, ?, ?, ?)')
            .bind(id, auth.id, t, content == null ? null : String(content))
            .run();
          const row = await env.DB.prepare(
            'SELECT id, title, content, created_at, updated_at FROM items WHERE id = ? AND user_id = ? LIMIT 1',
          )
            .bind(id, auth.id)
            .first();
          return withCors(request, env, json(row));
        }

        if (request.method === 'GET' && r.name === 'item') {
          const row = await env.DB.prepare(
            'SELECT id, title, content, created_at, updated_at FROM items WHERE id = ? AND user_id = ? LIMIT 1',
          )
            .bind(itemId, auth.id)
            .first();
          if (!row) return withCors(request, env, json({ error: 'not_found' }, { status: 404 }));
          return withCors(request, env, json(row));
        }

        if (request.method === 'PUT' && r.name === 'item') {
          const { title, content } = await readJson(request);
          const t = title === undefined ? undefined : String(title || '').trim();
          if (t !== undefined && !t) return withCors(request, env, json({ error: 'invalid_title' }, { status: 400 }));
          await env.DB.prepare(
            `UPDATE items
             SET title = COALESCE(?, title),
                 content = COALESCE(?, content),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND user_id = ?`,
          )
            .bind(t ?? null, content === undefined ? null : content == null ? null : String(content), itemId, auth.id)
            .run();
          const row = await env.DB.prepare(
            'SELECT id, title, content, created_at, updated_at FROM items WHERE id = ? AND user_id = ? LIMIT 1',
          )
            .bind(itemId, auth.id)
            .first();
          if (!row) return withCors(request, env, json({ error: 'not_found' }, { status: 404 }));
          return withCors(request, env, json(row));
        }

        if (request.method === 'DELETE' && r.name === 'item') {
          await env.DB.prepare('DELETE FROM items WHERE id = ? AND user_id = ?').bind(itemId, auth.id).run();
          return withCors(request, env, json({ ok: true }));
        }

        return withCors(request, env, json({ error: 'method_not_allowed' }, { status: 405 }));
      }

      return withCors(request, env, json({ error: 'not_found' }, { status: 404 }));
    } catch (e) {
      const msg = String(e?.message || '');
      if (msg === 'bad_request') return withCors(request, env, json({ error: 'bad_request' }, { status: 400 }));
      return withCors(request, env, json({ error: 'server_error' }, { status: 500 }));
    }
  },
};
