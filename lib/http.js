// Shared request plumbing for every function in api/.
//
// Response contract (all endpoints):
//   success  200  { ok: true, ...data }
//   failure  4xx/5xx  { ok: false, error: '<snake_case_code>' }
// Codes: 400 invalid input, 401 not signed in, 403 wrong origin, 405 wrong
// method, 413 body too large, 429 throttled, 500 our fault, 503 dependency down.
import crypto from 'node:crypto';
import { log } from './log.js';
import { reportEnvOnce } from './env.js';

export function fail(res, status, error) {
  return res.status(status).json({ ok: false, error });
}

/**
 * Returns the JSON body as an object, or `{ error, status }`.
 * Handles both a pre-parsed object (Vercel) and a raw string, and enforces the
 * size limit in both cases — a parsed body used to bypass it.
 */
export function readJson(req, limit = 4000) {
  let body = req.body;
  if (body == null || body === '') return { status: 400, error: 'bad_body' };
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > limit) return { status: 413, error: 'too_large' };
    try { body = JSON.parse(body); } catch { return { status: 400, error: 'bad_json' }; }
  } else if (typeof body === 'object' && JSON.stringify(body).length > limit) {
    return { status: 413, error: 'too_large' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: 'bad_body' };
  return { body };
}

/** Strips control characters, trims and caps length. Non-strings become ''. */
export function clean(v, max = 300) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}

/**
 * Wraps a handler: assigns a request id, rejects other methods with 405 and
 * turns anything thrown into a logged, uniform 500, so no promise rejection
 * escapes.
 */
export function route(methods, handler) {
  return async function wrapped(req, res) {
    reportEnvOnce(log);
    req.id = crypto.randomBytes(6).toString('hex');
    res.setHeader('X-Request-Id', req.id);
    res.setHeader('Cache-Control', 'no-store');
    if (!methods.includes(req.method)) {
      res.setHeader('Allow', methods.join(', '));
      return fail(res, 405, 'method_not_allowed');
    }
    try {
      return await handler(req, res);
    } catch (err) {
      log.error('unhandled', { rid: req.id, path: req.url && req.url.split('?')[0], err });
      if (!res.headersSent) return fail(res, 500, 'server_error');
    }
  };
}
