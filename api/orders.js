import { assertConfigured, requireUser, getUser, getOrders, saveOrders, deliver, escHtml, waLink, body, send, fail } from './_lib.js';

// GET /api/orders                 -> the logged-in owner's received orders
// PUT /api/orders?id=...          -> { status } update an order's status and notify the customer
// PUT /api/orders?id=...&notify=1 -> re-send the customer update for the current status
const STATUSES = ['new', 'confirmed', 'in_production', 'ready', 'completed', 'cancelled'];
const LABEL = { new: 'New', confirmed: 'Confirmed', in_production: 'In production', ready: 'Ready for delivery', completed: 'Completed', cancelled: 'Cancelled' };
const aed = (n) => 'AED ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function customerMessage(order, owner) {
  const first = order.customer.name.split(/\s+/)[0];
  const items = order.items.map((i) => `${i.qty} × ${i.name}`).join(', ');
  const head = `Hi ${first}, this is ${owner.business}.`;
  const ref = `Order ${order.orderNo} (${items}) — total ${aed(order.total)}.`;
  const body = {
    confirmed: `Good news — your order is confirmed! ✅\n${ref}\nWe'll start crocheting it soon and keep you updated.`,
    in_production: `Your order is now being handmade 🧶\n${ref}\nWe'll let you know as soon as it's ready.`,
    ready: `Your order is ready for delivery 📦\n${ref}\nDelivery address: ${order.customer.address}\nWe'll contact you to arrange the delivery time.`,
    completed: `Your order is complete — thank you for shopping with us! 💕\n${ref}\nWe'd love to hear what you think.`,
    cancelled: `Your order has been cancelled.\n${ref}\nIf you have any questions, just reply to this message.`,
    new: `We've received your order and will confirm it shortly.\n${ref}`
  }[order.status];
  return `${head}\n${body}\n\n— ${owner.business}${owner.whatsapp ? `\nWhatsApp: ${owner.whatsapp}` : ''}`;
}

async function notify(order, owner) {
  const text = customerMessage(order, owner);
  const subject = `Your order ${order.orderNo} is ${LABEL[order.status].toLowerCase()} — ${owner.business}`;
  const html = `<div style="font-family:Arial,sans-serif;color:#2a1430;max-width:560px">
    <h2 style="color:#4a1d4f">Order ${escHtml(order.orderNo)}: ${escHtml(LABEL[order.status])}</h2>
    ${text.split('\n').map((l) => `<p style="margin:6px 0">${escHtml(l)}</p>`).join('')}
    <table style="border-collapse:collapse;width:100%;margin-top:12px">${order.items.map((x) => `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${x.qty} × ${escHtml(x.name)}</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right">${aed(x.lineTotal)}</td></tr>`).join('')}
    <tr><td style="padding:8px 0"><b>Total</b></td><td style="padding:8px 0;text-align:right"><b>${aed(order.total)}</b></td></tr></table></div>`;
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
    if (req.method === 'GET') return send(res, 200, { orders });
    if (req.method === 'PUT') {
      const o = orders.find((x) => x.id === String(req.query?.id || ''));
      if (!o) return send(res, 404, { error: 'Order not found.' });
      const owner = await getUser(uid);
      if (!owner) return send(res, 401, { error: 'Please log in again.' });
      const resend = String(req.query?.notify || '') === '1';
      if (!resend) {
        const status = String(body(req).status || '');
        if (!STATUSES.includes(status)) return send(res, 400, { error: 'Unknown status.' });
        if (status === o.status) return send(res, 200, { orders, notification: null });
        o.status = status;
      }
      const now = new Date().toISOString();
      o.updatedAt = now;
      const notification = o.status === 'new' && !resend ? null : await notify(o, owner);
      o.history = [...(o.history || []), { status: o.status, at: now, emailSent: !!notification?.emailSent }].slice(-30);
      await saveOrders(uid, orders);
      return send(res, 200, { orders, notification });
    }
    res.setHeader('Allow', 'GET, PUT');
    send(res, 405, { error: 'Method not allowed' });
  } catch (e) { fail(res, e); }
}
