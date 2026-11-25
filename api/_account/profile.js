import { assertConfigured, requireUser, getUser, saveUser, publicUser, clean, validEmail, normWhatsApp, normSocial, isBlobUrl, sendOwnerWhatsApp, body, send, onlyMethod, fail } from '../_lib.js';

// POST /api/profile { name, business, email, whatsapp, callmebotKey? } -> update the logged-in owner's details
// POST /api/profile?test=whatsapp -> send a test WhatsApp alert to the owner's number
export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'POST')) return;
  try {
    assertConfigured();
    const uid = requireUser(req, res); if (!uid) return;
    const rec = await getUser(uid);
    if (!rec) return send(res, 401, { error: 'Please log in again.' });
    if (String(req.query?.test || '') === 'whatsapp') {
      const r = await sendOwnerWhatsApp(rec, `✅ CrochetHub test: order alerts for ${rec.business} will arrive on this WhatsApp number.`);
      return send(res, r.sent ? 200 : 400, r.sent ? { ok: true } : { error: rec.callmebotKey ? 'The test message could not be sent. Check your WhatsApp number and CallMeBot API key.' : 'Add your CallMeBot API key first.' });
    }
    const b = body(req);
    const name = clean(b.name), business = clean(b.business), email = clean(b.email, 254).toLowerCase(), whatsapp = normWhatsApp(b.whatsapp);
    if (!name) return send(res, 400, { error: 'Please enter your name.', field: 'name' });
    if (!business) return send(res, 400, { error: 'Please enter your business name.', field: 'business' });
    if (!validEmail(email)) return send(res, 400, { error: 'Please enter a valid email address.', field: 'email' });
    if (!whatsapp) return send(res, 400, { error: 'Please enter a valid WhatsApp number with country code, e.g. +971 55 123 4567.', field: 'whatsapp' });
    if (whatsapp !== rec.whatsapp) delete rec.callmebotKey; // key belongs to a specific number
    if (typeof b.callmebotKey === 'string') {
      const k = b.callmebotKey.trim();
      if (k && !/^[A-Za-z0-9_-]{3,40}$/.test(k)) return send(res, 400, { error: 'That CallMeBot API key does not look right — it is the number the bot sent you.', field: 'callmebotKey' });
      if (k) rec.callmebotKey = k; else if (b.callmebotKey === '') delete rec.callmebotKey;
    }
    if (b.social && typeof b.social === 'object') {
      const social = {};
      for (const k of ['instagram', 'facebook', 'tiktok']) {
        const v = normSocial(k, b.social[k]);
        if (v === null) return send(res, 400, { error: `That ${k === 'tiktok' ? 'TikTok' : k[0].toUpperCase() + k.slice(1)} link doesn't look right. Paste your profile link or just your username.`, field: k });
        if (v) social[k] = v;
      }
      rec.social = social;
    }
    if (b.logo === '' || b.logo === null) delete rec.logo;
    else if (isBlobUrl(b.logo)) rec.logo = b.logo;
    Object.assign(rec, { name, business, email, whatsapp, updatedAt: new Date().toISOString() });
    await saveUser(rec);
    send(res, 200, { user: publicUser(rec) });
  } catch (e) { fail(res, e); }
}
