// Admin-only feed of submissions. The panel polls GET; DELETE removes rows.
// GET ?format=csv hands the same rows over as a spreadsheet download.
import { listLeads, deleteLeads, isAuthed, dbConfigured, sameOrigin, ATTRIBUTION_FIELDS } from '../lib/store.js';

const CSV_COLUMNS = ['at', 'type', 'name', 'phone', 'email', 'program', 'message', 'lang', 'page', ...ATTRIBUTION_FIELDS];

/**
 * One CSV cell. Quotes are doubled, and a value that a spreadsheet would run
 * as a formula (=, @, or a +/- that does not start a number) gets a leading
 * apostrophe — the classic CSV-injection fix; phone numbers keep their "+".
 */
function cell(v) {
  let t = String(v == null ? '' : v);
  if (/^[=@\t\r]/.test(t) || /^[+-](?![\d\s(])/.test(t)) t = `'${t}`;
  return `"${t.replace(/"/g, '""')}"`;
}

function toCsv(leads) {
  const lines = [CSV_COLUMNS.join(';')];
  for (const l of leads) lines.push(CSV_COLUMNS.map(c => cell(l[c])).join(';'));
  // BOM so Excel opens the Cyrillic correctly; semicolons for its ru/kk locale
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export default async function handler(req, res) {
  if (!isAuthed(req)) return res.status(401).json({ ok: false, error: 'unauthorised' });

  if (req.method === 'DELETE') {
    // SameSite=Strict already stops cross-site cookies; this is the second lock.
    if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'bad_origin' });
    let ids = [];
    const q = req.query.id;
    if (q) ids = String(q).split(',');
    else {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
      }
      if (body && Array.isArray(body.ids)) ids = body.ids;
      else if (body && body.id) ids = [body.id];
    }
    if (!ids.length) return res.status(400).json({ ok: false, error: 'no_ids' });

    try {
      const removed = await deleteLeads(ids);
      return res.status(200).json({ ok: true, removed });
    } catch (err) {
      console.error('lead delete failed:', err);
      return res.status(500).json({ ok: false, error: 'delete_failed' });
    }
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, DELETE');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const csv = String(req.query.format || '').toLowerCase() === 'csv';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || (csv ? 500 : 200), 1), 500);
  try {
    const leads = await listLeads(limit);
    res.setHeader('Cache-Control', 'no-store');
    if (csv) {
      const day = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="smarthub-leads-${day}.csv"`);
      return res.status(200).send(toCsv(leads));
    }
    return res.status(200).json({ ok: true, leads, persistent: dbConfigured });
  } catch (err) {
    console.error('lead read failed:', err);
    return res.status(500).json({ ok: false, error: 'read_failed' });
  }
}
