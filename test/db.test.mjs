// Real-PostgreSQL checks. Skipped unless DATABASE_URL is set, and refuses to
// run against anything but a local server: the test empties the leads and
// login-failure tables. Example:
//   DATABASE_URL=postgres://postgres@127.0.0.1:5432/smarthub_test npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const URL_ = process.env.DATABASE_URL || '';
const local = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL_);
const skip = !URL_ ? 'DATABASE_URL is not set' : !local ? 'DATABASE_URL is not a local server' : false;

process.env.ADMIN_PASSWORD = 'correct horse battery staple';
process.env.ADMIN_SECRET = 'x'.repeat(40);
process.env.LOG_LEVEL = 'error';

let pg, store, lead, leads, login, health;
if (!skip) {
  pg = (await import('pg')).default;
  store = await import('../lib/store.js');
  lead = (await import('../api/lead.js')).default;
  leads = (await import('../api/leads.js')).default;
  login = (await import('../api/login.js')).default;
  health = (await import('../api/health.js')).default;
}

function call(fn, { method = 'GET', headers = {}, body, query = {} } = {}) {
  return new Promise(resolve => {
    const res = {
      code: 200, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      getHeader(k) { return this.headers[k.toLowerCase()]; },
      status(c) { this.code = c; return this; },
      json(d) { resolve({ status: this.code, body: d, headers: this.headers }); },
      send(d) { resolve({ status: this.code, body: d, headers: this.headers }); }
    };
    fn({ method, headers: { host: 'smarthub-kz.com', ...headers }, body, query, url: '/api/x' }, res);
  });
}
const own = ip => ({ origin: 'https://smarthub-kz.com', 'x-real-ip': ip });
const good = (o = {}) => ({ type: 'trial', name: 'Aigerim', phone: '+7 701 234 56 78', consent: true, elapsed: 9000, lang: 'ru', ...o });

test('db: health, schema, lead, throttles, login, csv', { skip }, async t => {
  const admin = new pg.Client({ connectionString: URL_ });
  await admin.connect();
  t.after(() => admin.end());
  await admin.query('DROP TABLE IF EXISTS leads, admin_login_failures');

  assert.deepEqual((await call(health, { method: 'GET' })).body.db, 'up');
  const tables = async () => (await admin.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('leads','admin_login_failures')")).rowCount;
  assert.equal(await tables(), 0, 'health must not create tables');

  // lazy schema + concurrent first requests
  const first = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    call(lead, { method: 'POST', headers: own(`10.0.0.${i}`), body: good({ phone: `+7 701 234 56 ${10 + i}` }) })));
  assert.ok(first.every(r => r.status === 200 && r.body.id));
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM leads')).rows[0].n, 10);

  // duplicate (same IP + phone) is swallowed; per-IP cap is 5 per hour
  await call(lead, { method: 'POST', headers: own('10.0.0.0'), body: good({ phone: '+7 701 234 56 10' }) });
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM leads')).rows[0].n, 10);
  const codes = [];
  for (let i = 0; i < 7; i++) {
    codes.push((await call(lead, { method: 'POST', headers: own('9.9.9.9'), body: good({ phone: `+7 702 000 00 ${10 + i}` }) })).status);
  }
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);

  // login throttle: 8 failures per address, then 429 even with the right password
  const bad = () => call(login, { method: 'POST', headers: own('8.8.8.8'), body: { password: 'nope' } });
  for (let i = 0; i < 8; i++) assert.equal((await bad()).status, 401);
  assert.equal((await bad()).status, 429);
  assert.equal((await call(login, { method: 'POST', headers: own('8.8.8.8'), body: { password: process.env.ADMIN_PASSWORD } })).status, 429);

  const ok = await call(login, { method: 'POST', headers: own('7.7.7.7'), body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(ok.status, 200);
  const cookie = ok.headers['set-cookie'].split(';')[0];

  assert.equal((await call(leads, { method: 'GET' })).status, 401);
  const list = await call(leads, { headers: { cookie } });
  assert.equal(list.body.persistent, true);
  assert.equal(list.body.leads.length, 15);

  const csv = await call(leads, { headers: { cookie }, query: { format: 'csv' } });
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.equal(csv.body.split('\r\n').filter(Boolean).length, 16);

  const del = await call(leads, { method: 'DELETE', headers: { cookie, origin: 'https://smarthub-kz.com' }, body: { ids: [list.body.leads[0].id] } });
  assert.equal(del.body.removed, 1);
});

test('db: separate processes creating the schema at once do not collide', { skip }, async () => {
  const admin = new pg.Client({ connectionString: URL_ });
  await admin.connect();
  await admin.query('DROP TABLE IF EXISTS leads, admin_login_failures');
  await admin.end();
  const script = `const s = await import(${JSON.stringify(new URL('../lib/store.js', import.meta.url).href)});
    await s.listLeads(1); await s.loginBlocked('x'); process.exit(0);`;
  const runs = Array.from({ length: 6 }, () => new Promise(resolve => {
    let err = '';
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, err }));
  }));
  for (const r of await Promise.all(runs)) assert.equal(r.code, 0, r.err);
});
