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

if (!DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn('[api] DATABASE_URL is not set. The server will not work without a database.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

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
  const file = path.join(process.cwd(), 'migrations', '001_init.sql');
  const sql = fs.readFileSync(file, 'utf8');
  try {
    await pool.query(sql);
    // eslint-disable-next-line no-console
    console.log('[api] migrations ok');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[api] failed to connect/run migrations:', e?.message || e);
    const msg = String(e?.message || '');
    const code = String(e?.code || '');
    if (code === 'ENOTFOUND' && msg.includes('dpg-')) {
      // eslint-disable-next-line no-console
      console.error(
        '[api] It looks like you are using Render INTERNAL Postgres hostname (dpg-...). ' +
          'That hostname only works inside Render. For local dev, use the Postgres EXTERNAL Database URL from Render.',
      );
    }
    process.exit(1);
  }
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
    await pool.query(
      'INSERT INTO app_user (id, username, email, password_hash) VALUES ($1,$2,$3,$4)',
      [id, username, email, passwordHash],
    );
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
    const { rows } = await pool.query(
      'SELECT id, username, email, password_hash FROM app_user WHERE username=$1 OR email=$1 LIMIT 1',
      [identifier],
    );
    const u = rows[0];
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
    const { rows } = await pool.query('SELECT id, username, email FROM app_user WHERE id=$1', [req.user.id]);
    const u = rows[0];
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
    await pool.query(
      `INSERT INTO user_data (user_id, data, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [req.user.id, data],
    );
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
