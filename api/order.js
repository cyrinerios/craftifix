import crypto from 'node:crypto';
import { money, assertConfigured, normId, validId, validEmail, clean, normWhatsApp, waLink, getUser, getProducts, getOrders, saveOrders, deliver, sendOwnerWhatsApp, escHtml, body, send, onlyMethod, fail } from './_lib.js';

// POST /api/order — a shopper places an order on a shop.
// Saves the order to the owner's account, emails the owner (when email sending is configured)
// and returns a WhatsApp link addressed to the owner with the order filled in.

export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'POST')) return;
  try {
    assertConfigured();
    const b = body(req);
    const uid = normId(b.shop);
    if (!validId(uid)) return send(res, 404, { error: 'Shop not found.' });
    const owner = await getUser(uid);
    if (!owner || owner.subscription?.status === 'suspended') return send(res, 404, { error: 'Shop not found.' });

    const cur = owner.currency || 'AED';
    const aed = (n) => money(n, cur);
    const c = b.customer || {};
    const customer = {
      name: clean(c.name, 80), email: clean(c.email, 254).toLowerCase(),
      whatsapp: normWhatsApp(c.whatsapp), address: clean(c.address, 400), notes: clean(c.notes, 800)
    };
    if (!customer.name) return send(res, 400, { error: 'Please enter your name.', field: 'name' });
    if (!validEmail(customer.email)) return send(res, 400, { error: 'Please enter a valid email address.', field: 'email' });
    if (!customer.whatsapp) return send(res, 400, { error: 'Please enter your WhatsApp number with country code, e.g. +971 55 123 4567.', field: 'whatsapp' });
    if (customer.address.length < 8) return send(res, 400, { error: 'Please enter your full delivery address.', field: 'address' });

    // Prices always come from the shop's own published products, never from the browser.
    const catalogue = (await getProducts(uid)).filter((p) => p.status === 'published');
    const items = [];
    for (const it of (Array.isArray(b.items) ? b.items : []).slice(0, 50)) {
      const p = catalogue.find((x) => x.id === it?.id);
      const qty = Math.min(99, Math.max(1, Math.round(Number(it?.qty) || 0)));
      if (!p) continue;
      const unit = p.pricing.retail ? Math.round(p.pricing.retail * (p.costing.vat ? 1.05 : 1) * 100) / 100 : p.pricing.customerPrice;
      items.push({ productId: p.id, name: p.name, qty, unitPrice: unit, lineTotal: Math.round(unit * qty * 100) / 100 });
    }
    if (!items.length) return send(res, 400, { error: 'Your order is empty, or those products are no longer available.' });
    const total = Math.round(items.reduce((s, x) => s + x.lineTotal, 0) * 100) / 100;

    const now = new Date();
    const orderNo = 'CH-' + now.toISOString().slice(2, 10).replace(/-/g, '') + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
    const order = { id: crypto.randomUUID(), orderNo, status: 'new', customer, items, total, currency: cur, createdAt: now.toISOString() };

    const orders = await getOrders(uid);
    orders.unshift(order);
    await saveOrders(uid, orders.slice(0, 1000));

    const lines = items.map((x) => `${x.qty} × ${x.name} — ${aed(x.lineTotal)}`);
    const text = [
      `New order ${orderNo} for ${owner.business}`, '',
      `Customer: ${customer.name}`, `Email: ${customer.email}`, `WhatsApp: ${customer.whatsapp}`, `Delivery address: ${customer.address}`, '',
      'Items:', ...lines, '', `Total: ${aed(total)}`,
      customer.notes ? `\nNotes: ${customer.notes}` : ''
    ].join('\n').trim();

    const html = `<div style="font-family:Arial,sans-serif;color:#2a1430;max-width:560px">
      <h2 style="color:#4a1d4f">New order ${escHtml(orderNo)}</h2>
      <p>You have a new order on your Craftifix shop <b>${escHtml(owner.business)}</b>.</p>
      <table style="border-collapse:collapse;width:100%">${items.map((x) => `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${x.qty} × ${escHtml(x.name)}</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right">${aed(x.lineTotal)}</td></tr>`).join('')}
      <tr><td style="padding:8px 0"><b>Total</b></td><td style="padding:8px 0;text-align:right"><b>${aed(total)}</b></td></tr></table>
      <h3 style="color:#4a1d4f">Customer</h3>
      <p>${escHtml(customer.name)}<br>Email: ${escHtml(customer.email)}<br>WhatsApp: <a href="${waLink(customer.whatsapp)}">${escHtml(customer.whatsapp)}</a><br>Delivery address: ${escHtml(customer.address)}</p>
      ${customer.notes ? `<p><b>Notes:</b> ${escHtml(customer.notes)}</p>` : ''}
      <p style="color:#6d5670;font-size:13px">Reply to this email to contact the customer. You can also see this order in your Craftifix account.</p></div>`;

    const [email, wa] = await Promise.all([
      deliver({
        action: 'new_order',
        order: { ...order, shop: uid, statusLabel: 'New' },
        email: { to: owner.email, subject: `New order ${orderNo} — ${aed(total)}`, text, html, replyTo: customer.email, fromName: `${owner.business} orders` }
      }),
      sendOwnerWhatsApp(owner, '🛍️ ' + text)
    ]);
    order.emailSent = email.sent;
    order.whatsappSent = wa.sent;
    orders[0] = order;
    await saveOrders(uid, orders.slice(0, 1000));

    const base = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    send(res, 201, {
      orderNo, total, items, currency: cur,
      trackUrl: `${base}/shop.html?u=${encodeURIComponent(uid)}&track=${orderNo}`,
      emailSent: email.sent,
      whatsappSent: wa.sent,
      whatsappUrl: owner.whatsapp ? waLink(owner.whatsapp, text) : null,
      mailtoUrl: email.sent ? null : `mailto:${owner.email}?subject=${encodeURIComponent(`Order ${orderNo} for ${owner.business}`)}&body=${encodeURIComponent(text)}`
    });
  } catch (e) { fail(res, e); }
}
