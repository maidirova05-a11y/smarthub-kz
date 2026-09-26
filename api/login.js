// Admin sign-in. The password lives only in the ADMIN_PASSWORD env var —
// it is never written into the repo.
import {
  passwordMatches, issueToken, sessionCookie, clearCookie, isAuthed,
  clientIp, hashIp, sameOrigin, loginBlocked, noteLoginFailure
} from '../lib/store.js';

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

  if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'bad_origin' });

  // Failures are counted in the database, per address and across all of them,
  // so neither a cold start nor a botnet resets the budget.
  const ipHash = hashIp(clientIp(req));
  try {
    if (await loginBlocked(ipHash)) {
      return res.status(429).json({ ok: false, error: 'too_many_attempts' });
    }
  } catch (err) {
    console.error('login throttle check failed:', err.message);
    return res.status(503).json({ ok: false, error: 'try_later' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  const ok = passwordMatches(body && body.password);
  if (!ok) {
    await noteLoginFailure(ipHash).catch(err => console.error('login failure log failed:', err.message));
    console.warn(`admin login failed (ip ${ipHash.slice(0, 8)})`);
    return res.status(401).json({ ok: false, error: 'wrong_password' });
  }

  res.setHeader('Set-Cookie', sessionCookie(issueToken()));
  return res.status(200).json({ ok: true });
}
