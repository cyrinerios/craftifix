import { assertConfigured, readSession, getUser, getProducts, publicUser, clearSession, send, onlyMethod, fail } from '../_lib.js';

export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'GET')) return;
  try {
    assertConfigured();
    const uid = readSession(req);
    if (!uid) return send(res, 401, { error: 'Not logged in' });
    const rec = await getUser(uid);
    if (!rec) { clearSession(res); return send(res, 401, { error: 'Not logged in' }); }
    const productCount = (await getProducts(uid)).length;
    send(res, 200, { user: { ...publicUser(rec), productCount } });
  } catch (e) { fail(res, e); }
}
