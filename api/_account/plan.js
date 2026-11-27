import { stripeEnabled, switchPlan, createCheckout, applySubscription } from '../_stripe.js';
import { PLANS, BASE_CURRENCY, assertConfigured, readSession, getUser, getProducts, getOrders, planUsage, pricingFor, saveUser, publicUser, body, send, onlyMethod, fail , syncAccount } from '../_lib.js';

// Change the logged-in user's plan.
// With Stripe set up: an active Stripe subscription is switched (prorated); otherwise the owner is sent to Stripe Checkout.
// Without Stripe: the plan changes straight away (payment skipped).
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
    const pricing = await pricingFor(rec.currency);
    if (stripeEnabled()) {
      const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
      if (rec.subscription?.provider === 'stripe' && rec.stripe?.subscriptionId && ['active', 'past_due'].includes(rec.subscription.status)) {
        if (plan === rec.plan) return send(res, 400, { error: `You're already on ${PLANS[plan].name}.` });
        const { sub } = await switchPlan(rec, plan);
        applySubscription(rec, sub);
        await saveUser(rec);
        await syncAccount(rec);
        const usage = planUsage(rec, products, await getOrders(uid));
        return send(res, 200, { user: { ...publicUser(rec), productCount: products.length, usage, pricing }, switched: true });
      }
      const { url } = await createCheckout(rec, plan, origin);
      await saveUser(rec);
      return send(res, 200, { checkoutUrl: url });
    }
    const now = new Date().toISOString();
    rec.plan = plan;
    rec.subscription = { ...rec.subscription, status: 'active', paymentStatus: 'skipped', changedAt: now,
      currency: pricing.currency, amount: pricing.plans[plan].amount, basePrice: PLANS[plan].price, baseCurrency: BASE_CURRENCY, rate: pricing.rate };
    rec.updatedAt = now;
    await saveUser(rec);
    await syncAccount(rec);
    const usage = planUsage(rec, products, await getOrders(uid));
    send(res, 200, { user: { ...publicUser(rec), productCount: products.length, usage, pricing } });
  } catch (e) { fail(res, e); }
}
