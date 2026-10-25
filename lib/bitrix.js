// Pushes a website enquiry into Bitrix24 as a DEAL in the "Smart Hub" pipeline.
//
// The webhook URL is a credential: anyone holding it can read and write the
// CRM. It therefore lives only in BITRIX_WEBHOOK_URL and is never logged,
// never returned to the browser and never committed.
//
// Delivery is best-effort by design: the database is the source of truth, so a
// Bitrix outage must never make a visitor's form submission fail.

const RAW = process.env.BITRIX_WEBHOOK_URL || '';
const BASE = RAW.replace(/\/+$/, '');

// "Smart Hub" funnel, stage "Новая заявка". Overridable so the pipeline can be
// moved in Bitrix without touching the code.
const CATEGORY_ID = process.env.BITRIX_CATEGORY_ID || '1';
const STAGE_ID = process.env.BITRIX_STAGE_ID || 'C1:NEW';

export const bitrixConfigured = Boolean(BASE);

/** Strips the secret out of anything we might print. */
function safe(text) {
  return String(text).replace(/\/rest\/\d+\/[A-Za-z0-9]+/g, '/rest/***');
}

/** One REST call, sharing a deadline with the rest of the batch. */
async function call(method, payload, deadline) {
  const left = deadline - Date.now();
  if (left <= 200) throw new Error('timeout');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), left);
  try {
    const res = await fetch(`${BASE}/${method}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new Error(safe(data.error_description || data.error || `HTTP ${res.status}`));
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

const TITLE = { trial: 'Пробный урок', contact: 'Вопрос с сайта' };

/** Reuses an existing contact with this phone instead of piling up duplicates. */
async function findContact(phone, deadline) {
  try {
    const dup = await call('crm.duplicate.findbycomm',
      { entity_type: 'CONTACT', type: 'PHONE', values: [phone] }, deadline);
    const ids = dup && dup.CONTACT;
    return Array.isArray(ids) && ids.length ? ids[0] : null;
  } catch {
    return null; // not worth failing the whole push over
  }
}

export async function sendToBitrix(lead, { timeoutMs = 7000 } = {}) {
  if (!BASE) return { ok: false, skipped: true };
  const deadline = Date.now() + timeoutMs;

  try {
    let contactId = await findContact(lead.phone, deadline);

    if (!contactId) {
      const fields = {
        NAME: lead.name,
        OPENED: 'Y',
        TYPE_ID: 'CLIENT',
        SOURCE_ID: 'WEB',
        SOURCE_DESCRIPTION: 'smarthub-kz.com',
        PHONE: [{ VALUE: lead.phone, VALUE_TYPE: 'MOBILE' }]
      };
      if (lead.email) fields.EMAIL = [{ VALUE: lead.email, VALUE_TYPE: 'WORK' }];
      contactId = await call('crm.contact.add', { fields, params: { REGISTER_SONET_EVENT: 'N' } }, deadline);
    }

    const utm = [lead.utmSource, lead.utmMedium, lead.utmCampaign].filter(Boolean).join(' / ');
    const comments = [
      lead.program && `Программа: ${lead.program}`,
      lead.message && `Сообщение: ${lead.message}`,
      lead.email && `Почта: ${lead.email}`,
      lead.lang && `Язык сайта: ${lead.lang}`,
      lead.page && `Страница: ${lead.page}`,
      utm && `Источник (utm): ${utm}`,
      lead.utmContent && `Объявление (utm_content): ${lead.utmContent}`,
      lead.utmTerm && `Ключевое слово (utm_term): ${lead.utmTerm}`,
      lead.referrer && `Переход с: ${lead.referrer}`,
      lead.landing && `Первая страница визита: ${lead.landing}`
    ].filter(Boolean).join('\n');

    // Bitrix24 has these as standard deal fields; the "Источники" report and
    // the ad-spend analytics read them from here, not from the comment.
    const utmFields = {
      UTM_SOURCE: lead.utmSource,
      UTM_MEDIUM: lead.utmMedium,
      UTM_CAMPAIGN: lead.utmCampaign,
      UTM_CONTENT: lead.utmContent,
      UTM_TERM: lead.utmTerm
    };
    for (const k of Object.keys(utmFields)) if (!utmFields[k]) delete utmFields[k];

    const dealId = await call('crm.deal.add', {
      fields: {
        TITLE: `${TITLE[lead.type] || 'Заявка'} с сайта — ${lead.name} (${lead.phone})`,
        CATEGORY_ID,
        STAGE_ID,
        CONTACT_ID: contactId,
        OPENED: 'Y',
        SOURCE_ID: 'WEB',
        SOURCE_DESCRIPTION: 'smarthub-kz.com',
        ASSIGNED_BY_ID: process.env.BITRIX_ASSIGNED_BY_ID || undefined,
        COMMENTS: comments,
        ...utmFields
      },
      params: { REGISTER_SONET_EVENT: 'Y' }
    }, deadline);

    return { ok: true, dealId, contactId };
  } catch (err) {
    console.error('bitrix push failed:', safe(err.message));
    return { ok: false, error: 'push_failed' };
  }
}
