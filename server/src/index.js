import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const { Pool } = pg;

const PORT = Number(process.env.PORT || 10000);
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';

let storeMode = process.env.USE_MEMORY_DB === '1' || !DATABASE_URL ? 'memory' : 'pg';
const memory = {
  usersById: new Map(),
  userIdByUsername: new Map(),
  userIdByEmail: new Map(),
  userDataByUserId: new Map(),
};

let pool = null;
if (storeMode === 'pg') {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });
} else {
  // eslint-disable-next-line no-console
  console.warn('[api] running in in-memory mode (no DATABASE_URL). Data will not persist.');
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(
  cors({
    origin: FRONTEND_ORIGIN === '*' ? true : FRONTEND_ORIGIN.split(',').map((s) => s.trim()),
    credentials: false,
  }),
);

const isValidUsername = (username) => /^[a-zA-Z0-9_-]{3,20}$/.test(username);
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const isValidPassword = (password) => typeof password === 'string' && password.length >= 6;

const signToken = (user) =>
  jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });

const auth = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) return res.status(401).json({ error: 'missing_token' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, username: payload.username };
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
};

async function runMigrations() {
  if (storeMode !== 'pg' || !pool) return;
  const file = path.join(process.cwd(), 'migrations', '001_init.sql');
  const sql = fs.readFileSync(file, 'utf8');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query(sql);
      // eslint-disable-next-line no-console
      console.log('[api] migrations ok');
      return;
    } catch (e) {
      const msg = String(e?.message || '');
      const code = String(e?.code || '');
      // eslint-disable-next-line no-console
      console.error(`[api] failed to connect/run migrations (attempt ${attempt}/${maxAttempts}):`, msg || e);
      if (code === 'ENOTFOUND' && msg.includes('dpg-')) {
        // eslint-disable-next-line no-console
        console.error(
          '[api] It looks like you are using Render INTERNAL Postgres hostname (dpg-...). ' +
            'That hostname only works inside Render. For local dev, use the Postgres EXTERNAL Database URL from Render.',
        );
      }
      if (attempt === maxAttempts) break;
      await sleep(800 * attempt);
    }
  }
  // eslint-disable-next-line no-console
  console.error('[api] falling back to in-memory mode. Fix DATABASE_URL to enable persistence.');
  storeMode = 'memory';
  try {
    await pool.end();
  } catch {
  }
  pool = null;
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!isValidUsername(username)) return res.status(400).json({ error: 'invalid_username' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'invalid_email' });
  if (!isValidPassword(password)) return res.status(400).json({ error: 'invalid_password' });

  const id = nanoid();
  const passwordHash = await bcrypt.hash(password, 12);

  try {
    if (storeMode === 'memory') {
      if (memory.userIdByUsername.has(username)) return res.status(409).json({ error: 'username_taken' });
      if (memory.userIdByEmail.has(email)) return res.status(409).json({ error: 'email_taken' });
      const u = { id, username, email, password_hash: passwordHash };
      memory.usersById.set(id, u);
      memory.userIdByUsername.set(username, id);
      memory.userIdByEmail.set(email, id);
    } else {
      await pool.query(
        'INSERT INTO app_user (id, username, email, password_hash) VALUES ($1,$2,$3,$4)',
        [id, username, email, passwordHash],
      );
    }
    const token = signToken({ id, username });
    return res.json({ token, user: { id, username, email } });
  } catch (e) {
    const msg = String(e?.message || '');
    if (msg.includes('app_user_username_key')) return res.status(409).json({ error: 'username_taken' });
    if (msg.includes('app_user_email_key')) return res.status(409).json({ error: 'email_taken' });
    // eslint-disable-next-line no-console
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { usernameOrEmail, password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'invalid_password' });

  const identifier = String(usernameOrEmail || '').trim();
  if (!identifier) return res.status(400).json({ error: 'missing_username' });

  try {
    let u = null;
    if (storeMode === 'memory') {
      const userId = memory.userIdByUsername.get(identifier) ?? memory.userIdByEmail.get(identifier);
      u = userId ? memory.usersById.get(userId) : null;
    } else {
      const { rows } = await pool.query(
        'SELECT id, username, email, password_hash FROM app_user WHERE username=$1 OR email=$1 LIMIT 1',
        [identifier],
      );
      u = rows[0];
    }
    if (!u) return res.status(401).json({ error: 'invalid_credentials' });

    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

    const token = signToken({ id: u.id, username: u.username });
    return res.json({ token, user: { id: u.id, username: u.username, email: u.email } });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    let u = null;
    if (storeMode === 'memory') {
      const found = memory.usersById.get(req.user.id);
      u = found ? { id: found.id, username: found.username, email: found.email } : null;
    } else {
      const { rows } = await pool.query('SELECT id, username, email FROM app_user WHERE id=$1', [req.user.id]);
      u = rows[0];
    }
    if (!u) return res.status(401).json({ error: 'invalid_token' });
    return res.json({ user: u });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/user/data', auth, async (req, res) => {
  try {
    if (storeMode === 'memory') {
      const row = memory.userDataByUserId.get(req.user.id);
      if (!row) return res.json({ data: null, updatedAt: null });
      return res.json({ data: row.data, updatedAt: row.updatedAt });
    }
    const { rows } = await pool.query('SELECT data, updated_at FROM user_data WHERE user_id=$1', [req.user.id]);
    if (!rows[0]) return res.json({ data: null, updatedAt: null });
    return res.json({ data: rows[0].data, updatedAt: rows[0].updated_at });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.put('/api/user/data', auth, async (req, res) => {
  const { data } = req.body || {};
  if (data === undefined) return res.status(400).json({ error: 'missing_data' });

  try {
    if (storeMode === 'memory') {
      memory.userDataByUserId.set(req.user.id, { data, updatedAt: new Date().toISOString() });
    } else {
      await pool.query(
        `INSERT INTO user_data (user_id, data, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id)
         DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [req.user.id, data],
      );
    }
    return res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
});

await runMigrations();

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on :${PORT}`);
});
