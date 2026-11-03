// Admin-only feed of submissions. The panel polls GET; DELETE removes rows.
// GET ?format=csv hands the same rows over as a spreadsheet download.
import { route, fail } from '../lib/http.js';
import { log } from '../lib/log.js';
import { listLeads, deleteLeads, isAuthed, dbConfigured, sameOrigin, ATTRIBUTION_FIELDS } from '../lib/store.js';

const CSV_COLUMNS = ['at', 'type', 'name', 'phone', 'email', 'program', 'message', 'lang', 'page', ...ATTRIBUTION_FIELDS];

/**
 * One CSV cell. Quotes are doubled, and a value that a spreadsheet would run
 * as a formula (=, @, tab, CR, or a leading +/-) gets a leading apostrophe —
 * the classic CSV-injection fix. The only +/- cell kept as is looks like a
 * phone number from start to end, so "+7 700 …" survives while
 * "+1+cmd|' /C calc'!A0" does not.
 */
function cell(v) {
  let t = String(v == null ? '' : v);
  if (/^[=@\t\r]/.test(t) || (/^[+-]/.test(t) && !/^[+-][\d\s().-]*$/.test(t))) t = `'${t}`;
  return `"${t.replace(/"/g, '""')}"`;
}

function toCsv(leads) {
  const lines = [CSV_COLUMNS.join(';')];
  for (const l of leads) lines.push(CSV_COLUMNS.map(c => cell(l[c])).join(';'));
  // BOM so Excel opens the Cyrillic correctly; semicolons for its ru/kk locale
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export default route(['GET', 'DELETE'], async (req, res) => {
  if (!isAuthed(req)) return fail(res, 401, 'unauthorised');

  if (req.method === 'DELETE') {
    // SameSite=Strict already stops cross-site cookies; this is the second lock.
    if (!sameOrigin(req)) return fail(res, 403, 'bad_origin');
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
    if (!ids.length) return fail(res, 400, 'no_ids');

    try {
      const removed = await deleteLeads(ids);
      return res.status(200).json({ ok: true, removed });
    } catch (err) {
      log.error('lead delete failed', { rid: req.id, err });
      return fail(res, 500, 'delete_failed');
    }
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
    log.error('lead read failed', { rid: req.id, err });
    return fail(res, 500, 'read_failed');
  }
});
