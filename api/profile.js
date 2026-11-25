import { assertConfigured, requireUser, getUser, saveUser, publicUser, clean, validEmail, normWhatsApp, body, send, onlyMethod, fail } from './_lib.js';

// POST /api/profile { name, business, email, whatsapp } -> update the logged-in owner's details
export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'POST')) return;
  try {
    assertConfigured();
    const uid = requireUser(req, res); if (!uid) return;
    const rec = await getUser(uid);
    if (!rec) return send(res, 401, { error: 'Please log in again.' });
    const b = body(req);
    const name = clean(b.name), business = clean(b.business), email = clean(b.email, 254).toLowerCase(), whatsapp = normWhatsApp(b.whatsapp);
    if (!name) return send(res, 400, { error: 'Please enter your name.', field: 'name' });
    if (!business) return send(res, 400, { error: 'Please enter your business name.', field: 'business' });
    if (!validEmail(email)) return send(res, 400, { error: 'Please enter a valid email address.', field: 'email' });
    if (!whatsapp) return send(res, 400, { error: 'Please enter a valid WhatsApp number with country code, e.g. +971 55 123 4567.', field: 'whatsapp' });
    Object.assign(rec, { name, business, email, whatsapp, updatedAt: new Date().toISOString() });
    await saveUser(rec);
    send(res, 200, { user: publicUser(rec) });
  } catch (e) { fail(res, e); }
}
