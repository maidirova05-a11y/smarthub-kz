// Liveness/readiness probe for uptime monitors and Docker. Public, so it
// reveals only coarse state: no env values, no counts, no error text.
import { route } from '../lib/http.js';
import { log } from '../lib/log.js';
import { pingDb } from '../lib/store.js';
import { bitrixConfigured } from '../lib/bitrix.js';
import { checkEnv } from '../lib/env.js';

export default route(['GET', 'HEAD'], async (req, res) => {
  let db;
  try {
    db = await Promise.race([
      pingDb(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('db ping timeout')), 3000).unref())
    ]);
  } catch (err) {
    log.error('health: database down', { rid: req.id, err });
    return res.status(503).json({ ok: false, error: 'db_down', db: 'down' });
  }
  const env = checkEnv();
  // Misconfiguration is reported but does not fail the probe: it must not
  // make the platform restart a site that is serving visitors.
  return res.status(200).json({
    ok: true,
    db,
    crm: bitrixConfigured ? 'configured' : 'off',
    config: env.ok ? 'ok' : 'invalid',
    time: new Date().toISOString()
  });
});
