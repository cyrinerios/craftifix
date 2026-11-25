import { PLANS, assertConfigured, normId, validId, validEmail, clean, normWhatsApp, hashPassword, getUser, saveUser, publicUser, setSession, body, send, onlyMethod, fail } from './_lib.js';

export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'POST')) return;
  try {
    assertConfigured();
    const b = body(req);
    const userId = normId(b.userId);
    const password = String(b.password || '');
    const name = clean(b.name);
    const business = clean(b.business);
    const email = clean(b.email, 254).toLowerCase();
    const plan = String(b.plan || '').toLowerCase();
    const whatsapp = normWhatsApp(b.whatsapp);

    if (!validId(userId)) return send(res, 400, { error: 'User ID must be 3–20 characters: letters, numbers, dot, dash or underscore, starting with a letter or number.', field: 'userId' });
    if (password.length < 8 || password.length > 128) return send(res, 400, { error: 'Password must be at least 8 characters.', field: 'password' });
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return send(res, 400, { error: 'Password needs at least one letter and one number.', field: 'password' });
    if (!name) return send(res, 400, { error: 'Please enter your name.', field: 'name' });
    if (!business) return send(res, 400, { error: 'Please enter your business name.', field: 'business' });
    if (!validEmail(email)) return send(res, 400, { error: 'Please enter a valid email address.', field: 'email' });
    if (!whatsapp) return send(res, 400, { error: 'Please enter a valid WhatsApp number with country code, e.g. +971 55 123 4567.', field: 'whatsapp' });
    if (!PLANS[plan]) return send(res, 400, { error: 'Please choose a plan.', field: 'plan' });

    if (await getUser(userId)) return send(res, 409, { error: 'That user ID is already taken. Please choose another.', field: 'userId' });

    const now = new Date().toISOString();
    const rec = {
      userId, name, business, email, whatsapp, plan,
      passwordHash: await hashPassword(password),
      subscription: { status: 'active', billing: 'monthly', paymentStatus: 'skipped', startedAt: now },
      createdAt: now, updatedAt: now
    };
    try { await saveUser(rec, { create: true }); }
    catch (e) {
      if (/already exists/i.test(String(e?.message))) return send(res, 409, { error: 'That user ID is already taken. Please choose another.', field: 'userId' });
      throw e;
    }
    setSession(res, userId);
    send(res, 201, { user: publicUser(rec) });
  } catch (e) { fail(res, e); }
}
