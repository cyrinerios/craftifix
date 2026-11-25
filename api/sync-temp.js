// TEMPORARY: checks the Apps Script connection and refreshes the owner's account and products in the sheet.
// Requires ?t=EXPORT_TOKEN. Removed right after use.
import crypto from 'node:crypto';
import { assertConfigured, getUser, getProducts, deliver, syncAccount, send } from './_lib.js';

export default async function handler(req, res) {
  try {
    assertConfigured();
    const tok = String(req.query?.t || ''), want = process.env.EXPORT_TOKEN || '';
    if (!want || tok.length !== want.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(want))) return send(res, 404, { error: 'Not found' });
    const out = { urlSet: !!process.env.APPS_SCRIPT_URL };
    const url = process.env.APPS_SCRIPT_URL;
    // Raw call so we can see exactly what the script answers.
    const r = await fetch(url, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: process.env.APPS_SCRIPT_SECRET || '', action: 'ping' }) });
    out.ping = { status: r.status, body: (await r.text()).slice(0, 300) };
    const owner = await getUser('handmadebycrj');
    out.account = await syncAccount(owner);
    out.products = [];
    for (const p of await getProducts('handmadebycrj')) out.products.push((await deliver({ action: 'product_upsert', product: { ...p, shop: 'handmadebycrj' } })).sheet);
    if (String(req.query?.email || '') === '1') {
      out.email = await deliver({ action: 'email_test', email: { to: owner.email, subject: 'CrochetHub: emails from your Gmail are working', text: `Hi ${owner.name.split(' ')[0]},\n\nThis is a test from your CrochetHub shop. Order alerts, customer updates and quotes will now be sent from this Gmail account.\n\n— CrochetHub`, fromName: 'CrochetHub' } });
    }
    send(res, 200, out);
  } catch (e) { send(res, 500, { error: String(e?.message || e) }); }
}
