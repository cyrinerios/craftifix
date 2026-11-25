import { PLANS, assertConfigured, readSession, getUser, saveUser, publicUser, body, send, onlyMethod, fail } from '../_lib.js';

// Change the logged-in user's plan. Payment is skipped for now.
export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'POST')) return;
  try {
    assertConfigured();
    const uid = readSession(req);
    if (!uid) return send(res, 401, { error: 'Please log in again.' });
    const plan = String(body(req).plan || '').toLowerCase();
    if (!PLANS[plan]) return send(res, 400, { error: 'Unknown plan.' });
    const rec = await getUser(uid);
    if (!rec) return send(res, 401, { error: 'Please log in again.' });
    const now = new Date().toISOString();
    rec.plan = plan;
    rec.subscription = { ...rec.subscription, status: 'active', paymentStatus: 'skipped', changedAt: now };
    rec.updatedAt = now;
    await saveUser(rec);
    send(res, 200, { user: publicUser(rec) });
  } catch (e) { fail(res, e); }
}
