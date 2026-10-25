// Public endpoint the landing-page forms post to.
import crypto from 'node:crypto';
import { addLead, recentFromIp, isDuplicate, dbConfigured, clientIp, hashIp, sameOrigin } from '../lib/store.js';
import { sendToBitrix } from '../lib/bitrix.js';

const LIMIT = 4000;        // bytes of JSON we are willing to read
const MAX_PER_HOUR = 5;    // submissions allowed from one address per hour
const MIN_FILL_MS = 2500;  // a human cannot read and fill the form faster

// strips control characters only — spaces, brackets and dashes in a phone
// number must survive untouched
function clean(v, max = 300) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // Only our own pages may post here.
  // Browsers always send Origin on a cross-origin-capable POST; a request
  // without Origin or Referer is a script, and gets the same answer.
  if (!sameOrigin(req)) {
    return res.status(403).json({ ok: false, error: 'bad_origin' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    if (body.length > LIMIT) return res.status(413).json({ ok: false, error: 'too_large' });
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ ok: false, error: 'bad_json' });
    }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ ok: false, error: 'bad_body' });

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
  if (body.consent !== true) return res.status(400).json({ ok: false, error: 'consent_required' });
  if (!name || !phone) return res.status(400).json({ ok: false, error: 'name_and_phone_required' });

  const digits = (phone.match(/\d/g) || []).length;
  if (digits < 9 || digits > 15) return res.status(400).json({ ok: false, error: 'bad_phone' });

  const ipHash = hashIp(clientIp(req));

  // Both checks also run against the in-memory store when there is no
  // database, so local runs behave like production.
  try {
    if (await isDuplicate(ipHash, phone)) return quiet();       // double-clicked submit
    if (await recentFromIp(ipHash) >= MAX_PER_HOUR) {
      return res.status(429).json({ ok: false, error: 'too_many_requests' });
    }
  } catch (err) {
    console.error('spam check failed, letting the lead through:', err.message);
  }

  // Marketing attribution, as the page collected it on the first landing.
  // Free text from the URL, so it is sanitised and capped like everything
  // else; the referrer must at least look like a URL to be kept.
  const referrer = clean(body.referrer, 200);

  const lead = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    type: clean(body.type, 20) === 'contact' ? 'contact' : 'trial',
    name,
    phone,
    email: clean(body.email, 160),
    program: clean(body.program, 160),
    message: clean(body.message, 1500),
    lang: clean(body.lang, 5),
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
    console.error('lead store failed:', err);
    return res.status(500).json({ ok: false, error: 'store_failed' });
  }

  if (!dbConfigured) {
    console.warn('DATABASE_URL is not set — this lead is only in memory and will be lost on restart');
  }

  // The database already has it, so a CRM problem must not fail the visitor.
  try {
    await sendToBitrix(lead);
  } catch (err) {
    console.error('bitrix push threw:', err.message);
  }

  return res.status(200).json({ ok: true, id: lead.id });
}
