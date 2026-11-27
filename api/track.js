import { invoiceUrl, assertConfigured, normId, validId, normWhatsApp, getUser, getOrders, body, send, onlyMethod, fail } from './_lib.js';

// POST /api/track { shop, orderNo, contact } -> the order's status for the customer who placed it.
// The customer must give the email or WhatsApp number used on the order.
export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'POST')) return;
  try {
    assertConfigured();
    const b = body(req);
    const uid = normId(b.shop);
    const orderNo = String(b.orderNo || '').trim().toUpperCase().replace(/\s+/g, '');
    const contact = String(b.contact || '').trim();
    const notFound = () => send(res, 404, { error: 'We couldn’t find an order with that number and email or WhatsApp. Please check both and try again.' });
    if (!validId(uid) || !/^CH-\d{6}-[0-9A-F]{4}$/.test(orderNo) || !contact) return notFound();
    const owner = await getUser(uid);
    if (!owner) return notFound();
    const o = (await getOrders(uid)).find((x) => x.orderNo === orderNo);
    if (!o) return notFound();
    const emailMatch = contact.toLowerCase() === String(o.customer.email || '').toLowerCase();
    const wa = normWhatsApp(contact);
    const waMatch = !!wa && wa === o.customer.whatsapp;
    if (!emailMatch && !waMatch) return notFound();

    const history = [{ status: 'new', at: o.createdAt }, ...(o.history || []).map((h) => ({ status: h.status, at: h.at }))];
    send(res, 200, {
      order: {
        orderNo: o.orderNo, status: o.status, createdAt: o.createdAt, updatedAt: o.updatedAt || o.createdAt,
        items: o.items.map((i) => ({ name: i.name, qty: i.qty, lineTotal: i.lineTotal })), total: o.total,
        shipping: o.shipping ? { label: o.shipping.label, fee: o.shipping.fee, pending: !!o.shipping.pending, method: o.shipping.method } : null,
        customerName: o.customer.name.split(/\s+/)[0], deliveryArea: o.customer.address,
        invoice: o.invoice ? { no: o.invoice.no, url: invoiceUrl(`https://${req.headers['x-forwarded-host'] || req.headers.host}`, uid, o.orderNo) } : null,
        history
      },
      shop: { business: owner.business, whatsapp: owner.whatsapp || null, currency: o.currency || owner.currency || 'AED' }
    });
  } catch (e) { fail(res, e); }
}
