import { stripeEnabled, stripeMode, reconcile, expireTrial, syncSubscriptionPrice, notifyPriceChange } from '../_stripe.js';
import { geocode, defaultShipping } from '../_shipping.js';
import { assertConfigured, readSession, getUser, saveUser, syncAccount, getProducts, getOrders, planUsage, pricingFor, publicUser, clearSession, send, onlyMethod, fail } from '../_lib.js';

export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'GET')) return;
  try {
    assertConfigured();
    const uid = readSession(req);
    if (!uid) return send(res, 401, { error: 'Not logged in' });
    const rec = await getUser(uid);
    if (!rec) { clearSession(res); return send(res, 401, { error: 'Not logged in' }); }
    // One-time: shop address the owner of Hand Made by CRJ gave on 27 Nov 2026 (accounts made before addresses were asked for).
    if (rec.userId === 'handmadebycrj' && !rec.shopAddress?.text) {
      const text = 'Al Fairouz Building 504, 25th St, Al Nahda, Sharjah, UAE';
      const pin = await geocode(text) || await geocode('Al Nahda, Sharjah, United Arab Emirates');
      rec.shopAddress = { text, ...(pin ? { lat: pin.lat, lng: pin.lng } : {}) };
      if (!rec.shipping) rec.shipping = defaultShipping(rec.currency);
      await saveUser(rec);
    }
    if (!rec.shipping) rec.shipping = defaultShipping(rec.currency);
    try { if (await reconcile(rec)) { await saveUser(rec); await syncAccount(rec); console.log('stripe: reconciled', uid, rec.subscription.status); } }
    catch (e) { console.warn('stripe reconcile failed', e.message); }
    // At most twice a day: keep the subscription on the current plan price (promotion changes), from the next billing date.
    if (stripeEnabled() && rec.stripe?.subscriptionId && ['active', 'past_due'].includes(rec.subscription?.status)
      && !(Date.now() - new Date(rec.subscription.priceCheckedAt || 0).getTime() < 12 * 3600e3)) {
      try {
        const ch = await syncSubscriptionPrice(rec);
        rec.subscription = { ...rec.subscription, priceCheckedAt: new Date().toISOString() };
        await saveUser(rec);
        if (ch.changed) { await syncAccount(rec); await notifyPriceChange(rec, ch); }
      } catch (e) { console.warn('price sync failed', uid, e.message); }
    }
    if (expireTrial(rec)) { await saveUser(rec); await syncAccount(rec); }
    const [products, orders, pricing] = await Promise.all([getProducts(uid), getOrders(uid), pricingFor(rec.currency)]);
    const usage = planUsage(rec, products, orders);
    send(res, 200, { user: { ...publicUser(rec), productCount: products.length, usage, pricing }, billing: { online: stripeEnabled(), mode: stripeEnabled() ? stripeMode() : null } });
  } catch (e) { fail(res, e); }
}
