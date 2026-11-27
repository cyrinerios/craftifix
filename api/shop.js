import { shopPaused } from './_stripe.js';
import { publicShipping, quoteShipping } from './_shipping.js';
import { assertConfigured, normId, validId, getUser, getProducts, body, send, fail } from './_lib.js';

// GET /api/shop?u=<userId> -> public storefront data (published products only, no costs)
// POST /api/shop?u=<userId>&action=quote { method, region, address, lat, lng, subtotal } -> shipping fee for the cart
// GET /s/<userId>/<productId> (rewritten to /api/shop?action=share) -> a small page with the product's photo, name and
// price for link previews (Facebook, X, WhatsApp, Threads…), which then opens the product in the shop.
const h = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function sharePage(req, res) {
  const uid = normId(req.query?.u), pid = String(req.query?.p || '').slice(0, 80);
  const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
  let target = `${origin}/shop.html?u=${encodeURIComponent(uid)}`, title = 'Craftifix shop', desc = 'Handmade products', image = `${origin}/media/icons/icon-512.png`;
  try {
    const user = validId(uid) ? await getUser(uid) : null;
    if (user && user.subscription?.status !== 'suspended') {
      title = user.business || title; desc = `Handmade by ${user.name || user.business}`; if (user.logo) image = user.logo;
      const p = /^[\w-]{1,80}$/.test(pid) && !shopPaused(user) ? (await getProducts(uid)).find((x) => x.id === pid && x.status === 'published') : null;
      if (p) {
        const price = p.pricing.retail ? Math.round(p.pricing.retail * (p.costing.vat ? 1.05 : 1) * 100) / 100 : p.pricing.customerPrice;
        const cur = user.currency || 'AED';
        title = `${p.name} · ${cur} ${Number(price).toFixed(2)} | ${user.business}`;
        desc = (p.description || `Handmade by ${user.business}`).slice(0, 200);
        if (p.image) image = p.image;
        target += `&p=${encodeURIComponent(p.id)}`;
      }
    }
  } catch (e) { console.warn('share page', e.message); }
  const url = `${origin}/s/${encodeURIComponent(uid)}${pid ? '/' + encodeURIComponent(pid) : ''}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
  res.status(200).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${h(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${h(desc)}">
<meta property="og:type" content="product"><meta property="og:site_name" content="Craftifix"><meta property="og:title" content="${h(title)}">
<meta property="og:description" content="${h(desc)}"><meta property="og:image" content="${h(image)}"><meta property="og:url" content="${h(url)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${h(title)}"><meta name="twitter:description" content="${h(desc)}"><meta name="twitter:image" content="${h(image)}">
<link rel="canonical" href="${h(url)}"><meta http-equiv="refresh" content="0;url=${h(target)}">
</head><body style="font-family:sans-serif;padding:30px"><p>Opening <a href="${h(target)}">${h(title)}</a>…</p>
<script>location.replace(${JSON.stringify(target).replace(/</g, '\\u003c')})</script></body></html>`);
}

export default async function handler(req, res) {
  if (String(req.query?.action || '') === 'share' && req.method === 'GET') return sharePage(req, res);
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
