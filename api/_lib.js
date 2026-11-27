// Shared helpers for the Craftifix account API.
// Files starting with "_" are not exposed as routes by Vercel.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { put, head, list, BlobNotFoundError } from '@vercel/blob';
import { useDb, q, tx, setFirstRun, dbEnvName } from './_db.js';

const scrypt = promisify(crypto.scrypt);
const SECRET = process.env.AUTH_SECRET || '';
const COOKIE = 'ch_session';
const SESSION_DAYS = 7;

export const PLANS = {
  standard: {
    id: 'standard', name: 'Standard', price: 5,
    limits: { products: 5, inquiryOrdersPerMonth: 5 },
    features: { dashboard: 'Basic', pricingCalculator: 'Full', onlineStore: 'Basic', customers: 'Basic', inventory: 'Limited', salesReports: 'Basic', productionTracking: 'No', staffAccounts: 'No' }
  },
  premium: {
    id: 'premium', name: 'Premium', price: 15,
    limits: { products: null, inquiryOrdersPerMonth: null },
    features: { dashboard: 'Advanced', pricingCalculator: 'Full', onlineStore: 'Customizable', customers: 'Full', inventory: 'Full', salesReports: 'Advanced', productionTracking: 'Full', staffAccounts: 'Multiple' }
  }
};

// Accounts created before the plan change keep working: Starter -> Standard, Professional/Business -> Premium.
const LEGACY_PLANS = { starter: 'standard', professional: 'premium', business: 'premium' };
export const planId = (id) => (PLANS[id] ? id : LEGACY_PLANS[id] || 'standard');
export const planFor = (id) => PLANS[planId(id)];

// Plan limits are counted per calendar month in UAE time (UTC+4).
const uaeMonth = (d) => new Date(new Date(d).getTime() + 4 * 3600e3).toISOString().slice(0, 7);
export const isInquiryOrderThisMonth = (o, now = new Date()) => o.source?.type === 'inquiry' && uaeMonth(o.createdAt) === uaeMonth(now);
export function planUsage(rec, products, orders, now = new Date()) {
  const p = planFor(rec.plan);
  const [y, m] = uaeMonth(now).split('-').map(Number);
  const resetsOn = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
  return {
    plan: p.id, planName: p.name,
    products: { used: products.length, limit: p.limits.products },
    inquiryOrders: { used: orders.filter((o) => isInquiryOrderThisMonth(o, now)).length, limit: p.limits.inquiryOrdersPerMonth, resetsOn }
  };
}

export function assertConfigured() {
  if (!SECRET || SECRET.length < 32) throw new Error('AUTH_SECRET is not configured');
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN is not configured');
}

/* ---------- validation ---------- */
export const normId = (v) => String(v || '').trim().toLowerCase();
export const validId = (v) => /^[a-z0-9][a-z0-9._-]{2,19}$/.test(v);
export const validEmail = (v) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(v);
export const clean = (v, max = 80) => String(v || '').trim().slice(0, max);

/* ---------- passwords ---------- */
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, s, k] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !s || !k) return false;
  const expected = Buffer.from(k, 'base64');
  const got = await scrypt(pw, Buffer.from(s, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, got);
}

/* ---------- encrypted record storage (Vercel Blob) ---------- */
// Do not change 'crochethub-records' — it is part of the encryption key for all stored records (kept after the rename to Craftifix).
const encKey = () => crypto.createHash('sha256').update('crochethub-records:' + SECRET).digest();
const pathFor = (uid) => 'users/' + crypto.createHmac('sha256', SECRET).update(uid).digest('hex') + '.json';

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
}
function decrypt(text) {
  const { iv, tag, data } = JSON.parse(text);
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'));
}

