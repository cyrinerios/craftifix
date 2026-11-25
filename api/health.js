// TEMPORARY self-test — removed after verification.
import { del } from '@vercel/blob';
import { assertConfigured, calcPrice, cleanProduct, getProducts, saveProducts, uploadImage, send } from './_lib.js';

export default async function handler(req, res) {
  const s = {};
  try {
    assertConfigured(); s.config = 'ok';
    const c = calcPrice({ materials: 38, accessories: 12, packaging: 15, hours: 6, rate: 20, overheadPct: 10, method: 'markup', pct: 40, round: 5 });
    s.calcMarkup = c.result.price === 285 && c.result.cost === 203.5 ? 'ok' : JSON.stringify(c.result);
    const m = calcPrice({ materials: 100, method: 'margin', pct: 50, round: 0 });
    s.calcMargin = m.result.price === 200 ? 'ok' : JSON.stringify(m.result);
    const w = calcPrice({ materials: 100, method: 'wholesale', pct: 20, round: 0, vat: true });
    s.calcWholesale = w.result.price === 120 && w.result.retail === 240 && w.result.vatAmount === 6 ? 'ok' : JSON.stringify(w.result);
    const uid = 'zz-health-' + Date.now();
    s.emptyList = (await getProducts(uid)).length === 0 ? 'ok' : 'unexpected';
    const p = cleanProduct({ name: 'Test bouquet', category: 'Bouquets', status: 'published', image: 'javascript:alert(1)', costing: { materials: 10, hours: 1, rate: 20 } });
    s.sanitize = p.image === '' && p.pricing.price > 0 ? 'ok' : JSON.stringify(p);
    await saveProducts(uid, [{ id: 'x', ...p }]);
    s.roundTrip = (await getProducts(uid))[0]?.name === 'Test bouquet' ? 'ok' : 'failed';
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
    const url = await uploadImage(uid, png);
    const ir = await fetch(url);
    s.upload = ir.ok && /image\/png/.test(ir.headers.get('content-type') || '') ? 'ok' : 'status ' + ir.status;
    let bad = 'not-rejected';
    try { await uploadImage(uid, 'data:text/html;base64,PGgxPg=='); } catch (e) { bad = e.status === 400 ? 'ok' : e.message; }
    s.rejectsNonImage = bad;
    const { head } = await import('@vercel/blob');
    const crypto = await import('node:crypto');
    const pp = 'products/' + crypto.createHmac('sha256', process.env.AUTH_SECRET).update('products:' + uid).digest('hex') + '.json';
    await del([url, (await head(pp)).url]); s.cleanup = 'ok';
    send(res, 200, s);
  } catch (e) { send(res, 500, { ...s, error: String(e?.message || e) }); }
}
