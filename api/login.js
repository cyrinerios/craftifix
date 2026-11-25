import { assertConfigured, normId, verifyPassword, getUser, publicUser, setSession, body, send, onlyMethod, fail } from './_lib.js';

export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'POST')) return;
  try {
    assertConfigured();
    const b = body(req);
    const userId = normId(b.userId);
    const password = String(b.password || '');
    const bad = () => send(res, 401, { error: 'User ID or password is incorrect.' });
    if (!userId || !password || password.length > 128) return bad();
    const rec = await getUser(userId);
    if (!rec || !(await verifyPassword(password, rec.passwordHash))) return bad();
    if (rec.subscription?.status === 'suspended') return send(res, 403, { error: 'This account is suspended. Please contact support.' });
    setSession(res, userId);
    send(res, 200, { user: publicUser(rec) });
  } catch (e) { fail(res, e); }
}