async function blobGetUser(uid) {
  let meta;
  try { meta = await head(pathFor(uid)); }
  catch (e) { if (e instanceof BlobNotFoundError || e?.name === 'BlobNotFoundError') return null; throw e; }
  const r = await fetch(meta.url + '?v=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) return null;
  return decrypt(await r.text());
}

async function blobSaveUser(rec, { create = false } = {}) {
  await put(pathFor(rec.userId), encrypt(rec), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: !create,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

export function publicUser(rec) {
  const { passwordHash, callmebotKey, ...rest } = rec;
  return { ...rest, currency: rec.currency || 'AED', whatsappAlerts: !!callmebotKey, plan: planId(rec.plan), planDetails: planFor(rec.plan), trial: trialInfo(rec) };
}

/* ---------- sessions (HMAC-signed cookie) ---------- */
const b64u = (b) => Buffer.from(b).toString('base64url');
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

export function setSession(res, uid) {
  const payload = b64u(JSON.stringify({ u: uid, exp: Date.now() + SESSION_DAYS * 864e5 }));
  const token = payload + '.' + sign(payload);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}
export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
// ---------- Invoices ----------
// Each completed order gets a shop-numbered invoice (INV-0001, INV-0002 …) and a private link the customer can open.
export const invoiceToken = (uid, orderNo) => crypto.createHmac('sha256', SECRET).update(`inv:${uid}:${orderNo}`).digest('base64url').slice(0, 24);
export const invoiceUrl = (origin, uid, orderNo) => `${origin}/invoice.html?u=${encodeURIComponent(uid)}&o=${encodeURIComponent(orderNo)}&t=${invoiceToken(uid, orderNo)}`;
// Gives completed orders without an invoice the next number. Returns true if anything changed (caller saves both).
export function assignInvoices(owner, orders) {
  let changed = false;
  for (const o of [...orders].reverse()) { // oldest first, so numbers follow completion order for older orders
    if (o.status === 'completed' && !o.invoice) {
      owner.invoiceSeq = (owner.invoiceSeq || 0) + 1;
      o.invoice = { no: 'INV-' + String(owner.invoiceSeq).padStart(4, '0'), issuedAt: new Date().toISOString() };
      changed = true;
    }
  }
  return changed;
}

// ---------- Password reset ----------
// A reset link carries a signed token: account, expiry (1 hour) and a fingerprint of the current password hash.
// Once the password changes the fingerprint no longer matches, so each link works only once.
const pwPrint = (hash) => crypto.createHash('sha256').update(String(hash || '')).digest('hex').slice(0, 16);
export function makeResetToken(rec, minutes = 60) {
  const payload = b64u(JSON.stringify({ u: rec.userId, exp: Date.now() + minutes * 60e3, p: pwPrint(rec.passwordHash) }));
  return payload + '.' + sign('reset.' + payload);
}
export function readResetToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign('reset.' + payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const t = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return t.exp > Date.now() ? t : { expired: true };
  } catch { return null; }
}
export const resetTokenMatches = (t, rec) => !!(t && rec && t.p === pwPrint(rec.passwordHash));

// Find accounts by email (owners may forget their user ID). Reads the stored accounts; fine at small scale.
async function blobFindUsersByEmail(email) {
  const want = String(email || '').trim().toLowerCase();
  if (!want) return [];
  const found = [];
  let cursor;
  do {
    const page = await list({ prefix: 'users/', cursor, limit: 1000 });
    for (const b of page.blobs) {
      try {
        const r = await fetch(b.url + '?v=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) continue;
        const rec = decrypt(await r.text());
        if (String(rec.email || '').toLowerCase() === want) found.push(rec);
      } catch { /* skip unreadable */ }
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return found;
}

export function readSession(req) {
  const raw = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!payload || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return exp > Date.now() ? u : null;
  } catch { return null; }
}

/* ---------- products (one encrypted list per business) ---------- */
const productsPath = (uid) => 'products/' + crypto.createHmac('sha256', SECRET).update('products:' + uid).digest('hex') + '.json';

async function blobGetProducts(uid) {
  let meta;
  try { meta = await head(productsPath(uid)); }
  catch (e) { if (e instanceof BlobNotFoundError || e?.name === 'BlobNotFoundError') return []; throw e; }
  const r = await fetch(meta.url + '?v=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) return [];
  return decrypt(await r.text());
}
async function blobSaveProducts(uid, list) {
  await put(productsPath(uid), encrypt(list), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json', cacheControlMaxAge: 60
  });
}

export const CATEGORIES = ['Flowers', 'Bouquets', 'Dolls & amigurumi', 'Bags', 'Accessories', 'Clothing', 'Home decor', 'Customized gifts', 'Other'];
export const METHODS = ['markup', 'margin', 'hourly', 'wholesale'];

const num = (v, max = 1e6) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : 0; };
const r2 = (v) => Math.round(v * 100) / 100;
const roundTo = (v, step) => step > 0 ? Math.ceil(v / step) * step : r2(v);

// Same maths as the calculator on the website. The server recomputes so stored prices are always consistent.
// Itemised costs: each row is a material bought in packs (e.g. 100 g yarn ball for AED 12, 35 g used).
export const COST_GROUPS = ['yarn', 'material', 'accessory', 'packaging'];
export const UNITS = ['g', 'kg', 'oz', 'lb', 'm', 'cm', 'mm', 'yd', 'in', 'ft', 'pcs', 'pair', 'set', 'ball', 'skein', 'roll', 'sheet', 'pack', 'ml'];
const txt = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
export function cleanItems(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, 80).map((it) => {
    const packSize = num(it?.packSize, 1e7), packPrice = num(it?.packPrice, 1e7), used = num(it?.used, 1e7);
    return {
      group: COST_GROUPS.includes(it?.group) ? it.group : 'material',
      name: txt(it?.name, 80), desc: txt(it?.desc, 120),
      unit: UNITS.includes(it?.unit) ? it.unit : 'pcs',
      packSize, packPrice, used,
      cost: packSize > 0 ? r2(packPrice / packSize * used) : 0
    };
  }).filter((it) => it.name || it.packPrice || it.used);
}
const sumGroup = (items, ...g) => r2(items.filter((i) => g.includes(i.group)).reduce((a, i) => a + i.cost, 0));

export function calcPrice(input = {}) {
  const items = cleanItems(input.items);
  const c = {
    materials: num(input.materials), accessories: num(input.accessories), packaging: num(input.packaging),
    overheadPct: num(input.overheadPct, 100), hours: num(input.hours, 1000), rate: num(input.rate, 10000),
    method: METHODS.includes(input.method) ? input.method : 'markup',
    pct: num(input.pct, 500), round: [0, 1, 5, 10].includes(Number(input.round)) ? Number(input.round) : 0,
    vat: !!input.vat
  };
  if (c.method === 'margin') c.pct = Math.min(c.pct, 95);
  // With an itemised list, the three totals always come from the rows.
  if (items) {
    c.items = items;
    c.materials = sumGroup(items, 'yarn', 'material');
    c.accessories = sumGroup(items, 'accessory');
    c.packaging = sumGroup(items, 'packaging');
  }
  const extras = c.materials + c.accessories + c.packaging;
  const labour = c.hours * c.rate;
  const overhead = (extras + labour) * c.overheadPct / 100;
  const cost = extras + labour + overhead;
  let price = c.method === 'margin' ? cost / (1 - c.pct / 100) : c.method === 'hourly' ? cost : cost * (1 + c.pct / 100);
  price = roundTo(price, c.round);
  const retail = c.method === 'wholesale' ? roundTo(price * 2, c.round) : null;
  const vatAmount = c.vat ? r2(price * 0.05) : 0;
  const profit = price - cost;
  return {
    input: c,
    result: {
      extras: r2(extras), yarn: items ? sumGroup(items, 'yarn') : null, otherMaterials: items ? sumGroup(items, 'material') : null, labour: r2(labour), overhead: r2(overhead), cost: r2(cost),
      price: r2(price), retail, vatAmount, customerPrice: r2(price + vatAmount),
      profit: r2(profit), margin: price > 0 ? r2(profit / price * 100) : 0
    }
  };
}

export function cleanProduct(b = {}, prev = {}) {
  const pricing = calcPrice(b.costing || prev.costing || {});
  const status = b.status === 'published' ? 'published' : 'draft';
  return {
    name: clean(b.name, 100),
    category: CATEGORIES.includes(b.category) ? b.category : 'Other',
    description: clean(b.description, 1500),
    sku: clean(b.sku, 40),
    quantity: Math.round(num(b.quantity, 100000)),
    productionDays: Math.round(num(b.productionDays, 365)),
    customizable: !!b.customizable,
    image: typeof b.image === 'string' && /^https:\/\/[a-z0-9.-]+\.public\.blob\.vercel-storage\.com\//i.test(b.image) ? b.image.slice(0, 500) : (b.image === null ? '' : (prev.image || '')),
    status,
    costing: pricing.input,
    pricing: pricing.result
  };
}

export async function uploadImage(uid, dataUrl) {
  const m = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw Object.assign(new Error('Please upload a JPG, PNG or WebP image.'), { status: 400 });
  const buf = Buffer.from(m[3], 'base64');
  if (buf.length > 2_500_000) throw Object.assign(new Error('Image is too large (max 2.5 MB).'), { status: 400 });
  const folder = crypto.createHmac('sha256', SECRET).update('img:' + uid).digest('hex').slice(0, 16);
  const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  const blob = await put(`images/${folder}/${crypto.randomUUID()}.${ext}`, buf, {
    access: 'public', addRandomSuffix: false, contentType: m[1], cacheControlMaxAge: 31536000
  });
  return blob.url;
}

/* ---------- WhatsApp numbers ---------- */
// Accepts +971 55 741 2445, 00971557412445 or UAE local 0557412445. Returns "+971557412445" or "".
export function normWhatsApp(v) {
  let s = String(v || '').trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^05\d{8}$/.test(s)) s = '+971' + s.slice(1);
  if (/^\+\d{8,15}$/.test(s)) return s;
  return '';
}
// Social links: accept a full link or a username/handle. Returns a clean https link, '' for empty, or null if invalid.
const SOCIAL = {
  instagram: { hosts: ['instagram.com'], make: (h) => `https://www.instagram.com/${h}` },
  facebook: { hosts: ['facebook.com', 'fb.com', 'm.facebook.com'], make: (h) => `https://www.facebook.com/${h}` },
  tiktok: { hosts: ['tiktok.com'], make: (h) => `https://www.tiktok.com/@${h}` }
};
export function normSocial(kind, v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const cfg = SOCIAL[kind];
  if (/^https?:\/\//i.test(s) || /^(www\.|m\.)?[a-z]+\.com\//i.test(s)) {
    try {
      const u = new URL(/^https?:/i.test(s) ? s : 'https://' + s);
      const host = u.hostname.replace(/^www\./, '');
      if (!cfg.hosts.some((h) => host === h || host.endsWith('.' + h))) return null;
      if (u.pathname.length < 2) return null;
      return ('https://' + u.hostname + u.pathname + u.search).slice(0, 300);
    } catch { return null; }
  }
  const h = s.replace(/^@/, '');
  return /^[A-Za-z0-9._-]{1,60}$/.test(h) ? cfg.make(h) : null;
}
export const isBlobUrl = (u) => typeof u === 'string' && /^https:\/\/[a-z0-9.-]+\.public\.blob\.vercel-storage\.com\//i.test(u);

export const CURRENCIES = ['AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'USD', 'EUR', 'GBP', 'PHP', 'INR', 'PKR', 'EGP', 'JOD', 'LKR', 'NPR', 'BDT', 'CAD', 'AUD'];
export const validCurrency = (c) => CURRENCIES.includes(String(c || '').toUpperCase()) ? String(c).toUpperCase() : null;
export function money(n, cur = 'AED') {
  const c = validCurrency(cur) || 'AED';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: c, currencyDisplay: 'code' }).format(Number(n) || 0).replace(/\u00a0/g, ' '); }
  catch { return c + ' ' + (Number(n) || 0).toFixed(2); }
}

