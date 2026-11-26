import crypto from 'node:crypto';
import { del } from '@vercel/blob';
import { planFor, deliver, assertConfigured, requireUser, getUser, getProducts, saveProducts, cleanProduct, body, send, fail } from './_lib.js';

// GET    /api/products            -> list the logged-in business's products
// POST   /api/products            -> create a product (plan limit enforced)
// PUT    /api/products?id=...     -> update a product
// DELETE /api/products?id=...     -> delete a product
export default async function handler(req, res) {
  try {
    assertConfigured();
    const uid = requireUser(req, res); if (!uid) return;
    const user = await getUser(uid);
    if (!user) return send(res, 401, { error: 'Please log in again.' });
    const plan = planFor(user.plan);
    const list = await getProducts(uid);
    const limit = plan.limits.products;
    const id = String(req.query?.id || '');

    if (req.method === 'GET') return send(res, 200, { products: list, limit, plan: plan.id, currency: user.currency || 'AED' });

    if (req.method === 'POST') {
      if (limit !== null && list.length >= limit)
        return send(res, 403, { error: `Your ${plan.name} plan allows up to ${limit} product listings (published and drafts). Delete a product or upgrade to Premium for unlimited listings.`, limitReached: 'products' });
      const p = cleanProduct(body(req));
      if (!p.name) return send(res, 400, { error: 'Please enter a product name.', field: 'name' });
      if (p.pricing.price <= 0) return send(res, 400, { error: 'The calculated price is zero — add your costs first.' });
      const now = new Date().toISOString();
      const rec = { id: crypto.randomUUID(), ...p, createdAt: now, updatedAt: now };
      list.unshift(rec);
      await saveProducts(uid, list);
      await deliver({ action: 'product_upsert', product: { ...rec, shop: uid } });
      return send(res, 201, { product: rec, products: list, limit });
    }

    const i = list.findIndex((x) => x.id === id);
    if (req.method === 'PUT') {
      if (i < 0) return send(res, 404, { error: 'Product not found.' });
      const p = cleanProduct(body(req), list[i]);
      if (!p.name) return send(res, 400, { error: 'Please enter a product name.', field: 'name' });
      if (p.pricing.price <= 0) return send(res, 400, { error: 'The calculated price is zero — add your costs first.' });
      const oldImage = list[i].image;
      list[i] = { ...list[i], ...p, updatedAt: new Date().toISOString() };
      await saveProducts(uid, list);
      await deliver({ action: 'product_upsert', product: { ...list[i], shop: uid } });
      if (oldImage && oldImage !== list[i].image) del(oldImage).catch(() => {});
      return send(res, 200, { product: list[i], products: list, limit });
    }

    if (req.method === 'DELETE') {
      if (i < 0) return send(res, 404, { error: 'Product not found.' });
      const [gone] = list.splice(i, 1);
      await saveProducts(uid, list);
      await deliver({ action: 'product_delete', product: { id: gone.id, shop: uid } });
      if (gone.image) del(gone.image).catch(() => {});
      return send(res, 200, { products: list, limit });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    send(res, 405, { error: 'Method not allowed' });
  } catch (e) { fail(res, e); }
}
