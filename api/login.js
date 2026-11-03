// Admin sign-in. The password lives only in the ADMIN_PASSWORD env var —
// it is never written into the repo.
import {
  passwordMatches, issueToken, sessionCookie, clearCookie, isAuthed,
  clientIp, hashIp, sameOrigin, loginBlocked, noteLoginFailure
} from '../lib/store.js';
import { route, fail } from '../lib/http.js';
import { log } from '../lib/log.js';

export default route(['GET', 'POST', 'DELETE'], async (req, res) => {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, authed: isAuthed(req) });
  }
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearCookie());
    return res.status(200).json({ ok: true });
  }
  if (!process.env.ADMIN_PASSWORD) {
    return fail(res, 503, 'admin_not_configured');
  }

  if (!sameOrigin(req)) return fail(res, 403, 'bad_origin');

  // Failures are counted in the database, per address and across all of them,
  // so neither a cold start nor a botnet resets the budget.
  const ipHash = hashIp(clientIp(req));
  try {
    if (await loginBlocked(ipHash)) {
      return fail(res, 429, 'too_many_attempts');
    }
  } catch (err) {
    log.error('login throttle check failed', { rid: req.id, err });
    return fail(res, 503, 'try_later');
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
    await noteLoginFailure(ipHash).catch(err => log.error('login failure log failed', { rid: req.id, err }));
    log.warn('admin login failed', { rid: req.id, ip: ipHash.slice(0, 8) });
    return fail(res, 401, 'wrong_password');
  }

  res.setHeader('Set-Cookie', sessionCookie(issueToken()));
  return res.status(200).json({ ok: true });
});