// ---------- Subscription prices in the shop's currency ----------
// Plan prices are set in US dollars (BASE_CURRENCY) and converted with the day's rate from ExchangeRate-API's free endpoint
// (https://www.exchangerate-api.com — attribution required, updates once a day). Rates are cached for
// 12 hours per server instance; if the service can't be reached we fall back to approximate rates.
// Free trial: new shops run on their chosen plan for 30 days with no payment details. After that the
// owner adds a card (Stripe) to keep the shop open.
export const TRIAL_DAYS = 30;
export const trialEndFrom = (iso) => new Date(new Date(iso).getTime() + TRIAL_DAYS * 864e5).toISOString();
// { onTrial, ended, endsAt, daysLeft } for accounts on the free trial; null otherwise.
export function trialInfo(rec, now = Date.now()) {
  const s = rec?.subscription;
  if (!s || !['trial', 'trial_ended'].includes(s.status) || !s.trialEndsAt) return null;
  const end = new Date(s.trialEndsAt).getTime();
  const ended = s.status === 'trial_ended' || now >= end;
  return { onTrial: !ended, ended, endsAt: s.trialEndsAt, daysLeft: ended ? 0 : Math.max(1, Math.ceil((end - now) / 864e5)) };
}
export const BASE_CURRENCY = 'USD';
const FX_URL = 'https://open.er-api.com/v6/latest/' + BASE_CURRENCY;
const FX_TTL = 12 * 3600e3;
// Approximate rates per 1 USD, used only if the rate service can't be reached.
const FX_FALLBACK = { USD: 1, AED: 3.6725, SAR: 3.75, QAR: 3.64, KWD: 0.307, BHD: 0.376, OMR: 0.385, EUR: 0.86, GBP: 0.75,
  PHP: 63.8, INR: 86.7, PKR: 280, EGP: 49, JOD: 0.709, LKR: 300, NPR: 139, BDT: 122, CAD: 1.39, AUD: 1.53 };
