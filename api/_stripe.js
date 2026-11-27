// Stripe subscriptions for Craftifix plans, using Stripe's REST API directly (no SDK).
// Needs two Vercel environment variables, set by the owner in the Vercel dashboard:
//   STRIPE_SECRET_KEY      sk_test_... (test mode) or sk_live_... (live)
//   STRIPE_WEBHOOK_SECRET  whsec_... from the webhook endpoint in Stripe
// Without STRIPE_SECRET_KEY the site behaves as before (payment skipped).
import crypto from 'node:crypto';
import { PLANS, pricingFor, validCurrency } from './_lib.js';

// Keys are trimmed of stray spaces/quotes from copy-pasting.
const clean = (v) => String(v || '').trim().replace(/^['"]+|['"]+$/g, '').trim();
// If extra text was pasted around the key (e.g. "STRIPE_SECRET_KEY=sk_test_…"), pick the key out of it.
const secretKey = () => { const raw = clean(process.env.STRIPE_SECRET_KEY); const m = raw.match(/sk_(test|live)_[A-Za-z0-9]+/); return m ? m[0] : raw; };
export const stripeKeyKind = () => {
  const k = secretKey();
  if (!k) return 'missing';
  if (/^sk_(test|live)_[A-Za-z0-9]+$/.test(k)) return 'ok';
  if (/rk_(test|live)_/.test(k)) return 'restricted-key';
  if (/pk_(test|live)_/.test(k)) return 'publishable-key';
  if (/whsec_/.test(k)) return 'webhook-signing-secret';
  if (/\.\.\./.test(k) || /…/.test(k)) return 'shortened-key-with-dots';
  return `unrecognised (${k.length} characters)`;
};
export const stripeEnabled = () => stripeKeyKind() === 'ok';
export const stripeMode = () => (secretKey().startsWith('sk_live_') ? 'live' : 'test');

// Stripe wants form encoding with bracketed keys: items[0][price_data][currency]=aed
function form(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out;
}

export async function stripe(path, params, method = params ? 'POST' : 'GET') {
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    method,
    headers: { Authorization: 'Bearer ' + secretKey(), 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2024-06-20' },
    body: params ? form(params).join('&') : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j?.error?.message || `Stripe error ${r.status}`);
    err.stripe = j?.error || {}; err.httpStatus = r.status;
    throw err;
  }
  return j;
}

// One Stripe product per plan, with fixed IDs so we never create duplicates.
const productId = (plan) => `craftifix_${plan}`;
const ensured = new Set();
async function ensureProduct(plan) {
  const id = productId(plan);
  if (ensured.has(id)) return id;
  try { await stripe('products/' + id); }
  catch (e) {
    if (e.httpStatus !== 404) throw e;
    await stripe('products', { id, name: `Craftifix ${PLANS[plan].name} plan`, description: PLANS[plan].limits.products === null ? 'Unlimited product listings and orders from inquiries' : 'Up to 5 product listings and 5 orders from inquiries a month' })
      .catch((x) => { if (x.stripe?.code !== 'resource_already_exists') throw x; });
  }
  ensured.add(id);
  return id;
}

// Stripe amounts are in the smallest unit. Kuwaiti/Bahraini/Omani/Jordanian currencies use 3 decimals and
// Stripe requires those amounts to end in 0.
const THREE_DEC = new Set(['KWD', 'BHD', 'OMR', 'JOD']);
const minor = (amount, cur) => THREE_DEC.has(cur) ? Math.round(amount * 100) * 10 : Math.round(amount * 100);

// Monthly price for a plan in the shop's currency (falls back to AED).
export async function planPrice(plan, currency) {
  const p = await pricingFor(validCurrency(currency) || 'AED');
  return { currency: p.currency, amount: p.plans[plan].amount, rate: p.rate, priceAED: PLANS[plan].price };
}
const priceData = (product, price) => ({ currency: price.currency.toLowerCase(), product, unit_amount: minor(price.amount, price.currency), recurring: { interval: 'month' } });

async function ensureCustomer(rec) {
  if (rec.stripe?.customerId) return rec.stripe.customerId;
  const c = await stripe('customers', { email: rec.email, name: rec.business, phone: rec.whatsapp || undefined, metadata: { userId: rec.userId } });
  rec.stripe = { ...(rec.stripe || {}), customerId: c.id };
  return c.id;
}

// Stripe Checkout page for a new subscription. Returns { url, price }. Caller saves rec (customer ID).
export async function createCheckout(rec, plan, origin) {
  const product = await ensureProduct(plan);
  const customer = await ensureCustomer(rec);
  const meta = { userId: rec.userId, plan };
  const make = (price) => stripe('checkout/sessions', {
    mode: 'subscription', customer, client_reference_id: rec.userId,
    line_items: [{ quantity: 1, price_data: priceData(product, price) }],
    subscription_data: { metadata: meta, description: `Craftifix ${PLANS[plan].name} plan for ${rec.business}` },
    metadata: meta, allow_promotion_codes: 'true',
    success_url: `${origin}/account.html?billing=success#settings`,
    cancel_url: `${origin}/account.html?billing=cancelled#settings`
  });
  let price = await planPrice(plan, rec.currency);
  let session;
  try { session = await make(price); }
  catch (e) {
    // If Stripe can't charge in this currency, charge the AED price instead.
    if (price.currency === 'AED' || !/currency/i.test(e.message)) throw e;
    price = await planPrice(plan, 'AED');
    session = await make(price);
  }
  return { url: session.url, price };
}

// Customer portal: update card, see invoices, cancel.
export async function createPortal(rec, origin) {
  const s = await stripe('billing_portal/sessions', { customer: rec.stripe.customerId, return_url: `${origin}/account.html#settings` });
  return s.url;
}

// Switch an existing subscription to another plan (prorated), keeping the same currency.
export async function switchPlan(rec, plan) {
  const sub = await stripe('subscriptions/' + rec.stripe.subscriptionId);
  const item = sub.items.data[0];
  const product = await ensureProduct(plan);
  let price = await planPrice(plan, item.price.currency.toUpperCase());
  const updated = await stripe('subscriptions/' + sub.id, {
    items: [{ id: item.id, price_data: priceData(product, price) }],
    metadata: { userId: rec.userId, plan }, proration_behavior: 'create_prorations'
  });
  return { sub: updated, price };
}

// Map a Stripe subscription onto the account record.
const STATUS = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'unpaid', canceled: 'canceled', incomplete: 'pending', incomplete_expired: 'canceled', paused: 'unpaid' };
export function applySubscription(rec, sub) {
  const item = sub.items?.data?.[0];
  const plan = sub.metadata?.plan && PLANS[sub.metadata.plan] ? sub.metadata.plan : rec.plan;
  const periodEnd = sub.current_period_end || item?.current_period_end;
  const cur = item?.price?.currency?.toUpperCase();
  const amt = item?.price?.unit_amount;
  rec.plan = plan;
  rec.stripe = { ...(rec.stripe || {}), customerId: sub.customer, subscriptionId: sub.id, status: sub.status, mode: sub.livemode ? 'live' : 'test' };
  rec.subscription = {
    ...(rec.subscription || {}),
    status: STATUS[sub.status] || sub.status, billing: 'monthly', provider: 'stripe',
    paymentStatus: sub.status === 'active' || sub.status === 'trialing' ? 'paid' : sub.status,
    paidUntil: periodEnd ? new Date(periodEnd * 1000).toISOString() : rec.subscription?.paidUntil,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    currency: cur || rec.subscription?.currency,
    amount: amt != null ? amt / (THREE_DEC.has(cur) ? 1000 : 100) : rec.subscription?.amount,
    priceAED: PLANS[plan].price, changedAt: new Date().toISOString()
  };
  rec.updatedAt = new Date().toISOString();
  return rec;
}

// Webhook signature check (Stripe-Signature: t=...,v1=...). Rejects events older than 5 minutes.
export function verifyWebhook(raw, header, secret = clean(process.env.STRIPE_WEBHOOK_SECRET)) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, v]));
  const sigs = String(header).split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

// If an account still waits for payment but Stripe already has a subscription for it (e.g. a missed webhook),
// pick it up. Returns true when the record changed.
export async function reconcile(rec) {
  if (!stripeEnabled() || !rec?.stripe?.customerId) return false;
  if (!['pending', 'past_due', 'unpaid'].includes(rec.subscription?.status)) return false;
  const list = await stripe(`subscriptions?customer=${encodeURIComponent(rec.stripe.customerId)}&status=all&limit=5`);
  const sub = (list.data || []).find((s) => ['active', 'trialing'].includes(s.status)) || (list.data || [])[0];
  if (!sub || (sub.status === rec.stripe.status && sub.id === rec.stripe.subscriptionId)) return false;
  applySubscription(rec, sub);
  return true;
}

// Accounts that must pay before their shop is open to customers.
export const shopPaused = (rec) => ['pending', 'canceled', 'unpaid'].includes(rec?.subscription?.status);
