// TEMPORARY self-test — removed after verification.
import { del } from '@vercel/blob';
import { assertConfigured, getUser, saveUser, hashPassword, verifyPassword, send } from './_lib.js';

export default async function handler(req, res) {
  const steps = {};
  try {
    assertConfigured(); steps.config = 'ok';
    steps.missingUser = (await getUser('zz-health-missing')) === null ? 'ok' : 'unexpected';
    const id = 'zz-health-' + Date.now();
    const h = await hashPassword('abc12345');
    await saveUser({ userId: id, passwordHash: h, plan: 'starter' }, { create: true }); steps.create = 'ok';
    let dup = 'not-blocked';
    try { await saveUser({ userId: id, passwordHash: h, plan: 'starter' }, { create: true }); } catch (e) { dup = /already exists/i.test(String(e?.message)) ? 'ok' : 'other: ' + e?.message; }
    steps.duplicateBlocked = dup;
    const back = await getUser(id);
    steps.readBack = back && back.userId === id ? 'ok' : 'failed';
    steps.password = (await verifyPassword('abc12345', back?.passwordHash)) && !(await verifyPassword('wrong999', back?.passwordHash)) ? 'ok' : 'failed';
    await saveUser({ ...back, plan: 'business' });
    steps.update = (await getUser(id))?.plan === 'business' ? 'ok' : 'stale-or-failed';
    const { head } = await import('@vercel/blob');
    const crypto = await import('node:crypto');
    const p = 'users/' + crypto.createHmac('sha256', process.env.AUTH_SECRET).update(id).digest('hex') + '.json';
    await del((await head(p)).url); steps.cleanup = 'ok';
    send(res, 200, steps);
  } catch (e) { send(res, 500, { ...steps, error: String(e?.message || e) }); }
}