let fxCache = null;
export async function getFx() {
  if (fxCache && Date.now() - fxCache.fetchedAt < FX_TTL) return fxCache;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3500);
    const r = await fetch(FX_URL, { signal: ctl.signal }); clearTimeout(t);
    const j = await r.json();
    if (j.result !== 'success' || !j.rates) throw new Error('fx');
    fxCache = { rates: j.rates, updated: j.time_last_update_utc ? new Date(j.time_last_update_utc).toISOString() : new Date().toISOString(), live: true, fetchedAt: Date.now() };
  } catch {
    if (!fxCache) return { rates: FX_FALLBACK, updated: null, live: false, fetchedAt: 0 };
  }
  return fxCache;
}
const decimals = (c) => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
export function convertFromBase(base, cur, rates) {
  const c = validCurrency(cur) || BASE_CURRENCY;
  if (c === BASE_CURRENCY) return { amount: base, rate: 1 };
  const rate = Number(rates[c]) || FX_FALLBACK[c];
  const f = 10 ** decimals(c);
  return { amount: Math.round(base * rate * f) / f, rate };
}
// Subscription promotion: percent off both plans, until further notice.
// Change it in Vercel → Settings → Environment Variables: PROMO_PERCENT_OFF (e.g. 50), or 0 to end the promotion,
// then redeploy. Without that setting the default below applies. PROMO_LABEL changes the promotion's name.
const DEFAULT_PROMO_PERCENT_OFF = 70;
export function promoPercentOff() {
  const v = process.env.PROMO_PERCENT_OFF;
  const n = v === undefined || String(v).trim() === '' ? DEFAULT_PROMO_PERCENT_OFF : Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), 95) : 0;
}
export const promoLabel = () => String(process.env.PROMO_LABEL || 'Launch promo').slice(0, 40);
const promoBase = (price, off) => Math.round(price * (100 - off)) / 100;   // USD price after the promotion, to the cent

