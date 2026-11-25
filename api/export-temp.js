// TEMPORARY one-off export of all data (no passwords). Requires ?t=EXPORT_TOKEN. Removed right after use.
import crypto from 'node:crypto';
import { list } from '@vercel/blob';
import { assertConfigured, getProducts, getOrders, send } from './_lib.js';

export default async function handler(req, res) {
  try {
    assertConfigured();
    const tok = String(req.query?.t || ''), want = process.env.EXPORT_TOKEN || '';
    if (!want || tok.length !== want.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(want))) return send(res, 404, { error: 'Not found' });
    const key = crypto.createHash('sha256').update('crochethub-records:' + process.env.AUTH_SECRET).digest();
    const { blobs } = await list({ prefix: 'users/', limit: 1000 });
    const accounts = [];
    for (const b of blobs) {
      const r = await fetch(b.url + '?v=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) continue;
      try {
        const { iv, tag, data } = JSON.parse(await r.text());
        const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
        d.setAuthTag(Buffer.from(tag, 'base64'));
        const { passwordHash, ...rec } = JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'));
        if (!rec.userId || rec.userId.startsWith('zz-health')) continue;
        accounts.push({ ...rec, products: await getProducts(rec.userId), orders: await getOrders(rec.userId) });
      } catch { /* skip unreadable */ }
    }
    send(res, 200, { exportedAt: new Date().toISOString(), accounts });
  } catch (e) { send(res, 500, { error: String(e?.message || e) }); }
}
