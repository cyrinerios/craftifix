import { money, assertConfigured, requireUser, getUser, saveUser, getOrders, saveOrders, assignInvoices, invoiceUrl, deliver, escHtml, waLink, body, send, fail } from './_lib.js';

// GET /api/orders                 -> the logged-in owner's received orders
// PUT /api/orders?id=...          -> { status } update an order's status and notify the customer
// PUT /api/orders?id=...&notify=1 -> re-send the customer update for the current status
const STATUSES = ['new', 'confirmed', 'in_production', 'ready', 'shipped', 'completed', 'cancelled'];
export const LABEL = { new: 'New', confirmed: 'Confirmed', in_production: 'In production', ready: 'Ready for delivery', shipped: 'Order shipped', completed: 'Completed', cancelled: 'Cancelled' };

// Shipment details the owner gives when marking an order as shipped. The tracking link is required.
const txt = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
export function cleanShipment(b = {}) {
  let url = txt(b.url, 500);
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) url = ''; } catch { url = ''; }
  return { courier: txt(b.courier, 60), trackingNo: txt(b.trackingNo, 60), url };
}

export function customerMessage(order, owner, trackUrl, invUrl) {
  const aed = (n) => money(n, order.currency || owner.currency);
  const first = order.customer.name.split(/\s+/)[0];
  const items = order.items.map((i) => `${i.qty} × ${i.name}`).join(', ');
  const head = `Hi ${first}, this is ${owner.business}.`;
  const ref = `Order ${order.orderNo} (${items}) — total ${aed(order.total)}.`;
  const body = {
    confirmed: `Good news — your order is confirmed! ✅\n${ref}\nWe'll start crocheting it soon and keep you updated.`,
    in_production: `Your order is now being handmade 🧶\n${ref}\nWe'll let you know as soon as it's ready.`,
    ready: `Your order is ready for delivery 📦\n${ref}\nDelivery address: ${order.customer.address}\nWe'll contact you to arrange the delivery time.`,
    shipped: `Your order is on its way! 🚚\n${ref}${order.shipment?.courier ? `\nCourier: ${order.shipment.courier}` : ''}${order.shipment?.trackingNo ? `\nTracking number: ${order.shipment.trackingNo}` : ''}${order.shipment?.url ? `\nTrack your parcel: ${order.shipment.url}` : ''}\nDelivery address: ${order.customer.address}`,
    completed: `Your order is complete — thank you for shopping with us! 💕\n${ref}${invUrl ? `\nYour invoice (${order.invoice?.no || 'invoice'}): ${invUrl}` : ''}\nWe'd love to hear what you think.`,
    cancelled: `Your order has been cancelled.\n${ref}\nIf you have any questions, just reply to this message.`,
    new: `We've received your order and will confirm it shortly.\n${ref}`
  }[order.status];
  return `${head}\n${body}${trackUrl ? `\nTrack your order: ${trackUrl}` : ''}\n\n— ${owner.business}${owner.whatsapp ? `\nWhatsApp: ${owner.whatsapp}` : ''}`;
}