export async function pricingFor(cur) {
  const currency = validCurrency(cur) || BASE_CURRENCY;
  const fx = await getFx();
  const off = promoPercentOff();
  const plans = {};
  for (const p of Object.values(PLANS)) {
    // base/amount/label are what the owner pays now (after any promotion); full* are the normal prices.
    const base = off ? promoBase(p.price, off) : p.price;
    const { amount } = convertFromBase(base, currency, fx.rates);
    const full = convertFromBase(p.price, currency, fx.rates).amount;
    plans[p.id] = { base, baseLabel: money(base, BASE_CURRENCY), amount, label: money(amount, currency),
      fullBase: p.price, fullBaseLabel: money(p.price, BASE_CURRENCY), fullAmount: full, fullLabel: money(full, currency), percentOff: off };
  }
  return { currency, baseCurrency: BASE_CURRENCY, rate: convertFromBase(1, currency, fx.rates).rate, updated: fx.updated, live: fx.live,
    source: 'ExchangeRate-API', sourceUrl: 'https://www.exchangerate-api.com', plans,
    promo: off ? { percentOff: off, label: promoLabel() } : null };
}

export const waLink = (number, text) => 'https://wa.me/' + String(number).replace(/\D/g, '') + (text ? '?text=' + encodeURIComponent(text) : '');

/* ---------- orders (one encrypted list per business) ---------- */
const ordersPath = (uid) => 'orders/' + crypto.createHmac('sha256', SECRET).update('orders:' + uid).digest('hex') + '.json';
async function blobGetOrders(uid) {
  let meta;
  try { meta = await head(ordersPath(uid)); }
  catch (e) { if (e instanceof BlobNotFoundError || e?.name === 'BlobNotFoundError') return []; throw e; }
  const r = await fetch(meta.url + '?v=' + Date.now(), { cache: 'no-store' });
  return r.ok ? decrypt(await r.text()) : [];
}
async function blobSaveOrders(uid, list) {
  await put(ordersPath(uid), encrypt(list), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60
  });
}

/* ---------- custom inquiries (one encrypted list per business) ---------- */
const inquiriesPath = (uid) => 'inquiries/' + crypto.createHmac('sha256', SECRET).update('inquiries:' + uid).digest('hex') + '.json';
async function blobGetInquiries(uid) {
  let meta;
  try { meta = await head(inquiriesPath(uid)); }
  catch (e) { if (e instanceof BlobNotFoundError || e?.name === 'BlobNotFoundError') return []; throw e; }
  const r = await fetch(meta.url + '?v=' + Date.now(), { cache: 'no-store' });
  return r.ok ? decrypt(await r.text()) : [];
}
async function blobSaveInquiries(uid, list) {
  await put(inquiriesPath(uid), encrypt(list), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60
  });
}

/* ---------- Prisma Postgres storage ---------- */
// With a database connected (see _db.js) all reads and writes use Postgres; otherwise the Vercel Blob functions above.
// Password hashes and the CallMeBot key stay encrypted (same key as before) in accounts.secrets; everything else is
// stored as readable columns plus the full record in "data".
const SECRET_FIELDS = ['passwordHash', 'callmebotKey'];
const ts = (v) => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d.toISOString() : null; };
const numOrNull = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

