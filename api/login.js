// Admin sign-in. The password lives only in the ADMIN_PASSWORD env var —
// it is never written into the repo.
import { passwordMatches, issueToken, sessionCookie, clearCookie, isAuthed } from '../lib/store.js';

const attempts = new Map(); // ip -> { n, until }  (best-effort, per instance)

function throttled(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.until) {
    attempts.delete(ip);
    return false;
  }
  return rec.n >= 8;
}

function note(ip, ok) {
  if (ok) return attempts.delete(ip);
  const rec = attempts.get(ip) || { n: 0, until: Date.now() + 15 * 60_000 };
  rec.n += 1;
  attempts.set(ip, rec);
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, authed: isAuthed(req) });
  }
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearCookie());
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ ok: false, error: 'admin_password_not_set' });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'local';
  if (throttled(ip)) return res.status(429).json({ ok: false, error: 'too_many_attempts' });

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  const ok = passwordMatches(body && body.password);
  note(ip, ok);
  if (!ok) return res.status(401).json({ ok: false, error: 'wrong_password' });

  res.setHeader('Set-Cookie', sessionCookie(issueToken()));
  return res.status(200).json({ ok: true });
}
