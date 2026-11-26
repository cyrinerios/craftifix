import crypto from 'node:crypto';
import { del } from '@vercel/blob';
import { money, assertConfigured, requireUser, getUser, getInquiries, saveInquiries, getOrders, saveOrders, getProducts, planFor, planUsage, deliver, waLink, escHtml, clean, body, send, fail } from './_lib.js';
import { notify, LABEL as ORDER_LABEL } from './orders.js';

// GET    /api/inquiries                         -> the logged-in owner's custom inquiries
// PUT    /api/inquiries?id=...                  -> { status } change an inquiry's status
// POST   /api/inquiries?id=...&action=reply     -> { message, price?, readyBy? } reply to the customer (email + WhatsApp link)
// POST   /api/inquiries?id=...&action=convert   -> { items:[{name,qty,unitPrice}], address, notes? } turn the inquiry into a confirmed order
// DELETE /api/inquiries?id=...                  -> delete an inquiry and its photos
const STATUSES = ['new', 'replied', 'quoted', 'accepted', 'converted', 'closed'];
export const LABEL = { new: 'New', replied: 'Replied', quoted: 'Quoted', accepted: 'Customer accepted', converted: 'Converted to order', closed: 'Closed' };
const amount = (v) => { const n = Math.round(Number(v) * 100) / 100; return Number.isFinite(n) && n >= 0 && n <= 1e6 ? n : null; };
const host = (req) => `https://${req.headers['x-forwarded-host'] || req.headers.host}`;

