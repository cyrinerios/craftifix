import { assertConfigured, normId, validId, invoiceToken, getUser, getOrders, send, onlyMethod, fail } from './_lib.js';
import crypto from 'node:crypto';

// GET /api/invoice?u=<shop>&o=<orderNo>&t=<token> -> invoice data for the private invoice page.
export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'GET')) return;
  try {
    assertConfigured();
    res.setHeader('Cache-Control', 'no-store');
    const uid = normId(req.query?.u);
    const orderNo = String(req.query?.o || '').toUpperCase();
    const t = String(req.query?.t || '');
    const notFound = () => send(res, 404, { error: 'This invoice link is not valid.' });
    if (!validId(uid) || !/^CH-\d{6}-[0-9A-F]{4}$/.test(orderNo) || t.length !== 24) return notFound();
    const want = invoiceToken(uid, orderNo);
    if (!crypto.timingSafeEqual(Buffer.from(t), Buffer.from(want))) return notFound();
    const owner = await getUser(uid);
    if (!owner) return notFound();
    const o = (await getOrders(uid)).find((x) => x.orderNo === orderNo);
    if (!o || !o.invoice) return notFound();
    send(res, 200, {
      invoice: { no: o.invoice.no, issuedAt: o.invoice.issuedAt, status: o.status },
      order: {
        orderNo: o.orderNo, createdAt: o.createdAt, currency: o.currency || owner.currency || 'AED', total: o.total,
        shipping: o.shipping ? { label: o.shipping.label, fee: o.shipping.fee, method: o.shipping.method, pending: !!o.shipping.pending } : null,
        items: o.items.map((i) => ({ name: i.name, qty: i.qty, unitPrice: i.unitPrice ?? (i.qty ? i.lineTotal / i.qty : i.lineTotal), lineTotal: i.lineTotal, vat: !!i.vat })),
        payment: o.payment?.ref ? { ref: o.payment.ref, paidAt: o.payment.paidAt || null } : null,
        fromInquiry: o.source?.type === 'inquiry' ? o.source.inqNo || true : null
      },
      customer: { name: o.customer.name, email: o.customer.email, whatsapp: o.customer.whatsapp, address: o.customer.address },
      shop: { userId: owner.userId, business: owner.business, owner: owner.name, email: owner.email, whatsapp: owner.whatsapp || '', logo: owner.logo || '', social: owner.social || {} }
    });
  } catch (e) { fail(res, e); }
}
