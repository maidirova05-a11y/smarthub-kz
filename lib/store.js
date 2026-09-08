// Storage + admin-session helpers.
//
// Leads live in PostgreSQL. Any server works — Neon, Supabase, Vercel Postgres
// or your own box — because this uses plain `pg` rather than a vendor driver.
// With no connection string configured the module falls back to an in-process
// array so the site still runs locally; that store is wiped on every restart,
// so it is only ever a development convenience.

import crypto from 'node:crypto';
import pg from 'pg';

const CONN =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  '';

export const dbConfigured = Boolean(CONN);

const memory = [];

/* ── connection ───────────────────────────────────────────────────────── */

let pool = null;

function sslFor(url) {
  if (/localhost|127\.0\.0\.1/.test(url)) return false;
  // Managed providers have valid certificates, so verify by default.
  // Set PGSSL_NO_VERIFY=1 only if your server uses a self-signed chain.
  return process.env.PGSSL_NO_VERIFY === '1' ? { rejectUnauthorized: false } : true;
}

function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: CONN,
      ssl: sslFor(CONN),
      // Serverless: many short-lived instances, so keep each one tiny.
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000
    });
    pool.on('error', err => console.error('pg pool error:', err.message));
  }
  return pool;
}

/* ── schema ───────────────────────────────────────────────────────────── */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS leads (
    id          TEXT PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    type        TEXT        NOT NULL,
    name        TEXT        NOT NULL,
    phone       TEXT        NOT NULL,
    email       TEXT,
    program     TEXT,
    message     TEXT,
    lang        TEXT,
    page        TEXT,
    ua          TEXT
  );
  CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads (created_at DESC);

  -- added later: the table may already exist without it
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS ip_hash TEXT;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS leads_ip_recent_idx ON leads (ip_hash, created_at DESC);
`;

// Runs once per instance; concurrent callers await the same promise.
let ready = null;
function ensureSchema() {
  if (!ready) {
    ready = getPool()
      .query(SCHEMA)
      .catch(err => {
        ready = null; // let a later request retry
        throw err;
      });
  }
  return ready;
}

/* ── leads ────────────────────────────────────────────────────────────── */

export async function addLead(lead) {
  if (!dbConfigured) {
    memory.unshift(lead);
    memory.length = Math.min(memory.length, 500);
    return;
  }
  await ensureSchema();
  await getPool().query(
    `INSERT INTO leads (id, created_at, type, name, phone, email, program, message, lang, page, ua, ip_hash, consent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (id) DO NOTHING`,
    [lead.id, lead.at, lead.type, lead.name, lead.phone, lead.email,
     lead.program, lead.message, lead.lang, lead.page, lead.ua, lead.ipHash, lead.consentAt]
  );
}

export async function listLeads(limit = 200) {
  // `ua` is kept for diagnostics but never handed to the panel — mirror the
  // column list of the SQL query below so both paths return the same shape.
  if (!dbConfigured) return memory.slice(0, limit).map(({ ua, ...rest }) => rest);
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT id, created_at, type, name, phone, email, program, message, lang, page
       FROM leads
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit]
  );
  // the panel expects `at`
  return rows.map(r => ({
    id: r.id,
    at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    type: r.type,
    name: r.name,
    phone: r.phone,
    email: r.email || '',
    program: r.program || '',
    message: r.message || '',
    lang: r.lang || '',
    page: r.page || ''
  }));
}

/**
 * Per-IP submission counter, kept in the database so it survives the many
 * short-lived serverless instances an in-memory Map cannot span.
 * Returns how many leads that address has sent inside the window.
 */
export async function recentFromIp(ipHash, windowMinutes = 60) {
  if (!dbConfigured) return 0;
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM leads
      WHERE ip_hash = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
    [ipHash, String(windowMinutes)]
  );
  return rows[0] ? rows[0].n : 0;
}

/** True when the exact same person submitted the same thing moments ago. */
export async function isDuplicate(ipHash, phone, withinMinutes = 10) {
  if (!dbConfigured) return false;
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT 1 FROM leads
      WHERE ip_hash = $1 AND phone = $2
        AND created_at > now() - ($3 || ' minutes')::interval
      LIMIT 1`,
    [ipHash, phone, String(withinMinutes)]
  );
  return rows.length > 0;
}

/** Removes the given ids. Returns how many rows actually went. */
export async function deleteLeads(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String).slice(0, 200);
  if (!list.length) return 0;

  if (!dbConfigured) {
    const before = memory.length;
    for (let i = memory.length - 1; i >= 0; i--) {
      if (list.includes(memory[i].id)) memory.splice(i, 1);
    }
    return before - memory.length;
  }
  await ensureSchema();
  const { rowCount } = await getPool().query(
    'DELETE FROM leads WHERE id = ANY($1::text[])',
    [list]
  );
  return rowCount;
}

/* ── admin session ────────────────────────────────────────────────────── */

const SECRET = process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || '';
const COOKIE = 'sh_admin';

export function issueToken(ttlHours = 12) {
  const exp = Date.now() + ttlHours * 3600_000;
  const sig = crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
  return `${exp}.${sig}`;
}

export function verifyToken(token) {
  if (!SECRET || !token) return false;
  const [exp, sig] = String(token).split('.');
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', SECRET).update(exp).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function readCookie(req, name = COOKIE) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

export function sessionCookie(token, ttlHours = 12) {
  const bits = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${ttlHours * 3600}`
  ];
  if (process.env.VERCEL) bits.push('Secure');
  return bits.join('; ');
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function isAuthed(req) {
  return verifyToken(readCookie(req));
}

/** Constant-time password check that never short-circuits on length. */
export function passwordMatches(input) {
  const real = process.env.ADMIN_PASSWORD || '';
  if (!real) return false;
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  return crypto.timingSafeEqual(a, b);
}