export async function notify(order, owner, trackUrl, invUrl) {
  const aed = (n) => money(n, order.currency || owner.currency);
  const text = customerMessage(order, owner, trackUrl, invUrl);
  const subject = `Your order ${order.orderNo} is ${LABEL[order.status].toLowerCase()} — ${owner.business}`;
  const html = `<div style="font-family:Arial,sans-serif;color:#2a1430;max-width:560px">
    <h2 style="color:#4a1d4f">Order ${escHtml(order.orderNo)}: ${escHtml(LABEL[order.status])}</h2>
    ${text.split('\n').map((l) => `<p style="margin:6px 0">${escHtml(l)}</p>`).join('')}
    <table style="border-collapse:collapse;width:100%;margin-top:12px">${order.items.map((x) => `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${x.qty} × ${escHtml(x.name)}</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right">${aed(x.lineTotal)}</td></tr>`).join('')}
    ${order.shipping ? `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${escHtml(order.shipping.label)}</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right">${order.shipping.pending ? 'to be confirmed' : aed(order.shipping.fee)}</td></tr>` : ''}
    <tr><td style="padding:8px 0"><b>Total</b></td><td style="padding:8px 0;text-align:right"><b>${aed(order.total)}</b></td></tr></table>
    ${order.status === 'shipped' && order.shipment?.url ? `<p style="margin:18px 0"><a href="${escHtml(order.shipment.url)}" style="display:inline-block;background:#4a1d4f;color:#fff;text-decoration:none;padding:11px 20px;border-radius:999px;font-weight:bold">Track your parcel${order.shipment.courier ? ' with ' + escHtml(order.shipment.courier) : ''}</a></p>` : ''}
    ${invUrl ? `<p style="margin:18px 0"><a href="${escHtml(invUrl)}" style="display:inline-block;background:#4a1d4f;color:#fff;text-decoration:none;padding:11px 20px;border-radius:999px;font-weight:bold">View &amp; download invoice ${escHtml(order.invoice?.no || '')}</a></p>` : ''}</div>`;
  const email = await deliver({
    action: 'status_update',
    order: { orderNo: order.orderNo, statusLabel: LABEL[order.status] },
    email: { to: order.customer.email, subject, text, html, replyTo: owner.email, fromName: owner.business }
  });
  return {
    status: order.status,
    message: text,
    emailSent: email.sent,
    whatsappUrl: order.customer.whatsapp ? waLink(order.customer.whatsapp, text) : null,
    mailtoUrl: email.sent ? null : `mailto:${order.customer.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`
  };
}

export default async function handler(req, res) {
  try {
    assertConfigured();
    const uid = requireUser(req, res); if (!uid) return;
    const orders = await getOrders(uid);
    const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    const withLinks = (list) => list.map((o) => (o.invoice ? { ...o, invoiceUrl: invoiceUrl(origin, uid, o.orderNo) } : o));
    if (req.method === 'GET') {
      // Older completed orders get their invoice the first time the owner opens Orders.
      const owner = await getUser(uid);
      if (owner && assignInvoices(owner, orders)) { await saveUser(owner); await saveOrders(uid, orders); }
      return send(res, 200, { orders: withLinks(orders) });
    }
    if (req.method === 'PUT') {
      const o = orders.find((x) => x.id === String(req.query?.id || ''));
      if (!o) return send(res, 404, { error: 'Order not found.' });
      const owner = await getUser(uid);
      if (!owner) return send(res, 401, { error: 'Please log in again.' });
      const resend = String(req.query?.notify || '') === '1';
      if (!resend) {
        const status = String(body(req).status || '');
        if (!STATUSES.includes(status)) return send(res, 400, { error: 'Unknown status.' });
        const b = body(req);
        if (status === 'shipped' || b.shipment) {
          const sh = cleanShipment(b.shipment || o.shipment || {});
          if (status === 'shipped' && !sh.url) return send(res, 400, { error: 'Add the shipment tracking link (for example the courier’s tracking page) so the customer can follow the parcel.', field: 'shipmentUrl' });
          if (sh.url) o.shipment = { ...sh, at: o.shipment?.url === sh.url ? o.shipment.at : new Date().toISOString() };
        }
        if (status === o.status && !b.shipment) return send(res, 200, { orders: withLinks(orders), notification: null });
        o.status = status;
        if (status === 'completed' && assignInvoices(owner, [o])) await saveUser(owner);
      }
      const now = new Date().toISOString();
      o.updatedAt = now;
      const trackUrl = `https://${req.headers['x-forwarded-host'] || req.headers.host}/shop.html?u=${encodeURIComponent(uid)}&track=${o.orderNo}`;
      const invUrl = o.status === 'completed' && o.invoice ? invoiceUrl(origin, uid, o.orderNo) : null;
      const notification = o.status === 'new' && !resend ? null : await notify(o, owner, trackUrl, invUrl);
      o.history = [...(o.history || []), { status: o.status, at: now, emailSent: !!notification?.emailSent }].slice(-30);
      await saveOrders(uid, orders);
      return send(res, 200, { orders: withLinks(orders), notification });
    }
    res.setHeader('Allow', 'GET, PUT');
    send(res, 405, { error: 'Method not allowed' });
  } catch (e) { fail(res, e); }
}
