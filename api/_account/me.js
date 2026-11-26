import { stripeEnabled, stripeMode } from '../_stripe.js';
import { assertConfigured, readSession, getUser, getProducts, getOrders, planUsage, pricingFor, publicUser, clearSession, send, onlyMethod, fail } from '../_lib.js';

export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'GET')) return;
  try {
    assertConfigured();
    const uid = readSession(req);
    if (!uid) return send(res, 401, { error: 'Not logged in' });
    const rec = await getUser(uid);
    if (!rec) { clearSession(res); return send(res, 401, { error: 'Not logged in' }); }
    const [products, orders, pricing] = await Promise.all([getProducts(uid), getOrders(uid), pricingFor(rec.currency)]);
    const usage = planUsage(rec, products, orders);
    send(res, 200, { user: { ...publicUser(rec), productCount: products.length, usage, pricing }, billing: { online: stripeEnabled(), mode: stripeEnabled() ? stripeMode() : null } });
  } catch (e) { fail(res, e); }
}