async function dbGetUser(uid) {
  const [row] = await q('SELECT data, secrets FROM accounts WHERE user_id = $1', [uid]);
  return row ? { ...row.data, ...(row.secrets ? decrypt(row.secrets) : {}) } : null;
}
function accountRow(rec) {
  const data = { ...rec }, sec = {};
  for (const f of SECRET_FIELDS) if (f in data) { if (data[f] != null) sec[f] = data[f]; delete data[f]; }
  return [rec.userId, String(rec.email || ''), String(rec.business || ''), String(rec.plan || ''), String(rec.subscription?.status || 'active'),
    String(rec.currency || 'AED'), ts(rec.createdAt), JSON.stringify(data), Object.keys(sec).length ? encrypt(sec) : null];
}
const ACCOUNT_INSERT = `INSERT INTO accounts (user_id, email, business, plan, status, currency, created_at, data, secrets, updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9, now())`;
async function dbSaveUser(rec, { create = false } = {}, run = q) {
  const row = accountRow(rec);
  if (create) {
    const r = await run(ACCOUNT_INSERT + ' ON CONFLICT (user_id) DO NOTHING RETURNING user_id', row);
    if (!r.length) throw new Error('This blob already exists');   // same message the signup code checks for
    return;
  }
  await run(ACCOUNT_INSERT + ` ON CONFLICT (user_id) DO UPDATE SET email=EXCLUDED.email, business=EXCLUDED.business, plan=EXCLUDED.plan,
    status=EXCLUDED.status, currency=EXCLUDED.currency, created_at=COALESCE(accounts.created_at, EXCLUDED.created_at), data=EXCLUDED.data,
    secrets=EXCLUDED.secrets, updated_at=now()`, row);
}
async function dbFindUsersByEmail(email) {
  const want = String(email || '').trim().toLowerCase();
  if (!want) return [];
  const rows = await q('SELECT data, secrets FROM accounts WHERE lower(email) = $1', [want]);
  return rows.map((r) => ({ ...r.data, ...(r.secrets ? decrypt(r.secrets) : {}) }));
}

// Lists (products, orders, inquiries) keep the order the app gives them (newest first) via "position".
const LISTS = {
  products: { cols: ['name', 'category', 'status', 'price', 'quantity', 'created_at'],
    vals: (p) => [String(p.name || ''), String(p.category || ''), String(p.status || ''), numOrNull(p.pricing?.customerPrice ?? p.price), Number.isFinite(Number(p.quantity)) ? Math.round(Number(p.quantity)) : null, ts(p.createdAt)] },
  orders: { cols: ['order_no', 'status', 'total', 'currency', 'customer_name', 'customer_email', 'invoice_no', 'created_at', 'updated_at'],
    vals: (o) => [String(o.orderNo || ''), String(o.status || ''), numOrNull(o.total), String(o.currency || ''), String(o.customer?.name || ''), String(o.customer?.email || ''), o.invoice?.no || null, ts(o.createdAt), ts(o.updatedAt || o.createdAt)] },
  inquiries: { cols: ['inq_no', 'status', 'customer_name', 'customer_email', 'created_at'],
    vals: (x) => [String(x.inqNo || ''), String(x.status || ''), String(x.customer?.name || ''), String(x.customer?.email || ''), ts(x.createdAt)] }
};
async function dbGetList(table, uid) {
  return (await q(`SELECT data FROM ${table} WHERE user_id = $1 ORDER BY position`, [uid])).map((r) => r.data);
}
async function insertList(run, table, uid, list) {
  const { cols, vals } = LISTS[table];
  const all = ['user_id', 'id', 'position', ...cols, 'data'];
  const seen = new Set();
  // Every row needs a unique id; a missing or repeated one gets a stand-in so nothing is dropped.
  const items = (list || []).filter((it) => it && typeof it === 'object').map((it, n) => {
    let id = String(it.id || '') || `row-${n}`;
    while (seen.has(id)) id += '-' + n;
    seen.add(id); return { id, it };
  });
  for (let i = 0; i < items.length; i += 200) {   // batches keep each statement well under Postgres' parameter limit
    const chunk = items.slice(i, i + 200), params = [];
    const rows = chunk.map((it, j) => {
      const v = [uid, it.id, i + j, ...vals(it.it), JSON.stringify(it.it)];
      const base = params.length; params.push(...v);
      return '(' + v.map((_, k) => `$${base + k + 1}${k === v.length - 1 ? '::jsonb' : ''}`).join(',') + ')';
    });
    await run(`INSERT INTO ${table} (${all.join(',')}) VALUES ${rows.join(',')}`, params);
  }
  return items.length;
}
async function dbSaveList(table, uid, list) {
  await tx(async (run) => {
    await run(`DELETE FROM ${table} WHERE user_id = $1`, [uid]);
    await insertList(run, table, uid, list);
  });
}

