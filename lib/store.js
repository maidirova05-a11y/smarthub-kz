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

  -- marketing attribution: utm_* from the first landing, the external
  -- referrer and the first page of the visit (page = where the form was sent)
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_source   TEXT;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_medium   TEXT;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_content  TEXT;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_term     TEXT;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS referrer     TEXT;
  ALTER TABLE leads ADD COLUMN IF NOT EXISTS landing      TEXT;
`;

/** Attribution fields, in the order the columns, the CSV and the panel use. */
export const ATTRIBUTION_FIELDS = ['utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm', 'referrer', 'landing'];
const ATTRIBUTION_COLUMNS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'referrer', 'landing'];

/** The shape handed to the panel and the CSV — same for both stores. `ua`
 *  and `ipHash` stay on the server: one is diagnostics, the other a hash
 *  the panel has no use for. */
function publicLead(l) {
  const out = {
    id: l.id,
    at: l.at instanceof Date ? l.at.toISOString() : l.at,
    type: l.type,
    name: l.name,
    phone: l.phone,
    email: l.email || '',
    program: l.program || '',
    message: l.message || '',
    lang: l.lang || '',
    page: l.page || ''
  };
  for (const f of ATTRIBUTION_FIELDS) out[f] = l[f] || '';
  return out;
}

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
  const values = [lead.id, lead.at, lead.type, lead.name, lead.phone, lead.email,
    lead.program, lead.message, lead.lang, lead.page, lead.ua, lead.ipHash, lead.consentAt,
    ...ATTRIBUTION_FIELDS.map(f => lead[f] || null)];
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
  await getPool().query(
    `INSERT INTO leads (id, created_at, type, name, phone, email, program, message, lang, page, ua, ip_hash, consent_at,
                        ${ATTRIBUTION_COLUMNS.join(', ')})
     VALUES (${placeholders})
     ON CONFLICT (id) DO NOTHING`,
    values
  );
}

export async function listLeads(limit = 200) {
  if (!dbConfigured) return memory.slice(0, limit).map(publicLead);
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT id, created_at, type, name, phone, email, program, message, lang, page,
            ${ATTRIBUTION_COLUMNS.join(', ')}
       FROM leads
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit]
  );
  // the panel expects `at` and camelCase attribution keys
  return rows.map(r => {
    const l = { ...r, at: r.created_at };
    ATTRIBUTION_COLUMNS.forEach((c, i) => { l[ATTRIBUTION_FIELDS[i]] = r[c]; });
    return publicLead(l);
  });
}

/**
 * Per-IP submission counter, kept in the database so it survives the many
 * short-lived serverless instances an in-memory Map cannot span.
 * Returns how many leads that address has sent inside the window.
 */
export async function recentFromIp(ipHash, windowMinutes = 60) {
  if (!dbConfigured) {
    const since = Date.now() - windowMinutes * 60_000;
    return memory.filter(l => l.ipHash === ipHash && Date.parse(l.at) > since).length;
  }
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
  if (!dbConfigured) {
    const since = Date.now() - withinMinutes * 60_000;
    return memory.some(l => l.ipHash === ipHash && l.phone === phone && Date.parse(l.at) > since);
  }
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

/* ── request helpers ─────────────────────────────────────────────────── */

/**
 * The visitor's address as Vercel saw it. `x-real-ip` / `x-vercel-forwarded-for`
 * are set by Vercel's edge and cannot be supplied by the client; the first
 * `x-forwarded-for` entry is only a fallback for local runs.
 */
export function clientIp(req) {
  const h = req.headers;
  return (h['x-real-ip'] || h['x-vercel-forwarded-for'] || h['x-forwarded-for'] || '')
    .split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
}

export function hashIp(ip) {
  const salt = process.env.ADMIN_SECRET || 'smarthub';
  return crypto.createHmac('sha256', salt).update(ip).digest('hex').slice(0, 32);
}

/**
 * True when the request comes from one of our own pages. Compares exact
 * hostnames — a suffix check would let `evil-smarthub-kz.com` through.
 */
export function sameOrigin(req, { allowMissing = false } = {}) {
  const src = req.headers.origin || req.headers.referer || '';
  if (!src) return allowMissing;
  let from;
  try { from = new URL(src).hostname; } catch { return false; }
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
  return Boolean(host) && from === host;
}

/* ── admin login throttling ──────────────────────────────────────────── */

const LOGIN_WINDOW_MIN = 15;
const LOGIN_MAX_PER_IP = 8;
// A cap across all addresses, so a botnet cannot sidestep the per-IP limit.
const LOGIN_MAX_GLOBAL = 60;

const LOGIN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS admin_login_failures (
    ip_hash    TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS admin_login_failures_idx ON admin_login_failures (created_at DESC);
`;
let loginReady = null;
function ensureLoginSchema() {
  if (!loginReady) {
    loginReady = getPool().query(LOGIN_SCHEMA).catch(err => { loginReady = null; throw err; });
  }
  return loginReady;
}

