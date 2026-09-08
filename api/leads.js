// Admin-only feed of submissions. The panel polls GET; DELETE removes rows.
import { listLeads, deleteLeads, isAuthed, dbConfigured } from '../lib/store.js';

export default async function handler(req, res) {
  if (!isAuthed(req)) return res.status(401).json({ ok: false, error: 'unauthorised' });

  if (req.method === 'DELETE') {
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

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  try {
    const leads = await listLeads(limit);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, leads, persistent: dbConfigured });
  } catch (err) {
    console.error('lead read failed:', err);
    return res.status(500).json({ ok: false, error: 'read_failed' });
  }
}
