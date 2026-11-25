// TEMPORARY one-off: set the WhatsApp number on the Handmade by CRJ account. Removed right after use.
import { list } from '@vercel/blob';
import { assertConfigured, getUser, saveUser, send } from './_lib.js';
import crypto from 'node:crypto';

export default async function handler(req, res) {
  try {
    assertConfigured();
    const { blobs } = await list({ prefix: 'users/', limit: 1000 });
    const key = crypto.createHash('sha256').update('crochethub-records:' + process.env.AUTH_SECRET).digest();
    const matched = [];
    let total = 0;
    for (const b of blobs) {
      const r = await fetch(b.url + '?v=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) continue;
      let rec;
      try {
        const { iv, tag, data } = JSON.parse(await r.text());
        const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
        d.setAuthTag(Buffer.from(tag, 'base64'));
        rec = JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'));
      } catch { continue; }
      if (!rec?.userId || rec.userId.startsWith('zz-health')) continue;
      total++;
      if (/crj/i.test(`${rec.business} ${rec.userId}`)) {
        const fresh = await getUser(rec.userId);
        fresh.whatsapp = '+971557412445';
        fresh.updatedAt = new Date().toISOString();
        await saveUser(fresh);
        matched.push({ userId: fresh.userId, business: fresh.business, whatsapp: fresh.whatsapp });
      }
    }
    send(res, 200, { totalAccounts: total, updated: matched });
  } catch (e) { send(res, 500, { error: String(e?.message || e) }); }
}
