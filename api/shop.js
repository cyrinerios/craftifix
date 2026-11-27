import { shopPaused } from './_stripe.js';
import { publicShipping, quoteShipping } from './_shipping.js';
import { assertConfigured, normId, validId, getUser, getProducts, body, send, fail } from './_lib.js';

// GET /api/shop?u=<userId> -> public storefront data (published products only, no costs)
// POST /api/shop?u=<userId>&action=quote { method, region, address, lat, lng, subtotal } -> shipping fee for the cart
export default async function handler(req, res) {
  const quote = String(req.query?.action || '') === 'quote';
  if (req.method !== (quote ? 'POST' : 'GET')) { res.setHeader('Allow', quote ? 'POST' : 'GET'); return send(res, 405, { error: 'Method not allowed' }); }
  try {
    assertConfigured();
    const uid = normId(req.query?.u);
    if (!validId(uid)) return send(res, 404, { error: 'Shop not found.' });
    const user = await getUser(uid);
    if (!user || user.subscription?.status === 'suspended') return send(res, 404, { error: 'Shop not found.' });
    const shop = { userId: user.userId, business: user.business, owner: user.name, hasWhatsApp: !!user.whatsapp, logo: user.logo || null, currency: user.currency || 'AED', social: user.social || {} };
    if (shopPaused(user)) return send(res, 200, { shop: { ...shop, paused: true }, products: [] });
    // Each quote also returns the shop's current delivery settings, so an open cart stays in step with the owner's changes.
    if (quote) { const q = await quoteShipping(user, body(req)); return send(res, q.ok ? 200 : 400, { ...q, config: publicShipping(user) }); }
    shop.shipping = publicShipping(user);
    const products = (await getProducts(uid))
      .filter((p) => p.status === 'published')
      .map((p) => ({
        id: p.id, name: p.name, category: p.category, description: p.description, image: p.image,
        // Wholesale-priced products show their suggested retail price to shoppers.
        price: p.pricing.retail ? Math.round(p.pricing.retail * (p.costing.vat ? 1.05 : 1) * 100) / 100 : p.pricing.customerPrice,
        vatIncluded: !!p.costing.vat,
        inStock: p.quantity > 0, quantity: p.quantity, customizable: p.customizable, productionDays: p.productionDays
      }));
    send(res, 200, { shop, products });
  } catch (e) { fail(res, e); }
}
