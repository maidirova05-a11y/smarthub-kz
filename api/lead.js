// Public endpoint the landing-page forms post to.
import crypto from 'node:crypto';
import { addLead, spamCheck, dbConfigured, clientIp, hashIp, sameOrigin } from '../lib/store.js';
import { sendToBitrix } from '../lib/bitrix.js';
import { route, fail, readJson, clean } from '../lib/http.js';
import { log } from '../lib/log.js';

const LIMIT = 4000;        // bytes of JSON we are willing to read
const MAX_PER_HOUR = 5;    // submissions allowed from one address per hour
const MIN_FILL_MS = 2500;  // a human cannot read and fill the form faster

const LANGS = new Set(['ru', 'kk', 'kz', 'en']);
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

export default route(['POST'], async (req, res) => {
  // Only our own pages may post here.
  // Browsers always send Origin on a cross-origin-capable POST; a request
  // without Origin or Referer is a script, and gets the same answer.
  if (!sameOrigin(req)) return fail(res, 403, 'bad_origin');

  const parsed = readJson(req, LIMIT);
  if (parsed.error) return fail(res, parsed.status, parsed.error);
  const body = parsed.body;

  // ── spam gates. All of them answer 200 so a bot learns nothing. ──
  const quiet = () => res.status(200).json({ ok: true });

  // 1. honeypot: a field real people never see
  if (clean(body.company)) return quiet();

  // 2. filled impossibly fast → script, not a person. Both forms on the site
  // always send `elapsed`, so a request without a usable number did not come
  // from our page — it is a script posting directly and gets the same answer.
  const elapsed = typeof body.elapsed === 'number' ? body.elapsed : NaN;
  if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) return quiet();

  // 3. links in the message are the classic spam payload
  if (/https?:\/\/|<a\s|\[url/i.test(String(body.message || ''))) return quiet();

  const name = clean(body.name, 120);
  const phone = clean(body.phone, 40);
  // без согласия обработка персональных данных незаконна
  if (body.consent !== true) return fail(res, 400, 'consent_required');
  if (!name || !phone) return fail(res, 400, 'name_and_phone_required');

  const digits = (phone.match(/\d/g) || []).length;
  if (digits < 9 || digits > 15) return fail(res, 400, 'bad_phone');

  const email = clean(body.email, 160);
  if (email && !EMAIL.test(email)) return fail(res, 400, 'bad_email');

  const ipHash = hashIp(clientIp(req));

  // Both checks also run against the in-memory store when there is no
  // database, so local runs behave like production.
  try {
    const { duplicate, recent } = await spamCheck(ipHash, phone);
    if (duplicate) return quiet();                               // double-clicked submit
    if (recent >= MAX_PER_HOUR) {
      return fail(res, 429, 'too_many_requests');
    }
  } catch (err) {
    log.error('spam check failed, letting the lead through', { rid: req.id, err });
  }

  // Marketing attribution, as the page collected it on the first landing.
  // Free text from the URL, so it is sanitised and capped like everything
  // else; the referrer must at least look like a URL to be kept.
  const referrer = clean(body.referrer, 200);

  const lead = {
    id: `${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`,
    at: new Date().toISOString(),
    type: clean(body.type, 20) === 'contact' ? 'contact' : 'trial',
    name,
    phone,
    email,
    program: clean(body.program, 160),
    message: clean(body.message, 1500),
    lang: LANGS.has(clean(body.lang, 5)) ? clean(body.lang, 5) : '',
    page: clean(body.page, 200),
    utmSource: clean(body.utm_source, 200),
    utmMedium: clean(body.utm_medium, 200),
    utmCampaign: clean(body.utm_campaign, 200),
    utmContent: clean(body.utm_content, 200),
    utmTerm: clean(body.utm_term, 200),
    referrer: /^https?:\/\//i.test(referrer) ? referrer : '',
    landing: clean(body.landing, 200),
    ua: clean(req.headers['user-agent'], 200),
    consentAt: new Date().toISOString(),
    ipHash
  };

  try {
    await addLead(lead);
  } catch (err) {
    log.error('lead store failed', { rid: req.id, err });
    return fail(res, 500, 'store_failed');
  }

  if (!dbConfigured) {
    log.warn('lead kept in memory only: DATABASE_URL is not set', { rid: req.id });
  }

  // The database already has it, so a CRM problem must not fail the visitor.
  try {
    await sendToBitrix(lead);
  } catch (err) {
    log.error('bitrix push threw', { rid: req.id, err });
  }

  log.info('lead accepted', { rid: req.id, id: lead.id, type: lead.type });
  return res.status(200).json({ ok: true, id: lead.id });
});
