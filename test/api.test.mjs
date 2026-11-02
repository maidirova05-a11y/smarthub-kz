// Run with: npm test  (node --test). No database: the in-memory store is used.
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL; delete process.env.POSTGRES_URL; delete process.env.POSTGRES_PRISMA_URL;
process.env.ADMIN_PASSWORD = 'correct horse battery staple';
process.env.ADMIN_SECRET = 'x'.repeat(40);
process.env.LOG_LEVEL = 'error';

const { default: lead } = await import('../api/lead.js');
const { default: leads } = await import('../api/leads.js');
const { default: login } = await import('../api/login.js');
const { default: health } = await import('../api/health.js');
const store = await import('../lib/store.js');
const { checkEnv } = await import('../lib/env.js');

function call(fn, { method = 'GET', headers = {}, body, query = {} } = {}) {
  return new Promise(resolve => {
    const res = {
      code: 200, headers: {}, headersSent: false,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.code = c; return this; },
      json(d) { this.headersSent = true; resolve({ status: this.code, body: d, headers: this.headers }); },
      send(d) { this.headersSent = true; resolve({ status: this.code, body: d, headers: this.headers }); }
    };
    const req = { method, headers: { host: 'smarthub-kz.com', ...headers }, body, query, url: '/api/x' };
    fn(req, res);
  });
}
const own = { origin: 'https://smarthub-kz.com' };
const good = (o = {}) => ({
  type: 'trial', name: 'Aigerim', phone: '+7 701 234 56 78', consent: true,
  elapsed: 9000, lang: 'ru', ...o
});

test('lead: only POST', async () => {
  const r = await call(lead, { method: 'GET' });
  assert.equal(r.status, 405);
  assert.deepEqual(r.body, { ok: false, error: 'method_not_allowed' });
  assert.equal(r.headers.allow, 'POST');
});

test('lead: foreign origin and missing origin are refused', async () => {
  assert.equal((await call(lead, { method: 'POST', headers: { origin: 'https://evil.com' }, body: good() })).status, 403);
  assert.equal((await call(lead, { method: 'POST', body: good() })).status, 403);
  assert.equal((await call(lead, { method: 'POST', headers: { origin: 'https://evil-smarthub-kz.com' }, body: good() })).status, 403);
});

test('lead: validation errors', async () => {
  const post = body => call(lead, { method: 'POST', headers: own, body });
  assert.equal((await post('{bad')).body.error, 'bad_json');
  assert.equal((await post('[]')).body.error, 'bad_body');
  assert.equal((await post(good({ message: 'x'.repeat(5000) }))).status, 413);
  assert.equal((await post(good({ consent: false }))).body.error, 'consent_required');
  assert.equal((await post(good({ name: '' }))).body.error, 'name_and_phone_required');
  assert.equal((await post(good({ phone: '123' }))).body.error, 'bad_phone');
  assert.equal((await post(good({ email: 'nope' }))).body.error, 'bad_email');
});

test('lead: bots get a quiet 200 and nothing is stored', async () => {
  const post = body => call(lead, { method: 'POST', headers: own, body });
  const before = (await store.listLeads()).length;
  for (const b of [good({ company: 'spam' }), good({ elapsed: 100 }), good({ elapsed: undefined }), good({ message: 'see http://x.io' })]) {
    const r = await post(b);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, undefined);
  }
  assert.equal((await store.listLeads()).length, before);
});

test('lead: accepted, duplicate swallowed, per-IP cap, admin sees it', async () => {
  const hdr = { ...own, 'x-real-ip': '10.0.0.1' };
  const r = await call(lead, { method: 'POST', headers: hdr, body: good() });
  assert.equal(r.status, 200);
  assert.ok(r.body.id);
  const dup = await call(lead, { method: 'POST', headers: hdr, body: good() });
  assert.equal(dup.body.id, undefined);
  for (let i = 0; i < 4; i++) {
    await call(lead, { method: 'POST', headers: hdr, body: good({ phone: `+7 701 000 00 0${i}` }) });
  }
  const capped = await call(lead, { method: 'POST', headers: hdr, body: good({ phone: '+7 701 999 99 99' }) });
  assert.equal(capped.status, 429);

  assert.equal((await call(leads)).status, 401);
  const cookie = `sh_admin=${encodeURIComponent(store.issueToken())}`;
  const list = await call(leads, { headers: { cookie } });
  assert.equal(list.status, 200);
  assert.ok(list.body.leads.length >= 5);
  assert.equal(list.body.leads[0].ipHash, undefined);
  assert.equal((await call(leads, { method: 'DELETE', headers: { cookie, ...own }, query: {} })).body.error, 'no_ids');
  assert.equal((await call(leads, { method: 'DELETE', headers: { cookie }, query: { id: 'x' } })).status, 403);
});

test('login: wrong password, then right one; garbage token rejected', async () => {
  const hdr = { ...own, 'x-real-ip': '10.0.0.2' };
  assert.equal((await call(login, { method: 'POST', headers: hdr, body: { password: 'nope' } })).status, 401);
  const ok = await call(login, { method: 'POST', headers: hdr, body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['set-cookie'], /HttpOnly/);
  assert.equal(store.verifyToken('abc.def'), false);
  assert.equal(store.verifyToken('NaN.abc'), false);
  assert.equal(store.verifyToken(store.issueToken()), true);
  assert.equal((await call(login, { method: 'PUT' })).status, 405);
});

test('login: brute force is throttled', async () => {
  const hdr = { ...own, 'x-real-ip': '10.0.0.3' };
  let last;
  for (let i = 0; i < 10; i++) last = await call(login, { method: 'POST', headers: hdr, body: { password: 'bad' + i } });
  assert.equal(last.status, 429);
});

test('health: ok without secrets', async () => {
  const r = await call(health);
  assert.equal(r.status, 200);
  assert.equal(r.body.db, 'memory');
  assert.ok(!JSON.stringify(r.body).includes(process.env.ADMIN_SECRET));
});

test('env check', () => {
  assert.equal(checkEnv({ VERCEL: '1' }).ok, false);
  assert.equal(checkEnv({ VERCEL: '1', DATABASE_URL: 'postgres://a', ADMIN_PASSWORD: 'p'.repeat(14), ADMIN_SECRET: 's'.repeat(40) }).ok, true);
  assert.equal(checkEnv({ DATABASE_URL: 'mysql://a' }).ok, false);
});
