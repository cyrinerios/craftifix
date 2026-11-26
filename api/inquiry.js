import crypto from 'node:crypto';
import { shopPaused } from './_stripe.js';
import { assertConfigured, normId, validId, validEmail, clean, normWhatsApp, waLink, getUser, getInquiries, saveInquiries, uploadImage, deliver, sendOwnerWhatsApp, escHtml, body, send, onlyMethod, fail } from './_lib.js';

// POST /api/inquiry — a shopper sends a custom-order inquiry with up to two inspiration photos (Option 1, Option 2).
// Saved to the owner's account, emailed to the owner and sent to the owner's WhatsApp when alerts are set up.
export const config = { api: { bodyParser: { sizeLimit: '4.5mb' } } };

export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'POST')) return;
  try {
    assertConfigured();
    const b = body(req);
    const uid = normId(b.shop);
    if (!validId(uid)) return send(res, 404, { error: 'Shop not found.' });
    const owner = await getUser(uid);
    if (!owner || owner.subscription?.status === 'suspended') return send(res, 404, { error: 'Shop not found.' });
    if (shopPaused(owner)) return send(res, 403, { error: 'This shop is temporarily unavailable. Please try again later.' });

    const customer = { name: clean(b.name, 80), email: clean(b.email, 254).toLowerCase(), whatsapp: normWhatsApp(b.whatsapp), address: clean(b.address, 400) };
    const message = clean(b.message, 1500);
    const budget = clean(b.budget, 40);
    const neededBy = /^\d{4}-\d{2}-\d{2}$/.test(String(b.neededBy || '')) ? b.neededBy : '';
    if (!customer.name) return send(res, 400, { error: 'Please enter your name.', field: 'name' });
    if (!validEmail(customer.email)) return send(res, 400, { error: 'Please enter a valid email address.', field: 'email' });
    if (!customer.whatsapp) return send(res, 400, { error: 'Please enter your WhatsApp number with country code, e.g. +971 55 123 4567.', field: 'whatsapp' });
    if (customer.address.length < 8) return send(res, 400, { error: 'Please enter your delivery address.', field: 'address' });
    if (message.length < 5) return send(res, 400, { error: 'Please tell the shop what you would like made.', field: 'message' });

    const raw = Array.isArray(b.options) ? b.options.slice(0, 2) : [];
    const options = [];
    for (let i = 0; i < raw.length; i++) {
      const o = raw[i] || {};
      const note = clean(o.note, 300);
      let image = '';
      if (o.dataUrl) {
        try { image = await uploadImage(uid, o.dataUrl); }
        catch (e) { if (e?.status === 400) return send(res, 400, { error: `Option ${i + 1}: ${e.message}` }); throw e; }
      }
      if (note || image) options.push({ label: `Option ${i + 1}`, note, image });
    }

    const now = new Date();
    const inqNo = 'IQ-' + now.toISOString().slice(2, 10).replace(/-/g, '') + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
    const inq = { id: crypto.randomUUID(), inqNo, status: 'new', customer, message, budget, neededBy, options, createdAt: now.toISOString() };
    const list = await getInquiries(uid);
    list.unshift(inq);
    await saveInquiries(uid, list.slice(0, 500));

    const text = [
      `New custom inquiry ${inqNo} for ${owner.business}`, '',
      `From: ${customer.name}`, `Email: ${customer.email}`, `WhatsApp: ${customer.whatsapp}`, `Delivery address: ${customer.address}`, '',
      `Request: ${message}`,
      budget ? `Budget: ${budget}` : '', neededBy ? `Needed by: ${neededBy}` : '',
      ...options.map((o) => `\n${o.label}${o.note ? `: ${o.note}` : ''}${o.image ? `\nPhoto: ${o.image}` : ''}`)
    ].filter((l) => l !== '').join('\n');

    const html = `<div style="font-family:Arial,sans-serif;color:#2a1430;max-width:600px">
      <h2 style="color:#4a1d4f">New custom inquiry ${escHtml(inqNo)}</h2>
      <p><b>${escHtml(customer.name)}</b><br>Email: ${escHtml(customer.email)}<br>WhatsApp: <a href="${waLink(customer.whatsapp)}">${escHtml(customer.whatsapp)}</a><br>Delivery address: ${escHtml(customer.address)}</p>
      <p><b>What they'd like:</b><br>${escHtml(message).replace(/\n/g, '<br>')}</p>
      ${budget ? `<p><b>Budget:</b> ${escHtml(budget)}</p>` : ''}${neededBy ? `<p><b>Needed by:</b> ${escHtml(neededBy)}</p>` : ''}
      ${options.map((o) => `<div style="margin:16px 0;padding:12px;border:1px solid #ecd9e4;border-radius:12px"><b style="color:#4a1d4f">${escHtml(o.label)}</b>${o.note ? `<p style="margin:6px 0">${escHtml(o.note)}</p>` : ''}${o.image ? `<a href="${escHtml(o.image)}"><img src="${escHtml(o.image)}" alt="${escHtml(o.label)}" style="max-width:100%;max-height:360px;border-radius:8px"></a>` : ''}</div>`).join('')}
      <p style="color:#6d5670;font-size:13px">Reply to this email to answer the customer. You can also see this inquiry in your Craftifix account.</p></div>`;

    const [email, wa] = await Promise.all([
      deliver({ action: 'new_inquiry', inquiry: { ...inq, shop: uid, statusLabel: 'New' }, email: { to: owner.email, subject: `New custom inquiry ${inqNo} from ${customer.name}`, text, html, replyTo: customer.email, fromName: `${owner.business} inquiries` } }),
      sendOwnerWhatsApp(owner, '💡 ' + text)
    ]);
    inq.emailSent = email.sent; inq.whatsappSent = wa.sent;
    list[0] = inq;
    await saveInquiries(uid, list.slice(0, 500));

    send(res, 201, {
      inqNo, emailSent: email.sent, whatsappSent: wa.sent,
      whatsappUrl: owner.whatsapp ? waLink(owner.whatsapp, text) : null,
      mailtoUrl: email.sent ? null : `mailto:${owner.email}?subject=${encodeURIComponent(`Custom inquiry ${inqNo}`)}&body=${encodeURIComponent(text)}`
    });
  } catch (e) { fail(res, e); }
}