const memFailures = []; // { ipHash, at } — fallback without a database

/** Kept in the database: an in-memory counter resets with every cold start. */
export async function loginBlocked(ipHash) {
  const since = Date.now() - LOGIN_WINDOW_MIN * 60_000;
  if (!dbConfigured) {
    const recent = memFailures.filter(f => f.at > since);
    return recent.length >= LOGIN_MAX_GLOBAL || recent.filter(f => f.ipHash === ipHash).length >= LOGIN_MAX_PER_IP;
  }
  await ensureLoginSchema();
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE ip_hash = $1)::int AS mine
       FROM admin_login_failures
      WHERE created_at > now() - ($2 || ' minutes')::interval`,
    [ipHash, String(LOGIN_WINDOW_MIN)]
  );
  const r = rows[0] || { total: 0, mine: 0 };
  return r.total >= LOGIN_MAX_GLOBAL || r.mine >= LOGIN_MAX_PER_IP;
}

export async function noteLoginFailure(ipHash) {
  if (!dbConfigured) {
    memFailures.push({ ipHash, at: Date.now() });
    if (memFailures.length > 1000) memFailures.splice(0, memFailures.length - 1000);
    return;
  }
  await ensureLoginSchema();
  await getPool().query('INSERT INTO admin_login_failures (ip_hash) VALUES ($1)', [ipHash]);
  // keep the table small
  await getPool().query(`DELETE FROM admin_login_failures WHERE created_at < now() - interval '1 day'`);
}

/* ── admin session ────────────────────────────────────────────────────── */

const COOKIE = 'sh_admin';

/**
 * Signing key. Mixing in a digest of the password means that changing
 * ADMIN_PASSWORD signs every existing session out — the one lever you need
 * after a laptop is lost.
 */
function signingKey() {
  const secret = process.env.ADMIN_SECRET || '';
  const pw = process.env.ADMIN_PASSWORD || '';
  if (!secret && !pw) return '';
  return `${secret}:${crypto.createHash('sha256').update(pw).digest('hex')}`;
}

export function issueToken(ttlHours = 12) {
  const exp = Date.now() + ttlHours * 3600_000;
  const sig = crypto.createHmac('sha256', signingKey()).update(String(exp)).digest('hex');
  return `${exp}.${sig}`;
}

export function verifyToken(token) {
  const key = signingKey();
  if (!key || !token) return false;
  const [exp, sig] = String(token).split('.');
  if (!exp || !sig) return false;
  // `Number('abc')` is NaN, and NaN passes both range checks below
  if (!/^\d+$/.test(exp)) return false;
  if (Number(exp) < Date.now()) return false;
  // a token may not claim a lifetime longer than we ever issue
  if (Number(exp) > Date.now() + 13 * 3600_000) return false;
  const expected = crypto.createHmac('sha256', key).update(exp).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function readCookie(req, name = COOKIE) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== name) continue;
    // a malformed %-sequence throws; that is an invalid token, not a crash
    try { return decodeURIComponent(v.join('=')); } catch { return ''; }
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
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.VERCEL ? '; Secure' : ''}`;
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