// One-time copy of everything stored in Vercel Blob into Postgres, the first time the database is used.
// Blob data is left untouched as a backup. Accounts already in Postgres are never overwritten.
setFirstRun(async (run) => {
  const [done] = await run(`SELECT value FROM app_meta WHERE key = 'blob_import'`);
  if (done && done.value?.state === 'done') return;
  const claimed = await run(`INSERT INTO app_meta (key, value) VALUES ('blob_import', '{"state":"running"}'::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    WHERE app_meta.value->>'state' <> 'done' AND app_meta.updated_at < now() - interval '2 minutes' RETURNING key`);
  if (!claimed.length) return;   // another server instance is copying right now
  const counts = { accounts: 0, products: 0, orders: 0, inquiries: 0, skipped: 0, errors: [] };
  try {
    let cursor;
    do {
      const page = await list({ prefix: 'users/', cursor, limit: 1000 });
      for (const b of page.blobs) {
        try {
          const r = await fetch(b.url + '?v=' + Date.now(), { cache: 'no-store' });
          if (!r.ok) { counts.errors.push(`read ${r.status}`); continue; }
          const rec = decrypt(await r.text());
          const added = await run(ACCOUNT_INSERT + ' ON CONFLICT (user_id) DO NOTHING RETURNING user_id', accountRow(rec));
          if (!added.length) { counts.skipped++; continue; }
          counts.accounts++;
          const uid = rec.userId;
          const [products, orders, inquiries] = await Promise.all([blobGetProducts(uid), blobGetOrders(uid), blobGetInquiries(uid)]);
          counts.products += await insertList(run, 'products', uid, products);
          counts.orders += await insertList(run, 'orders', uid, orders);
          counts.inquiries += await insertList(run, 'inquiries', uid, inquiries);
        } catch (e) { counts.errors.push(String(e.message).slice(0, 120)); }
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    await run(`UPDATE app_meta SET value = $1::jsonb, updated_at = now() WHERE key = 'blob_import'`,
      [JSON.stringify({ state: 'done', at: new Date().toISOString(), ...counts })]);
    console.log('blob import done', JSON.stringify(counts));
  } catch (e) {
    await run(`DELETE FROM app_meta WHERE key = 'blob_import'`).catch(() => {});
    throw e;
  }
});

// Storage summary (counts only) for checking the move to Postgres.
export async function storageStatus() {
  if (!useDb()) return { storage: 'vercel-blob' };
  const [c] = await q(`SELECT (SELECT count(*) FROM accounts)::int AS accounts, (SELECT count(*) FROM products)::int AS products,
    (SELECT count(*) FROM orders)::int AS orders, (SELECT count(*) FROM inquiries)::int AS inquiries`);
  const [m] = await q(`SELECT value FROM app_meta WHERE key = 'blob_import'`);
  return { storage: 'prisma-postgres', connection: dbEnvName(), counts: c, blobImport: m?.value || null };
}

export const getUser = (uid) => (useDb() ? dbGetUser(uid) : blobGetUser(uid));
export const saveUser = (rec, opts) => (useDb() ? dbSaveUser(rec, opts) : blobSaveUser(rec, opts));
export const findUsersByEmail = (email) => (useDb() ? dbFindUsersByEmail(email) : blobFindUsersByEmail(email));
export const getProducts = (uid) => (useDb() ? dbGetList('products', uid) : blobGetProducts(uid));
export const saveProducts = (uid, list) => (useDb() ? dbSaveList('products', uid, list) : blobSaveProducts(uid, list));
export const getOrders = (uid) => (useDb() ? dbGetList('orders', uid) : blobGetOrders(uid));
export const saveOrders = (uid, list) => (useDb() ? dbSaveList('orders', uid, list) : blobSaveOrders(uid, list));
export const getInquiries = (uid) => (useDb() ? dbGetList('inquiries', uid) : blobGetInquiries(uid));
export const saveInquiries = (uid, list) => (useDb() ? dbSaveList('inquiries', uid, list) : blobSaveInquiries(uid, list));

/* ---------- email (Resend) ---------- */
// Sends only when RESEND_API_KEY is set. EMAIL_FROM must be a sender on a domain verified in Resend
// (without a domain, Resend's test sender onboarding@resend.dev can only deliver to the Resend account's own email).
export async function sendEmail({ to, subject, text, html, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: 'not_configured' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM || 'Craftifix Orders <onboarding@resend.dev>', to: [].concat(to), subject, text, html, reply_to: replyTo || undefined })
    });
    if (!r.ok) { console.error('Resend error', r.status, await r.text().catch(() => '')); return { sent: false, reason: 'provider_error' }; }
    return { sent: true };
  } catch (e) { console.error('Resend failed', e); return { sent: false, reason: 'provider_error' }; }
}
/* ---------- automatic WhatsApp alerts to the shop owner (CallMeBot) ---------- */
// CallMeBot sends WhatsApp messages to the owner's OWN number, using the API key the owner gets
// by messaging the CallMeBot bot once. It cannot message customers.
export async function sendOwnerWhatsApp(owner, text) {
  if (!owner?.whatsapp || !owner?.callmebotKey) return { sent: false, reason: 'not_configured' };
  try {
    const url = 'https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent(owner.whatsapp)
      + '&text=' + encodeURIComponent(text.slice(0, 1500)) + '&apikey=' + encodeURIComponent(owner.callmebotKey);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    const body = (await r.text().catch(() => '')).toLowerCase();
    const ok = r.ok && /queued|sent|will be sent|currently in the queue/.test(body) && !/error|invalid|not activ/.test(body);
    if (!ok) console.error('CallMeBot', r.status, body.slice(0, 300));
    return { sent: ok };
  } catch (e) { console.error('CallMeBot failed', e); return { sent: false }; }
}

