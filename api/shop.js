import { assertConfigured, normId, validId, getUser, getProducts, send, onlyMethod, fail } from './_lib.js';

// GET /api/shop?u=<userId> -> public storefront data (published products only, no costs)
export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'GET')) return;
  try {
    assertConfigured();
    const uid = normId(req.query?.u);
    if (!validId(uid)) return send(res, 404, { error: 'Shop not found.' });
    const user = await getUser(uid);
    if (!user || user.subscription?.status === 'suspended') return send(res, 404, { error: 'Shop not found.' });
    const products = (await getProducts(uid))
      .filter((p) => p.status === 'published')
      .map((p) => ({
        id: p.id, name: p.name, category: p.category, description: p.description, image: p.image,
        // Wholesale-priced products show their suggested retail price to shoppers.
        price: p.pricing.retail ? Math.round(p.pricing.retail * (p.costing.vat ? 1.05 : 1) * 100) / 100 : p.pricing.customerPrice,
        vatIncluded: !!p.costing.vat,
        inStock: p.quantity > 0, quantity: p.quantity, customizable: p.customizable, productionDays: p.productionDays
      }));
    send(res, 200, { shop: { userId: user.userId, business: user.business, owner: user.name, hasWhatsApp: !!user.whatsapp, logo: user.logo || null, currency: user.currency || 'AED', social: user.social || {} }, products });
  } catch (e) { fail(res, e); }
}