export default async function handler(req, res) {
  try {
    assertConfigured();
    const uid = requireUser(req, res); if (!uid) return;
    const list = await getInquiries(uid);
    if (req.method === 'GET') {
      // Delivery address for each inquiry: the one the customer gave, otherwise their latest order's address.
      const orders = await getOrders(uid);
      const withAddr = list.map((q) => {
        if (q.customer.address) return { ...q, suggestedAddress: q.customer.address, addressFrom: 'inquiry' };
        const prev = orders.find((o) => o.customer?.address && (o.customer.email === q.customer.email || o.customer.whatsapp === q.customer.whatsapp));
        return prev ? { ...q, suggestedAddress: prev.customer.address, addressFrom: prev.orderNo } : q;
      });
      const owner = await getUser(uid);
      const usage = owner ? planUsage(owner, await getProducts(uid), orders).inquiryOrders : null;
      return send(res, 200, { inquiries: withAddr, usage });
    }

    const i = list.findIndex((x) => x.id === String(req.query?.id || ''));
    if (i < 0) return send(res, 404, { error: 'Inquiry not found.' });
    const q = list[i];
    const action = String(req.query?.action || '');

    if (req.method === 'PUT') {
      const status = String(body(req).status || '');
      if (!STATUSES.includes(status) || status === 'converted') return send(res, 400, { error: 'Unknown status.' });
      if (q.status === 'converted') return send(res, 400, { error: `This inquiry is already order ${q.orderNo}.` });
      q.status = status; q.updatedAt = new Date().toISOString();
      await saveInquiries(uid, list);
      await deliver({ action: 'inquiry_status', inquiry: { inqNo: q.inqNo, statusLabel: LABEL[status] } });
      return send(res, 200, { inquiries: list });
    }

    if (req.method === 'POST' && action === 'reply') {
      const owner = await getUser(uid);
      if (!owner) return send(res, 401, { error: 'Please log in again.' });
      const aed = (n) => money(n, owner.currency);
      const b = body(req);
      const message = clean(b.message, 1500);
      const price = b.price === '' || b.price == null ? null : amount(b.price);
      const readyBy = /^\d{4}-\d{2}-\d{2}$/.test(String(b.readyBy || '')) ? b.readyBy : '';
      if (message.length < 2) return send(res, 400, { error: 'Please write your reply.', field: 'message' });
      if (b.price !== '' && b.price != null && price === null) return send(res, 400, { error: 'Please enter a valid price.', field: 'price' });

      const now = new Date().toISOString();
      const reply = { at: now, message, price, readyBy };
      q.replies = [...(q.replies || []), reply].slice(-30);
      if (price !== null) q.quote = { price, readyBy, at: now };
      if (q.status !== 'converted' && q.status !== 'accepted') q.status = price !== null ? 'quoted' : 'replied';
      q.updatedAt = now;

      const lines = [message];
      if (price !== null) lines.push('', `Price: ${aed(price)}`);
      if (readyBy) lines.push(`Ready by: ${readyBy}`);
      lines.push('', `Inquiry ${q.inqNo}`, `— ${owner.business}${owner.whatsapp ? `\nWhatsApp: ${owner.whatsapp}` : ''}`);
      const text = lines.join('\n');
      const subject = price !== null ? `Your quote from ${owner.business} — ${aed(price)}` : `Reply to your inquiry ${q.inqNo} — ${owner.business}`;
      const html = `<div style="font-family:Arial,sans-serif;color:#2a1430;max-width:560px">${text.split('\n').map((l) => `<p style="margin:6px 0">${escHtml(l) || '&nbsp;'}</p>`).join('')}</div>`;
      const email = await deliver({
        action: 'inquiry_status',
        inquiry: { inqNo: q.inqNo, shop: uid, customerName: q.customer.name, statusLabel: LABEL[q.status], lastReply: message, price, readyBy, replyAt: now },
        email: { to: q.customer.email, subject, text, html, replyTo: owner.email, fromName: owner.business }
      });
      reply.emailSent = email.sent;
      await saveInquiries(uid, list);
      return send(res, 200, {
        inquiries: list,
        notification: {
          message: text, emailSent: email.sent,
          whatsappUrl: q.customer.whatsapp ? waLink(q.customer.whatsapp, text) : null,
          mailtoUrl: email.sent ? null : `mailto:${q.customer.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`
        }
      });
    }

    if (req.method === 'POST' && action === 'convert') {
      if (q.status === 'converted') return send(res, 400, { error: `This inquiry is already order ${q.orderNo}.` });
      const owner = await getUser(uid);
      if (!owner) return send(res, 401, { error: 'Please log in again.' });
      const plan = planFor(owner.plan);
      const before = planUsage(owner, [], await getOrders(uid)).inquiryOrders;
      if (before.limit !== null && before.used >= before.limit)
        return send(res, 403, { limitReached: 'inquiryOrders', usage: before, error: `You've used all ${before.limit} orders from inquiries on your ${plan.name} plan this month. The count resets on ${before.resetsOn}. Upgrade to Premium in Settings for unlimited orders from inquiries.` });
      const b = body(req);
      const items = [];
      for (const it of (Array.isArray(b.items) ? b.items : []).slice(0, 20)) {
        const name = clean(it?.name, 120);
        const qty = Math.min(99, Math.max(1, Math.round(Number(it?.qty) || 0)));
        const unitPrice = amount(it?.unitPrice);
        if (!name) continue;
        if (unitPrice === null || unitPrice <= 0) return send(res, 400, { error: `Please enter a price for “${name}”.` });
        items.push({ productId: null, name, qty, unitPrice, lineTotal: Math.round(unitPrice * qty * 100) / 100 });
      }
      if (!items.length) return send(res, 400, { error: 'Add at least one item with a price.' });
      const address = clean(b.address, 400);
      if (address.length < 8) return send(res, 400, { error: 'Please enter the delivery address.', field: 'address' });

      const now = new Date();
      const orderNo = 'CH-' + now.toISOString().slice(2, 10).replace(/-/g, '') + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
      const order = {
        id: crypto.randomUUID(), orderNo, status: 'confirmed',
        customer: { ...q.customer, address, notes: clean(b.notes, 800) },
        items, total: Math.round(items.reduce((s, x) => s + x.lineTotal, 0) * 100) / 100, currency: owner.currency || 'AED',
        source: { type: 'inquiry', inqNo: q.inqNo, inquiryId: q.id },
        createdAt: now.toISOString(), updatedAt: now.toISOString(),
        history: [{ status: 'confirmed', at: now.toISOString() }]
      };
      const orders = await getOrders(uid);
      orders.unshift(order);
      await saveOrders(uid, orders.slice(0, 1000));

      q.status = 'converted'; q.orderNo = orderNo; q.orderId = order.id; q.updatedAt = now.toISOString();
      await saveInquiries(uid, list);

      // Google Sheet: add the order row, then mark the inquiry as converted.
      await deliver({ action: 'new_order', order: { ...order, shop: uid, statusLabel: ORDER_LABEL.confirmed } });
      await deliver({ action: 'inquiry_status', inquiry: { inqNo: q.inqNo, statusLabel: LABEL.converted, orderNo } });

      // Tell the customer their custom order is confirmed, with a tracking link.
      const trackUrl = `${host(req)}/shop.html?u=${encodeURIComponent(uid)}&track=${orderNo}`;
      const notification = await notify(order, owner, trackUrl);
      order.history[0].emailSent = !!notification.emailSent;
      await saveOrders(uid, orders.slice(0, 1000));
      const usage = planUsage(owner, [], orders).inquiryOrders;
      return send(res, 201, { inquiries: list, orders, order, notification, usage });
    }

    if (req.method === 'DELETE') {
      const [gone] = list.splice(i, 1);
      await saveInquiries(uid, list);
      const imgs = (gone.options || []).map((o) => o.image).filter(Boolean);
      if (imgs.length) del(imgs).catch(() => {});
      return send(res, 200, { inquiries: list });
    }

    res.setHeader('Allow', 'GET, PUT, POST, DELETE');
    send(res, 405, { error: 'Method not allowed' });
  } catch (e) { fail(res, e); }
}
