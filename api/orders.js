import { assertConfigured, requireUser, getOrders, saveOrders, body, send, fail } from './_lib.js';

// GET /api/orders            -> the logged-in owner's received orders
// PUT /api/orders?id=...     -> update an order's status
const STATUSES = ['new', 'confirmed', 'in_production', 'ready', 'completed', 'cancelled'];

export default async function handler(req, res) {
  try {
    assertConfigured();
    const uid = requireUser(req, res); if (!uid) return;
    const orders = await getOrders(uid);
    if (req.method === 'GET') return send(res, 200, { orders });
    if (req.method === 'PUT') {
      const o = orders.find((x) => x.id === String(req.query?.id || ''));
      if (!o) return send(res, 404, { error: 'Order not found.' });
      const status = String(body(req).status || '');
      if (!STATUSES.includes(status)) return send(res, 400, { error: 'Unknown status.' });
      o.status = status; o.updatedAt = new Date().toISOString();
      await saveOrders(uid, orders);
      return send(res, 200, { orders });
    }
    res.setHeader('Allow', 'GET, PUT');
    send(res, 405, { error: 'Method not allowed' });
  } catch (e) { fail(res, e); }
}
