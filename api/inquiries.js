import { del } from '@vercel/blob';
import { assertConfigured, requireUser, getInquiries, saveInquiries, body, send, fail } from './_lib.js';

// GET    /api/inquiries          -> the logged-in owner's custom inquiries
// PUT    /api/inquiries?id=...   -> { status } update an inquiry's status
// DELETE /api/inquiries?id=...   -> delete an inquiry and its photos
const STATUSES = ['new', 'replied', 'quoted', 'accepted', 'closed'];

export default async function handler(req, res) {
  try {
    assertConfigured();
    const uid = requireUser(req, res); if (!uid) return;
    const list = await getInquiries(uid);
    if (req.method === 'GET') return send(res, 200, { inquiries: list });
    const i = list.findIndex((x) => x.id === String(req.query?.id || ''));
    if (i < 0) return send(res, 404, { error: 'Inquiry not found.' });
    if (req.method === 'PUT') {
      const status = String(body(req).status || '');
      if (!STATUSES.includes(status)) return send(res, 400, { error: 'Unknown status.' });
      list[i].status = status; list[i].updatedAt = new Date().toISOString();
      await saveInquiries(uid, list);
      return send(res, 200, { inquiries: list });
    }
    if (req.method === 'DELETE') {
      const [gone] = list.splice(i, 1);
      await saveInquiries(uid, list);
      const imgs = (gone.options || []).map((o) => o.image).filter(Boolean);
      if (imgs.length) del(imgs).catch(() => {});
      return send(res, 200, { inquiries: list });
    }
    res.setHeader('Allow', 'GET, PUT, DELETE');
    send(res, 405, { error: 'Method not allowed' });
  } catch (e) { fail(res, e); }
}
