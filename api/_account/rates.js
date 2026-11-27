import { stripeEnabled, stripeMode, stripeKeyKind } from '../_stripe.js';
import { pricingFor, send, onlyMethod, fail } from '../_lib.js';

// Public: plan prices converted from AED into a currency. GET /api/rates?currency=PHP
export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'GET')) return;
  try {
    const pricing = await pricingFor(req.query?.currency);
    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    res.status(200).json({ pricing, onlinePayment: stripeEnabled(), paymentMode: stripeEnabled() ? stripeMode() : null, paymentKey: stripeKeyKind() });
  } catch (e) { fail(res, e); }
}
