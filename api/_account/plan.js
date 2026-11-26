import { PLANS, assertConfigured, readSession, getUser, getProducts, getOrders, planUsage, saveUser, publicUser, body, send, onlyMethod, fail , syncAccount } from '../_lib.js';

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
    const max = PLANS[plan].limits.products;
    const products = await getProducts(uid);
    if (max !== null && products.length > max)
      return send(res, 400, { error: `The ${PLANS[plan].name} plan allows up to ${max} product listings and you have ${products.length}. Delete ${products.length - max} product${products.length - max === 1 ? '' : 's'} in My products first, then switch.` });
    const now = new Date().toISOString();
    rec.plan = plan;
    rec.subscription = { ...rec.subscription, status: 'active', paymentStatus: 'skipped', changedAt: now };
    rec.updatedAt = now;
    await saveUser(rec);
    await syncAccount(rec);
    const usage = planUsage(rec, products, await getOrders(uid));
    send(res, 200, { user: { ...publicUser(rec), productCount: products.length, usage } });
  } catch (e) { fail(res, e); }
}