/* ---------- Google Apps Script (Gmail + Google Sheet) ---------- */
// When APPS_SCRIPT_URL is set, emails go out from the owner's Gmail through the Apps Script web app,
// which also records orders and status changes in the "Craftifix Database" Google Sheet.
// Otherwise email falls back to Resend (if configured).
export async function deliver(payload) {
  const { email } = payload;
  const url = process.env.APPS_SCRIPT_URL;
  if (url) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(url, {
        method: 'POST', redirect: 'follow', signal: ctrl.signal,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...payload, secret: process.env.APPS_SCRIPT_SECRET || '' })
      });
      clearTimeout(t);
      const j = await r.json().catch(() => ({}));
      if (!j.ok) console.error('Apps Script error', r.status, j.error);
      return { sent: !!j.emailed, sheet: !!j.sheet, via: 'apps_script' };
    } catch (e) { console.error('Apps Script failed', e); return { sent: false, sheet: false, via: 'apps_script' }; }
  }
  if (!email) return { sent: false };
  const r = await sendEmail(email);
  return { ...r, via: 'resend' };
}

export const escHtml =(s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Account row for the Google Sheet (no password or private keys).
export function accountForSheet(rec) {
  const p = planFor(rec.plan);
  const st = rec.subscription?.status || 'active';
  return {
    userId: rec.userId, name: rec.name, business: rec.business, email: rec.email, whatsapp: rec.whatsapp || '',
    plan: rec.subscription?.planChosen === false ? `${p.name} (free trial, plan not chosen yet)` : p.name, planPrice: promoPercentOff() ? `${money(promoBase(p.price, promoPercentOff()), BASE_CURRENCY)} (${promoPercentOff()}% off ${money(p.price, BASE_CURRENCY)})` : money(p.price, BASE_CURRENCY), status: ({ trial: 'Free trial', trial_ended: 'Trial ended', past_due: 'Past due' })[st] || st[0].toUpperCase() + st.slice(1),
    payment: rec.subscription?.paymentStatus === 'skipped' ? 'Skipped' : rec.subscription?.trialEndsAt && ['trial', 'trial_ended'].includes(st) ? `Trial ends ${rec.subscription.trialEndsAt.slice(0, 10)}` : (rec.subscription?.paymentStatus || ''),
    createdAt: rec.createdAt, updatedAt: rec.updatedAt || rec.createdAt, currency: rec.currency || 'AED',
    logo: rec.logo || '', social: rec.social || {}
  };
}
export const syncAccount = (rec) => deliver({ action: 'account_upsert', account: accountForSheet(rec) });

export function requireUser(req, res) {
  const uid = readSession(req);
  if (!uid) { send(res, 401, { error: 'Please log in again.' }); return null; }
  return uid;
}

/* ---------- request helpers ---------- */
export function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}
export function send(res, status, data) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(data);
}
export function onlyMethod(req, res, method) {
  if (req.method !== method) { res.setHeader('Allow', method); send(res, 405, { error: 'Method not allowed' }); return false; }
  return true;
}
export function fail(res, e) {
  console.error(e);
  send(res, 500, { error: 'Something went wrong on our side. Please try again.' });
}
