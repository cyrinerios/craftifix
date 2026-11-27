import { PLANS, assertConfigured, requireUser, getUser, saveUser, syncAccount, body, send, fail } from './_lib.js';
import { stripeEnabled, createCheckout, createPortal, applySubscription, verifyWebhook, stripe } from './_stripe.js';

// POST /api/billing?action=checkout  { plan }  -> { url } Stripe Checkout for the logged-in owner
// POST /api/billing?action=portal               -> { url } Stripe customer portal (card, invoices, cancel)
// POST /api/stripe/webhook (rewritten here with action=webhook) <- events from Stripe
const origin = (req) => `https://${req.headers['x-forwarded-host'] || req.headers.host}`;

async function rawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString('utf8');
}

async function onWebhook(req, res) {
  const raw = await rawBody(req).catch(() => '');
  let event = null;
  if (raw && verifyWebhook(raw, req.headers['stripe-signature'])) event = JSON.parse(raw);
  else {
    // Signature couldn't be checked (body re-encoded on the way in, or secret mismatch): only trust the event if
    // Stripe itself returns it when we ask with our secret key.
    let id = null;
    try { id = (raw ? JSON.parse(raw) : req.body)?.id; } catch {}
    if (!id && req.body && typeof req.body === 'object') id = req.body.id;
    if (!/^evt_[A-Za-z0-9]+$/.test(String(id || ''))) { console.warn('stripe webhook: rejected', { rawLength: raw.length, bodyType: typeof req.body, hasSig: !!req.headers['stripe-signature'] }); return send(res, 400, { error: 'Invalid signature' }); }
    try { event = await stripe('events/' + id); console.log('stripe webhook: verified via API', event.type); }
    catch (e) { console.warn('stripe webhook: unknown event', id, e.message); return send(res, 400, { error: 'Unknown event' }); }
  }
  const obj = event.data?.object || {};
  let sub = null;
  if (event.type === 'checkout.session.completed' && obj.mode === 'subscription' && obj.subscription) sub = await stripe('subscriptions/' + obj.subscription);
  else if (event.type.startsWith('customer.subscription.')) sub = obj;
  if (!sub) return send(res, 200, { received: true, ignored: event.type });

  const userId = sub.metadata?.userId || obj.client_reference_id || obj.metadata?.userId;
  const rec = userId && await getUser(userId);
  if (!rec) { console.warn('stripe webhook: no account for', userId, event.type); return send(res, 200, { received: true }); }
  // Ignore events about an older subscription once the account has moved to a newer one.
  if (rec.stripe?.subscriptionId && rec.stripe.subscriptionId !== sub.id && event.type !== 'checkout.session.completed') return send(res, 200, { received: true, stale: true });
  applySubscription(rec, sub);
  await saveUser(rec);
  await syncAccount(rec);
  send(res, 200, { received: true });
}

export default async function handler(req, res) {
  try {
    assertConfigured();
    const action = String(req.query?.action || '');
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    if (!stripeEnabled()) return send(res, 503, { error: 'Online payment is not set up yet.' });
    if (action === 'webhook') return await onWebhook(req, res);

    const uid = requireUser(req, res); if (!uid) return;
    const rec = await getUser(uid);
    if (!rec) return send(res, 401, { error: 'Please log in again.' });

    if (action === 'checkout') {
      const plan = String(body(req).plan || rec.plan || '').toLowerCase();
      if (!PLANS[plan]) return send(res, 400, { error: 'Unknown plan.' });
      if (rec.subscription?.provider === 'stripe' && ['active', 'past_due'].includes(rec.subscription.status))
        return send(res, 400, { error: 'You already have an active subscription. Use Change plan or Manage billing.' });
      const { url } = await createCheckout(rec, plan, origin(req));
      await saveUser(rec); // keeps the Stripe customer ID
      return send(res, 200, { url });
    }
    if (action === 'portal') {
      if (!rec.stripe?.customerId) return send(res, 400, { error: 'No billing account yet. Pay for a plan first.' });
      return send(res, 200, { url: await createPortal(rec, origin(req)) });
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e.stripe) { console.error('stripe', e.message); return send(res, 502, { error: 'Payment service error: ' + e.message }); }
    fail(res, e);
  }
}
